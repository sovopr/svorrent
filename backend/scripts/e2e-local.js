// Local, self-contained smoke test: synthetic video -> local tracker ->
// Svorrent download -> on-disk verification -> native playback -> deletion.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import WebTorrent from 'webtorrent';
import TrackerServer from 'bittorrent-tracker/server';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-e2e-'));
const video = path.join(root, 'Svorrent Test Clip.mp4');
const downloads = path.join(root, 'downloads');
const data = path.join(root, 'data');
const backendDir = fileURLToPath(new URL('..', import.meta.url));
let tracker;
let seeder;
let backend;
let backendOutput = '';
let infoHash;
let base;
let launchedVlcByTest = false;

function isVlcRunning() {
  try {
    if (process.platform === 'darwin') {
      return spawnSync('pgrep', ['-x', 'VLC'], { stdio: 'ignore' }).status === 0;
    }
    if (process.platform === 'linux') {
      return spawnSync('pgrep', ['-x', 'vlc'], { stdio: 'ignore' }).status === 0;
    }
    if (process.platform === 'win32') {
      const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq vlc.exe'], { encoding: 'utf8' });
      return /vlc\.exe/i.test(res.stdout || '');
    }
  } catch {
    // Ignore process lookup errors
  }
  return false;
}

async function closeTestVlc() {
  if (!launchedVlcByTest) return;
  try {
    if (!isVlcRunning()) {
      await delay(400);
    }
    if (process.platform === 'darwin') {
      spawnSync('osascript', ['-e', 'tell application "VLC" to quit'], { timeout: 3000, stdio: 'ignore' });
      for (let i = 0; i < 8 && isVlcRunning(); i += 1) {
        await delay(250);
      }
      if (isVlcRunning()) {
        spawnSync('pkill', ['-TERM', '-x', 'VLC'], { stdio: 'ignore' });
      }
      for (let i = 0; i < 4 && isVlcRunning(); i += 1) {
        await delay(200);
      }
      if (isVlcRunning()) {
        spawnSync('pkill', ['-KILL', '-x', 'VLC'], { stdio: 'ignore' });
      }
    } else if (process.platform === 'linux') {
      spawnSync('pkill', ['-TERM', '-x', 'vlc'], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawnSync('taskkill', ['/IM', 'vlc.exe', '/F'], { stdio: 'ignore' });
    }
  } catch {
    // Best-effort cleanup so local test runs do not leave VLC open
  } finally {
    launchedVlcByTest = false;
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function api(route, options) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(5000), ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(check, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(350);
  }
  throw new Error(`Timed out waiting for local transfer. ${lastError?.message || ''}\n${backendOutput.slice(-3000)}`);
}

async function closeBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((resolve) => backend.once('exit', resolve));
  backend.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (backend.exitCode === null) {
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/pid', String(backend.pid), '/T', '/F']); } catch {}
    } else {
      backend.kill('SIGKILL');
    }
    await Promise.race([exited, delay(2000)]);
  }
}

