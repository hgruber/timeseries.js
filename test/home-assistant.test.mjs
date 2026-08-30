// Home Assistant source: mixed-shape (numeric → multiline, binary/state → gantt).
// Three layers:
//   1. pure helpers (window, infer type, fold numeric, fold span);
//   2. jpHomeAssistant client end-to-end over a stubbed fetch — auth, query
//      string, response shape re-keying;
//   3. source end-to-end — first push mixes both renderers, padded window
//      skip, seq guard against out-of-order responses, switching between
//      numeric ↔ span when an entity re-classifies after auth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const {
  haWindow, inferHaRenderType, haFoldNumeric, haFoldSpan,
} = await import('../src/sources.js');

// ── 1. pure helpers ──────────────────────────────────────────────────────────

test('prefetch window pads ±padding around the viewport', () => {
  const w = haWindow({ tmin: 1000, tmax: 3000 }, 0.5);
  assert.deepEqual(w, { from: 0, to: 4000 });
});

test('inferHaRenderType: numeric strings and 0 route to numeric', () => {
  assert.equal(inferHaRenderType('sensor.cpu', '12.4', { unit_of_measurement: '°C' }), 'numeric');
  assert.equal(inferHaRenderType('sensor.cpu', '0', {}), 'numeric');
  assert.equal(inferHaRenderType('sensor.cpu', '-3.7', {}), 'numeric');
});

test('inferHaRenderType: on/off/unavailable/unknown route to span', () => {
  assert.equal(inferHaRenderType('binary_sensor.door', 'on', {}), 'span');
  assert.equal(inferHaRenderType('binary_sensor.door', 'off', {}), 'span');
  assert.equal(inferHaRenderType('sensor.x', 'unavailable', {}), 'span');
  assert.equal(inferHaRenderType('sensor.x', 'unknown', {}), 'span');
  assert.equal(inferHaRenderType('sensor.x', '', {}), 'span');
  assert.equal(inferHaRenderType('sensor.x', null, {}), 'span');
});

test('inferHaRenderType: non-numeric strings route to span', () => {
  assert.equal(inferHaRenderType('sensor.x', 'hello', {}), 'span');
  assert.equal(inferHaRenderType('sensor.x', 'abc123', {}), 'span');
});

test('haFoldNumeric: parses last_changed timestamps and drops non-numeric rows', () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const t1 = t0 + 60000;
  const t2 = t0 + 120000;
  const states = [
    { entity_id: 'e', state: '1.5', last_changed: new Date(t0).toISOString() },
    { entity_id: 'e', state: 'unavailable', last_changed: new Date(t1).toISOString() },
    { entity_id: 'e', state: '2.0', last_changed: new Date(t2).toISOString() },
    { entity_id: 'e', state: 'oops', last_changed: new Date(t2 + 30000).toISOString() },
  ];
  const points = haFoldNumeric('e', states, t0 - 1, t2 + 120000);
  assert.equal(points.length, 2);
  assert.equal(points[0].t, t0);
  assert.equal(points[0].values.e, 1.5);
  assert.equal(points[1].t, t2);
  assert.equal(points[1].values.e, 2.0);
});

test('haFoldNumeric: rows outside [from, to] are dropped', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const t1 = t0 + 60000;
  const t2 = t0 + 120000;
  const states = [
    { entity_id: 'e', state: '1', last_changed: new Date(t0).toISOString() },
    { entity_id: 'e', state: '2', last_changed: new Date(t1).toISOString() },
    { entity_id: 'e', state: '3', last_changed: new Date(t2).toISOString() },
  ];
  const points = haFoldNumeric('e', states, t1 - 30000, t1 + 30000);
  assert.equal(points.length, 1);
  assert.equal(points[0].values.e, 2);
});

test('haFoldSpan: emits one span per state interval, last one open-ended', () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const t1 = t0 + 60000;
  const t2 = t0 + 120000;
  const states = [
    { entity_id: 'door', state: 'off', last_changed: new Date(t0).toISOString() },
    { entity_id: 'door', state: 'on',  last_changed: new Date(t1).toISOString() },
    { entity_id: 'door', state: 'off', last_changed: new Date(t2).toISOString() },
  ];
  const spans = haFoldSpan('door', states, t0 - 1, t2 + 30000);
  // Three intervals → three spans.
  assert.equal(spans.length, 3);
  assert.equal(spans[0].label, 'off');
  assert.equal(spans[0].start, t0);
  assert.equal(spans[0].end, t1);
  assert.equal(spans[1].label, 'on');
  assert.equal(spans[1].start, t1);
  assert.equal(spans[1].end, t2);
  // The last span is open-ended: end = max(toMs, now()) ≥ toMs.
  assert.equal(spans[2].label, 'off');
  assert.equal(spans[2].start, t2);
  assert.ok(spans[2].end >= t2 + 30000, 'last span end ≥ toMs');
  // Each span gets a unique id and the right lane.
  for (const s of spans) {
    assert.ok(s.id.indexOf('door@') === 0);
    assert.equal(s.lane, 'door');
    assert.equal(s.allDay, false);
  }
});

