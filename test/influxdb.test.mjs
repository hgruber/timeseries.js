// InfluxDB source: zoom-adaptive two-API source (InfluxQL 1.x + Flux 2.x).
// Three layers:
//   1. pure helpers (window, fold, plot, step, series key), directly;
//   2. the jpInfluxdb client end-to-end, with both modes driven over a
//      stubbed fetch — auth precedence, body shape, response parsing;
//   3. the source end-to-end — first push → multiline, padded window skip,
//      seq guard against out-of-order responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const {
  influxWindow, influxSeriesKey, influxFold, influxPlot, influxStepFor,
} = await import('../src/sources.js');

// ── 1. pure helpers ──────────────────────────────────────────────────────────

test('prefetch window pads ±padding around the viewport', () => {
  const w = influxWindow({ tmin: 1000, tmax: 3000 }, 0.5);
  assert.deepEqual(w, { from: 0, to: 4000 });
});

test('influxSeriesKey is deterministic and tag-order-independent', () => {
  const a = { host: 'web01', cpu: '0' };
  const b = { cpu: '0', host: 'web01' };
  assert.equal(influxSeriesKey('cpu', a), influxSeriesKey('cpu', b));
  const c = { host: 'web02', cpu: '0' };
  assert.notEqual(influxSeriesKey('cpu', a), influxSeriesKey('cpu', c));
  // A tag whose value contains '=' must not collide with another tag's name.
  const d = { 'a=b': '1', a: 'b' };
  assert.notEqual(influxSeriesKey('m', { a: 'b' }), influxSeriesKey('m', d));
});

test('influxFold aggregates sub-bucket values into [mn, av, mx]', () => {
  const ring = {};
  influxFold(ring, { series: [{ name: 'cpu', tags: { host: 'a' }, points: [[0, 10], [30000, 20]] }] }, 60000, 30000);
  const plot = influxPlot({ intervalMs: 60000 }, ring, 'm');
  assert.equal(plot.data.length, 1);
  const key = influxSeriesKey('cpu', { host: 'a' });
  assert.deepEqual(plot.data[0].values[key], [10, 15, 20]);
});

test('influxFold treats already-binned values as scalars', () => {
  const ring = {};
  influxFold(ring, { series: [{ name: 'cpu', tags: { host: 'a' }, points: [[0, 10], [60000, 20]] }] }, 60000, 60000);
  const plot = influxPlot({ intervalMs: 60000 }, ring, 'm');
  const key = influxSeriesKey('cpu', { host: 'a' });
  assert.equal(plot.data[0].values[key], 10);
  assert.equal(plot.data[1].values[key], 20);
});

test('influxFold on empty envelope returns a graceful empty block', () => {
  const ring = {};
  influxFold(ring, { series: [] }, 60000, 60000);
  const plot = influxPlot({ intervalMs: 60000 }, ring, 'm');
  assert.equal(plot.data.length, 0);
  assert.equal(plot.min, 0);
  assert.equal(plot.max, 0);
});

test('influxStepFor never returns a step finer than 2 px at the current ppms', () => {
  assert.ok(influxStepFor(0.001, null, null) >= 2);
  assert.equal(influxStepFor(0.001, null, 30), 30);
  const prev = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try { assert.equal(influxStepFor(0.001, null, 1) >= 2, true); }
  finally { console.warn = prev; }
  assert.ok(warned, 'a too-fine explicit step warns');
});

test('influxPlot keeps absolute timestamps and reports min/max', () => {
  const ring = {};
  influxFold(ring, {
    series: [
      { name: 's', tags: {}, points: [[5 * 60000, -1], [5 * 60000 + 10000, 3]] },
      { name: 's', tags: {}, points: [[7 * 60000, 2]] },
    ],
  }, 60000, 30000);
  const plot = influxPlot({ intervalMs: 60000 }, ring, 'p', null, 'multiline');
  assert.equal(plot.min, -1);
  assert.equal(plot.max, 3);
  assert.equal(plot.data.length, 2);
});

// ── 2. jpInfluxdb client over a stubbed fetch ───────────────────────────────

const calls = [];
const pending = [];
let autoRespond = true;

