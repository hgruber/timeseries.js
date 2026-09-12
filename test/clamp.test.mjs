// Outlier clamping ("Kappung") — the core side.
//
// One or a few values can own almost the whole y-axis and squash the rest of
// the data against the zero line. When the feature is on, prepare_grid detects
// the outlier group per block per window (clampOne/deriveClamp, renderers.js),
// stamps `plot._clamped = { up, down }` and overwrites the axis extent with
// `limit × _vscale`, where `limit = bulk / bulkFrac` is the value AT the plot
// edge — the bulk lands at clampBulkFrac of the plot height. Three consumers
// read the record: the extent scan, the renderer and the hit test. The ink
// policy is split by family (bars and glyphs fill to the edge under an
// arrowhead; the line/area family draws through the TRUE values and marks each
// clamped value with the arrowhead where its ink leaves the box — pinned in
// clamp-renderers.test.mjs). Default OFF: with it off, nothing about the
// extent, the paint or the hit test changes at all — the off-invariant section
// below pins that per shape.
//
// The arithmetic every expectation here is built from, with the defaults
// (factor 3, share 0.05, bulkFrac 0.8):
//   limit = bulk / bulkFrac             = bulk × 5/4
//   axis entry = limit × _vscale        (the value at the plot edge)
// so a stacked bulk of 30 clamps to an axis of exactly 37.5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { clampOne, deriveClamp, clampValue, clampY, collectClampSamples,
        POINT_RADIUS, CLAMP_HEAD_PX } = await import('../src/renderers.js');

// ── 1. The detection, unit level ─────────────────────────────────────────────

// The validated defaults, exactly what the constructor builds and shares as
// rctx.clamp.
const CP = { on: true, factor: 3, share: 0.05, bulkFrac: 0.8 };
// The plot-edge value a bulk of `b` clamps to: limit = bulk / bulkFrac.
const lim = b => b / CP.bulkFrac;

// clampOne sorts in place; every test passes a fresh array, but the copy keeps
// a future implementation change from turning a passing test into a trap.
const one = (arr, cp = CP) => clampOne(arr.slice(), cp);

test('the top group clamps at limit = bulk / bulkFrac', () => {
  // 12 bulk slots of 30 and one spike of 320 (the multibar fixture below):
  // share 0.05 of 4 samples → K = 1, so the group is the single top sample and
  // the bulk is arr[1] = 30, the max of the rest.
  assert.deepEqual(one([320, 30, 30, 30]), { bulk: 30, limit: lim(30) });
  assert.equal(lim(30), 37.5);
  // Order in the input is irrelevant — the detection sorts.
  assert.deepEqual(one([30, 320, 30, 30]), { bulk: 30, limit: lim(30) });
});

test('a group of near-equal spikes clamps together inside the share cap', () => {
  // Five equal spikes: they occupy the top K = 5 positions (share 0.45 of 12
  // samples), so the bulk is the first sample below the group — arr[5] = 30 —
  // and the top value clears factor × bulk by a wide margin.
  const spikes = [320, 320, 320, 320, 320, 30, 30, 30, 30, 30, 30, 30];
  assert.deepEqual(one(spikes, Object.assign({}, CP, { share: 0.45 })),
                   { bulk: 30, limit: lim(30) });
});

test('fewer than four samples declines to mean anything', () => {
  assert.equal(one([320, 30, 30]), null);
  assert.equal(one([320, 30]), null);
  assert.equal(one([]), null);
});

test('the bulk always keeps at least two samples (K ≤ n - 2)', () => {
  // share 0.75 of 4 samples → K = 3, so arr[3] would leave a one-sample bulk.
  // The detection declines entirely — there is no smaller k to fall back to:
  // the top group IS the top K, not "the fewest samples that could work".
  const cp = Object.assign({}, CP, { share: 0.75 });
  assert.equal(one([320, 160, 80, 20], cp), null);
  assert.equal(one([320, 160, 50, 20], cp), null);
  // The same shape with a share that keeps two samples below the group clamps.
  assert.deepEqual(one([320, 160, 50, 20],
                       Object.assign({}, cp, { share: 0.5, bulkFrac: 0.5 })),
                   { bulk: 50, limit: 100 });
});

test('a bulk of zero or less has no scale to clamp against', () => {
  // arr[1] = 0 fails the `bulk > 0` guard even though arr[0] > 3 × 0 holds.
  assert.equal(one([320, 0, 0, 0]), null);
  assert.equal(one([0, 0, 0, 0]), null);
});

test('the factor decides whether a ratio is an outlier group', () => {
  // A 2× spike is well inside factor 3 but outside factor 1.5.
  assert.equal(one([60, 30, 30, 30]), null);
  assert.deepEqual(one([60, 30, 30, 30], Object.assign({}, CP, { factor: 1.5 })),
                   { bulk: 30, limit: lim(30) });
});

test('a dominant spike over a dense tail clamps even without a gap in the top', () => {
  // The regression this rule was corrected for: the head is dense — 181, 117,
  // 112 … sit right under the 364, so no two NEIGHBOURING values inside the
  // top group are 3× apart and the old largest-k loop found nothing, leaving
  // the spike in charge of the axis. Under the top-K rule the tail decides:
  // n = 199, share 0.05 → K = 9, bulk = arr[9] = 73, and 364 > 3 × 73.
  // (Shape and numbers of the 1h tier of the real /plot.json this fixed.)
  const arr = [364, 181, 117, 112, 106, 97, 95, 84, 79, 73];
  while (arr.length < 199) arr.push(73);
  assert.deepEqual(one(arr), { bulk: 73, limit: lim(73) });
  assert.equal(lim(73), 91.25);
  // A dense tail that does NOT clear the factor keeps the axis honest — the
  // same shape scaled down (364 → 200, just above 2 × 73) declines.
  arr[0] = 200;
  assert.equal(one(arr), null);
});