test('haFoldSpan: state already in effect at window start is clipped to fromMs', () => {
  const t_pre = Date.UTC(2026, 0, 1, 11, 59, 0);  // before window
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const t1 = t0 + 60000;
  const states = [
    { entity_id: 'door', state: 'on', last_changed: new Date(t_pre).toISOString() },
    { entity_id: 'door', state: 'off', last_changed: new Date(t0).toISOString() },
    { entity_id: 'door', state: 'on',  last_changed: new Date(t1).toISOString() },
  ];
  const fromMs = t_pre + 30000;        // window starts AFTER t_pre but before t0
  const spans = haFoldSpan('door', states, fromMs, t1 + 30000);
  // First span (state 'on', changed at t_pre) is clipped to fromMs.
  assert.equal(spans[0].label, 'on');
  assert.equal(spans[0].start, fromMs);
  assert.equal(spans[0].end, t0);
  // Second span (state 'off' from t0 → t1).
  assert.equal(spans[1].label, 'off');
  assert.equal(spans[1].start, t0);
  assert.equal(spans[1].end, t1);
  // Third (open-ended) span from t1.
  assert.equal(spans[2].label, 'on');
  assert.equal(spans[2].start, t1);
});

test('haFoldSpan: empty history returns an empty array, no error', () => {
  const spans = haFoldSpan('e', [], 0, 1000);
  assert.deepEqual(spans, []);
});

// ── 2. jpHomeAssistant client over a stubbed fetch ──────────────────────────

const calls = [];
const pending = [];
let autoRespond = true;

function isoLocal(ms) { return new Date(ms).toISOString(); }

globalThis.fetch = function fetchStub(url, init) {
  calls.push({ url: String(url), method: init && init.method, headers: init && init.headers });
  const u = String(url);
  if (u.indexOf('/api/history/period') === -1) {
    return Promise.resolve({ status: 404, json: () => Promise.resolve({}) });
  }
  // Parse ISO range from the URL.
  const m = u.match(/\/api\/history\/period\/([^?]+)/);
  const fromIso = m ? decodeURIComponent(m[1]) : '';
  // Return a deterministic envelope: one numeric entity, one binary entity.
  const env = [
    [
      { entity_id: 'sensor.temp', state: '21.5', last_changed: isoLocal(Date.UTC(2026, 0, 1, 12, 0, 0)), attributes: { unit_of_measurement: '°C' } },
      { entity_id: 'sensor.temp', state: '22.1', last_changed: isoLocal(Date.UTC(2026, 0, 1, 12, 1, 0)), attributes: { unit_of_measurement: '°C' } },
    ],
    [
      { entity_id: 'binary_sensor.door', state: 'off', last_changed: isoLocal(Date.UTC(2026, 0, 1, 12, 0, 0)), attributes: { device_class: 'door' } },
      { entity_id: 'binary_sensor.door', state: 'on',  last_changed: isoLocal(Date.UTC(2026, 0, 1, 12, 0, 30)), attributes: { device_class: 'door' } },
    ],
  ];
  const resp = { status: 200, json: function () { return Promise.resolve(env); } };
  if (!autoRespond) {
    return new Promise(function (resolve) { pending.push({ response: resp, fromIso: fromIso, resolve: resolve }); });
  }
  return Promise.resolve(resp);
};

const { default: jpHomeAssistant, parseHAHistory } = await import('../src/jpHomeAssistant.js');

