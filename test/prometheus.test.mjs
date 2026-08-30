// Prometheus source: zoom-adaptive two-tier source. Three layers:
//   1. the pure helpers (window, fold, plot, step, series key), directly;
//   2. the source end-to-end, driving jpPrometheus over a stubbed fetch —
//      first push → multiline, padded window skip, sequence guard, empty
//      PromQL result renders a graceful empty block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const {
  promWindow, promSeriesKey, promFold, promPlot, promStepFor,
} = await import('../src/sources.js');

// ── 1. pure helpers ──────────────────────────────────────────────────────────

test('prefetch window pads ±padding around the viewport', () => {
  const w = promWindow({ tmin: 1000, tmax: 3000 }, 0.5);
  assert.deepEqual(w, { from: 0, to: 4000 });
});

test('promSeriesKey is deterministic and stable under label permutation', () => {
  const a = { __name__: 'up', instance: 'a', job: 'x' };
  const b = { job: 'x', instance: 'a', __name__: 'up' };
  assert.equal(promSeriesKey('up', a), promSeriesKey('up', b));
  // Different label values must yield different keys.
  const c = { __name__: 'up', instance: 'b', job: 'x' };
  assert.notEqual(promSeriesKey('up', a), promSeriesKey('up', c));
  // A label whose value contains '=' must not collide with another label's name.
  const d = { __name__: 'up', 'a=b': '1', a: 'b' };
  assert.notEqual(promSeriesKey('up', { a: 'b' }), promSeriesKey('up', d));
});

test('promFold aggregates sub-bucket values into [mn, av, mx]', () => {
  const ring = {};
  promFold(ring, [{ metric: { __name__: 'm' }, values: [[0, 10], [30000, 20]] }], 60000, 30000);
  const plot = promPlot({ intervalMs: 60000 }, ring, 'm');
  // One bucket (slot 0) → one point at slot centre.
  assert.equal(plot.data.length, 1);
  const key = promSeriesKey('m', { __name__: 'm' });
  assert.deepEqual(plot.data[0].values[key], [10, 15, 20]);
});

test('promFold collapses mn===av===mx to a scalar point value', () => {
  const ring = {};
  promFold(ring, [{ metric: { __name__: 'm' }, values: [[0, 10], [30000, 10]] }], 60000, 30000);
  const plot = promPlot({ intervalMs: 60000 }, ring, 'm');
  const key = promSeriesKey('m', { __name__: 'm' });
  assert.equal(plot.data[0].values[key], 10);
});

test('promFold treats already-binned values as scalars', () => {
  const ring = {};
  promFold(ring, [{ metric: { __name__: 'm' }, values: [[0, 10], [60000, 20]] }], 60000, 60000);
  const plot = promPlot({ intervalMs: 60000 }, ring, 'm');
  const key = promSeriesKey('m', { __name__: 'm' });
  assert.equal(plot.data[0].values[key], 10);
  assert.equal(plot.data[1].values[key], 20);
});

test('promPlot reports interval in seconds and pins point t to slot centres', () => {
  const ring = {};
  // One bucket at slot 5 of a 60s tier → t = (5 + 0.5) * 60000 = 330000.
  promFold(ring, [{ metric: { __name__: 'm' }, values: [[5 * 60000, 7]] }], 60000, 60000);
  const plot = promPlot({ intervalMs: 60000 }, ring, 'p', null, 'multiline');
  assert.equal(plot.interval, 60);
  assert.equal(plot.data[0].t, 330000);
});

test('promStepFor never returns a step finer than 2 px at the current ppms', () => {
  // ppms 0.001 → 2 px needs 2000 ms per bucket → step 2 s
  assert.ok(promStepFor(0.001, null, null) >= 2);
  // Explicit step is preserved when it's at/above the threshold.
  assert.equal(promStepFor(0.001, null, 30), 30);
  // A too-fine explicit step falls back to the safe one and warns.
  const prev = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try { assert.equal(promStepFor(0.001, null, 1) >= 2, true); }
  finally { console.warn = prev; }
  assert.ok(warned, 'a too-fine explicit step warns');
});

