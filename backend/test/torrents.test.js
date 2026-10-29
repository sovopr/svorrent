import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanMagnet, extractInfoHash } from '../lib/torrents.js';

const hash = '0123456789abcdef0123456789abcdef01234567';

test('normalizes hashes and preserves encoded magnet fields', () => {
  assert.equal(cleanMagnet(hash), `magnet:?xt=urn:btih:${hash}`);
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=A%26B&tr=udp%3A%2F%2Ftracker.example%2Fannounce`;
  assert.equal(new URLSearchParams(cleanMagnet(magnet).slice(8)).get('dn'), 'A&B');
  assert.equal(extractInfoHash(cleanMagnet(magnet)), hash);
});

test('rejects malformed info hashes', () => {
  assert.throws(() => cleanMagnet('magnet:?xt=urn:btih:invalid'), /Invalid torrent info hash/);
});
