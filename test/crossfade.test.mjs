// Resolution cross-fade: when two blocks of the same type differ only in
// `interval`, prepare_grid keeps both across a 2px→1px band of bar width and
// stamps `_fade` on each. Three layers are exercised:
//
//   1. plotData applies `_fade` via globalAlpha, for every renderer — this is
//      what gives multibar the dissolve quantile-bands already had;
//   2. prepare_grid interpolates the y-extent across the band, so a coarse tier
//      on a different value scale (a `sum` rollup) does not snap the axis;
//   3. the hit test follows the dominant tier, not activePlot order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { plotData } = await import('../src/renderers.js');

// ── 1. plotData applies _fade through globalAlpha ────────────────────────────

// A 2D context that records the alpha and style in force at each paint op.
// The Proxy context in helpers/dom.mjs is a pure no-op and cannot answer this.
function recorder() {
  const calls = [];
  const c = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect: (...args) => calls.push({ op: 'fillRect', alpha: c.globalAlpha, style: c.fillStyle, args }),
    fill: () => calls.push({ op: 'fill', alpha: c.globalAlpha, style: c.fillStyle }),
    stroke: () => calls.push({ op: 'stroke', alpha: c.globalAlpha, style: c.strokeStyle }),
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {},
  };
  return { c, calls };
}

function rctxFor(c) {
  return {
    c,
    X: t => t / 1000,
    Y: v => 100 - v,
    ppms: 1 / 1000, ppv: 1,
    margin: { left: 0, top: 0, right: 0, bottom: 0 },
    plotWidth: 1000, plotHeight: 100,
    hidden: new Set(),
  };
}

function bars(interval, fade, value = 5) {
  const p = { type: 'multibar', interval, interval_start: 0, data: { 0: { a: value } } };
  if (fade !== undefined) p._fade = fade;
  return p;
}

test('multibar draws at the block\'s _fade', () => {
  const { c, calls } = recorder();
  plotData([0], [bars(60, 0.4)], rctxFor(c));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].alpha, 0.4);
});

test('without _fade nothing is dimmed', () => {
  const { c, calls } = recorder();
  plotData([0], [bars(60)], rctxFor(c));
  assert.equal(calls[0].alpha, 1);
});

test('a fully faded-out block is not drawn at all', () => {
  const { c, calls } = recorder();
  plotData([0], [bars(60, 0)], rctxFor(c));
  assert.equal(calls.length, 0);
});

test('globalAlpha is restored after drawing', () => {
  const { c } = recorder();
  plotData([0], [bars(60, 0.4)], rctxFor(c));
  assert.equal(c.globalAlpha, 1);
});

test('the fainter block is painted first, whatever the push order', () => {
  // Pushed dominant-first: without an explicit order the 0.15 block would land
  // on top and wash out the one the user is actually meant to see.
  const { c, calls } = recorder();
  plotData([0, 1], [bars(3600, 0.85), bars(60, 0.15)], rctxFor(c));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].alpha, 0.15);
  assert.equal(calls[1].alpha, 0.85);
});

test('multiline and multipoint are faded too, without knowing about _fade', () => {
  for (const type of ['multiline', 'multipoint']) {
    const { c, calls } = recorder();
    const p = bars(60, 0.3);
    p.type = type;
    p.data = { 0: { a: 5 }, 1: { a: 7 } };
    plotData([0], [p], rctxFor(c));
    assert.ok(calls.length > 0, type + ' drew nothing');
    for (const call of calls) assert.equal(call.alpha, 0.3, type + ' ignored _fade');
  }
});

test('quantile-bands keeps its own band/median alphas, faded via globalAlpha', () => {
  const { c, calls } = recorder();
  const p = {
    type: 'quantile-bands', interval: 3600, interval_start: 0,
    percentiles: ['min', 'avg', 'max'], _fade: 0.5,
    data: { 0: { a: [1, 2, 3] }, 1: { a: [2, 3, 4] } },
  };
  plotData([0], [p], rctxFor(c));
  for (const call of calls) assert.equal(call.alpha, 0.5);
  // The median line is still drawn at its own 0.9 — the fade must not have
  // been folded into the colour, or it would double up with globalAlpha.
  const strokes = calls.filter(k => k.op === 'stroke').map(k => k.style);
  assert.ok(strokes.some(s => s.endsWith(',0.9)')), 'median stroke alpha: ' + strokes);
  assert.ok(strokes.some(s => s.endsWith(',0.55)')), 'outer stroke alpha: ' + strokes);
});

// ── 2 & 3. axis interpolation and hit test, on a real instance ───────────────

// Two multibar tiers of the same signal on deliberately different value scales
// (a `sum` rollup would look like this): fine bars are worth 1, hourly bars 60.
const START_S = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const DAYS = 4;
const MID_MS = (START_S + DAYS * 86400 / 2) * 1000;
const FINE_V = 1, COARSE_V = 60;

function tier(interval, value) {
  const data = {};
  for (let i = 0; i < (DAYS * 86400) / interval; i++) data[i] = { a: value };
  return {
    'source-type': 'artificial', type: 'multibar', name: 'm',
    interval, interval_start: START_S, data, min: 0, max: value,
  };
}

let nextId = 0;
async function build(opts) {
  const id = 'xfade-' + (nextId++);
  const canvas = makeCanvas(id);
  const ts = new TimeSeries(Object.assign({
    canvas: id,
    sources: [tier(3600, COARSE_V), tier(60, FINE_V)],   // coarse pushed first
    initialView: null,
  }, opts));
  await setView(ts, MID_MS - 6e6, MID_MS + 6e6);         // settle the margins
  return { ts, canvas, plotWidth: ts.getPlotArea().plotWidth };
}