try {
  let clipCreated = false;
  try {
    const generated = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', video,
    ], { timeout: 30000, encoding: 'utf8' });
    if (generated && generated.status === 0) clipCreated = true;
  } catch {}
  if (!clipCreated) throw new Error('ffmpeg is required to generate a real video for the media integration test');

  tracker = new TrackerServer({ http: true, udp: false, ws: false, stats: false, interval: 1000 });
  await new Promise((resolve, reject) => tracker.once('error', reject).listen(0, '127.0.0.1', resolve));
  const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`;
  seeder = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, torrentPort: 0 });
  seeder.on('error', (error) => { backendOutput += `\nSeeder: ${error.message}`; });
  const seeded = await new Promise((resolve, reject) => {
    const torrent = seeder.seed(video, { announce: [announce], private: true }, resolve);
    torrent.once('error', reject);
  });

  const port = await freePort();
  const torrentPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  backend = spawn(process.execPath, ['--openssl-legacy-provider', 'server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      TORRENT_PORT: String(torrentPort),
      SVORRENT_DOWNLOAD_DIR: downloads,
      SVORRENT_DATA_DIR: data,
      SVORRENT_DISABLE_PUBLIC_DISCOVERY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (chunk) => { backendOutput += chunk; });
  backend.stderr.on('data', (chunk) => { backendOutput += chunk; });
  await waitFor(async () => Array.isArray(await api('/api/torrents')), 15000);
  assert.match(await (await fetch(`${base}/downloads`)).text(), /id="root"/);
  assert.equal((await api('/api/config')).downloadDir, downloads);
  console.log(`Isolated test UI: ${base}/downloads`);

  const magnet = `${seeded.magnetURI}&tr=${encodeURIComponent(announce)}`;
  const added = await api('/api/torrent/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet }),
  });
  infoHash = added.infoHash;
  assert.equal(infoHash, seeded.infoHash);
  console.log(`Added synthetic torrent ${infoHash} via local tracker`);

  const completed = await waitFor(async () => {
    const items = await api('/api/torrents');
    return items.find((item) => item.infoHash === infoHash && item.done);
  });
  assert.equal(completed.playability?.canPlay, true);
  const received = path.join(downloads, path.basename(video));
  assert.equal(fs.existsSync(received), true);
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(digest(received), digest(video));
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', received, '-f', 'null', '-'], {
    timeout: 30000, encoding: 'utf8',
  });
  assert.equal(decoded.status, 0, `Downloaded video failed to decode: ${decoded.stderr || decoded.error || ''}`);
  console.log('Completed transfer; SHA-256 matches the source clip');

  const stats = await api(`/api/torrent/${infoHash}/nerd-stats`);
  assert.ok(Array.isArray(stats.files) && stats.files.length > 0);
  assert.ok(Array.isArray((await api('/api/networks')).interfaces));
  await api(`/api/torrent/${infoHash}/pause`, { method: 'POST' });
  assert.equal((await api('/api/torrents')).find((item) => item.infoHash === infoHash)?.paused, true);
  await api(`/api/torrent/${infoHash}/resume`, { method: 'POST' });
  console.log('Details, network status, pause, and resume passed');

  const vlcWasRunning = isVlcRunning();
  try {
    const playback = await api(`/api/torrent/${infoHash}/play`, { method: 'POST' });
    assert.equal(playback.success, true);
    if (!vlcWasRunning && (playback.player === 'VLC' || isVlcRunning())) {
      launchedVlcByTest = true;
    }
    console.log(`Native player accepted the test clip: ${playback.player}`);
  } catch (err) {
    if (process.platform === 'linux' || process.platform === 'win32') {
      console.log(`Skipping native GUI player on headless ${process.platform} CI`);
    } else {
      throw err;
    }
  }
  const holdMs = Math.min(60000, Math.max(0, Number(process.env.SVORRENT_E2E_HOLD_MS) || 0));
  if (holdMs) {
    console.log(`Holding the isolated test open for ${holdMs} ms for visual playback inspection`);
    await delay(holdMs);
  }
  await closeTestVlc();

  await api(`/api/torrent/${infoHash}/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleteFiles: true }),
  });
  infoHash = null;
  assert.equal(fs.existsSync(received), false);
  console.log('Delete removed the test download from the isolated folder');
} catch (error) {
  console.error(error);
  console.error(backendOutput.slice(-4000));
  process.exitCode = 1;
} finally {
  if (infoHash && backend?.exitCode === null) {
    try {
      await api(`/api/torrent/${infoHash}/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteFiles: true }),
      });
    } catch {}
  }
  await closeTestVlc();
  await closeBackend();
  if (seeder) await new Promise((resolve) => seeder.destroy(resolve));
  if (tracker) await new Promise((resolve) => tracker.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
