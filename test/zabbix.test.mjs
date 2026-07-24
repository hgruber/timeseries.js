// Zabbix source: zoom-adaptive history/trends with a min/avg/max band, ±50%
// prefetch, a bounded ring cache, and a cross-fade at the resolution switch.
//
// Three layers are exercised:
//   1. the pure ring helpers (fold/evict/plot/window/primary-tier), directly;
//   2. the cross-fade the core does when two quantile-bands intervals overlap,
//      through a real TimeSeries fed two artificial band blocks;
//   3. the source end-to-end, driving jpZabbix over a stubbed XMLHttpRequest
//      (token auth, so no login round-trip) — trends→band, prefetch skip, and
//      the sequence guard against out-of-order responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const {
  zabbixPrimaryTier, zabbixWindow, zabbixClearRange,
  zabbixFold, zabbixEvict, zabbixPlot,
} = await import('../src/sources.js');

const TIERS = [{ interval: 60, kind: 'history' }, { interval: 3600, kind: 'trends' }];

// ── 1. pure helpers ──────────────────────────────────────────────────────────

test('primary tier is the finest whose buckets are ≥ 2px, else the coarsest', () => {
  // 60s buckets at exactly 2px → the fine tier is usable.
  assert.equal(zabbixPrimaryTier(TIERS, 2 / (60 * 1000)), 0);
  // 60s sub-2px but 3600s well above → step out to trends.
  assert.equal(zabbixPrimaryTier(TIERS, 1 / (60 * 1000)), 1);
  // both sub-2px (extreme zoom-out) → coarsest available.
  assert.equal(zabbixPrimaryTier(TIERS, 1e-9), 1);
});

test('prefetch window pads ±padding around the viewport', () => {
  const w = zabbixWindow({ tmin: 1000, tmax: 3000 }, 0.5);
  assert.deepEqual(w, { from: 0, to: 4000 });
});

test('trend rows fold straight into [min, avg, max]', () => {
  const ring = new Map();
  zabbixFold(ring, [{ itemid: '1', clock: '3600', value_min: '1', value_avg: '2', value_max: '3' }], 3600, true);
  const plot = zabbixPlot({ interval: 3600 }, ring, 'm');
  assert.deepEqual(plot.percentiles, ['min', 'avg', 'max']);
  // slot 1 rebased onto baseSlot 1 → key 0.
  assert.deepEqual(plot.data[0]['1'], [1, 2, 3]);
});

test('history samples in one bucket aggregate to min/avg/max', () => {
  const ring = new Map();
  zabbixFold(ring, [
    { itemid: '1', clock: '0', value: '10' },
    { itemid: '1', clock: '30', value: '20' },
  ], 60, false);
  const plot = zabbixPlot({ interval: 60 }, ring, 'm');
  assert.deepEqual(plot.data[0]['1'], [10, 15, 20]);   // min 10, avg 15, max 20
});

test('plot rebases slots onto interval_start and reports extent', () => {
  const ring = new Map();
  zabbixFold(ring, [
    { itemid: '1', clock: String(10 * 60), value: '5' },
    { itemid: '1', clock: String(12 * 60), value: '9' },
  ], 60, false);
  const plot = zabbixPlot({ interval: 60 }, ring, 'm');
  assert.equal(plot.interval_start, 10 * 60);
  assert.equal(plot.interval_end, 13 * 60);   // (maxSlot 12 + 1) * 60
  assert.deepEqual(Object.keys(plot.data).sort(), ['0', '2']);
  assert.equal(plot.min, 5);
  assert.equal(plot.max, 9);
});

test('clearRange drops only slots inside the window', () => {
  const ring = new Map([[0, {}], [1, {}], [2, {}], [3, {}]]);
  zabbixClearRange(ring, 60, 1 * 60 * 1000, 3 * 60 * 1000);   // slots [1,3)
  assert.deepEqual([...ring.keys()].sort((a, b) => a - b), [0, 3]);
});

test('evict caps the ring and keeps the neighbourhood around the viewport centre', () => {
  const ring = new Map();
  for (let s = 0; s <= 10; s++) ring.set(s, {});
  zabbixEvict(ring, 60, 5 * 60 * 1000, 5);   // centre = slot 5, cap 5
  assert.equal(ring.size, 5);
  assert.ok(ring.has(5), 'centre slot survives');
  assert.ok(!ring.has(0) && !ring.has(10), 'farthest slots evicted');
});

// ── 2. cross-fade in prepare_grid ────────────────────────────────────────────

const START_S = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const SPAN_S = 3 * 86400;
const MID_MS = (START_S + SPAN_S / 2) * 1000;