test('deriveClamp detects both directions and null when neither has one', () => {
  assert.deepEqual(deriveClamp([320, 30, 30, 30], [1000, 10, 10, 10], CP), {
    up: { bulk: 30, limit: lim(30) },
    down: { bulk: 10, limit: lim(10) },
  });
  assert.equal(deriveClamp([], [], CP), null);
  // Only one side clamps: the other stays null, so the extent on that side is
  // untouched (pinned end to end by the down-outlier instance test below).
  assert.deepEqual(deriveClamp([10, 10, 10, 10], [1000, 10, 10, 10], CP), {
    up: null, down: { bulk: 10, limit: lim(10) },
  });
});

test('clampValue clamps in both directions and passes everything else through', () => {
  const cl = { up: { bulk: 30, limit: lim(30) }, down: { bulk: 10, limit: lim(10) } };
  assert.equal(clampValue(cl, 300), 37.5);
  assert.equal(clampValue(cl, -1000), -lim(10));
  assert.equal(clampValue(cl, 30), 30);
  assert.equal(clampValue(cl, -10), -10);
  assert.equal(clampValue(cl, 0), 0);
  assert.equal(clampValue(null, 300), 300);
});

test('clampY: a cut value sits at the shaft line, everything else passes through Y',
     () => {
  // The clamped-axis mapping of the standard fixture: limit 37.5 at the plot
  // edge, so Y(v) = 100 − (v / 37.5) × 100 on a 100px plot with margin.top 0
  // (the bulk line Y(30) = 20 = 0.8 of the plot height down from the edge).
  const rctx = {
    Y: v => 100 - (v / 37.5) * 100, ppv: 100 / 37.5,
    margin: { top: 0, left: 0, right: 0, bottom: 0 },
    plotWidth: 1000, plotHeight: 100,
  };
  const cl = { up: { bulk: 30, limit: lim(30) }, down: { bulk: 10, limit: lim(10) } };
  // A cut value sits CLAMP_HEAD px below the top edge (the arrowhead fills the
  // rest, apex at the edge) — pixel-clamped, not value-clamped.
  assert.equal(clampY(rctx, cl, 900), CLAMP_HEAD_PX);
  assert.equal(clampY(rctx, cl, 900), 9);
  // A deeply negative value mirrors to the bottom edge.
  assert.equal(clampY(rctx, cl, -1000), 100 - CLAMP_HEAD_PX);
  // Values the clamp did not touch pass through Y unchanged.
  assert.equal(clampY(rctx, cl, 30), 20);          // the bulk line
  assert.equal(clampY(rctx, cl, -12), 132);   // inside the down bulk
  assert.equal(clampY(rctx, cl, 0), 100);
  // No record: everything passes through.
  assert.equal(clampY(rctx, null, 900), -2300);
  // A record that only clamps up leaves negative values alone.
  assert.equal(clampY(rctx, { up: cl.up, down: null }, -750), 2100);
});

// ── 2. The sampling, unit level ──────────────────────────────────────────────
//
// collectClampSamples must measure exactly what the y-extent scan measures —
// the stack total for a stacked type, every series value otherwise, every
// array entry for a banded type — culled to the pixel window.

// X: 1px per second, interval 100 → a 100px bin; slot n starts at x = 100n.
const SAMPLE_RCTX = () => ({ X: t => t / 1000, ppms: 1 / 1000, hidden: new Set() });

test('a stacked type samples its per-slot stack totals', () => {
  const s = collectClampSamples({
    type: 'multibar', interval: 100, interval_start: 0,
    data: { 0: { a: 10, b: 20 }, 1: { a: 300, b: 20 } },
  }, 0, 1000, SAMPLE_RCTX());
  assert.deepEqual(s.ups.sort((a, b) => a - b), [30, 320]);
  assert.deepEqual(s.downs, []);
});

test('an unstacked type samples every series value, negatives magnified', () => {
  const s = collectClampSamples({
    type: 'multiline', interval: 100, interval_start: 0,
    data: { 0: { a: 10, b: -5 }, 1: { a: 300, b: -2 } },
  }, 0, 1000, SAMPLE_RCTX());
  assert.deepEqual(s.ups.sort((a, b) => a - b), [10, 300]);
  assert.deepEqual(s.downs.sort((a, b) => a - b), [2, 5]);
});

test('a binned ladder type samples every array entry', () => {
  const s = collectClampSamples({
    type: 'quantile-bands', interval: 100, interval_start: 0,
    data: { 0: { a: [1, 5, 9] } },
  }, 0, 1000, SAMPLE_RCTX());
  assert.deepEqual(s.ups, [1, 5, 9]);
  assert.deepEqual(s.downs, []);
});

test('hidden series contribute nothing', () => {
  const rctx = { X: t => t / 1000, ppms: 1 / 1000, hidden: new Set(['a']) };
  const s = collectClampSamples({
    type: 'multibar', interval: 100, interval_start: 0,
    data: { 0: { a: 10, b: 20 }, 1: { a: 300, b: 20 } },
  }, 0, 1000, rctx);
  assert.deepEqual(s.ups, [20, 20]);
});