// Window width (ms) that makes the fine (60s) bucket exactly `px` pixels wide.
const widthForFinePx = (pw, px) => (60 * 1000 * pw) / px;
const centred = (w) => [MID_MS - w / 2, MID_MS + w / 2];

async function atFinePx(px, opts) {
  const built = await build(opts);
  const [a, b] = centred(widthForFinePx(built.plotWidth, px));
  await setView(built.ts, a, b);
  return built;
}

test('outside the band the axis belongs to the single visible tier', async () => {
  const zoomedIn = await atFinePx(5);
  assert.equal(zoomedIn.ts.getActiveData().length, 1);
  assert.equal(zoomedIn.ts.getValueRange().ymax, FINE_V);

  const zoomedOut = await atFinePx(0.3);
  assert.equal(zoomedOut.ts.getActiveData().length, 1);
  assert.equal(zoomedOut.ts.getValueRange().ymax, COARSE_V);
});

test('inside the band the axis interpolates by the same progress as the alphas', async () => {
  const { ts } = await atFinePx(1.5);
  const active = ts.getActiveData();
  const fine = active.find(p => p.interval === 60);
  const coarse = active.find(p => p.interval === 3600);
  assert.ok(fine && coarse, 'both tiers active');

  // Were the extents left alone, the ratio-weighted blend downstream would pick
  // the taller tier outright and ymax would already sit at COARSE_V here.
  const expected = coarse._fade * COARSE_V + fine._fade * FINE_V;
  const ymax = ts.getValueRange().ymax;
  assert.ok(Math.abs(ymax - expected) < 1e-6, `ymax ${ymax}, expected ${expected}`);
  assert.ok(ymax > FINE_V && ymax < COARSE_V, 'axis is genuinely mid-way');
});

test('the axis travels monotonically across the band instead of snapping', async () => {
  const early = (await atFinePx(1.8)).ts.getValueRange().ymax;
  const mid   = (await atFinePx(1.5)).ts.getValueRange().ymax;
  const late  = (await atFinePx(1.2)).ts.getValueRange().ymax;
  assert.ok(early < mid && mid < late, `${early} < ${mid} < ${late}`);
  assert.ok(early > FINE_V && late < COARSE_V, 'never reaches either end inside the band');
});

// ── 4. the band is configurable ──────────────────────────────────────────────
//
// A host that decides for itself which tier to *fetch* has a switch threshold of
// its own; unless the canvas switches on the same number it renders one tier
// while the host keeps the other one topped up.

const WIDE = { fadeHi: 6, fadeLo: 3 };

test('a widened band moves the switch point, not just its width', async () => {
  // 5px: inside the widened band, but well clear of the default 2px→1px one.
  assert.equal((await atFinePx(5)).ts.getActiveData().length, 1, 'default band');
  const wide = await atFinePx(5, WIDE);
  assert.equal(wide.ts.getActiveData().length, 2);
  const fine = wide.ts.getActiveData().find(p => p.interval === 60);
  // fadeProg = (6 - 5) / (6 - 3) → the coarse tier is a third of the way in.
  assert.ok(Math.abs(fine._fade - 2 / 3) < 1e-6, 'fine _fade ' + fine._fade);
});

test('either side of a widened band a single tier stands alone', async () => {
  const above = await atFinePx(7, WIDE);
  assert.equal(above.ts.getActiveData().length, 1);
  assert.equal(above.ts.getActiveData()[0].interval, 60);

  const below = await atFinePx(2, WIDE);
  assert.equal(below.ts.getActiveData().length, 1);
  assert.equal(below.ts.getActiveData()[0].interval, 3600);
});

test('setFadeBand re-decides the tiers at the current zoom', async () => {
  // A host learns its threshold from the server, long after construction.
  const { ts } = await atFinePx(5);
  assert.equal(ts.getActiveData().length, 1);
  ts.setFadeBand(6, 3);
  assert.equal(ts.getActiveData().length, 2);
  ts.setFadeBand(2, 1);
  assert.equal(ts.getActiveData().length, 1);
});

test('setFadeBand refuses a band that would poison globalAlpha', async () => {
  const { ts } = await atFinePx(5, WIDE);
  const before = ts.getActiveData().length;
  for (const bad of [[3, 6], [6, 6], [6, 0], [6, -1], [NaN, 1], [6, 'x']]) {
    ts.setFadeBand(bad[0], bad[1]);
    assert.equal(ts.getActiveData().length, before, 'accepted ' + JSON.stringify(bad));
  }
  for (const p of ts.getActiveData()) assert.ok(p._fade >= 0 && p._fade <= 1, '_fade ' + p._fade);
});

// Hover the bottom of the plot, where a bar of either tier is present, and see
// which block the hover contract reports.
async function hoveredIntervalAt(px) {
  const { ts, canvas } = await atFinePx(px);
  const area = ts.getPlotArea();
  let hovered = null;
  ts.onHoverDataCallback(plot => { hovered = plot; });
  canvas.onmousemove({
    clientX: area.margin.left + area.plotWidth / 2,
    clientY: area.margin.top + area.plotHeight - 2,
  });
  return hovered && hovered.interval;
}

test('mid-fade only the dominant tier is hittable', async () => {
  // fine _fade 0.8 → the fine block answers the hover…
  assert.equal(await hoveredIntervalAt(1.8), 60);
  // …and once it has faded to 0.2 the coarse one does.
  assert.equal(await hoveredIntervalAt(1.2), 3600);
});