test('promPlot keeps absolute timestamps and reports min/max', () => {
  const ring = {};
  promFold(ring, [
    { metric: { __name__: 's' }, values: [[5 * 60000, -1], [5 * 60000 + 10000, 3]] },
    { metric: { __name__: 's' }, values: [[7 * 60000, 2]] },
  ], 60000, 30000);
  const plot = promPlot({ intervalMs: 60000 }, ring, 'p', null, 'multiline');
  assert.equal(plot.min, -1);
  assert.equal(plot.max, 3);
  // Two buckets (5, 7) → two points, ordered by slot.
  assert.equal(plot.data.length, 2);
});

test('promPlot on an empty ring returns a graceful empty block (no throw)', () => {
  const ring = {};
  const plot = promPlot({ intervalMs: 60000 }, ring, 'p', null, 'multiline');
  assert.deepEqual(plot.data, []);
  assert.equal(plot.min, 0);
  assert.equal(plot.max, 0);
});

// ── 2. source end-to-end over a stubbed fetch ────────────────────────────────

const calls = [];        // [{ url, headers, body }] — for inspecting what was sent
const pending = [];      // resolver callbacks for manual response ordering
let autoRespond = true;

// Deterministic sinusoid across the requested window. Five points, integer
// timestamps, integer values so the assertions stay readable.
function syntheticMatrix(from, to, stepSec, seriesName) {
  const values = [];
  for (let t = Math.floor(from / 1000); t <= Math.floor(to / 1000); t += stepSec) {
    values.push([String(t), String(Math.round(10 + 5 * Math.sin(t / 60)))]);
  }
  return {
    status: 'success',
    data: { resultType: 'matrix', result: [{ metric: { __name__: seriesName }, values }] },
  };
}