test('point blocks sample one entry per series value', () => {
  const s = collectClampSamples({
    type: 'scatter', category: 'point',
    data: [{ t: 0, values: { a: 5, b: -3 } }, { t: 50000, values: { a: 300 } }],
  }, 0, 1000, SAMPLE_RCTX());
  assert.deepEqual(s.ups.sort((a, b) => a - b), [5, 300]);
  assert.deepEqual(s.downs, [3]);
});

test('cumulative, laned and span blocks contribute nothing at all', () => {
  const rctx = SAMPLE_RCTX();
  // waterfall: clamping a running total shifts the base of every later bar.
  assert.deepEqual(collectClampSamples({
    type: 'waterfall', interval: 100, interval_start: 0,
    data: { 0: { a: 10 }, 1: { a: 1000 } },
  }, 0, 1000, rctx), { ups: [], downs: [] });
  // heatmap: a lane axis has no magnitude to clamp against.
  assert.deepEqual(collectClampSamples({
    type: 'heatmap', interval: 100, interval_start: 0,
    data: { 0: { a: 1000 } },
  }, 0, 1000, rctx), { ups: [], downs: [] });
  // span blocks are excluded by category, before the type even matters.
  assert.deepEqual(collectClampSamples({
    type: 'gantt', category: 'span', tmin: 0, tmax: 1000, data: [],
  }, 0, 1000, rctx), { ups: [], downs: [] });
});

test('a skipped partial bin contributes nothing', () => {
  const plot = {
    type: 'multibar', interval: 100, interval_start: 0,
    data: { 0: { a: 10, b: 20 }, 1: { a: 300, b: 20 } },
    _partial: { slot: 1, frac: 0.05, scale: 0, skip: true },
  };
  const s = collectClampSamples(plot, 0, 1000, SAMPLE_RCTX());
  assert.deepEqual(s.ups, [30]);
});

test('bins at or past the right pixel edge contribute nothing', () => {
  // The right-edge cull is `>=`, matching the extent scan's strict
  // `slotTime < tmax`: a bin starting exactly at the window edge is not
  // measured by the axis, so it must not be sampled either.
  const plot = {
    type: 'multibar', interval: 100, interval_start: 0,
    data: { 0: { a: 10, b: 20 }, 1: { a: 300, b: 20 } },
  };
  assert.deepEqual(collectClampSamples(plot, 0, 99, SAMPLE_RCTX()).ups, [30]);
  assert.deepEqual(collectClampSamples(plot, 0, 100, SAMPLE_RCTX()).ups, [30]);
  assert.deepEqual(collectClampSamples(plot, 0, 101, SAMPLE_RCTX()).ups.sort(
    (a, b) => a - b), [30, 320]);
});

// ── 2. Through a real instance ───────────────────────────────────────────────

const START = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const SLOTS = 12;

// A multibar block: 12 bulk slots of {a:10, b:20} (stack total 30) with the
// slot indices in `outliers` replaced by {a:300, b:20} (stack 320). `max` is
// deliberately wrong, as in area-types.test.mjs: the extent is supposed to
// come from the slots in the viewport, so if the scan ever falls back to it
// the failure is loud instead of silent.
function barSource(extra, outliers, aVal) {
  const data = {};
  for (let i = 0; i < SLOTS; i++) data[i] = { a: 10, b: 20 };
  for (const o of outliers || []) data[o] = { a: aVal || 300, b: 20 };
  return Object.assign({
    'source-type': 'artificial', type: 'multibar', name: 'm',
    interval_start: START, interval: 3600, count: SLOTS,
    interval_end: START + SLOTS * 3600,
    data, min: 0, max: 999,
  }, extra);
}

let nextId = 0;
async function build(sources, opts, view) {
  const id = 'clamp-' + (nextId++);
  makeCanvas(id);
  const ts = new TimeSeries(Object.assign({
    canvas: id, sources, initialView: null,
  }, opts || {}));
  const full = [START * 1000, (START + SLOTS * 3600) * 1000];
  await setView(ts, (view || full)[0], (view || full)[1]);
  return ts;
}

const range = async (sources, opts, view) => {
  const ts = await build(sources, opts, view);
  return ts.getValueRange();
};

test('a stacked outlier clamps the axis to the bulk-stretched limit', async () => {
  // bulk 30 → limit = 30/0.8 = 37.5, the value AT the plot edge. Without the
  // clamp the axis would be 320.
  const { ymax } = await range([barSource({}, [5])], { clampOutliers: true });
  assert.equal(ymax, 30 / 0.8);
  assert.equal(ymax, 37.5);
});

test('with the feature off the axis stays at the true max', async () => {
  // (both the default and an explicit false — the off-invariant section below
  // pins this per shape; this one pins the ON/OFF pair for the same fixture.)
  const off = await range([barSource({}, [5])]);
  assert.equal(off.ymax, 320);
  const off2 = await range([barSource({}, [5])], { clampOutliers: false });
  assert.equal(off2.ymax, 320);
});

test('the factor decides whether a 2× spike is an outlier at all', async () => {
  // Stack 60 is 2× the bulk 30: inside factor 3 at the default, so the axis is
  // the true max; at factor 1.5 the same data clamps to 50.
  const src = [barSource({}, [5], 40)];
  const plain = await range(src, { clampOutliers: true });
  assert.equal(plain.ymax, 60);
  const loose = await range(src, { clampOutliers: true, clampOutliersFactor: 1.5 });
  assert.equal(loose.ymax, 37.5);
});

