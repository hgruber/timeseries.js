// intervals.js had no tests despite being pure, self-contained functions.
// The first four cases are the worked examples documented in the file header
// (src/intervals.js:12-15) — pinning them means the header can no longer drift
// away from the implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  intervalSubtract, intervalInvert, intervalIntersect,
  intervalAdd, intervalLength, getWeek,
} from '../src/intervals.js';

const A = [[1, 3], [8, 10], [17, 20]];
const B = [[2, 11], [14, 15]];

// ── The documented examples ───────────────────────────────────────────────────
test('intervalAdd matches the example in the file header', () => {
  assert.deepEqual(intervalAdd(A, B), [[1, 11], [14, 15], [17, 20]]);
});

test('intervalSubtract matches the example in the file header', () => {
  assert.deepEqual(intervalSubtract(A, B), [[1, 2], [17, 20]]);
});

test('intervalIntersect matches the example in the file header', () => {
  assert.deepEqual(intervalIntersect(A, B), [[2, 3], [8, 10]]);
});

test('intervalLength matches the example in the file header', () => {
  assert.equal(intervalLength(A), 7);
});

// ── intervalSubtract ──────────────────────────────────────────────────────────
test('subtracting a disjoint interval changes nothing', () => {
  assert.deepEqual(intervalSubtract([[1, 5]], [[10, 20]]), [[1, 5]]);
});

test('subtracting an enclosing interval empties the result', () => {
  assert.deepEqual(intervalSubtract([[3, 7]], [[1, 10]]), []);
});

test('subtracting from the middle splits one interval into two', () => {
  assert.deepEqual(intervalSubtract([[0, 10]], [[4, 6]]), [[0, 4], [6, 10]]);
});

test('subtracting an exactly touching interval is a no-op', () => {
  // [5,10] starts where [0,5] ends — they share only the boundary point.
  assert.deepEqual(intervalSubtract([[0, 5]], [[5, 10]]), [[0, 5]]);
});

test('subtracting undefined operands yields an empty result', () => {
  assert.deepEqual(intervalSubtract(undefined, B), []);
  assert.deepEqual(intervalSubtract(A, undefined), []);
});

// ── intervalIntersect ─────────────────────────────────────────────────────────
test('intersecting disjoint sets is empty', () => {
  assert.deepEqual(intervalIntersect([[1, 3]], [[5, 8]]), []);
});

test('intersecting identical sets returns the set', () => {
  assert.deepEqual(intervalIntersect([[2, 6]], [[2, 6]]), [[2, 6]]);
});

test('intersecting a subset returns the subset', () => {
  assert.deepEqual(intervalIntersect([[0, 10]], [[3, 4]]), [[3, 4]]);
});

// ── intervalInvert ────────────────────────────────────────────────────────────
test('inverting a single interval gives the two open-ended sides', () => {
  const inv = intervalInvert([[0, 10]]);
  assert.equal(inv.length, 2);
  assert.equal(inv[0][0], Number.NEGATIVE_INFINITY);
  assert.equal(inv[0][1], 0);
  assert.equal(inv[1][0], 10);
  assert.equal(inv[1][1], Number.POSITIVE_INFINITY);
});

test('inverting an empty set gives the whole line', () => {
  assert.deepEqual(intervalInvert([]),
    [[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]]);
});

// ── intervalAdd ───────────────────────────────────────────────────────────────
test('adding overlapping intervals merges them', () => {
  assert.deepEqual(intervalAdd([[1, 5]], [[3, 8]]), [[1, 8]]);
});

test('adding disjoint intervals keeps both, sorted', () => {
  assert.deepEqual(intervalAdd([[10, 12]], [[1, 3]]), [[1, 3], [10, 12]]);
});

// ── intervalLength ────────────────────────────────────────────────────────────
test('intervalLength sums the spans and is zero for an empty set', () => {
  assert.equal(intervalLength([]), 0);
  assert.equal(intervalLength([[5, 5]]), 0);
  assert.equal(intervalLength([[0, 2], [10, 13]]), 5);
});

// ── getWeek (ISO 8601) ────────────────────────────────────────────────────────
test('getWeek returns the ISO week number', () => {
  // 1 Jan 2026 is a Thursday, so it belongs to week 1 of 2026.
  assert.equal(getWeek(new Date(2026, 0, 1)), 1);
  // 1 Jan 2021 is a Friday — ISO puts it in week 53 of the previous year.
  assert.equal(getWeek(new Date(2021, 0, 1)), 53);
  assert.equal(getWeek(new Date(2026, 0, 5)), 2);
});

test('getWeek counts up to 52 or 53 across a whole year', () => {
  assert.equal(getWeek(new Date(2026, 11, 31)), 53); // 2026 is a 53-week year
  assert.equal(getWeek(new Date(2025, 11, 31)), 1);  // rolls into week 1 of 2026
});

test('getWeek is stable for every day of a week', () => {
  // Mon 11 May 2026 through Sun 17 May 2026 must all report the same week.
  const wk = getWeek(new Date(2026, 4, 11));
  for (let i = 1; i < 7; i++)
    assert.equal(getWeek(new Date(2026, 4, 11 + i)), wk, `day offset ${i}`);
});
