import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  normalizeMediaName,
  findBrowserCandidates,
  findBestCandidateForTorrent,
  adoptBrowserDownload,
  transferCandidateFile,
  cleanupCandidateSource,
  closeStoreFiles,
  reopenTorrentStore,
  stitchSplitDownload,
} from '../lib/browser-adoption.js';

test('normalizeMediaName normalizes punctuation, delimiters, and browser suffixes', () => {
  assert.equal(
    normalizeMediaName('The.Odyssey.2026.2160p.UHD.Blu-ray.Remux.HDR.HEVC.DTS-HD.MA.5.1-CiNEPHiLES.mkv'),
    'the odyssey 2026 2160p uhd blu ray remux hdr hevc dts hd ma 5 1 cinephiles'
  );
  assert.equal(
    normalizeMediaName('The Odyssey 2026 2160p UHD Blu-ray Remux HDR HEVC DTS-HD MA 5 1-CiNEPHiLES.mkv.crdownload'),
    'the odyssey 2026 2160p uhd blu ray remux hdr hevc dts hd ma 5 1 cinephiles'
  );
  assert.equal(
    normalizeMediaName('The_Odyssey_2026_2160p.part'),
    'the odyssey 2026 2160p'
  );
  assert.equal(
    normalizeMediaName('Movie Title (1).crdownload'),
    'movie title'
  );
});