test('the share cap decides between 5 and 6 equal outliers', async () => {
  // 100 bulk slots of 30, N outliers of 320. K = max(1, floor(105 × 0.05)) = 5:
  // with five spikes the bulk below the group is 30 and the group clamps; a
  // sixth spike is arr[5] itself, so the top no longer clears factor × bulk
  // and the detection declines.
  const wideSource = (extra, nOut) => {
    const data = {};
    for (let i = 0; i < 100; i++) data[i] = { a: 10, b: 20 };
    for (let i = 0; i < nOut; i++) data[10 + i] = { a: 300, b: 20 };
    return Object.assign({
      'source-type': 'artificial', type: 'multibar', name: 'm',
      interval_start: START, interval: 3600, count: 100,
      interval_end: START + 100 * 3600, data, min: 0, max: 999,
    }, extra);
  };
  const view = [START * 1000, (START + 100 * 3600) * 1000];
  const five = await range([wideSource({}, 5)], { clampOutliers: true }, view);
  assert.equal(five.ymax, 37.5);
  const six = await range([wideSource({}, 6)], { clampOutliers: true }, view);
  assert.equal(six.ymax, 320);
});

test('descending outliers collapse onto the same limit', async () => {
  // Unstacked (multiline), so the samples are the per-series values: 98 bulk
  // slots of 10, one of 300 and one of 1000. Both spikes sit inside the top K
  // = 5, so the bulk is the 10s and BOTH clamp to limit = 10/0.8.
  const data = {};
  for (let i = 0; i < 100; i++) data[i] = { a: 10 };
  data[10] = { a: 300 };
  data[20] = { a: 1000 };
  const src = [Object.assign({
    'source-type': 'artificial', type: 'multiline', name: 'l',
    interval_start: START, interval: 3600, count: 100,
    interval_end: START + 100 * 3600, data, min: 0, max: 999,
  })];
  const ts = await build(src, { clampOutliers: true },
                         [START * 1000, (START + 100 * 3600) * 1000]);
  assert.deepEqual(ts.getActiveData()[0]._clamped, {
    up: { bulk: 10, limit: 10 / 0.8 }, down: null,
  });
  assert.ok(Math.abs(ts.getValueRange().ymax - 10 / 0.8) < 1e-9,
            'ymax ' + ts.getValueRange().ymax);
});

test('a down outlier clamps the axis below zero by its magnitude', async () => {
  const data = {};
  for (let i = 0; i < 100; i++) data[i] = { a: -10 };
  data[30] = { a: -1000 };
  const src = [Object.assign({
    'source-type': 'artificial', type: 'multiline', name: 'l',
    interval_start: START, interval: 3600, count: 100,
    interval_end: START + 100 * 3600, data, min: -999, max: 0,
  })];
  const ts = await build(src, { clampOutliers: true },
                         [START * 1000, (START + 100 * 3600) * 1000]);
  const cl = ts.getActiveData()[0]._clamped;
  assert.equal(cl.up, null);
  assert.equal(cl.down.limit, 10 / 0.8);
  // The ymin entry is a positive magnitude: limit, mirrored below zero by
  // prepare_grid's `ymin = -blend`.
  assert.equal(ts.getValueRange().ymin, -10 / 0.8);
  assert.equal(ts.getValueRange().ymax, 0);
});

test('a symmetric outlier pair clamps both ends onto the same limit', async () => {
  const data = {};
  for (let i = 0; i < 100; i++) data[i] = { a: 10, b: -10 };
  data[40] = { a: 1000, b: -10 };
  data[50] = { a: 10, b: -1000 };
  const src = [Object.assign({
    'source-type': 'artificial', type: 'multiline', name: 'l',
    interval_start: START, interval: 3600, count: 100,
    interval_end: START + 100 * 3600, data, min: -999, max: 999,
  })];
  const ts = await build(src, { clampOutliers: true },
                         [START * 1000, (START + 100 * 3600) * 1000]);
  const r = ts.getValueRange();
  assert.ok(Math.abs(r.ymax - 10 / 0.8) < 1e-9, 'ymax ' + r.ymax);
  assert.ok(Math.abs(r.ymin + 10 / 0.8) < 1e-9, 'ymin ' + r.ymin);
  assert.deepEqual(ts.getActiveData()[0]._clamped, {
    up: { bulk: 10, limit: 10 / 0.8 }, down: { bulk: 10, limit: 10 / 0.8 },
  });
});

// ── 3. The per-plot override, in both directions ─────────────────────────────

test('the per-plot flag switches clamping on without the global setting', async () => {
  const ts = await build([barSource({ clampOutliers: true }, [5])], {});
  assert.equal(ts.getValueRange().ymax, 37.5);
});

test('the per-plot flag switches clamping off under the global setting', async () => {
  const ts = await build([barSource({ clampOutliers: false }, [5])],
                         { clampOutliers: true });
  assert.equal(ts.getValueRange().ymax, 320);
  assert.equal(ts.getActiveData()[0]._clamped, undefined,
               'no record may be stamped for an opted-out block');
});

// ── 4. Visibility and windowing ──────────────────────────────────────────────

test('hiding the series carrying the outlier removes the clamp', async () => {
  const ts = await build([barSource({}, [5])], { clampOutliers: true });
  assert.equal(ts.getValueRange().ymax, 37.5, 'precondition: clamped');
  ts.setSeriesHidden('a', true);
  ts.redraw();
  // Only b remains: stack 20 per slot, no outlier group, true extent.
  assert.equal(ts.getValueRange().ymax, 20);
  assert.equal(ts.getActiveData()[0]._clamped, undefined);
});

