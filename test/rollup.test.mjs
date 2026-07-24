// rollupBinned(): derives a coarser resolution tier from a binned block, so a
// consumer holding one high-resolution block can feed the core's cross-fade.
// Pure — no DOM, no TimeSeries instance.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rollupBinned } = await import('../src/rollup.js');

// 12 one-minute slots starting on an hour boundary; two series.
function fine(startS = 3600) {
  const data = {};
  for (let i = 0; i < 12; i++) data[i] = { a: i + 1, b: 10 };
  return {
    type: 'multibar', name: 'src',
    interval: 60, interval_start: startS, interval_end: startS + 12 * 60,
    count: 12, min: 1, max: 12, data,
  };
}

test('sum is the default aggregation', () => {
  const out = rollupBinned(fine(), 720);          // 12 minutes → one bucket
  assert.equal(out.interval, 720);
  assert.equal(out.count, 1);
  assert.equal(out.data[0].a, 78);                // 1+2+…+12
  assert.equal(out.data[0].b, 120);               // 12 × 10
});

test('mean, max and min aggregate as named', () => {
  assert.equal(rollupBinned(fine(), 720, { agg: 'mean' }).data[0].a, 6.5);
  assert.equal(rollupBinned(fine(), 720, { agg: 'max' }).data[0].a, 12);
  assert.equal(rollupBinned(fine(), 720, { agg: 'min' }).data[0].a, 1);
});

test('a function agg sees the whole bucket, its series id and its slot', () => {
  const seen = [];
  const out = rollupBinned(fine(), 720, {
    agg: (values, seriesId, slot) => { seen.push([values.length, seriesId, slot]); return values.length; },
  });
  assert.equal(out.data[0].a, 12);
  assert.deepEqual(seen.sort(), [[12, 'a', 0], [12, 'b', 0]].sort());
});

test('mean divides by the fine slots present, not by the bucket ratio', () => {
  // Only two of the twelve minute slots carry data.
  const sparse = fine();
  sparse.data = { 0: { a: 10 }, 5: { a: 20 } };
  assert.equal(rollupBinned(sparse, 720, { agg: 'mean' }).data[0].a, 15);
});

test('coarse buckets are gridded on absolute epoch time, not on slot 0', () => {
  // Block starts at 08:10; hourly buckets must still start at 08:00, so the
  // grid of a neighbouring block fetched from 08:40 lines up with this one.
  const start = 8 * 3600 + 600;
  const out = rollupBinned(fine(start), 3600);
  assert.equal(out.interval_start, 8 * 3600);
  assert.equal(out.interval_start % 3600, 0);
});

test('slots spanning a coarse boundary land in separate buckets', () => {
  // 12 minutes from 08:55 → 5 slots in the 08:00 hour, 7 in the 09:00 hour.
  const out = rollupBinned(fine(8 * 3600 + 55 * 60), 3600);
  assert.equal(out.count, 2);
  assert.equal(out.data[0].a, 1 + 2 + 3 + 4 + 5);
  assert.equal(out.data[1].a, 6 + 7 + 8 + 9 + 10 + 11 + 12);
});

test('min/max/count/interval_end describe the coarse block, not the fine one', () => {
  const out = rollupBinned(fine(), 360);          // 6 minutes per bucket → 2
  assert.equal(out.count, 2);
  assert.equal(out.interval_end, 3600 + 2 * 360);
  assert.equal(out.min, 21);                      // bucket 0, series a: 1+…+6
  assert.equal(out.max, 60);                      // either bucket, series b: 6 × 10
  assert.equal(out.data[1].a, 57);                // bucket 1, series a: 7+…+12
});

test('descriptive metadata is carried, render state is not', () => {
  const src = fine();
  src.series_colors = { a: '#ff0000' };
  src.series_directions = { b: 'down' };
  src._fade = 0.3;
  src.intervals = 12;
  const out = rollupBinned(src, 720);
  assert.equal(out.name, 'src');
  assert.equal(out.type, 'multibar');
  assert.deepEqual(out.series_colors, { a: '#ff0000' });
  assert.deepEqual(out.series_directions, { b: 'down' });
  assert.equal(out._fade, undefined);
  assert.equal(out.intervals, undefined);
});

test('the input block is not mutated', () => {
  const src = fine();
  const before = JSON.parse(JSON.stringify(src));
  rollupBinned(src, 720, { agg: 'mean' });
  assert.deepEqual(JSON.parse(JSON.stringify(src)), before);
});

test('null for anything outside the binned scalar shape', () => {
  assert.equal(rollupBinned(fine(), 90), null, 'not an integer multiple');
  assert.equal(rollupBinned(fine(), 30), null, 'finer than the source');
  assert.equal(rollupBinned(fine(), 720, { agg: 'nope' }), null, 'unknown agg');
  assert.equal(rollupBinned(null, 720), null);
  assert.equal(rollupBinned({ category: 'point', data: [], interval: 60 }, 720), null);
  assert.equal(rollupBinned({ category: 'span', data: [], interval: 60 }, 720), null);

  // quantile-bands hold an array per series and need percentile-aware folding.
  const bands = fine();
  bands.type = 'quantile-bands';
  bands.data = { 0: { a: [1, 2, 3] } };
  assert.equal(rollupBinned(bands, 720), null);
});

test('an equal interval is a legal (identity-grained) rollup', () => {
  const out = rollupBinned(fine(), 60);
  assert.equal(out.interval, 60);
  assert.equal(out.data[0].a, 1);
  assert.equal(out.count, 12);
});