test('findBrowserCandidates accurately detects Safari bundles, Chrome .crdownload, and Firefox .part', () => {
  const tmpDir = path.join(os.tmpdir(), `svorrent-test-adoption-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const targetName = 'Dune.Part.Two.2024.1080p.mkv';
    const targetSize = 50 * 1024 * 1024;

    // 1. Safari .download bundle
    const safariDir = path.join(tmpDir, `${targetName}.download`);
    fs.mkdirSync(safariDir, { recursive: true });
    fs.writeFileSync(path.join(safariDir, 'Info.plist'), 'plist');
    const safariFile = path.join(safariDir, targetName);
    fs.writeFileSync(safariFile, Buffer.alloc(20 * 1024 * 1024, 's'));

    // 2. Chrome .crdownload for another file
    const chromeFile = path.join(tmpDir, 'Another.Movie.2024.1080p.mkv.crdownload');
    fs.writeFileSync(chromeFile, Buffer.alloc(15 * 1024 * 1024, 'c'));

    // 3. Firefox .part for Dune
    const firefoxFile = path.join(tmpDir, 'Dune Part Two 2024 1080p.mkv.part');
    fs.writeFileSync(firefoxFile, Buffer.alloc(10 * 1024 * 1024, 'f'));

    const candidates = findBrowserCandidates(targetName, targetSize, { searchDirs: [tmpDir] });

    assert.equal(candidates.length, 2);
    // Largest first: Safari (20 MB) then Firefox (10 MB)
    assert.equal(candidates[0].browser, 'Safari');
    assert.equal(candidates[0].size, 20 * 1024 * 1024);
    assert.equal(candidates[1].browser, 'Firefox');
    assert.equal(candidates[1].size, 10 * 1024 * 1024);

    // Test findBestCandidateForTorrent
    const fakeTorrent = {
      name: targetName,
      length: targetSize,
      downloaded: 2 * 1024 * 1024, // Svorrent only has 2 MB
      files: [{ name: targetName, path: targetName, length: targetSize }],
    };
    const best = findBestCandidateForTorrent(fakeTorrent, { searchDirs: [tmpDir] });
    assert.ok(best);
    assert.equal(best.browser, 'Safari');
    assert.equal(best.size, 20 * 1024 * 1024);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('adoptBrowserDownload transfers file and triggers rescan', async () => {
  const tmpDir = path.join(os.tmpdir(), `svorrent-test-transfer-${Date.now()}`);
  const destDir = path.join(tmpDir, 'dest');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });

  try {
    const filename = 'Test.Movie.2024.mkv';
    const srcFile = path.join(srcDir, `${filename}.crdownload`);
    fs.writeFileSync(srcFile, Buffer.alloc(5 * 1024 * 1024, 'a'));

    let rescanned = false;
    const fakeTorrent = {
      name: filename,
      length: 10 * 1024 * 1024,
      downloaded: 0,
      path: destDir,
      files: [{ name: filename, path: filename, length: 10 * 1024 * 1024 }],
      pause: () => {},
      resume: () => {},
      rescanFiles: (cb) => {
        rescanned = true;
        fakeTorrent.downloaded = 5 * 1024 * 1024;
        fakeTorrent.progress = 0.5;
        cb(null);
      },
    };

    const candidate = {
      path: srcFile,
      name: filename,
      size: 5 * 1024 * 1024,
      browser: 'Chrome / Edge',
      targetPath: path.join(destDir, filename),
    };

    const result = await adoptBrowserDownload(fakeTorrent, candidate, { mode: 'move' });
    assert.equal(result.success, true);
    assert.equal(rescanned, true);
    assert.equal(result.progress, 0.5);
    assert.equal(fs.existsSync(path.join(destDir, filename)), true);
    assert.equal(fs.existsSync(srcFile), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cleanupCandidateSource safely deletes candidate files and bundles', () => {
  const tmpDir = path.join(os.tmpdir(), `svorrent-test-cleanup-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const srcFile = path.join(tmpDir, 'download.part');
    const targetFile = path.join(tmpDir, 'download.mkv');
    fs.writeFileSync(srcFile, 'data');
    fs.writeFileSync(targetFile, 'data');

    // Safe cleanup deletes source but never touches target
    cleanupCandidateSource({ path: srcFile }, targetFile);
    assert.equal(fs.existsSync(srcFile), false);
    assert.equal(fs.existsSync(targetFile), true);

    // Safeguard: does not delete if source matches target
    cleanupCandidateSource({ path: targetFile }, targetFile);
    assert.equal(fs.existsSync(targetFile), true);

    // Cleans up Safari bundle directory
    const bundleDir = path.join(tmpDir, 'movie.download');
    fs.mkdirSync(bundleDir, { recursive: true });
    const bundleInner = path.join(bundleDir, 'movie.mkv');
    fs.writeFileSync(bundleInner, 'movie');
    cleanupCandidateSource({ path: bundleInner, bundleDir }, targetFile);
    assert.equal(fs.existsSync(bundleDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('transferCandidateFile handles clone, move, and copy safely', () => {
  const tmpDir = path.join(os.tmpdir(), `svorrent-test-transfermode-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const src1 = path.join(tmpDir, 'source1.bin');
    const dst1 = path.join(tmpDir, 'dest1.bin');
    fs.writeFileSync(src1, 'hello payload');

    const method1 = transferCandidateFile(src1, dst1, { mode: 'auto' });
    assert.ok(['clone', 'reflink', 'move', 'copy'].includes(method1));
    assert.equal(fs.readFileSync(dst1, 'utf8'), 'hello payload');

    // Test move mode
    const src2 = path.join(tmpDir, 'source2.bin');
    const dst2 = path.join(tmpDir, 'dest2.bin');
    fs.writeFileSync(src2, 'move payload');
    const method2 = transferCandidateFile(src2, dst2, { mode: 'move' });
    assert.equal(method2, 'move');
    assert.equal(fs.existsSync(src2), false);
    assert.equal(fs.readFileSync(dst2, 'utf8'), 'move payload');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('closeStoreFiles safely handles null or open RAF descriptors', async () => {
  await closeStoreFiles(null);
  await closeStoreFiles({});

  let closedCount = 0;
  const mockTorrent = {
    store: {
      store: {
        files: [
          {
            open: (cb) => cb(null, {
              close: (onClose) => {
                closedCount++;
                onClose();
              },
            }),
          },
          {
            open: (cb) => cb(new Error('not open')),
          },
        ],
      },
    },
  };

  await closeStoreFiles(mockTorrent);
  assert.equal(closedCount, 1);
});

test('reopenTorrentStore safely reconstructs store hierarchy', () => {
  reopenTorrentStore(null);
  reopenTorrentStore({});

  class FakeRawStore {
    constructor(pieceLength, opts) {
      this.pieceLength = pieceLength;
      this.opts = opts;
    }
  }

  class FakeCacheStore {
    constructor(store, opts) {
      this.store = store;
      this.opts = opts;
    }
  }

  class FakeImmediateStore {
    constructor(store) {
      this.store = store;
    }
  }

  const mockTorrent = {
    pieceLength: 16384,
    length: 32768,
    name: 'test',
    infoHash: 'abcd1234abcd1234abcd1234abcd1234abcd1234',
    files: [],
    _store: FakeRawStore,
    _storeCacheSlots: 10,
    store: new FakeImmediateStore(new FakeCacheStore(new FakeRawStore(16384, {}), {})),
  };

  reopenTorrentStore(mockTorrent);
  assert.equal(mockTorrent.store instanceof FakeImmediateStore, true);
  assert.equal(mockTorrent.store.store instanceof FakeCacheStore, true);
  assert.equal(mockTorrent.store.store.store instanceof FakeRawStore, true);
});

test('stitchSplitDownload dynamically detects split boundaries and stitches sparse target file', async () => {
  const tmpDir = path.join(os.tmpdir(), `svorrent-test-stitch-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const pieceLen = 256 * 1024; // 256 KB
    const numPieces = 16;
    const targetLength = numPieces * pieceLen;

    const originalData = crypto.randomBytes(targetLength);
    const hashes = [];
    for (let i = 0; i < numPieces; i++) {
      const slice = originalData.subarray(i * pieceLen, (i + 1) * pieceLen);
      hashes.push(crypto.createHash('sha1').update(slice).digest('hex'));
    }

    // Split: 5 head pieces (0..4), 6 middle missing pieces (5..10), 5 tail pieces (11..15)
    const headPieces = 5;
    const gapPieces = 6;
    const tailStartPiece = 11;
    const tailPieces = numPieces - tailStartPiece;

    const headBuf = originalData.subarray(0, headPieces * pieceLen);
    const tailBuf = originalData.subarray(tailStartPiece * pieceLen, targetLength);
    const splitBuf = Buffer.concat([headBuf, tailBuf]);

    const srcFile = path.join(tmpDir, 'download.mkv');
    const dstFile = path.join(tmpDir, 'target.mkv');
    fs.writeFileSync(srcFile, splitBuf);

    const mockTorrent = {
      length: targetLength,
      pieceLength: pieceLen,
      lastPieceLength: pieceLen,
      _hashes: hashes,
      pieces: new Array(numPieces).fill(null),
    };

    const res = await stitchSplitDownload(srcFile, dstFile, mockTorrent, targetLength);
    assert.ok(res);
    assert.equal(res.stitched, true);
    assert.equal(res.headPieces, headPieces);
    assert.equal(res.tailPieces, tailPieces);
    assert.equal(res.totalValidPieces, headPieces + tailPieces);

    const stat = fs.statSync(dstFile);
    assert.equal(stat.size, targetLength);

    const fd = fs.openSync(dstFile, 'r');
    const buf = Buffer.alloc(pieceLen);

    for (let i = 0; i < numPieces; i++) {
      fs.readSync(fd, buf, 0, pieceLen, i * pieceLen);
      const h = crypto.createHash('sha1').update(buf).digest('hex');
      const isZero = buf.every((b) => b === 0);

      if (i < headPieces) {
        assert.equal(h, hashes[i]);
      } else if (i < tailStartPiece) {
        assert.equal(isZero, true);
      } else {
        assert.equal(h, hashes[i]);
      }
    }
    fs.closeSync(fd);

    // Negative case: mismatched last piece returns null
    const corruptFile = path.join(tmpDir, 'corrupt.mkv');
    fs.writeFileSync(corruptFile, crypto.randomBytes(1024 * 1024));
    const corruptRes = await stitchSplitDownload(corruptFile, dstFile, mockTorrent, targetLength);
    assert.equal(corruptRes, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
