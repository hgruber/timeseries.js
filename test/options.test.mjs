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

// ── panSnap ───────────────────────────────────────────────────────────────────
test('panSnap defaults to grid and round-trips through the setter', () => {
  const ts = build();
  assert.equal(ts.getPanSnap(), 'grid');

  ts.setPanSnap('off');
  assert.equal(ts.getPanSnap(), 'off');

  ts.setPanSnap('grid');
  assert.equal(ts.getPanSnap(), 'grid');
});

test('panSnap can be set from the constructor', () => {
  assert.equal(build({ panSnap: 'off' }).getPanSnap(), 'off');
});

// An unusable mode must not reach the navigation code, where it would silently
// behave like 'grid' and leave the caller wondering.
test('setPanSnap rejects anything that is not a mode', () => {
  const ts = build();
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    for (const bad of ['on', true, null, 1, 'GRID']) {
      ts.setPanSnap(bad);
      assert.equal(ts.getPanSnap(), 'grid', `${String(bad)} must be refused`);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warned, 5, 'each refusal should say so');
});

// ── initialView window ────────────────────────────────────────────────────────
// The window form of initialView is the starcubes case: a host computes its own
// [tmin, tmax] from data-source metadata and wants that window on screen before
// the first paint — `initialView: 'last24'` would brief-case the last 24h in
// first and animate to the real window afterwards.
test('initialView: [tmin, tmax] is applied synchronously, before the first paint', () => {
  const t0 = Date.UTC(2026, 4, 11), t1 = Date.UTC(2026, 4, 18);
  const ts = build({ initialView: [t0, t1] });
  // No `await` — the contract is "before the first paint", i.e. before the
  // constructor returns. A refactor that defers this would slip past every
  // test that does sleep() first.
  const vp = ts.getViewport();
  assert.equal(vp.tmin, t0);
  assert.equal(vp.tmax, t1);
  assert.ok(vp.ppms > 0, 'ppms must reflect the new window, not the 24h default');
});

test('initialView: [tmin, tmax] also accepts Date objects', () => {
  const t0 = Date.UTC(2026, 4, 11), t1 = Date.UTC(2026, 4, 18);
  const ts = build({ initialView: [new Date(t0), new Date(t1)] });
  const vp = ts.getViewport();
  assert.equal(vp.tmin, t0);
  assert.equal(vp.tmax, t1);
});

test('initialView: null keeps the 24h default window', () => {
  const ts = build({ initialView: null });
  const vp = ts.getViewport();
  assert.ok(Math.abs((vp.tmax - vp.tmin) - 86400000) < 1000,
    `expected ~24h, got ${vp.tmax - vp.tmin} ms`);
});

test('initialView: [tmin, tmax] falls back to 24h on malformed input', () => {
  const cases = [
    [1, 2, 3],                   // wrong length
    [Date.UTC(2026, 4, 18), Date.UTC(2026, 4, 11)],  // tmax < tmin
    [NaN, Date.UTC(2026, 4, 18)], // NaN in tmin
    [Date.UTC(2026, 4, 11), NaN], // NaN in tmax
  ];
  for (const bad of cases) {
    const ts = build({ initialView: bad });
    const vp = ts.getViewport();
    assert.ok(Math.abs((vp.tmax - vp.tmin) - 86400000) < 1000,
      `${JSON.stringify(bad)} should fall back to 24h, got ${vp.tmax - vp.tmin} ms`);
  }
});

// ── follow option ─────────────────────────────────────────────────────────────
// `follow` is deferred (not synchronous like the window): onStop/onFollow
// callbacks are registered after the constructor returns, and firing them is
// half the point — a host's follow toggle syncs itself from them.
test('follow: false fires onStop after construction', async () => {
  const ts = build({ follow: false });
  let stopCount = 0;
  ts.onStop(() => { stopCount++; });
  await sleep(30);
  assert.equal(stopCount, 1, 'onStop must fire once when follow:false is set');
});

test('follow: true preserves the explicit initialView window width', async () => {
  const t0 = Date.UTC(2026, 4, 11), t1 = Date.UTC(2026, 4, 18);
  const range = t1 - t0;
  const ts = build({ initialView: [t0, t1], follow: true });
  let followPct = null;
  ts.onFollow(p => { followPct = p; });
  await sleep(30);
  assert.notEqual(followPct, null, 'onFollow must fire');
  const vp = ts.getViewport();
  assert.equal(vp.tmax - vp.tmin, range,
    'window width must be preserved across follow:true');
  // The derived fraction is (now − tmin) / (t1 − t0); now > t1 (test runs after
  // Date.UTC was passed), so it's clamped to 100.
  assert.equal(followPct, 100);
});

test('follow: true + a named view fires onFollow after the animation', async () => {
  const ts = build({ initialView: 'today', follow: true, zoomDuration: 0 });
  let followPct = null;
  ts.onFollow(p => { followPct = p; });
  await sleep(30);
  assert.notEqual(followPct, null,
    'onFollow must fire even though `today` calls doStop() — follow overrides it');
});

test('follow: 0 reports a fraction of 0', async () => {
  const ts = build({ follow: 0 });
  let followPct = null;
  ts.onFollow(p => { followPct = p; });
  await sleep(30);
  assert.equal(followPct, 0);
});

test('absent follow does not fire onStop or onFollow', async () => {
  const ts = build({});
  let stopCount = 0, followCount = 0;
  ts.onStop(() => { stopCount++; });
  ts.onFollow(() => { followCount++; });
  await sleep(30);
  assert.equal(stopCount, 0);
  assert.equal(followCount, 0);
});
