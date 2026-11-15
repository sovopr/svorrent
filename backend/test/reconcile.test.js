import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';
import { Server as TrackerServer } from 'bittorrent-tracker';
import {
  bitfieldHasVerifiedPieces,
  resolveWithinBase,
  getTorrentDiskPaths,
  checkTorrentFilesOnDisk,
  markTorrentHadFilesIfPresent,
  hasTorrentDataEverExisted,
  shouldSkipRestoredEntry,
  shouldRemoveActiveTorrentForMissingFiles,
  releaseStoreFileHandles,
} from '../lib/reconcile.js';
import { createSession } from '../lib/session.js';
import { TorrentArchive } from '../lib/archive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.resolve(__dirname, '../server.js');

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 80, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function getLeafFiles(torrent) {
  let cur = torrent?.store;
  const seen = new Set();
  while (cur && cur.store && !seen.has(cur)) {
    seen.add(cur);
    cur = cur.store;
  }
  return Array.isArray(cur?.files) ? cur.files : [];
}

async function startTestServer({ port, torrentPort, dataDir, downloadDir }) {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.dirname(SERVER_PATH),
    env: {
      ...process.env,
      PORT: String(port),
      TORRENT_PORT: String(torrentPort),
      SVORRENT_DATA_DIR: dataDir,
      SVORRENT_DOWNLOAD_DIR: downloadDir,
      SVORRENT_DISABLE_PUBLIC_DISCOVERY: '1',
      SVORRENT_NO_AUTO_UPDATE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  proc.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early with ${proc.exitCode}\n${logs}`);
    }
    const res = await fetch(`${baseUrl}/api/health`);
    return res.ok;
  }, { timeoutMs: 12000, label: 'server health' });

  return {
    proc,
    baseUrl,
    getLogs: () => logs,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

test('bitfieldHasVerifiedPieces detects verified pieces across all representations', () => {
  assert.equal(bitfieldHasVerifiedPieces(null), false);
  assert.equal(bitfieldHasVerifiedPieces(''), false);
  assert.equal(bitfieldHasVerifiedPieces(Buffer.from([0, 0, 0]).toString('base64')), false);
  assert.equal(bitfieldHasVerifiedPieces(new Uint8Array([0, 0])), false);
  assert.equal(bitfieldHasVerifiedPieces({ buffer: new Uint8Array([0, 0]) }), false);
  assert.equal(bitfieldHasVerifiedPieces({ length: 3, get: () => false }), false);
  assert.equal(bitfieldHasVerifiedPieces([false, false]), false);

  assert.equal(bitfieldHasVerifiedPieces(Buffer.from([0x80]).toString('base64')), true);
  assert.equal(bitfieldHasVerifiedPieces(new Uint8Array([0, 1])), true);
  assert.equal(bitfieldHasVerifiedPieces({ buffer: Buffer.from([0x04]) }), true);
  assert.equal(bitfieldHasVerifiedPieces({ length: 4, get: (i) => i === 2 }), true);
  assert.equal(bitfieldHasVerifiedPieces([false, true]), true);
});

test('resolveWithinBase and getTorrentDiskPaths stay strictly inside basePath', () => {
  const base = path.join(os.tmpdir(), 'svorrent-reconcile-paths');
  assert.equal(resolveWithinBase(base, '../etc/passwd'), null);
  assert.equal(resolveWithinBase(base, '/etc/passwd'), null);
  assert.equal(resolveWithinBase(base, '.'), null);
  assert.equal(resolveWithinBase(base, 'Movie.mkv'), path.resolve(base, 'Movie.mkv'));
  assert.equal(
    resolveWithinBase(base, 'Album/01.flac'),
    path.resolve(base, 'Album', '01.flac'),
  );

  const single = getTorrentDiskPaths({ name: 'Film.mp4', files: [{ path: 'Film.mp4' }] }, base);
  assert.deepEqual(single.targetPaths, [path.resolve(base, 'Film.mp4')]);

  const multi = getTorrentDiskPaths({
    name: 'Album',
    filePaths: ['Album/01.flac', '../escape.flac', 'Album/02.flac'],
  }, base);
  assert.deepEqual(multi.targetPaths, [
    path.resolve(base, 'Album', '01.flac'),
    path.resolve(base, 'Album', '02.flac'),
  ]);
});

test('shouldRemoveActiveTorrentForMissingFiles distinguishes unstarted vs manually deleted files and unmounted drives', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-reconcile-active-'));
  try {
    // 1. Unstarted torrent with RAM buffer only (no file written to disk yet) -> keep
    const brandNew = {
      name: 'NewRelease.mkv',
      path: tmpDir,
      downloaded: 1024 * 1024,
      done: false,
      files: [{ path: 'NewRelease.mkv' }],
    };
    assert.equal(shouldRemoveActiveTorrentForMissingFiles(brandNew, tmpDir), false);
    assert.equal(brandNew._hadFilesOnDisk, undefined);

    // 2. Once a file appears on disk -> mark _hadFilesOnDisk and keep while present
    const filePath = path.join(tmpDir, 'NewRelease.mkv');
    fs.writeFileSync(filePath, 'partial');
    assert.equal(shouldRemoveActiveTorrentForMissingFiles(brandNew, tmpDir), false);
    assert.equal(brandNew._hadFilesOnDisk, true);

    // 3. Manual deletion of single file -> detect deletion and remove
    fs.rmSync(filePath);
    assert.equal(shouldRemoveActiveTorrentForMissingFiles(brandNew, tmpDir), true);

    // 4. Multi-file torrent: keep while at least one file stays on disk; remove when all/folder deleted
    const folderDir = path.join(tmpDir, 'SeriesPack');
    fs.mkdirSync(folderDir, { recursive: true });
    const ep1 = path.join(folderDir, 'E01.mkv');
    const ep2 = path.join(folderDir, 'E02.mkv');
    fs.writeFileSync(ep1, 'ep1');
    fs.writeFileSync(ep2, 'ep2');

    const multi = {
      name: 'SeriesPack',
      path: tmpDir,
      done: true,
      files: [{ path: 'SeriesPack/E01.mkv' }, { path: 'SeriesPack/E02.mkv' }],
    };
    assert.equal(markTorrentHadFilesIfPresent(multi, tmpDir), true);
    fs.rmSync(ep1);
    assert.equal(shouldRemoveActiveTorrentForMissingFiles(multi, tmpDir), false);
    fs.rmSync(folderDir, { recursive: true, force: true });
    assert.equal(shouldRemoveActiveTorrentForMissingFiles(multi, tmpDir), true);

    // 5. Disconnected external drive (basePath missing) -> protect torrent
    const missingBase = path.join(tmpDir, 'UnmountedSSD');
    const externalTorrent = {
      name: 'External.mkv',
      path: missingBase,
      _hadFilesOnDisk: true,
      done: true,
      files: [{ path: 'External.mkv' }],
    };
    assert.equal(shouldRemoveActiveTorrentForMissingFiles(externalTorrent, tmpDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('shouldSkipRestoredEntry skips deleted session/legacy entries cleanly and protects unstarted/unmounted entries', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-reconcile-restore-'));
  try {
    // 1. Brand-new 0% magnet without verified pieces or files -> keep
    assert.equal(
      shouldSkipRestoredEntry(
        {
          infoHash: 'a'.repeat(40),
          name: 'Unstarted.mkv',
          path: tmpDir,
          done: false,
          hadFilesOnDisk: false,
          bitfield: '',
        },
        null,
        tmpDir,
      ),
      false,
    );

    // 2. Deleted completed download (new session metadata) -> skip
    assert.equal(
      shouldSkipRestoredEntry(
        {
          infoHash: 'b'.repeat(40),
          name: 'DeletedCompleted.mkv',
          path: tmpDir,
          done: true,
          hadFilesOnDisk: true,
          filePaths: ['DeletedCompleted.mkv'],
        },
        null,
        tmpDir,
      ),
      true,
    );

    // 3. Deleted download from legacy session.json (only bitfield set, no hadFilesOnDisk/done fields) -> skip
    assert.equal(
      shouldSkipRestoredEntry(
        {
          infoHash: 'c'.repeat(40),
          name: 'LegacyDeletedPack',
          path: tmpDir,
          bitfield: Buffer.from([0x80]).toString('base64'),
        },
        { files: [{ path: 'LegacyDeletedPack/video.mkv', name: 'video.mkv', length: 1234 }] },
        tmpDir,
      ),
      true,
    );

    // 4. Present file on disk -> keep
    const presentFile = path.join(tmpDir, 'StillHere.mkv');
    fs.writeFileSync(presentFile, 'data');
    assert.equal(
      shouldSkipRestoredEntry(
        {
          infoHash: 'd'.repeat(40),
          name: 'StillHere.mkv',
          path: tmpDir,
          done: true,
          hadFilesOnDisk: true,
          filePaths: ['StillHere.mkv'],
        },
        null,
        tmpDir,
      ),
      false,
    );

    // 5. Missing external drive -> protect
    assert.equal(
      shouldSkipRestoredEntry(
        {
          infoHash: 'e'.repeat(40),
          name: 'ExternalDeletedOrUnmounted.mkv',
          path: path.join(tmpDir, 'UnmountedVolume'),
          done: true,
          hadFilesOnDisk: true,
        },
        null,
        tmpDir,
      ),
      false,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createSession filters _deletedManually/_deleting and persists disk flags cleanly', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-reconcile-session-'));
  try {
    const session = createSession(dataDir);
    const active = {
      _isPermanentDownload: true,
      infoHash: '1'.repeat(40),
      magnetURI: `magnet:?xt=urn:btih:${'1'.repeat(40)}`,
      name: 'KeepMe.mkv',
      path: '/tmp/dl',
      done: true,
      _hadFilesOnDisk: true,
      files: [{ path: 'KeepMe.mkv' }],
      bitfield: { buffer: Buffer.from([0xff]) },
    };
    const manuallyDeleted = {
      _isPermanentDownload: true,
      _deletedManually: true,
      infoHash: '2'.repeat(40),
      magnetURI: `magnet:?xt=urn:btih:${'2'.repeat(40)}`,
      name: 'Gone.mkv',
      path: '/tmp/dl',
      done: true,
      _hadFilesOnDisk: true,
      files: [{ path: 'Gone.mkv' }],
    };

    session.save([active, manuallyDeleted]);
    const loaded = session.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].infoHash, '1'.repeat(40));
    assert.equal(loaded[0].done, true);
    assert.equal(loaded[0].hadFilesOnDisk, true);
    assert.deepEqual(loaded[0].filePaths, ['KeepMe.mkv']);
    assert.equal(hasTorrentDataEverExisted(loaded[0]), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('releaseStoreFileHandles closes open RAF descriptors while keeping reopened lazy store usable', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-reconcile-raf-'));
  const client = new WebTorrent({ dht: false, lsd: false, tracker: false, webSeeds: false });

  try {
    const payload = crypto.randomBytes(64 * 1024);
    const srcFile = path.join(tmpDir, 'ReleaseHandlesTest.bin');
    fs.writeFileSync(srcFile, payload);

    const torrent = await new Promise((resolve, reject) => {
      const t = client.seed(srcFile, { path: tmpDir }, () => resolve(t));
      t.on('error', reject);
    });

    // Trigger a read through FSChunkStore so random-access-file opens an OS fd
    const chunk0 = await new Promise((resolve, reject) => {
      torrent.store.get(0, (err, buf) => (err ? reject(err) : resolve(buf)));
    });
    assert.ok(chunk0.length > 0);

    const oldLeafFiles = getLeafFiles(torrent);
    assert.equal(oldLeafFiles.length, 1);
    const oldRaf = await new Promise((resolve, reject) => {
      oldLeafFiles[0].open((err, raf) => (err ? reject(err) : resolve(raf)));
    });
    assert.ok(oldRaf.fd > 0);
    assert.equal(oldRaf.closed, false);

    torrent._storeMayHaveOpenHandles = true;
    const released = releaseStoreFileHandles(torrent);
    assert.equal(released, true);
    assert.equal(torrent._storeMayHaveOpenHandles, false);

    // Wait briefly for RAF CLOSE_OP callback to finish closing fd
    await waitFor(() => oldRaf.closed === true && oldRaf.fd === 0, {
      timeoutMs: 3000,
      intervalMs: 20,
      label: 'RAF file descriptor close',
    });

    // New store must be fresh and readable on demand without "Storage is closed"
    const newLeafFiles = getLeafFiles(torrent);
    assert.equal(newLeafFiles.length, 1);
    assert.notEqual(newLeafFiles[0], oldLeafFiles[0]);

    const readAfterRelease = await new Promise((resolve, reject) => {
      torrent.store.get(0, (err, buf) => (err ? reject(err) : resolve(buf)));
    });
    assert.equal(Buffer.compare(readAfterRelease, chunk0), 0);

    // Release once more, verify deleting the file works cleanly and stays deleted
    const secondRaf = await new Promise((resolve, reject) => {
      newLeafFiles[0].open((err, raf) => (err ? reject(err) : resolve(raf)));
    });
    releaseStoreFileHandles(torrent);
    await waitFor(() => secondRaf.closed === true && secondRaf.fd === 0, {
      timeoutMs: 3000,
      intervalMs: 20,
      label: 'second RAF close',
    });
    fs.rmSync(srcFile);
    assert.equal(fs.existsSync(srcFile), false);
  } finally {
    await new Promise((resolve) => client.destroy(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('server removes manually deleted downloads at runtime and across restarts without re-downloading', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-reconcile-e2e-'));
  const seedDir = path.join(rootDir, 'seed');
  const downloadDir = path.join(rootDir, 'downloads');
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const tracker = new TrackerServer({ http: true, udp: false, ws: false });
  const seeder = new WebTorrent({ dht: false, lsd: false, tracker: true, webSeeds: false });
  let svorrent = null;

  try {
    await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve));
    const trackerPort = tracker.http.address().port;
    const announceUrl = `http://127.0.0.1:${trackerPort}/announce`;

    // Seed two distinct media files for online deletion and offline (restart) deletion tests
    const onlineFile = path.join(seedDir, 'ManualDeleteOnline.mp4');
    const offlineFile = path.join(seedDir, 'ManualDeleteOffline.mp4');
    fs.writeFileSync(onlineFile, crypto.randomBytes(256 * 1024));
    fs.writeFileSync(offlineFile, crypto.randomBytes(256 * 1024));

    const onlineTorrent = await new Promise((resolve, reject) => {
      const t = seeder.seed(onlineFile, { announce: [announceUrl] }, () => resolve(t));
      t.on('error', reject);
    });
    const offlineTorrent = await new Promise((resolve, reject) => {
      const t = seeder.seed(offlineFile, { announce: [announceUrl] }, () => resolve(t));
      t.on('error', reject);
    });

    const multiSeedDir = path.join(seedDir, 'ManualDeleteMultiPack');
    fs.mkdirSync(multiSeedDir, { recursive: true });
    fs.writeFileSync(path.join(multiSeedDir, 'Part1.mp4'), crypto.randomBytes(128 * 1024));
    fs.writeFileSync(path.join(multiSeedDir, 'Part2.mp4'), crypto.randomBytes(128 * 1024));
    const multiTorrent = await new Promise((resolve, reject) => {
      const t = seeder.seed(multiSeedDir, { announce: [announceUrl] }, () => resolve(t));
      t.on('error', reject);
    });

    const serverPort = await pickFreePort();
    const torrentPort = await pickFreePort();
    svorrent = await startTestServer({ port: serverPort, torrentPort, dataDir, downloadDir });

    // Enable autoStopSeeding so completed torrents exercise pause + FD release path as well
    const settingsRes = await fetch(`${svorrent.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoStopSeeding: true }),
    });
    assert.equal(settingsRes.ok, true);

    // 1. Download first file and delete it manually while Svorrent is running
    const addOnlineRes = await fetch(`${svorrent.baseUrl}/api/torrent/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet: onlineTorrent.magnetURI }),
    });
    assert.equal(addOnlineRes.ok, true);

    await waitFor(async () => {
      const res = await fetch(`${svorrent.baseUrl}/api/torrents`);
      const list = await res.json();
      const match = list.find((t) => t.infoHash === onlineTorrent.infoHash);
      return match && match.done && match.progress === 1;
    }, { timeoutMs: 15000, label: 'online test download completion' });

    const downloadedOnlinePath = path.join(downloadDir, 'ManualDeleteOnline.mp4');
    assert.equal(fs.existsSync(downloadedOnlinePath), true);

    // Manually delete file from disk (use retry on Windows while async done handler finishes closing FD)
    fs.rmSync(downloadedOnlinePath, { maxRetries: 10, retryDelay: 50 });

    // Torrent must disappear from /api/torrents, session.json, and archive, and never restart
    await waitFor(async () => {
      const res = await fetch(`${svorrent.baseUrl}/api/torrents`);
      const list = await res.json();
      return list.length === 0;
    }, { timeoutMs: 5000, label: 'removal from /api/torrents after manual delete' });

    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fs.existsSync(downloadedOnlinePath), false);

    const archiveCheck = new TorrentArchive(dataDir);
    assert.equal(archiveCheck.get(onlineTorrent.infoHash), null);
    const sessionCheck = createSession(dataDir);
    assert.deepEqual(sessionCheck.load(), []);

    // 2. Download second file, stop Svorrent cleanly, delete file offline, and restart Svorrent
    const addOfflineRes = await fetch(`${svorrent.baseUrl}/api/torrent/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet: offlineTorrent.magnetURI }),
    });
    assert.equal(addOfflineRes.ok, true);

    await waitFor(async () => {
      const res = await fetch(`${svorrent.baseUrl}/api/torrents`);
      const list = await res.json();
      const match = list.find((t) => t.infoHash === offlineTorrent.infoHash);
      return match && match.done && match.progress === 1;
    }, { timeoutMs: 15000, label: 'offline test download completion' });

    const downloadedOfflinePath = path.join(downloadDir, 'ManualDeleteOffline.mp4');
    assert.equal(fs.existsSync(downloadedOfflinePath), true);

    await waitFor(() => {
      const entries = sessionCheck.load();
      return Array.isArray(entries) && entries.some((e) => e.infoHash === offlineTorrent.infoHash);
    }, { timeoutMs: 5000, label: 'session.json persistence before restart' });

    await svorrent.stop();
    svorrent = null;

    // Delete file while Svorrent is shut down
    fs.rmSync(downloadedOfflinePath);

    // Restart Svorrent pointing to the same dataDir + downloadDir
    const serverPort2 = await pickFreePort();
    const torrentPort2 = await pickFreePort();
    svorrent = await startTestServer({ port: serverPort2, torrentPort: torrentPort2, dataDir, downloadDir });

    await new Promise((r) => setTimeout(r, 600));
    const afterRestartRes = await fetch(`${svorrent.baseUrl}/api/torrents`);
    const afterRestartList = await afterRestartRes.json();
    assert.equal(afterRestartList.length, 0);
    assert.equal(fs.existsSync(downloadedOfflinePath), false);
    assert.equal(archiveCheck.get(offlineTorrent.infoHash), null);

    // 3. Multi-file folder download, pause, then manual folder deletion on disk
    const addMultiRes = await fetch(`${svorrent.baseUrl}/api/torrent/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet: multiTorrent.magnetURI }),
    });
    assert.equal(addMultiRes.ok, true);

    await waitFor(async () => {
      const res = await fetch(`${svorrent.baseUrl}/api/torrents`);
      const list = await res.json();
      const match = list.find((t) => t.infoHash === multiTorrent.infoHash);
      return match && match.done && match.progress === 1;
    }, { timeoutMs: 15000, label: 'multi-file download completion' });

    const downloadedMultiDir = path.join(downloadDir, 'ManualDeleteMultiPack');
    assert.equal(fs.existsSync(path.join(downloadedMultiDir, 'Part1.mp4')), true);
    assert.equal(fs.existsSync(path.join(downloadedMultiDir, 'Part2.mp4')), true);

    const pauseMultiRes = await fetch(`${svorrent.baseUrl}/api/torrent/${multiTorrent.infoHash}/pause`, {
      method: 'POST',
    });
    assert.equal(pauseMultiRes.ok, true);

    fs.rmSync(downloadedMultiDir, { recursive: true, force: true });

    await waitFor(async () => {
      const res = await fetch(`${svorrent.baseUrl}/api/torrents`);
      const list = await res.json();
      return list.length === 0;
    }, { timeoutMs: 5000, label: 'removal after manual multi-file folder delete' });

    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fs.existsSync(downloadedMultiDir), false);
    assert.equal(archiveCheck.get(multiTorrent.infoHash), null);
    assert.deepEqual(sessionCheck.load(), []);
  } finally {
    if (svorrent) await svorrent.stop();
    await new Promise((resolve) => seeder.destroy(resolve));
    await new Promise((resolve) => tracker.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