// An artificial quantile-bands block spanning the whole test range with a few
// sparse slots — density is irrelevant to interval selection, only presence.
function bandBlock(interval) {
  const data = {};
  const last = Math.floor(SPAN_S / interval);
  for (const k of [0, Math.floor(last / 2), last]) data[k] = { '1': [1, 2, 3] };
  return {
    'source-type': 'artificial', type: 'quantile-bands', name: 'm', interval,
    interval_start: START_S, percentiles: ['min', 'avg', 'max'], data, min: 1, max: 3,
  };
}

let xfId = 0;
async function buildCrossfade() {
  const id = 'xf-' + (xfId++);
  makeCanvas(id);
  const ts = new TimeSeries({
    canvas: id,
    sources: [bandBlock(60), bandBlock(3600)],
    initialView: null,
  });
  await setView(ts, MID_MS - 6e6, MID_MS + 6e6);   // render once to settle margins
  return { ts, plotWidth: ts.getPlotArea().plotWidth };
}

// Window width (ms) that makes the fine (60s) bucket exactly `px` pixels wide.
const widthForFinePx = (pw, px) => (60 * 1000 * pw) / px;
const centred = (w) => [MID_MS - w / 2, MID_MS + w / 2];

test('zoomed in past the threshold, only the fine tier renders at full alpha', async () => {
  const { ts, plotWidth } = await buildCrossfade();
  const [a, b] = centred(widthForFinePx(plotWidth, 5));   // ~5px fine buckets
  await setView(ts, a, b);
  const active = ts.getActiveData();
  assert.equal(active.filter(p => p.interval === 3600).length, 0, 'coarse tier suppressed');
  const fine = active.find(p => p.interval === 60);
  assert.ok(fine, 'fine tier active');
  assert.equal(fine._fade, 1);
});

test('in the fade band both tiers render and their alphas cross-fade to sum 1', async () => {
  const { ts, plotWidth } = await buildCrossfade();
  const [a, b] = centred(widthForFinePx(plotWidth, 1.5));   // ~1.5px fine buckets → mid-fade
  await setView(ts, a, b);
  const wf = 60 * 1000 * ts.getViewport().ppms;
  assert.ok(wf > 1 && wf < 2, `precondition: fine bucket in the fade band, got ${wf}px`);
  const active = ts.getActiveData();
  const fine = active.find(p => p.interval === 60);
  const coarse = active.find(p => p.interval === 3600);
  assert.ok(fine && coarse, 'both tiers active during the fade');
  // fadeProg = (2 - wf); fine (outgoing) = wf - 1, coarse (incoming) = 2 - wf.
  assert.ok(Math.abs(fine._fade - (wf - 1)) < 1e-6, `fine fade ${fine._fade}`);
  assert.ok(Math.abs(coarse._fade - (2 - wf)) < 1e-6, `coarse fade ${coarse._fade}`);
  assert.ok(Math.abs(fine._fade + coarse._fade - 1) < 1e-6, 'alphas sum to 1');
});

test('zoomed far out, only the coarse tier renders at full alpha', async () => {
  const { ts, plotWidth } = await buildCrossfade();
  const [a, b] = centred(widthForFinePx(plotWidth, 0.3));   // fine deep sub-pixel
  await setView(ts, a, b);
  const active = ts.getActiveData();
  assert.equal(active.filter(p => p.interval === 60).length, 0, 'fine tier dropped');
  const coarse = active.find(p => p.interval === 3600);
  assert.ok(coarse, 'coarse tier active');
  assert.equal(coarse._fade, 1);
});

// ── 3. source end-to-end over a stubbed XMLHttpRequest ───────────────────────

const calls = [];            // {method, params} per JSON-RPC send
let autoRespond = true;      // false → queue in `pending` for manual, out-of-order resolution
const pending = [];
let tagCounter = 0;          // send-order tag, so a response is identifiable by send order
let markFor = () => 2;       // trends value_avg marker; overridden per test

function respond(entry) {
  const { method, params } = entry.req;
  const from = +params.time_from, till = +params.time_till, ids = params.itemids;
  const rows = [];
  for (let k = 0; k <= 4; k++) {
    const clock = Math.round(from + ((till - from) * k) / 4);
    for (const id of ids) {
      if (method === 'trends.get') {
        const a = markFor(entry);
        rows.push({ itemid: id, clock: String(clock), value_min: String(a - 1), value_avg: String(a), value_max: String(a + 1) });
      } else {
        rows.push({ itemid: id, clock: String(clock), value: String(10 + k) });
      }
    }
  }
  entry.xhr.status = 200;
  entry.xhr.response = JSON.stringify({ jsonrpc: '2.0', id: entry.req.id, result: rows });
  if (entry.xhr.onload) entry.xhr.onload();
}