test('the clamp follows the window: it appears and disappears with the outlier', async () => {
  const ts = await build([barSource({}, [11])], { clampOutliers: true });
  assert.equal(ts.getValueRange().ymax, 37.5, 'precondition: clamped');

  // Pan the outlier slot out of the window: the remaining slots are all bulk,
  // so the axis returns to the true max of what is visible. The window is
  // deliberately stopped mid-slot (10.5 h), not on slot 11's left edge, where
  // the boundary itself is its own case (unit-pinned above).
  await setView(ts, START * 1000, (START + 10.5 * 3600) * 1000);
  assert.equal(ts.getValueRange().ymax, 30);
  assert.equal(ts.getActiveData()[0]._clamped, undefined);

  // …and back in again.
  await setView(ts, START * 1000, (START + SLOTS * 3600) * 1000);
  assert.equal(ts.getValueRange().ymax, 37.5);
  assert.deepEqual(ts.getActiveData()[0]._clamped, {
    up: { bulk: 30, limit: 30 / 0.8 }, down: null,
  });
});

// ── 5. Exclusions ────────────────────────────────────────────────────────────

test('waterfall is excluded: the running-total extent survives an outlier', async () => {
  // Running total 10 + 5 - 8 + 1000 = 1007. Clamping a cumulative block would
  // shift the base of every later bar, so it is excluded by design — the
  // extent must be identical with the feature on.
  const wf = extra => {
    const data = { 0: { a: 10 }, 1: { a: 5 }, 2: { a: -8 }, 3: { a: 1000 } };
    return Object.assign({
      'source-type': 'artificial', type: 'waterfall', name: 'w',
      interval_start: START, interval: 3600, count: 4,
      interval_end: START + 4 * 3600, data, min: -999, max: 999,
    }, extra);
  };
  const on = await range([wf({ clampOutliers: true })], { clampOutliers: true });
  const off = await range([wf()]);
  assert.deepEqual(on, off);
  assert.equal(on.ymax, 1007);
  const ts = await build([wf({ clampOutliers: true })], { clampOutliers: true });
  assert.equal(ts.getActiveData()[0]._clamped, undefined,
               'no clamp record may be stamped for a cumulative block');
});

test('heatmap is excluded: the lane extent survives an outlier', async () => {
  // Two series → two lanes; the y axis is categorical, values only colour.
  const hm = extra => {
    const data = {};
    for (let i = 0; i < SLOTS; i++) data[i] = { a: 10, b: 20 };
    data[5] = { a: 5000, b: 20 };
    return Object.assign({
      'source-type': 'artificial', type: 'heatmap', name: 'h',
      interval_start: START, interval: 3600, count: SLOTS,
      interval_end: START + SLOTS * 3600, data, min: 0, max: 999,
    }, extra);
  };
  const on = await range([hm({ clampOutliers: true })], { clampOutliers: true });
  const off = await range([hm()]);
  assert.deepEqual(on, off);
  assert.equal(on.ymax, 2);
  const ts = await build([hm({ clampOutliers: true })], { clampOutliers: true });
  assert.equal(ts.getActiveData()[0]._clamped, undefined,
               'no clamp record may be stamped for a laned block');
});

// ── 6. Tiers and scales ──────────────────────────────────────────────────────

test('rollupBinned carries the per-plot toggle to the derived tier', () => {
  // Like name/series_colors, not like extensive/data_until: the toggle is
  // descriptive metadata of the signal, and one tier clamping while the other
  // does not would make the axis breathe through the cross-fade.
  assert.equal(TimeSeries.rollupBinned(barSource({ clampOutliers: true }), 7200)
               .clampOutliers, true);
  assert.equal(TimeSeries.rollupBinned(barSource({ clampOutliers: false }), 7200)
               .clampOutliers, false);
  assert.equal('clampOutliers' in
               TimeSeries.rollupBinned(barSource(), 7200), false);
});

test('the rate axis scales the clamped axis entry like any other', async () => {
  // An extensive block per minute: _vscale = 60/3600, so the clamped entry is
  // limit × _vscale = 37.5/60. Same fixture, same limit — only the axis unit
  // changed.
  const ts = await build(
    [barSource({ extensive: true, clampOutliers: true }, [5])],
    { clampOutliers: true });
  ts.setRateUnit(60);
  await setView(ts, START * 1000, (START + SLOTS * 3600) * 1000);
  const ymax = ts.getValueRange().ymax;
  assert.ok(Math.abs(ymax - 37.5 * (60 / 3600)) < 1e-9, 'ymax ' + ymax);
});

// ── 7. Coalescing ────────────────────────────────────────────────────────────

function areaSource(startSec, dataOver, extra) {
  const data = {};
  for (let i = 0; i < SLOTS; i++) data[i] = { a: 10, b: 20 };
  if (dataOver) Object.assign(data, dataOver);
  return Object.assign({
    'source-type': 'artificial', type: 'stackarea', name: 's',
    interval_start: startSec, interval: 3600, count: SLOTS,
    interval_end: startSec + SLOTS * 3600,
    data, min: 0, max: 999, clampOutliers: true,
  }, extra);
}