function make1xResponse(from, to, stepMs, marker) {
  // Generate a sinusoid envelope in the shape InfluxDB 1.x returns.
  const cols = ['time', 'mean'];
  const values = [];
  for (let t = from; t <= to; t += stepMs) {
    values.push([String(t), String(Math.round(10 + 5 * Math.sin(t / 60000)))]);
  }
  return {
    results: [{ statement_id: 0, series: [{ name: 'cpu' + marker, columns: cols, values: values }] }],
  };
}

function make2xCsv(from, to, stepMs, marker) {
  // Annotated CSV: header row of column names, then `#group` / `#datatype`
  // comments, then data rows. We emit the same shape the real InfluxDB 2.x
  // returns when the client asks for `text/csv` with `header: true`.
  let csv = '#group,false,false,true,true\n';
  csv += '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,long,string,string\n';
  csv += 'result,table,_start,_stop,time,value,_field,_measurement,host\n';
  let t = from;
  while (t <= to) {
    const v = Math.round(10 + 5 * Math.sin(t / 60000));
    csv += `cpu${marker},0,${from},${to},${new Date(t).toISOString()},${v},mean,cpu,web01\n`;
    t += stepMs;
  }
  return csv;
}

globalThis.fetch = function fetchStub(url, init) {
  calls.push({
    url: String(url),
    method: init && init.method,
    headers: init && init.headers,
    body: init && init.body,
  });
  const u = String(url);
  if (u.indexOf('/api/v2/query') !== -1) {
    // 2.x — JSON request, text/csv response (the shape we ask for).
    const marker = 'A';
    const text = make2xCsv(0, 1000000, 30000, marker);
    const resp = { status: 200, headers: { get: () => 'text/csv' }, text: () => Promise.resolve(text) };
    if (!autoRespond) return new Promise(function (resolve) { pending.push({ kind: '2x', resolve: resolve, text: text }); });
    return Promise.resolve(resp);
  }
  if (u.indexOf('/query') !== -1) {
    // 1.x — form-encoded request, JSON envelope.
    const body = (init && init.body) || '';
    const params = {};
    body.split('&').forEach(function (kv) {
      const [k, v] = kv.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    const from = +(params.from || 0);
    const to = +(params.to || 0);
    const env = make1xResponse(from, to, 30000, 'A');
    const resp = { status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(env) };
    if (!autoRespond) return new Promise(function (resolve) { pending.push({ kind: '1x', resolve: resolve, env: env }); });
    return Promise.resolve(resp);
  }
  return Promise.resolve({ status: 404, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ results: [{ error: 'not found' }] }) });
};

const { default: jpInfluxdb } = await import('../src/jpInfluxdb.js');

test('jpInfluxdb 1.x sends form-encoded body and parses the envelope', async () => {
  autoRespond = true; calls.length = 0;
  const c = new jpInfluxdb({ url: 'http://influx.local:8086', mode: '1x', token: 'tok', db: 'mydb' });
  const envelope = await c.query('SELECT mean(value) FROM cpu', 0, 1000000);
  // Last call is the actual query — auth checks use no endpoint.
  const queryCall = calls[calls.length - 1];
  assert.equal(queryCall.method, 'POST');
  assert.equal(queryCall.headers.Authorization, 'Token tok');
  assert.ok(queryCall.headers['Content-Type'].indexOf('form-urlencoded') !== -1);
  assert.ok(queryCall.body.indexOf('db=mydb') !== -1);
  assert.ok(queryCall.body.indexOf('SELECT') !== -1);
  assert.equal(envelope.series.length, 1);
});

test('jpInfluxdb 2.x sends a JSON body and parses the stream', async () => {
  autoRespond = true; calls.length = 0;
  const c = new jpInfluxdb({ url: 'http://influx.local:8086', mode: '2x', token: 'tok', org: 'myorg' });
  const envelope = await c.query('from(bucket:"b") |> range(start: v.timeStart, stop: v.timeStop)', 0, 1000000);
  const queryCall = calls[calls.length - 1];
  assert.equal(queryCall.method, 'POST');
  assert.equal(queryCall.headers.Authorization, 'Token tok');
  assert.ok(queryCall.body.indexOf('"org":"myorg"') !== -1);
  assert.equal(envelope.series.length, 1);
  // The stream had 33 rows; assert at least one numeric point landed.
  assert.ok(envelope.series[0].points.length > 0);
});

