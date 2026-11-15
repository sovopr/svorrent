import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanReleaseSearchQuery,
  filterSearchResults,
  getPageNumbers,
  getSearchFilterCounts,
  nextSortState,
  progressPercent,
  sortTorrentRows,
} from '../src/lib.js';

test('file progress stays in the valid 0–100% range', () => {
  assert.equal(progressPercent(-0.08), 0);
  assert.equal(progressPercent(0), 0);
  assert.equal(progressPercent(0.134), 13);
  assert.equal(progressPercent(1), 100);
  assert.equal(progressPercent(1.2), 100);
  assert.equal(progressPercent(NaN), 0);
});

test('getPageNumbers generates windowed pagination arrays for all page ranges', () => {
  // Small range <= 7 pages: full sequential list without ellipsis
  assert.deepEqual(getPageNumbers(1, 1), [1]);
  assert.deepEqual(getPageNumbers(1, 4), [1, 2, 3, 4]);
  assert.deepEqual(getPageNumbers(3, 7), [1, 2, 3, 4, 5, 6, 7]);

  // Large range > 7 pages: near beginning
  assert.deepEqual(getPageNumbers(1, 10), [1, 2, 3, 4, 5, '...', 10]);
  assert.deepEqual(getPageNumbers(4, 10), [1, 2, 3, 4, 5, '...', 10]);

  // Near end
  assert.deepEqual(getPageNumbers(7, 10), [1, '...', 6, 7, 8, 9, 10]);
  assert.deepEqual(getPageNumbers(10, 10), [1, '...', 6, 7, 8, 9, 10]);

  // In the middle
  assert.deepEqual(getPageNumbers(5, 10), [1, '...', 4, 5, 6, '...', 10]);
  assert.deepEqual(getPageNumbers(6, 12), [1, '...', 5, 6, 7, '...', 12]);
});

test('getSearchFilterCounts accurately tallies resolution and release tag filters', () => {
  const sample = [
    { title: 'The.Odyssey.2026.2160p.UHD.BluRay.Remux.HDR.HEVC-CiNEPHiLES', provider: 'extto.org', seeds: 7344 },
    { title: 'The.Odyssey.2026.1080p.WEB-DL.DDP5.1.DV.H265-GROUP', provider: '1337x', seeds: 120 },
    { title: 'The.Odyssey.2026.720p.BluRay.x264', provider: 'YTS', seeds: 0 },
    { title: 'The.Odyssey.2026.480p.DVDRip.XviD', provider: 'ThePirateBay', seeds: 5 },
    { title: 'Ubuntu 24.04.1 Desktop amd64 ISO', provider: 'LimeTorrents', seeds: 90 },
  ];

  const { qualityCounts, availableQualities, tagCounts } = getSearchFilterCounts(sample);
  assert.equal(qualityCounts.all, 5);
  assert.equal(qualityCounts['4k'], 1);
  assert.equal(qualityCounts['1080p'], 1);
  assert.equal(qualityCounts['720p'], 1);
  assert.equal(qualityCounts.sd, 1);
  assert.equal(availableQualities.sd, true);

  assert.equal(tagCounts.remux, 1);
  assert.equal(tagCounts.bluray, 2);
  assert.equal(tagCounts.webdl, 1);
  assert.equal(tagCounts.hdr, 1);
  assert.equal(tagCounts.dv, 1);
  assert.equal(tagCounts.hevc, 2);
  assert.equal(tagCounts.seeded, undefined);

  // Faceted counts narrow tag availability by selected quality while preserving availableQualities
  const sdFacet = getSearchFilterCounts(sample, { quality: 'sd' });
  assert.equal(sdFacet.availableQualities['4k'], true);
  assert.equal(sdFacet.tagCounts.remux, 0);
  assert.equal(sdFacet.tagCounts.hdr, 0);
});

test('filterSearchResults combines quality, multi-tag, and source filters', () => {
  const sample = [
    { title: 'The.Odyssey.2026.2160p.UHD.BluRay.Remux.HDR.HEVC-CiNEPHiLES', provider: 'extto.org', seeds: 7344 },
    { title: 'The.Odyssey.2026.2160p.WEB-DL.HEVC-PSA', provider: '1337x', seeds: 400 },
    { title: 'The.Odyssey.2026.1080p.BluRay.Remux.AVC', provider: 'extto.org', seeds: 0 },
  ];

  assert.equal(filterSearchResults(sample, { quality: '4k' }).length, 2);
  assert.deepEqual(
    filterSearchResults(sample, { quality: '4k', tags: ['remux', 'hdr'] }).map((r) => r.provider),
    ['extto.org'],
  );
  assert.equal(filterSearchResults(sample, { tags: ['remux'] }).length, 2);
  assert.equal(filterSearchResults(sample, { source: '1337x', quality: '4k' }).length, 1);
});

test('cleanReleaseSearchQuery and sortTorrentRows support Discover lookups and sorting', () => {
  assert.equal(cleanReleaseSearchQuery('The.Odyssey.2026.1080p.BluRay.HEVC.x265-BONE'), 'The Odyssey 2026');
  assert.equal(cleanReleaseSearchQuery('Avengers Endgame Encore (2026) 1080p WEBRip x265'), 'Avengers Endgame Encore 2026');
  assert.equal(cleanReleaseSearchQuery('MobLand S02E08 1080p AMZN WEB-DL DDP5.1'), 'MobLand S02E08');

  let sort = { key: 'relevance', dir: 'desc' };
  sort = nextSortState(sort, 'seeds');
  assert.deepEqual(sort, { key: 'seeds', dir: 'desc' });
  sort = nextSortState(sort, 'seeds');
  assert.deepEqual(sort, { key: 'seeds', dir: 'asc' });
  sort = nextSortState(sort, 'seeds');
  assert.deepEqual(sort, { key: 'relevance', dir: 'desc' });

  const sorted = sortTorrentRows(
    [
      { title: 'A', size: '500 MB', seeds: 10 },
      { title: 'B', size: '2.5 GB', seeds: 50 },
    ],
    { key: 'size', dir: 'desc' },
  );
  assert.deepEqual(sorted.map((x) => x.title), ['B', 'A']);
});