test('coalesced blocks draw and measure with the outlier block in the group', async () => {
  // Two abutting fetch blocks of one signal, the outlier in the newer one. The
  // merged block re-derives its clamp state from the merged data; the per-plot
  // flag on either member switches the group on. (The paint side is pinned in
  // clamp-renderers.test.mjs with a recording context.)
  const ts = await build([areaSource(START),
                          areaSource(START + SLOTS * 3600, { 5: { a: 300, b: 20 } })], {},
                         [START * 1000, (START + 2 * SLOTS * 3600) * 1000]);
  assert.equal(ts.getActiveData().length, 2, 'both blocks stay in data[]');
  assert.equal(ts.getValueRange().ymax, 37.5);
  const series = ts.getSeries().map(s => s.id).sort();
  assert.deepEqual(series, ['a', 'b']);
});

// ── 8. Hit testing ───────────────────────────────────────────────────────────
//
// The clamped band (bulk … limit) belongs to the series that straddles the
// limit; it answers with its RAW value plus `clamped: true`. A segment past
// the limit is not drawn, so it is not hittable, and above the plot edge the
// pointer finds nothing.

async function buildHit(extra) {
  const ts = await build([barSource(Object.assign({ clampOutliers: true }, extra), [5])],
                         { clampOutliers: true });
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const X = ms => ((ms - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth
                + area.margin.left;
  // ymin is 0 on every fixture here, so a value maps linearly into the plot box.
  const Y = v => area.margin.top + area.plotHeight * (1 - v / ts.getValueRange().ymax);
  let got = 'unset';
  ts.onHoverDataCallback((plot, n, key, value, clamped) => {
    got = { plot, n, key, value, clamped };
  });
  const hover = (ms, v) => ts.getCanvas().onmousemove({ clientX: X(ms), clientY: Y(v) });
  return { ts, hover, slot: n => (START + n * 3600 + 1800) * 1000, get got() { return got; } };
}

test('the clamped band answers with the raw value and clamped: true', async () => {
  const h = await buildHit();
  h.hover(h.slot(5), 35);            // between the bulk (30) and the edge (37.5)
  assert.equal(h.got.key, 'a');
  assert.equal(h.got.value, 300);    // the raw value, not the clamped height
  assert.equal(h.got.clamped, true);
  assert.equal(h.got.n, 5);
});

test('a series cut off entirely by the clamp is not hittable', async () => {
  // On the outlier slot, a consumes the whole headroom (50), so b has no ink
  // at all — the old arithmetic would have hit b at 50…70.
  const h = await buildHit();
  h.hover(h.slot(5), 55);            // past the plot edge
  assert.equal(h.got.key, null, 'no hit inside the head b used to own');
});

test('the bulk below the clamp line answers without the flag', async () => {
  const h = await buildHit();
  h.hover(h.slot(1), 10);            // a bulk slot: a sits at 0…10
  assert.equal(h.got.key, 'a');
  assert.equal(h.got.value, 10);
  assert.equal(h.got.clamped, false);
  h.hover(h.slot(1), 25);            // b sits at 10…30
  assert.equal(h.got.key, 'b');
  assert.equal(h.got.value, 20);
  assert.equal(h.got.clamped, false);
});

test('above the plot edge nothing is hit, like any empty space', async () => {
  const h = await buildHit();
  h.hover(h.slot(5), 55);            // the drawn stack stops at the edge (37.5)
  assert.equal(h.got.key, null);
  assert.ok(h.got.plot === null, 'the background fallback came back');
});

test('a clamped scatter marker is hittable just below the arrowhead', async () => {
  const T0 = Date.UTC(2026, 0, 5, 8);
  const H = 3600000;
  const data = [];
  for (let i = 0; i < 12; i++) data.push({ t: T0 + i * H, values: { a: 10 } });
  data[5] = { t: T0 + 5 * H, values: { a: 300 } };
  const src = {
    'source-type': 'artificial', name: 'p', type: 'scatter', category: 'point',
    tmin: T0, tmax: T0 + 11 * H, min: 0, max: 999, data, clampOutliers: true,
  };
  const ts = await build([src], { clampOutliers: true }, [T0, T0 + 11 * H]);
  // bulk 10 → limit = 10/0.8 at the plot edge; the marker is drawn as the
  // arrow's shaft: CLAMP_HEAD + r px below the edge.
  assert.ok(Math.abs(ts.getValueRange().ymax - 10 / 0.8) < 1e-9);
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const X = ms => ((ms - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth
                + area.margin.left;
  const Y = v => area.margin.top + area.plotHeight * (1 - v / ts.getValueRange().ymax);
  let got = 'unset';
  ts.onHoverDataCallback((plot, n, key, value, clamped) => {
    got = { key, value, clamped };
  });
  ts.getCanvas().onmousemove({
    clientX: X(T0 + 5 * H),
    clientY: area.margin.top + CLAMP_HEAD_PX + POINT_RADIUS.scatter,
  });
  assert.equal(got.key, 'a');
  assert.equal(got.value, 300, 'the raw value, not the clamped position');
  assert.equal(got.clamped, true);
  // A bulk marker answers at its true position, unchanged.
  got = 'unset';
  ts.getCanvas().onmousemove({ clientX: X(T0 + 1 * H), clientY: Y(10) });
  assert.equal(got.key, 'a');
  assert.equal(got.value, 10);
  assert.equal(got.clamped, false);
});

// ── 9. The off invariant ─────────────────────────────────────────────────────
//
// With the option absent — the default — nothing about a chart may change:
// the extent, the stamped state and the hover contract are today's arithmetic,
// hard-coded here. Every fixture carries an outlier so a silent clamping would
// be loud.

test('multibar: off, the extent is the stacked total and the hit is unchanged',
     async () => {
  const absent = await range([barSource({}, [5])]);
  assert.equal(absent.ymax, 320);
  const explicit = await range([barSource({}, [5])], { clampOutliers: false });
  assert.deepEqual(explicit, absent);

  // The 4-arg hover contract the tooltip and every app handler pins: the first
  // four arguments of a normal hit are exactly what they always were.
  const ts = await build([barSource({}, [5])], { clampOutliers: false });
  const area = ts.getPlotArea();
  let got = 'unset';
  ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, n, key, value }; });
  ts.getCanvas().onmousemove({
    clientX: area.margin.left + area.plotWidth * (0.5 / SLOTS),
    clientY: area.margin.top + area.plotHeight - 5,
  });
  assert.equal(got.key, 'a');
  assert.equal(got.value, 10);
  assert.equal(got.n, 0);
  assert.equal(got.plot.name, 'm');
});

test('multiline (binned and point) and scatter: off, the extent is the true max',
     async () => {
  const binned = {};
  for (let i = 0; i < SLOTS; i++) binned[i] = { a: 10 };
  binned[5] = { a: 300 };
  const line = [Object.assign({
    'source-type': 'artificial', type: 'multiline', name: 'l',
    interval_start: START, interval: 3600, count: SLOTS,
    interval_end: START + SLOTS * 3600, data: binned, min: 0, max: 999,
  })];
  assert.equal((await range(line)).ymax, 300);
  assert.equal((await range(line, { clampOutliers: false })).ymax, 300);

  const pts = [];
  for (let i = 0; i < SLOTS; i++)
    pts.push({ t: (START + i * 3600) * 1000, values: { a: 10 } });
  pts[5] = { t: (START + 5 * 3600) * 1000, values: { a: 300 } };
  const scatter = [{
    'source-type': 'artificial', name: 'p', type: 'scatter', category: 'point',
    tmin: START * 1000, tmax: (START + SLOTS * 3600) * 1000,
    min: 0, max: 999, data: pts,
  }];
  assert.equal((await range(scatter)).ymax, 300);
  assert.equal((await range(scatter, { clampOutliers: false })).ymax, 300);

  const point = [{
    'source-type': 'artificial', name: 'q', type: 'multiline', category: 'point',
    tmin: START * 1000, tmax: (START + SLOTS * 3600) * 1000,
    min: 0, max: 999, data: pts,
  }];
  assert.equal((await range(point)).ymax, 300);
  assert.equal((await range(point, { clampOutliers: false })).ymax, 300);
});

test('quantile-bands: off, the extent is the largest ladder entry', async () => {
  const lad = {};
  for (let i = 0; i < SLOTS; i++) lad[i] = { a: [10, 20, 30] };
  lad[5] = { a: [10, 20, 950] };
  const src = [Object.assign({
    'source-type': 'artificial', type: 'quantile-bands', name: 'q',
    interval_start: START, interval: 3600, count: SLOTS,
    interval_end: START + SLOTS * 3600, percentiles: [5, 50, 95],
    data: lad, min: 0, max: 999,
  })];
  assert.equal((await range(src)).ymax, 950);
  assert.equal((await range(src, { clampOutliers: false })).ymax, 950);
});

test('no clamp state is stamped anywhere while the feature is off', async () => {
  // Three shapes on one chart — binned scalar, ladder and laned — none of
  // which may carry a record after a frame with the feature off.
  const lad = {};
  for (let i = 0; i < SLOTS; i++) lad[i] = { a: [10, 20, 950] };
  const heat = {};
  for (let i = 0; i < SLOTS; i++) heat[i] = { a: 10, b: 950 };
  const ts = await build([
    barSource({}, [5]),
    Object.assign({
      'source-type': 'artificial', type: 'quantile-bands', name: 'q',
      interval_start: START, interval: 3600, count: SLOTS,
      interval_end: START + SLOTS * 3600,
      percentiles: [5, 50, 95], data: lad, min: 0, max: 999,
    }),
    Object.assign({
      'source-type': 'artificial', type: 'heatmap', name: 'h',
      interval_start: START, interval: 3600, count: SLOTS,
      interval_end: START + SLOTS * 3600, data: heat, min: 0, max: 999,
    }),
  ], {});
  for (const plot of ts.getActiveData())
    assert.equal(plot._clamped, undefined,
                 plot.type + ' must not carry a clamp record');
});

// ── 10. Settings validation ──────────────────────────────────────────────────

test('invalid clamp params warn and fall back to the defaults, i.e. off', async () => {
  // A bulkFrac of 1 would put the bulk at the plot edge and leave the
  // arrowhead no room; ≥ 1 is rejected outright.
  const warns = [];
  const orig = console.warn;
  console.warn = m => warns.push(String(m));
  let ts;
  try {
    ts = await build([barSource({}, [5])], {
      clampOutliers: true, clampBulkFrac: 1,
    });
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.length > 0, 'the misconfiguration went unreported');
  assert.match(warns[0], /clampOutliers/);
  // The validation switches the feature off rather than drawing with the
  // broken constants — the axis is the true max, exactly as if it were absent.
  assert.equal(ts.getValueRange().ymax, 320);
  assert.equal(ts.getActiveData()[0]._clamped, undefined);
});

test('a share at or above 0.5 is rejected the same way', async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = m => warns.push(String(m));
  let ts;
  try {
    ts = await build([barSource({}, [5])], {
      clampOutliers: true, clampOutliersShare: 0.5,
    });
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.length > 0, 'the misconfiguration went unreported');
  assert.equal(ts.getValueRange().ymax, 320);
});

