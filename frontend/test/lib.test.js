import assert from 'node:assert/strict';
import test from 'node:test';
import { getPageNumbers, progressPercent } from '../src/lib.js';

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