globalThis.fetch = function fetchStub(url, init) {
  calls.push({ url: String(url), method: init && init.method, headers: init && init.headers, body: init && init.body });
  const u = String(url);
  if (u.indexOf('/api/v1/query_range') === -1) {
    return Promise.resolve({ status: 404, json: () => Promise.resolve({ status: 'error' }) });
  }
  // Parse the request from the URL — query, start, end, step.
  const qs = u.split('?')[1] || '';
  const params = {};
  qs.split('&').forEach(function (kv) {
    const [k, v] = kv.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  const envelope = syntheticMatrix(+params.start * 1000, +params.end * 1000, +params.step, params.query || 'm');
  const response = {
    status: 200,
    json: function () { return Promise.resolve(envelope); },
  };
  if (!autoRespond) {
    return new Promise(function (resolve) { pending.push({ response: response, params: params, resolve: resolve }); });
  }
  return Promise.resolve(response);
};

let pId = 0;
function promSource(extra) {
  return Object.assign({
    'source-type': 'prometheus',
    url: 'http://prom.local:9090',
    query: 'up',
  }, extra || {});
}
async function buildProm(src) {
  const id = 'prom-' + (pId++);
  makeCanvas(id);
  const ts = new TimeSeries({ canvas: id, sources: [src], initialView: null });
  await sleep(30);
  return ts;
}

const FROM = Date.UTC(2026, 1, 1);
const TO = Date.UTC(2026, 1, 16);   // 15 days

test('a wide viewport pushes a multiline block from query_range', async () => {
  autoRespond = true;
  calls.length = 0;
  const ts = await buildProm(promSource());
  await setView(ts, FROM, TO);
  const blocks = ts.getActiveData();
  const line = blocks.find(p => p.type === 'multiline' && p.category === 'point');
  assert.ok(line, 'multiline block is the active resolution');
  assert.ok(line.data && Object.keys(line.data).length > 0, 'block carries slots');
  // Both tiers should have been fetched: the core decides which one to draw.
  assert.ok(calls.some(c => c.url.indexOf('/api/v1/query_range') !== -1), 'fetched query_range');
});

test('panning inside the padded window does not refetch', async () => {
  autoRespond = true;
  calls.length = 0;
  const ts = await buildProm(promSource());
  await setView(ts, FROM, TO);
  assert.ok(calls.length > 0, 'first view fetched');
  calls.length = 0;
  const span = TO - FROM;
  await setView(ts, FROM + span * 0.1, TO + span * 0.1);
  assert.equal(calls.length, 0, 'small pan inside ±50% served from cache');
});

test('an out-of-order response for a superseded window is dropped (seq guard)', async () => {
  autoRespond = true;
  calls.length = 0;
  const src = promSource();
  const ts = await buildProm(src);
  await setView(ts, FROM, TO);

  // Two requests for the SAME fine tier (each tier has its own seq counter,
// so two independent tiers won't race against each other — we need two
// fetches on a single tier). Manipulate the source's internal seq and ring
// directly so we can race two responses against the same tier without the
// padded-window skip interfering.
  autoRespond = false;
  pending.length = 0;
  calls.length = 0;
  // Reach into the source module's exported closure is not possible, but we
  // can drive the race through fetchTier by calling refresh twice in a row
  // while the viewport is unchanged: the first refresh queues one fetch
  // per tier (none resolved yet, so `fetched` is still null), the second
  // refresh queues a *second* fetch per tier (the seq counter advances,
  // so the second fetch supersedes the first).
  const F0 = Date.UTC(2026, 3, 1), F1 = Date.UTC(2026, 3, 16);
  await setView(ts, F0, F1);
  src.refresh();
  // Group pending fetches by `step` (each tier has its own step). At least
  // one tier must have two queued.
  const byStep = new Map();
  for (const p of pending) {
    if (!byStep.has(p.params.step)) byStep.set(p.params.step, []);
    byStep.get(p.params.step).push(p);
  }
  let racePair = null;
  for (const arr of byStep.values()) {
    if (arr.length >= 2) { racePair = arr; break; }
  }
  assert.ok(racePair, 'two same-tier fetches queued');
  const older = racePair[0], newer = racePair[1];

  // Tag each response with a distinct value so we can see which one's data
  // ends up in the ring.
  const tagResp = function (p, marker) {
    const env = syntheticMatrix(+p.params.start * 1000, +p.params.end * 1000, +p.params.step, 'm' + marker);
    p.resolve({ status: 200, json: function () { return Promise.resolve(env); } });
  };
  tagResp(newer, 'B');
  tagResp(older, 'A');
  autoRespond = true;
  await sleep(40);

  const blocks = ts.getActiveData();
  const seriesKeys = new Set();
  for (const p of blocks) {
    if (p.category === 'point') {
      // Point data is an array of {t, values} — iterate by hand.
      for (const pt of p.data || []) {
        if (pt && pt.values) for (const k of Object.keys(pt.values)) seriesKeys.add(k);
      }
    } else {
      for (const slot of Object.values(p.data || {})) {
        for (const k of Object.keys(slot || {})) seriesKeys.add(k);
      }
    }
  }
  assert.ok([...seriesKeys].some(k => k.indexOf('mB') !== -1), 'newer response\'s series is present');
  assert.ok(![...seriesKeys].some(k => k.indexOf('mA') !== -1), 'stale response\'s series was dropped');
});

test('an empty PromQL result renders a graceful empty block (no error)', async () => {
  autoRespond = true;
  const origFetch = globalThis.fetch;
  // Stub returns an empty result envelope.
  globalThis.fetch = function (url) {
    calls.push({ url: String(url) });
    return Promise.resolve({
      status: 200,
      json: function () { return Promise.resolve({ status: 'success', data: { resultType: 'matrix', result: [] } }); },
    });
  };
  try {
    const src = promSource({ query: 'nonexistent_metric' });
    const ts = await buildProm(src);
    await setView(ts, FROM, TO);
    const blocks = ts.getActiveData();
    for (const p of blocks) {
      // Either tier, either render: no throw, no exception, and data is empty.
      // Point data is an array; binned data is an object — both must be empty.
      if (p.category === 'point') {
        assert.equal(p.data.length, 0, 'empty result → empty point array, no error');
      } else {
        assert.deepEqual(p.data, {}, 'empty result → empty slot map, no error');
      }
    }
  } finally {
    // Restore the synthetic sinusoid for any later test in this file.
    globalThis.fetch = origFetch;
  }
});

test('a render other than multiline/multipoint/scatter falls back to multiline', async () => {
  autoRespond = true;
  const prev = console.warn;
  let warned = false;
  console.warn = function (msg) { if (String(msg).indexOf('prometheus render') !== -1) warned = true; };
  try {
    const src = promSource({ render: 'totally-not-a-renderer' });
    const ts = await buildProm(src);
    await setView(ts, FROM, TO);
    const blocks = ts.getActiveData();
    assert.ok(blocks.some(p => p.type === 'multiline'), 'falls back to multiline');
    assert.ok(warned, 'warns about the unknown render');
  } finally {
    console.warn = prev;
  }
});