test('a factor at or below 1 is rejected the same way', async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = m => warns.push(String(m));
  let ts;
  try {
    ts = await build([barSource({}, [5])], {
      clampOutliers: true, clampOutliersFactor: 1,
    });
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.length > 0, 'the misconfiguration went unreported');
  assert.equal(ts.getValueRange().ymax, 320);
});

// ── 11. The tooltip ──────────────────────────────────────────────────────────

test('onHoverDataCallback delivers clamped: true for a clamped hit and false '
     + 'otherwise', async () => {
  const h = await buildHit();
  h.hover(h.slot(5), 35);
  assert.equal(h.got.clamped, true);
  h.hover(h.slot(1), 10);
  assert.equal(h.got.clamped, false);
  h.hover(h.slot(5), 55);
  assert.equal(h.got.clamped, false);
});

test('the tooltip appends the "▲ clamped to axis" hint on a clamped hit only',
     async () => {
  const h = await buildHit();
  const tip = TimeSeries.attachTooltip(h.ts);

  h.hover(h.slot(5), 35);
  assert.equal(tip.el.style.display, 'block');
  const hint = tip.el.querySelectorAll('.ts-tooltip-clamped');
  assert.equal(hint.length, 1, 'the hint row is rendered on a clamped hit');
  assert.match(hint[0].textContent, /clamped to axis/);
  // The value shown stays the REAL one.
  assert.match(tip.el.textContent, /300/);

  // A normal hit carries no hint.
  h.hover(h.slot(1), 10);
  assert.equal(tip.el.querySelectorAll('.ts-tooltip-clamped').length, 0);
  assert.match(tip.el.textContent, /10/);

  tip.destroy();
});
// ── 12. The runtime toggle ───────────────────────────────────────────────────
// The clamp is a display policy, so it flips at runtime like panSnap does —
// setClampOutliers / getClampOutliers / toggleClampOutliers, which is what the
// c key calls. The transition is one plotAll(): prepare_grid deletes a stale
// `_clamped` before re-deriving it, so switching off has to leave the chart
// byte-identical to one that was never switched on.