test('jpHomeAssistant sends Bearer auth and the right query string', async () => {
  autoRespond = true; calls.length = 0;
  const c = new jpHomeAssistant({ url: 'http://ha.local:8123', token: 'tok-1' });
  const from = Date.UTC(2026, 0, 1, 12, 0, 0);
  const to = from + 600000;
  await c.history(['sensor.temp', 'binary_sensor.door'], from, to);
  const call = calls[calls.length - 1];
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.Authorization, 'Bearer tok-1');
  assert.ok(call.url.indexOf('/api/history/period/') !== -1);
  assert.ok(call.url.indexOf('filter_entity_id=') !== -1);
  // URL normalised the comma back; compare against the decoded form.
  assert.ok(call.url.indexOf('sensor.temp,binary_sensor.door') !== -1);
});

test('parseHAHistory re-keys the envelope by entity_id', () => {
  const env = [
    [{ entity_id: 'a', state: '1', last_changed: 't1', attributes: {} }],
    [{ entity_id: 'b', state: 'on', last_changed: 't2', attributes: {} }],
  ];
  const out = parseHAHistory(env, ['a', 'b']);
  assert.equal(out.a.length, 1);
  assert.equal(out.a[0].state, '1');
  assert.equal(out.b[0].state, 'on');
});

test('parseHAHistory falls back to last_updated when last_changed is missing', () => {
  const env = [[{ entity_id: 'a', state: '1', last_updated: 't1', attributes: {} }]];
  const out = parseHAHistory(env, ['a']);
  assert.equal(out.a[0].last_changed, 't1');
});

test('basic auth is silently dropped with a warning (HA does not support it)', async () => {
  autoRespond = true; calls.length = 0;
  const prev = console.warn;
  let warned = false;
  console.warn = function (msg) { if (String(msg).indexOf('does not support basic auth') !== -1) warned = true; };
  try {
    const c = new jpHomeAssistant({ url: 'http://ha.local:8123', username: 'u', password: 'p' });
    await c.history(['sensor.x'], Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2));
    const call = calls[calls.length - 1];
    assert.ok(!call.headers || !call.headers.Authorization, 'no Authorization header');
    assert.ok(warned, 'warning was emitted');
  } finally {
    console.warn = prev;
  }
});

// ── 3. source end-to-end ─────────────────────────────────────────────────────

let hId = 0;
function haSource(extra) {
  return Object.assign({
    'source-type': 'home-assistant',
    url: 'http://ha.local:8123',
    token: 'tok',
    'entity-ids': ['sensor.temp', 'binary_sensor.door'],
  }, extra || {});
}
async function buildHA(src) {
  const id = 'ha-' + (hId++);
  makeCanvas(id);
  const ts = new TimeSeries({ canvas: id, sources: [src], initialView: null });
  await sleep(30);
  return ts;
}

const FROM = Date.UTC(2026, 0, 1, 12, 0, 0);
const TO = Date.UTC(2026, 0, 1, 13, 0, 0);

test('numeric entity → multiline block, binary entity → gantt block', async () => {
  autoRespond = true; calls.length = 0;
  const ts = await buildHA(haSource());
  await setView(ts, FROM, TO);
  const blocks = ts.getActiveData();
  const line = blocks.find(p => p.type === 'multiline' && p.category === 'point');
  const gantt = blocks.find(p => p.type === 'gantt' && p.category === 'span');
  assert.ok(line, 'numeric entity renders as multiline');
  assert.ok(gantt, 'binary entity renders as gantt');
  // Numeric block carries a single point in this small window.
  assert.ok(Array.isArray(line.data));
  assert.ok(line.data.length >= 1);
  // Gantt block has the entity's id in its lane label.
  assert.ok(gantt.lanes && gantt.lanes.length === 1);
  assert.equal(gantt.lanes[0].id, 'binary_sensor.door');
  assert.ok(gantt.data && gantt.data.length >= 1);
});

test('panning inside the padded window does not refetch', async () => {
  autoRespond = true; calls.length = 0;
  const ts = await buildHA(haSource());
  await setView(ts, FROM, TO);
  calls.length = 0;
  const span = TO - FROM;
  await setView(ts, FROM + span * 0.1, TO + span * 0.1);
  assert.equal(calls.length, 0, 'small pan inside ±50% served from cache');
});

