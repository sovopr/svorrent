import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DownloadHistory } from '../lib/history.js';

test('DownloadHistory records, persists, and detects completed torrents', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-history-test-'));
  try {
    const history = new DownloadHistory(tmpDir);
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const title = 'Inception (2010) [1080p] [BluRay]';

    assert.equal(history.has(hash), false);
    assert.equal(history.has(null, title, '2.1 GB'), false);

    // Record completed torrent
    const ok = history.record({
      infoHash: hash,
      name: title,
      magnetURI: `magnet:?xt=urn:btih:${hash}&dn=Inception`,
      length: 2254857830,
    });
    assert.equal(ok, true);

    // Exact and case-insensitive infoHash lookup
    assert.equal(history.has(hash), true);
    assert.equal(history.has(hash.toUpperCase()), true);

    // Lookup by title and matching size
    assert.equal(history.has(null, 'Inception 2010 1080p BluRay', '2.1 GB'), true);
    assert.equal(history.has(null, 'Completely Different Movie', '1.0 GB'), false);

    // Check item data
    const item = history.get(hash);
    assert.equal(item.infoHash, hash);
    assert.equal(item.name, title);
    assert.ok(item.completedAt > 0);

    // Persists across reloads
    const reloaded = new DownloadHistory(tmpDir);
    assert.equal(reloaded.has(hash), true);
    assert.equal(reloaded.getHashes().length, 1);
    assert.equal(reloaded.getHashes()[0], hash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DownloadHistory seeds from archive and torrent instances safely', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-history-seed-test-'));
  try {
    const history = new DownloadHistory(tmpDir);
    const hash1 = '1111111111222222222233333333334444444444';
    const hash2 = '5555555555666666666677777777778888888888';

    const fakeArchive = {
      getAll: () => [
        {
          infoHash: hash1,
          name: 'The Dark Knight',
          savedAt: Date.now() - 5000,
          length: 1500000000,
        },
      ],
    };

    history.seedFromArchive(fakeArchive);
    assert.equal(history.has(hash1), true);

    const fakeTorrents = [
      { infoHash: hash2, name: 'Interstellar', done: true, length: 3000000000 },
      { infoHash: '9999999999000000000011111111112222222222', name: 'Unfinished', done: false, progress: 0.2 },
    ];

    history.seedFromTorrents(fakeTorrents);
    assert.equal(history.has(hash2), true);
    assert.equal(history.has('9999999999000000000011111111112222222222'), false);

    // Deleting does not remove from memory/disk unless explicitly called
    assert.equal(history.getAll().length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DownloadHistory rejects invalid hashes gracefully', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-history-invalid-test-'));
  try {
    const history = new DownloadHistory(tmpDir);
    assert.equal(history.record(null), false);
    assert.equal(history.record({}), false);
    assert.equal(history.record({ infoHash: 'not-a-hash' }), false);
    assert.equal(history.has(null), false);
    assert.equal(history.has(''), false);
    assert.equal(history.get('invalid'), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DownloadHistory accurately enriches search items with downloaded status and preserves past downloads across torrent deletion', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-history-search-test-'));
  try {
    const history = new DownloadHistory(tmpDir);
    const hash = 'abcdef0123456789abcdef0123456789abcdef01';
    history.record({
      infoHash: hash,
      name: 'Oppenheimer (2023) 2160p UHD BluRay x265',
      magnetURI: `magnet:?xt=urn:btih:${hash}&dn=Oppenheimer`,
      length: 15000000000,
    });

    // Simulating active torrents where the torrent was deleted from Svorrent client:
    const activeTorrents = [];
    const completedHashes = new Set(
      activeTorrents.filter((t) => t.done || t.progress === 1).map((t) => t.infoHash.toLowerCase())
    );

    const searchResults = [
      {
        title: 'Oppenheimer 2023 2160p UHD BluRay x265',
        size: '14.0 GB',
        infoHash: hash,
      },
      {
        title: 'Barbie 2023 1080p WEB-DL',
        size: '2.5 GB',
        infoHash: '9999999999999999999999999999999999999999',
      },
    ];

    const enriched = searchResults.map((item) => {
      const h = (item.infoHash || '').toLowerCase();
      return {
        ...item,
        downloaded: Boolean((h && completedHashes.has(h)) || history.has(h, item.title, item.size)),
      };
    });

    assert.equal(enriched[0].downloaded, true);
    assert.equal(enriched[1].downloaded, false);

    // Historical magnet retrieval for re-download
    const item = history.get(enriched[0].infoHash);
    assert.equal(item.magnetURI, `magnet:?xt=urn:btih:${hash}&dn=Oppenheimer`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
