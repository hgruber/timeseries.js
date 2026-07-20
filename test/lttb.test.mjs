// lttb.js (Largest Triangle Three Buckets downsampling) had no tests. The
// algorithm's contract is: never more than `threshold` points, always keep the
// first and last, keep them in order, and preserve visual extremes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lttb } from '../src/lttb.js';

// A PointSeries: [{ t, values: { v } }, …]
const series = (vals, key = 'v') =>
  vals.map((v, i) => ({ t: i * 1000, values: { [key]: v } }));

const sine = n =>
  series(Array.from({ length: n }, (_, i) => Math.sin(i / 5) * 100));

test('a series shorter than the threshold is returned unchanged', () => {
  const pts = sine(10);
  assert.deepEqual(lttb(pts, 50), pts);
});

test('the result is a copy, not the original array', () => {
  const pts = sine(10);
  const out = lttb(pts, 50);
  assert.notEqual(out, pts, 'must not hand back the caller\'s array');
  assert.deepEqual(out, pts);
});

test('a threshold below 2 is refused and returns everything', () => {
  const pts = sine(100);
  assert.equal(lttb(pts, 1).length, 100);
  assert.equal(lttb(pts, 0).length, 100);
});

test('downsampling yields exactly `threshold` points', () => {
  const pts = sine(1000);
  for (const n of [2, 10, 100, 500])
    assert.equal(lttb(pts, n).length, n, `threshold ${n}`);
});

test('the first and last point are always kept', () => {
  const pts = sine(1000);
  const out = lttb(pts, 50);
  assert.equal(out[0], pts[0]);
  assert.equal(out[out.length - 1], pts[pts.length - 1]);
});

test('output stays sorted ascending by t', () => {
  const out = lttb(sine(1000), 77);
  for (let i = 1; i < out.length; i++)
    assert.ok(out[i].t > out[i - 1].t, `not ascending at index ${i}`);
});

test('every output point is one of the input points, unmodified', () => {
  const pts = sine(500);
  const set = new Set(pts);
  for (const p of lttb(pts, 60))
    assert.ok(set.has(p), 'lttb must select points, never synthesise them');
});

test('an isolated spike survives downsampling', () => {
  // Flat line with one tall spike in the middle — the whole point of LTTB is
  // that this does not get averaged away.
  const vals = new Array(500).fill(10);
  vals[250] = 9999;
  const out = lttb(series(vals), 20);
  assert.ok(out.some(p => p.values.v === 9999), 'the spike was dropped');
});

test('an explicit seriesId selects which series drives the sampling', () => {
  const pts = Array.from({ length: 300 }, (_, i) => ({
    t: i * 1000,
    values: { flat: 1, spiky: i === 150 ? 9999 : 0 },
  }));
  const out = lttb(pts, 20, 'spiky');
  assert.ok(out.some(p => p.values.spiky === 9999),
    'sampling on "spiky" should retain its spike');
});

test('null values are skipped rather than treated as zero', () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({
    t: i * 1000,
    values: { v: i % 3 === 0 ? null : 50 },
  }));
  const out = lttb(pts, 20);
  assert.equal(out.length, 20);
  // First and last are kept verbatim regardless of being null.
  assert.equal(out[0], pts[0]);
  assert.equal(out[out.length - 1], pts[pts.length - 1]);
});

test('threshold equal to the input length returns everything', () => {
  const pts = sine(100);
  assert.equal(lttb(pts, 100).length, 100);
});