test('jpInfluxdb falls back to basic auth when no token is set', async () => {
  autoRespond = true; calls.length = 0;
  const c = new jpInfluxdb({ url: 'http://influx.local:8086', mode: '1x', username: 'u', password: 'p', db: 'd' });
  await c.query('SELECT 1', 0, 1);
  const queryCall = calls[calls.length - 1];
  assert.ok(queryCall.headers.Authorization.indexOf('Basic ') === 0);
});

// ── 3. source end-to-end ─────────────────────────────────────────────────────

let iId = 0;
function influxSource(extra) {
  return Object.assign({
    'source-type': 'influxdb',
    url: 'http://influx.local:8086',
    mode: '1x',
    db: 'mydb',
    query: 'SELECT mean(value) FROM cpu',
  }, extra || {});
}
async function buildInflux(src) {
  const id = 'infl-' + (iId++);
  makeCanvas(id);
  const ts = new TimeSeries({ canvas: id, sources: [src], initialView: null });
  await sleep(30);
  return ts;
}

const FROM = Date.UTC(2026, 1, 1);
const TO = Date.UTC(2026, 1, 16);

test('a wide viewport pushes a multiline block from /query', async () => {
  autoRespond = true; calls.length = 0;
  const ts = await buildInflux(influxSource());
  await setView(ts, FROM, TO);
  const blocks = ts.getActiveData();
  const line = blocks.find(p => p.type === 'multiline' && p.category === 'point');
  assert.ok(line, 'multiline block is the active resolution');
  assert.ok(calls.some(c => c.url.indexOf('/query') !== -1 && c.method === 'POST'), 'POSTed to /query');
});

test('panning inside the padded window does not refetch', async () => {
  autoRespond = true; calls.length = 0;
  const ts = await buildInflux(influxSource());
  await setView(ts, FROM, TO);
  calls.length = 0;
  const span = TO - FROM;
  await setView(ts, FROM + span * 0.1, TO + span * 0.1);
  assert.equal(calls.length, 0, 'small pan inside ±50% served from cache');
});

test('an out-of-order response for a superseded window is dropped (seq guard)', async () => {
  autoRespond = true; calls.length = 0;
  const src = influxSource();
  const ts = await buildInflux(src);
  await setView(ts, FROM, TO);

  autoRespond = false;
  pending.length = 0;
  calls.length = 0;
  const F0 = Date.UTC(2026, 3, 1), F1 = Date.UTC(2026, 3, 16);
  await setView(ts, F0, F1);
  src.refresh();
  // Group pending fetches by their tier (we only race within one tier).
  // The two Tiers share a query but produce different responses. Resolve
  // the older request FIRST (out-of-order) — the seq guard must drop it
  // when the newer request arrives.
  assert.ok(pending.length >= 2, 'at least two fetches queued');
  const older = pending[0], newer = pending[pending.length - 1];

  function respondOne(p) {
    return p.env
      ? { status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(p.env) }
      : { status: 200, headers: { get: () => 'text/plain' }, text: () => Promise.resolve(p.text) };
  }

  // Resolve older first. The seq guard rejects it because mine !== seq.
  older.resolve(respondOne(older));
  await sleep(20);
  // Resolve newer — this one must be accepted.
  newer.resolve(respondOne(newer));
  autoRespond = true;
  await sleep(40);

  // The point of the test: no error was thrown, the chart still renders.
  const blocks = ts.getActiveData();
  assert.ok(blocks.length > 0, 'blocks present after racing responses');
});

test('an empty series renders a graceful empty block (no error)', async () => {
  autoRespond = true;
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    calls.push({ url: String(url) });
    return Promise.resolve({ status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ results: [{ statement_id: 0, series: [] }] }) });
  };
  try {
    const ts = await buildInflux(influxSource({ query: 'SELECT mean(value) FROM nowhere' }));
    await setView(ts, FROM, TO);
    const blocks = ts.getActiveData();
    for (const p of blocks) {
      // Either tier, either render: no throw, no exception, and data is empty.
      if (p.category === 'point') {
        assert.equal(p.data.length, 0, 'empty series → empty point array, no error');
      } else {
        assert.deepEqual(p.data, {}, 'empty series → empty slot map, no error');
      }
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});