// Covers the constructor's option handling and the module-level statics —
// both were defect-prone in ways a caller hits immediately: a partial `colors`
// override used to wipe the rest of the palette, and TimeSeries.registerSource
// did not exist until the first instance had been built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, sleep } from './helpers/dom.mjs';

installDOM();

const mod = await import('../src/timeseries.js');
const TimeSeries = mod.default;

let nextId = 0;
const build = opts => {
  const canvasId = 'opts-test-' + (nextId++);
  makeCanvas(canvasId);
  return new TimeSeries(Object.assign({ canvas: canvasId, sources: [], initialView: null }, opts));
};

// ── Statics ───────────────────────────────────────────────────────────────────
// These are read straight off the imported module, before any instance exists.
test('statics are available without constructing an instance first', () => {
  assert.equal(typeof TimeSeries.registerRenderer, 'function');
  assert.equal(typeof TimeSeries.registerSource, 'function');
  assert.equal(typeof TimeSeries.seriesColor, 'function');
  assert.equal(typeof TimeSeries.lttb, 'function');
  assert.equal(typeof TimeSeries.siFormat, 'function');
  assert.ok(TimeSeries.themes && TimeSeries.themes.light);
});

// ── colors merge ──────────────────────────────────────────────────────────────
test('a partial colors override keeps the rest of the palette', () => {
  const ts = build({ colors: { text: '#ff0000' } });
  const colors = ts.getColors();
  assert.equal(colors.text, '#ff0000');
  // Everything else must still be defined — an undefined value reaches the
  // canvas as an invalid fillStyle.
  for (const key of Object.keys(TimeSeries.themes.light))
    assert.notEqual(colors[key], undefined, `colors.${key} was dropped`);
});

test('one instance overriding colors does not affect another', () => {
  const a = build({ colors: { text: '#111111' } });
  const b = build({});
  assert.equal(a.getColors().text, '#111111');
  assert.equal(b.getColors().text, TimeSeries.themes.light.text);
});

test('overriding colors does not mutate the shared light theme', () => {
  const before = TimeSeries.themes.light.text;
  build({ colors: { text: '#abcdef' } });
  assert.equal(TimeSeries.themes.light.text, before);
});

// ── holidays ──────────────────────────────────────────────────────────────────
test('holiday keys are strings, so October dates survive', () => {
  const ts = build({});
  const keys = Object.keys(ts.getHolidays());
  // "3.10" must stay distinct from "3.1"; an unquoted 3.10 would collapse to it.
  assert.ok(keys.includes('3.10'), 'German Unity Day key was normalised away');
  assert.ok(keys.includes('1.1'));
  assert.ok(keys.includes('-2'), 'Easter-relative keys must be preserved');
});

test('holidays are replaced wholesale, not merged', () => {
  const ts = build({ holidays: { '14.7': 'Fête nationale' } });
  const h = ts.getHolidays();
  assert.equal(h['14.7'], 'Fête nationale');
  assert.equal(h['1.1'], undefined, 'German defaults should not leak through');
});

// ── zoom duration ─────────────────────────────────────────────────────────────
test('zoom with duration 0 jumps immediately instead of animating', async () => {
  const ts = build({});
  const t0 = Date.UTC(2026, 4, 11), t1 = Date.UTC(2026, 4, 18);
  ts.zoom(t0, t1, 0);
  await sleep(30);            // far shorter than the 500ms default
  const vp = ts.getViewport();
  assert.equal(vp.tmin, t0);
  assert.equal(vp.tmax, t1);
});

test('zoom with duration 0 never produces NaN', async () => {
  const ts = build({});
  ts.zoom(Date.UTC(2026, 4, 11), Date.UTC(2026, 4, 18), 0);
  await sleep(30);
  const vp = ts.getViewport();
  assert.ok(Number.isFinite(vp.tmin), 'tmin is not finite');
  assert.ok(Number.isFinite(vp.tmax), 'tmax is not finite');
});

test('zoom without a duration still animates', async () => {
  const ts = build({});
  const t0 = Date.UTC(2026, 4, 11), t1 = Date.UTC(2026, 4, 18);
  await sleep(10);
  ts.zoom(t0, t1);
  await sleep(30);            // mid-flight for the 500ms default
  const mid = ts.getViewport();
  assert.notEqual(mid.tmin, t0, 'should not have arrived yet');
  await sleep(700);
  assert.equal(ts.getViewport().tmin, t0, 'should have arrived by now');
});

// ── siFormat ──────────────────────────────────────────────────────────────────
test('siFormat applies SI prefixes and trims trailing .0', () => {
  const f = TimeSeries.siFormat;
  assert.equal(f(0), '0');
  assert.equal(f(999), '999');
  assert.equal(f(1000), '1k');
  assert.equal(f(1500), '1.5k');
  assert.equal(f(2.5e6), '2.5M');
  assert.equal(f(3e9), '3G');
  assert.equal(f(4e12), '4T');
  assert.equal(f(-1500), '-1.5k');
});
