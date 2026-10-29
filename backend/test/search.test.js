import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQueries, filterAndDeduplicateResults } from '../lib/search.js';

test('buildSearchQueries creates prefix wildcard variants for terms with >= 3 chars', () => {
  assert.deepEqual(buildSearchQueries('inters'), ['inters', 'inters*']);
  assert.deepEqual(buildSearchQueries('aveng 1080p'), ['aveng 1080p', 'aveng* 1080p*']);
  assert.deepEqual(buildSearchQueries('in'), ['in']);
  assert.deepEqual(buildSearchQueries('inters*'), ['inters*']);
  assert.deepEqual(buildSearchQueries('   '), []);
  assert.deepEqual(buildSearchQueries(null), []);
});

test('filterAndDeduplicateResults filters scraper placeholders and sorts by seeds', () => {
  const rawResults = [
    {
      title: 'No results returned',
      id: '0',
      size: '0 B',
      seeds: 0,
      peers: 0,
    },
    {
      title: 'Interstellar (2014) 720p',
      size: '1.1 GB',
      seeds: '134',
      peers: '17',
    },
    {
      title: 'Interstellar (2014) 1080p',
      size: '2.4 GB',
      seeds: '944',
      peers: '117',
    },
    {
      // Duplicate of the 1080p result from a different query variant
      title: 'Interstellar (2014) 1080p',
      size: '2.4 GB',
      seeds: '944',
      peers: '117',
    },
    {
      title: 'no results found',
      size: '',
      seeds: 0,
    },
  ];

  const filtered = filterAndDeduplicateResults(rawResults);

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].title, 'Interstellar (2014) 1080p');
  assert.equal(filtered[0].seeds, '944');
  assert.equal(filtered[1].title, 'Interstellar (2014) 720p');
  assert.equal(filtered[1].seeds, '134');
});
