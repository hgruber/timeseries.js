// Micro-bench: CPU-time per `plotAll()` call on timeseries.js.
//
// Uses the same DOM stub as the unit tests (test/helpers/dom.mjs). The 2d
// context there is a Proxy that turns every drawing call into a no-op —
// which is exactly what we want here: we measure the cost the *library*
// pays (data iteration, axis math, prepare_grid, renderer's own loop),
// not what the canvas backend pays. Comparing this across libraries would
// not be fair (the stub's no-op context is unique to our test bench), so
// the cross-library comparison lives in benchmark/browser/ instead.
//
// Output shape: a flat array of { points, run, ms } — `run` is 1..RUNS.
// Aggregation (median, comparison table) is done by run.mjs after the
// micro-bench finishes, so the raw numbers stay available for post-hoc
// analysis.

import { installDOM, makeCanvas, setView } from '../../test/helpers/dom.mjs';
import { generate, toBinnedBlock, SIZES_MICRO, EPOCH_START } from '../shared/datasets.mjs';

const RUNS = 5;        // median over 5; first run is JIT-warmup so we discard it
const CANVAS_W = 1000;
const CANVAS_H = 400;

installDOM();

const { default: TimeSeries } = await import('../../src/timeseries.js');
const { registerSource } = await import('../../src/sources.js');

/**
 * Build a self-contained TimeSeries instance driven by an in-memory source.
 *
 * The source's `init` pushes a single binned block when `getViewport` fires
 * (which the library calls once during construction). After that, no further
 * polling — the bench controls the loop by calling `ts.zoom()` to re-trigger
 * `plotAll()`, not by redrawing via setTimeout, so a slow library cannot
 * starve the bench timer.
 */
async function buildInstance(points) {
  const id = 'bench-' + points;
  makeCanvas(id, CANVAS_W, CANVAS_H);
  const series = generate({ points });
  const block = toBinnedBlock(series);
  let push = null;
  const sourceType = 'bench-' + id;
  registerSource({
    type: sourceType,
    init(_s, cb) {
      push = p => cb.pushData(p);
      // Synchronous push on the first viewport query — mirrors what a
      // synchronously-serving source (or the artificial demo) does.
      push(block);
    },
  });
  const ts = new TimeSeries({
    canvas: id,
    sources: [{ 'source-type': sourceType }],
    initialView: null,
  });
  await setView(ts, EPOCH_START * 1000, (EPOCH_START + points * 60) * 1000);
  return ts;
}

/**
 * Time a single `plotAll()` invocation.
 *
 * `ts.redraw()` is the public, synchronous repaint hook (a thin wrapper
 * around the closure-internal `plotAll()`; see src/timeseries.js:3195).
 * It runs the full render path synchronously — no animation, no
 * setTimeout — so `process.hrtime.bigint()` brackets exactly the work we
 * want to measure: prepare_grid + every renderer's draw().
 *
 * We can't use `ts.zoom()`: that path schedules an animation and only
 * repaints on tick, so `process.hrtime` would bracket the schedule call
 * (microseconds), not the render.
 */
async function timeOnePlot(ts) {
  const start = process.hrtime.bigint();
  ts.redraw();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6; // ns → ms
}

const results = [];
for (const points of SIZES_MICRO) {
  const ts = await buildInstance(points);
  // Warmup: first run is JIT-warmup and one-shot data prep, skip it.
  await timeOnePlot(ts);
  const runs = [];
  for (let r = 1; r <= RUNS; r++) {
    runs.push(await timeOnePlot(ts));
  }
  results.push({ points, runs });
}

// JSON output — one line, machine-readable. Aggregated report is computed
// by run.mjs and printed to stdout (so the human reading CI logs sees
// numbers without having to open a file).
process.stdout.write(JSON.stringify({ bench: 'timeseries.micro', results }) + '\n');