test('an out-of-order response for a superseded window is dropped (seq guard)', async () => {
  // Switch to manual-response mode BEFORE building the chart, so the very
  // first refresh (issued synchronously by the source's init()) is queued
  // rather than auto-resolved. Then zoom to a disjoint viewport, which
  // queues a second fetch against the same seq counter.
  autoRespond = false;
  pending.length = 0;
  calls.length = 0;
  const id = 'ha-seq-' + (hId++);
  makeCanvas(id);
  const src = haSource({ 'entity-ids': ['sensor.tag_NEW', 'sensor.tag_OLD'] });
  const ts = new TimeSeries({ canvas: id, sources: [src], initialView: null });
  // Wait out the post-init throttle.
  await sleep(400);
  // Now zoom to a wide disjoint viewport — this triggers a second refresh,
  // which must supersede the still-pending first one.
  const F0 = Date.UTC(2026, 5, 1, 12, 0, 0), F1 = Date.UTC(2026, 5, 1, 13, 0, 0);
  await setView(ts, F0, F1);
  assert.ok(pending.length >= 2, 'at least two fetches queued (got ' + pending.length + ')');
  const older = pending[0], newer = pending[pending.length - 1];

  // Tag responses with distinct entities so we can see which one landed.
  const tagResp = function (p, marker) {
    const env = [[
      { entity_id: 'sensor.tag_' + marker, state: '1', last_changed: isoLocal(p.fromIso), attributes: {} },
    ]];
    p.resolve({ status: 200, json: function () { return Promise.resolve(env); } });
  };
  // Resolve NEWER first, then older — the older one must be dropped.
  tagResp(newer, 'NEW');
  await sleep(20);
  tagResp(older, 'OLD');
  autoRespond = true;
  await sleep(40);

  const blocks = ts.getData();
  const ids = new Set();
  for (const p of blocks) {
    if (!p) continue;
    if (p.category === 'point') for (const pt of p.data || []) if (pt && pt.values) for (const k of Object.keys(pt.values)) ids.add(k);
    else if (p.category === 'span') for (const s of p.data || []) if (s) ids.add(s.lane);
  }
  // The newer response set up `sensor.tag_NEW`; the older set up `sensor.tag_OLD`.
  // After seq-guard: NEW present, OLD absent.
  assert.ok([...ids].some(k => String(k).indexOf('NEW') !== -1), 'newer response entity is present');
  assert.ok(![...ids].some(k => String(k).indexOf('OLD') !== -1), 'older response entity was dropped');
});

test('an empty history array renders graceful empty blocks (no error)', async () => {
  autoRespond = true;
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (url) {
    calls.push({ url: String(url) });
    return Promise.resolve({ status: 200, json: () => Promise.resolve([[], []]) });
  };
  try {
    const ts = await buildHA(haSource());
    await setView(ts, FROM, TO);
    const blocks = ts.getActiveData();
    for (const p of blocks) {
      // Both renderers must render without throwing on empty data.
      if (p.category === 'point') {
        assert.equal(p.data.length, 0, 'empty numeric → empty point array');
      } else if (p.category === 'span') {
        assert.equal(p.data.length, 0, 'empty binary → empty span array');
      }
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('switching between numeric and span releases the old plotId', async () => {
  autoRespond = true; calls.length = 0;
  // First fetch returns a numeric-shaped value → numeric renderer.
  const origFetch = globalThis.fetch;
  let mode = 'numeric';
  globalThis.fetch = function (url, init) {
    calls.push({ url: String(url) });
    const env = mode === 'numeric'
      ? [[{ entity_id: 'sensor.flip', state: '1.0', last_changed: isoLocal(Date.UTC(2026, 0, 1, 12, 0, 0)), attributes: {} }]]
      : [[{ entity_id: 'sensor.flip', state: 'on',    last_changed: isoLocal(Date.UTC(2026, 0, 1, 12, 0, 0)), attributes: {} }]];
    return Promise.resolve({ status: 200, json: () => Promise.resolve(env) });
  };
  try {
    const ts = await buildHA(haSource({ 'entity-ids': ['sensor.flip'] }));
    await setView(ts, FROM, TO);
    let blocks = ts.getActiveData();
    let numeric = blocks.find(p => p.type === 'multiline' && p.category === 'point');
    assert.ok(numeric, 'first fetch is numeric');

    // Flip the state to 'on' and pan past the padded edge → refetch → span.
    mode = 'binary';
    await setView(ts, FROM - 7200000, TO - 7200000);
    blocks = ts.getActiveData();
    const span = blocks.find(p => p.type === 'gantt' && p.category === 'span');
    assert.ok(span, 'second fetch is span');
    // No leftover numeric block for the same entity.
    const stillNumeric = blocks.find(p => p.type === 'multiline' && p.category === 'point'
      && p.name && p.name.indexOf('sensor.flip') !== -1);
    assert.equal(stillNumeric, undefined, 'old numeric block was released');
  } finally {
    globalThis.fetch = origFetch;
  }
});
