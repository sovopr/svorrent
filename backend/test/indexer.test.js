import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInfoHash,
  formatMagnetUri,
  formatBytes,
  resolveMagnet,
  searchFederated,
  sanitizeSwarmCount,
  decodeHtmlEntities,
} from '../lib/indexer.js';

test('extractInfoHash extracts 40-char hex hash from magnet URI or raw string', () => {
  const hash = 'cfdd00ae7bb73ddbaa0531c5b14087324295e701';
  assert.equal(extractInfoHash(hash), hash);
  assert.equal(extractInfoHash(hash.toUpperCase()), hash);
  assert.equal(extractInfoHash(`magnet:?xt=urn:btih:${hash}&dn=Ubuntu`), hash);
  assert.equal(extractInfoHash('magnet:?xt=urn:btih:4D4ED4C0F0C04718849DA90FE1DF9F5BAF184A0E&dn=Test'), '4d4ed4c0f0c04718849da90fe1df9f5baf184a0e');
  assert.equal(extractInfoHash('not a magnet'), '');
  assert.equal(extractInfoHash(''), '');
  assert.equal(extractInfoHash(null), '');
});

test('sanitizeSwarmCount masks 64-bit flag overflow and negative underflows', () => {
  // 4294967301 is 2^32 + 5 (BitSearch packed internal 64-bit flag bit 32)
  assert.equal(sanitizeSwarmCount('4294967301'), 5);
  // 4294967614 is 2^32 + 318
  assert.equal(sanitizeSwarmCount('4294967614'), 318);
  // Standard swarm numbers
  assert.equal(sanitizeSwarmCount(586), 586);
  assert.equal(sanitizeSwarmCount('12'), 12);
  // Negative and zeroes
  assert.equal(sanitizeSwarmCount(0), 0);
  assert.equal(sanitizeSwarmCount('-10'), 0);
  assert.equal(sanitizeSwarmCount(null), 0);
  // Absurd counts beyond reasonable swarm ceiling
  assert.equal(sanitizeSwarmCount(1000000), 0);
});

test('decodeHtmlEntities decodes XML/HTML entity escaped characters', () => {
  assert.equal(decodeHtmlEntities('Dune &amp; Part Two'), 'Dune & Part Two');
  assert.equal(decodeHtmlEntities('It&#039;s a Wonderful Life'), "It's a Wonderful Life");
  assert.equal(decodeHtmlEntities('&quot;Inception&quot;'), '"Inception"');
  assert.equal(decodeHtmlEntities(''), '');
});

test('formatMagnetUri generates valid magnet link with trackers', () => {
  const hash = 'cfdd00ae7bb73ddbaa0531c5b14087324295e701';
  const name = 'Ubuntu 24.04 Desktop';
  const uri = formatMagnetUri(hash, name);

  assert.ok(uri.startsWith('magnet:?xt=urn:btih:cfdd00ae7bb73ddbaa0531c5b14087324295e701'));
  assert.ok(uri.includes('&dn=Ubuntu%2024.04%20Desktop'));
  assert.ok(uri.includes('&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'));
});

test('formatMagnetUri handles missing or empty input safely', () => {
  assert.equal(formatMagnetUri(''), '');
  assert.equal(formatMagnetUri(null), '');
  assert.equal(formatMagnetUri(undefined), '');
});

test('formatBytes formats binary byte sizes accurately', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-100), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1572864), '1.5 MB');
  assert.equal(formatBytes(1073741824), '1.0 GB');
  assert.equal(formatBytes(13207024435), '12.3 GB');
});

test('resolveMagnet returns valid magnet without extra network calls when already present', async () => {
  const existing = 'magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678&dn=Test';
  const resolved = await resolveMagnet({ magnet: existing });
  assert.equal(resolved, existing);
});

test('resolveMagnet constructs magnet from infoHash and title', async () => {
  const hash = '1234567890abcdef1234567890abcdef12345678';
  const resolved = await resolveMagnet({ infoHash: hash, title: 'Test Download' });
  assert.ok(resolved.startsWith(`magnet:?xt=urn:btih:${hash}`));
  assert.ok(resolved.includes('&dn=Test%20Download'));
});

test('searchFederated returns empty array when query is empty or whitespace', async () => {
  assert.deepEqual(await searchFederated(''), []);
  assert.deepEqual(await searchFederated('   '), []);
  assert.deepEqual(await searchFederated(null), []);
});