class FakeXHR {
  open(method, url) { this._url = url; }
  setRequestHeader() {}
  set timeout(_v) {}
  send(body) {
    const req = JSON.parse(body);
    calls.push({ method: req.method, params: req.params });
    const entry = { xhr: this, req, tag: ++tagCounter };
    if (autoRespond) respond(entry);
    else pending.push(entry);
  }
}
globalThis.XMLHttpRequest = FakeXHR;

// Every avg in a rebuilt plot's ring, as numbers — lets a test assert on which
// fetch's data is present without caring which slot it landed in.
function bandAvgs(ts) {
  const band = ts.getActiveData().find(p => p.interval === 3600);
  const avgs = [];
  if (band) for (const slot of Object.values(band.data))
    for (const arr of Object.values(slot)) avgs.push(arr[1]);
  return avgs;
}

let zbxId = 0;
function zabbixSource(extra = {}) {
  return Object.assign({
    'source-type': 'zabbix', url: 'http://z/api', 'auth-token': 'tok',
    itemids: ['1'], 'history-interval': 60,
  }, extra);
}
async function buildZabbix(src) {
  const id = 'zbx-' + (zbxId++);
  makeCanvas(id);
  const ts = new TimeSeries({ canvas: id, sources: [src], initialView: null });
  await sleep(30);   // connect() (token auth is a resolved promise) + handler registration
  return ts;
}

// A wide window keeps trends the primary tier (3600s buckets ≥ 2px, 60s far below).
const WIDE_FROM = Date.UTC(2026, 1, 1) / 1000 * 1000;
const WIDE_TO = Date.UTC(2026, 1, 16) / 1000 * 1000;   // 15 days

test('a wide viewport fetches trends and renders them as a min/avg/max band', async () => {
  markFor = () => 2;
  autoRespond = true;
  const ts = await buildZabbix(zabbixSource());
  await setView(ts, WIDE_FROM, WIDE_TO);
  const band = ts.getActiveData().find(p => p.interval === 3600 && p.type === 'quantile-bands');
  assert.ok(band, 'trends band is the active resolution');
  const slot = Object.values(band.data)[0];
  assert.deepEqual(Object.values(slot)[0], [1, 2, 3]);
});

test('panning inside the padded window does not refetch', async () => {
  markFor = () => 2;
  autoRespond = true;
  const ts = await buildZabbix(zabbixSource());
  await setView(ts, WIDE_FROM, WIDE_TO);
  assert.ok(calls.some(c => c.method === 'trends.get'), 'first view fetched trends');
  // Nudge the viewport within the padded (±50%) window and confirm no refetch.
  calls.length = 0;
  const span = WIDE_TO - WIDE_FROM;
  await setView(ts, WIDE_FROM + span * 0.1, WIDE_TO + span * 0.1);
  assert.equal(calls.filter(c => c.method === 'trends.get').length, 0,
    'small pan within ±50% served from cache');
});

test('an out-of-order response for a superseded window is dropped (seq guard)', async () => {
  markFor = () => 2;
  autoRespond = true;
  const src = zabbixSource();
  const ts = await buildZabbix(src);
  await setView(ts, WIDE_FROM, WIDE_TO);   // settle at a wide (trends) view

  // Race two trends fetches for the SAME window, tagged by send order, and
  // resolve them newest-first. The older (stale) one must be ignored, so the
  // window ends up carrying only the newer send's marker.
  markFor = (e) => e.tag;
  autoRespond = false;
  pending.length = 0;
  // A far window the WIDE fetch does not cover, so both fetches actually fire.
  const F0 = Date.UTC(2026, 3, 1), F1 = Date.UTC(2026, 3, 16);   // April, 15 days
  await setView(ts, F0, F1);   // send #1 (older)
  src.refresh();               // send #2 (newer), same still-uncovered window
  assert.equal(pending.length, 2, 'two trends fetches queued');
  const older = pending[0].tag, newer = pending[1].tag;

  respond(pending[1]);   // resolve the newer send first
  respond(pending[0]);   // then the older one — must be dropped by the seq guard
  autoRespond = true;
  await sleep(20);       // let the applied response's redraw microtasks flush

  const avgs = bandAvgs(ts);
  assert.ok(avgs.includes(newer), 'the newer send\'s data is present');
  assert.ok(!avgs.includes(older), 'the stale send did not overwrite the window');
});