test('setClampOutliers rescales the axis both ways', async () => {
  const ts = await build([barSource({}, [5])]);
  assert.equal(ts.getClampOutliers(), false, 'off is the default');
  assert.equal(ts.getValueRange().ymax, 320);

  ts.setClampOutliers(true);
  assert.equal(ts.getClampOutliers(), true);
  assert.equal(ts.getValueRange().ymax, 37.5, 'the bulk-stretched limit');
  assert.ok(ts.getActiveData()[0]._clamped, 'and a record is stamped');

  ts.setClampOutliers(false);
  assert.equal(ts.getValueRange().ymax, 320, 'the true max is back');
  assert.equal(ts.getActiveData()[0]._clamped, undefined,
               'and no stale record survives the flip');
});

test('toggleClampOutliers flips and reports the state now in force', async () => {
  const ts = await build([barSource({}, [5])]);
  assert.equal(ts.toggleClampOutliers(), true, 'returns what a host would relabel to');
  assert.equal(ts.getValueRange().ymax, 37.5);
  assert.equal(ts.toggleClampOutliers(), false);
  assert.equal(ts.getValueRange().ymax, 320);
});

test('a chart constructed with the clamp on can switch it off again', async () => {
  const ts = await build([barSource({}, [5])], { clampOutliers: true });
  assert.equal(ts.getClampOutliers(), true);
  ts.setClampOutliers(false);
  assert.equal(ts.getValueRange().ymax, 320);
});

test('the runtime toggle only moves the global setting', async () => {
  // Per-plot flags keep deciding for themselves, in both directions — the same
  // precedence the constructor-time setting has.
  const ts = await build([barSource({ clampOutliers: false }, [5])]);
  ts.setClampOutliers(true);
  assert.equal(ts.getValueRange().ymax, 320, 'an opted-out block stays unclamped');
  assert.equal(ts.getActiveData()[0]._clamped, undefined);

  const ts2 = await build([barSource({ clampOutliers: true }, [5])],
                          { clampOutliers: true });
  ts2.setClampOutliers(false);
  assert.equal(ts2.getValueRange().ymax, 37.5, 'an opted-in block stays clamped');
});

test('setting the value it already has changes nothing', async () => {
  const ts = await build([barSource({}, [5])]);
  const before = ts.getValueRange();
  ts.setClampOutliers(false);
  assert.deepEqual(ts.getValueRange(), before);
  assert.equal(ts.getClampOutliers(), false);
});

test('invalid params leave the toggle switched off but still usable', async () => {
  // The constructor replaced the three numbers with the defaults and forced the
  // feature off. Switching on at runtime must therefore clamp by the defaults,
  // not re-apply the rejected configuration.
  const warn = console.warn;
  console.warn = () => {};
  let ts;
  try {
    ts = await build([barSource({}, [5])],
                     { clampOutliers: true, clampOutliersFactor: 0.5 });
  } finally { console.warn = warn; }

  assert.equal(ts.getClampOutliers(), false, 'the bad config was forced off');
  assert.equal(ts.getValueRange().ymax, 320);
  ts.setClampOutliers(true);
  assert.equal(ts.getValueRange().ymax, 37.5, 'and clamps by factor 3, the default');
});
