// Deterministic dataset generator for the performance harness.
//
// All three libraries under test (timeseries.js, uPlot, Chart.js) are fed the
// same (t, v) stream so that differences in TTFR and heap reflect the
// libraries, not the input. Two pieces enforce that:
//
//   * `seed` feeds a numeric-LCG RNG (Numerical Recipes constants). Same seed,
//     same series, on every run, on every machine. No Date.now(), no Math.random().
//   * `interval` and `start` are fixed and exported so a test can compare the
//     exact same slice in the browser harness (where the dataset is generated
//     in-page from the same LCG constants).
//
// The output is a `{ t, v }` array — point-series shape, the simplest common
// denominator all three libraries accept without per-library wrapping. For
// timeseries.js it gets wrapped into a `multiline` block in the bench runner.
//
// `v` is a sine wave with period ~200 points plus ±10 noise — visually rich
// (peaks and troughs to render) but smooth enough that LTTB-style downsampling
// cannot eat entire features.

const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const RNG_MODULUS = 0x100000000;

export const EPOCH_START = Math.floor(Date.UTC(2026, 0, 1) / 1000); // seconds
export const DEFAULT_INTERVAL = 60; // 1-minute resolution, like the live demo
export const DEFAULT_SEED = 42;

/**
 * Generate `points` (t, v) pairs.
 *
 * @param {object} opts
 * @param {number} opts.points   Number of points to generate.
 * @param {number} [opts.seed]   LCG seed — keep identical across libraries.
 * @param {number} [opts.interval] Seconds between points.
 * @param {number} [opts.start]  Epoch seconds of the first point.
 * @returns {{ t: number, v: number }[]}
 */
export function generate({ points, seed = DEFAULT_SEED, interval = DEFAULT_INTERVAL, start = EPOCH_START }) {
  const out = new Array(points);
  let rng = seed >>> 0;
  for (let i = 0; i < points; i++) {
    rng = (rng * LCG_MULTIPLIER + LCG_INCREMENT) >>> 0;
    const noise = (rng / RNG_MODULUS) - 0.5;
    out[i] = {
      t: start + i * interval,
      v: 50 + 25 * Math.sin(i / 200) + noise * 20,
    };
  }
  return out;
}

/**
 * The default size ladder. 1k / 10k / 100k covers the regime where the three
 * libraries start to separate visibly. 1M is reserved for the micro-bench
 * (where the canvas drawing itself is no-op'd); the browser bench skips it
 * because Chromium's per-tab memory ceiling makes 1M points + three libraries
 * at once fragile, and we want one clean number per cell, not OOMs.
 */
export const SIZES_BROWSER = [1000, 10000, 100000];
export const SIZES_MICRO = [1000, 10000, 100000, 1000000];

/**
 * Wrap a (t, v) array into the binned scalar block the timeseries.js
 * source protocol expects. `interval` matches the points' spacing so every
 * point lands in its own slot.
 */
export function toBinnedBlock(series, { name = 'bench', interval = DEFAULT_INTERVAL, start = EPOCH_START } = {}) {
  // Explicit min/max loop — spreading a million-element array through Math.min
  // blows the argument limit on V8 (range error), and reduce is clearer anyway.
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < series.length; i++) {
    const v = series[i].v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const data = {};
  for (let i = 0; i < series.length; i++) data[i] = { s1: series[i].v };
  return {
    name,
    type: 'multiline',
    interval_start: start,
    interval,
    count: series.length,
    min: min - 1,
    max: max + 1,
    data,
  };
}