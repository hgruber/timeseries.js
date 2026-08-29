// The area family — multiline's `step`/`fill` options, the stackarea renderer —
// and the ohlc bar, plus the core plumbing they share.
//
// The load-bearing assertion here is the stackarea y-extent one: a stacked type
// that fails to declare `stacked: true` is measured as if each series stood on
// its own, so the axis stops well below the top of the stack and the chart is
// silently clipped. That is the same class of silent failure `values: 'array'`
// exists to prevent, which is why it gets the same kind of test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { plotData, isStackedType, isBandedType } = await import('../src/renderers.js');

// ── A recording 2D context ───────────────────────────────────────────────────
// Same reason as in ladder-types.test.mjs: the Proxy context in helpers/dom.mjs
// is a no-op and can report neither coordinates nor alpha.
function recorder() {
  const calls = [];
  const rec = (op, args) => calls.push({
    op, args,
    alpha: c.globalAlpha, fill: c.fillStyle, stroke: c.strokeStyle,
  });
  const c = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect: (...a) => rec('fillRect', a),
    strokeRect: (...a) => rec('strokeRect', a),
    moveTo: (...a) => rec('moveTo', a),
    lineTo: (...a) => rec('lineTo', a),
    fill: () => rec('fill', []),
    stroke: () => rec('stroke', []),
    beginPath() {}, closePath() {}, arc() {},
  };
  return { c, calls };
}

// X: 1px per second, Y: value v at pixel 100 - v. Interval 100 makes a bin
// exactly 100px wide, so slot n starts at x = 100n and every expectation below
// is readable arithmetic instead of a magic number.
function rctxFor(c, hidden) {
  return {
    c,
    X: t => t / 1000,
    Y: v => 100 - v,
    ppms: 1 / 1000, ppv: 1,
    margin: { left: 0, top: 0, right: 0, bottom: 0 },
    plotWidth: 1000, plotHeight: 100,
    hidden: hidden || new Set(),
  };
}

const IV = 100;

const draw = (plot, hidden) => {
  const { c, calls } = recorder();
  plotData([0], [plot], rctxFor(c, hidden));
  return calls;
};

// Path vertices in order, as "op x,y" strings — the whole point of these tests
// is the shape of the traced path, and comparing strings makes a failure legible.
const path = calls => calls
  .filter(k => k.op === 'moveTo' || k.op === 'lineTo')
  .map(k => `${k.op} ${k.args[0]},${k.args[1]}`);

function lineBlock(extra) {
  return Object.assign({
    type: 'multiline', interval: IV, interval_start: 0,
    data: { 0: { a: 1 }, 1: { a: 2 } },
  }, extra);
}

// ── 1. multiline: step ───────────────────────────────────────────────────────

test('multiline interpolates between slots by default', () => {
  assert.deepEqual(path(draw(lineBlock())), [
    'moveTo 0,99',
    'lineTo 100,98',
  ]);
});

test("step 'after' holds each value across its own bin, last bin included", () => {
  // The trailing lineTo to x=200 is the point: slot 1's value owns the whole
  // bin, so the staircase has to cross it rather than stop on its left edge.
  assert.deepEqual(path(draw(lineBlock({ step: 'after' }))), [
    'moveTo 0,99',
    'lineTo 100,99',
    'lineTo 100,98',
    'lineTo 200,98',
  ]);
});

test("step 'before' raises the value at the previous point", () => {
  assert.deepEqual(path(draw(lineBlock({ step: 'before' }))), [
    'moveTo 0,99',
    'lineTo 0,98',
    'lineTo 100,98',
  ]);
});

test('an unrecognised step value falls back to interpolation', () => {
  assert.deepEqual(path(draw(lineBlock({ step: 'sideways' }))), [
    'moveTo 0,99',
    'lineTo 100,98',
  ]);
});

test('a line bridges a gap in the slot numbering, as it always has', () => {
  // Deliberately NOT a break: multiline is the interpolating renderer and
  // quantile-bands does the same. What breaks a line is a missing *value* in a
  // slot that exists (below); an absent slot is simply not a vertex. The filled
  // forms — stackarea here, quantile-steps already — do break on it, because a
  // shaded region across unmeasured time asserts far more than a line does.
  const calls = draw(lineBlock({ data: { 0: { a: 1 }, 2: { a: 3 } } }));
  assert.deepEqual(path(calls), ['moveTo 0,99', 'lineTo 200,97']);
});

test('an explicit null breaks the line instead of diving to zero', () => {
  // The binned branch used to break only on `undefined`, so a null was drawn as
  // Y(0) — a spike to the axis that looks like real data.
  const calls = draw(lineBlock({ data: { 0: { a: 1 }, 1: { a: null }, 2: { a: 3 } } }));
  assert.deepEqual(path(calls), ['moveTo 0,99', 'moveTo 200,97']);
  assert.ok(!path(calls).some(p => p.endsWith(',100')), 'drew a point on the zero line');
});

// ── 2. multiline: fill ───────────────────────────────────────────────────────

test('fill closes the run down to the zero line and paints under the stroke', () => {
  const calls = draw(lineBlock({ fill: true }));
  const fills = calls.filter(k => k.op === 'fill');
  assert.equal(fills.length, 1);
  // Y(0) is 100 here, inside the plot box, so the fill closes on it.
  assert.deepEqual(path(calls).slice(0, 4), [
    'moveTo 0,99',
    'lineTo 100,98',
    'lineTo 100,100',
    'lineTo 0,100',
  ]);
  // …and the stroke comes after the fill, or the area would cover the line.
  const iFill = calls.findIndex(k => k.op === 'fill');
  const iStroke = calls.findIndex(k => k.op === 'stroke');
  assert.ok(iFill < iStroke, 'stroke was painted before its own fill');
});

test('fill clamps to the plot box when the zero line is off-screen', () => {
  // Y(0) = 100 sits below plotHeight 40, so the fill must stop at the box edge
  // instead of painting down through the axis and the bottom margin.
  const { c, calls } = recorder();
  const rctx = rctxFor(c);
  rctx.plotHeight = 40;
  plotData([0], [lineBlock({ fill: true })], rctx);
  // Only the two closing edges are clamped — the data vertices stay where the
  // value puts them, exactly as every other renderer leaves them.
  assert.deepEqual(path(calls).slice(2, 4), ['lineTo 100,40', 'lineTo 0,40']);
});

test('fill combines with step', () => {
  const calls = draw(lineBlock({ fill: true, step: 'after' }));
  // Closes from the staircase's true end (x=200), not from the last bin start.
  assert.deepEqual(path(calls).slice(0, 6), [
    'moveTo 0,99',
    'lineTo 100,99',
    'lineTo 100,98',
    'lineTo 200,98',
    'lineTo 200,100',
    'lineTo 0,100',
  ]);
});

// ── 3. stackarea ─────────────────────────────────────────────────────────────

function stackBlock(extra) {
  return Object.assign({
    type: 'stackarea', interval: IV, interval_start: 0,
    data: { 0: { a: 1, b: 2 }, 1: { a: 2, b: 3 } },
  }, extra);
}

test('stackarea stacks each series on the running total', () => {
  const calls = draw(stackBlock());
  assert.equal(calls.filter(k => k.op === 'fill').length, 2, 'one band per series');
  const p = path(calls);
  // Band a: 0 → 1 and 0 → 2. Top edge forward, bottom edge back.
  assert.deepEqual(p.slice(0, 4), [
    'moveTo 0,99', 'lineTo 100,98',   // top:  a = 1, 2
    'lineTo 100,100', 'lineTo 0,100', // base: 0, 0
  ]);
  // Band b sits *on* a: 1+2 = 3 and 2+3 = 5, with a's top as its own base.
  assert.deepEqual(p.slice(4, 8), [
    'moveTo 0,97', 'lineTo 100,95',
    'lineTo 100,98', 'lineTo 0,99',
  ]);
});

test('hiding a series removes it from the stack rather than leaving a hole', () => {
  const p = path(draw(stackBlock(), new Set(['a'])));
  // b now stands on the zero line: 2 and 3, not 3 and 5.
  assert.deepEqual(p, [
    'moveTo 0,98', 'lineTo 100,97',
    'lineTo 100,100', 'lineTo 0,100',
  ]);
});

test('stackarea treats a missing series as zero without tearing the stack', () => {
  // b is absent from slot 1. The band pinches shut there; it must not start a
  // new run, or the series above it would break too.
  const calls = draw(stackBlock({ data: { 0: { a: 1, b: 2 }, 1: { a: 2 } } }));
  assert.equal(calls.filter(k => k.op === 'fill').length, 2);
  const p = path(calls);
  assert.deepEqual(p.slice(4, 8), [
    'moveTo 0,97', 'lineTo 100,98',   // b: 1+2 = 3, then 2+0 = 2 (flat on a)
    'lineTo 100,98', 'lineTo 0,99',
  ]);
});

test('stackarea breaks every band at the same slot gap', () => {
  const calls = draw(stackBlock({ data: { 0: { a: 1, b: 2 }, 2: { a: 2, b: 3 } } }));
  // Two runs per series, two series → four filled polygons.
  assert.equal(calls.filter(k => k.op === 'fill').length, 4);
});

test('stackarea draws nothing when every series is hidden', () => {
  const calls = draw(stackBlock(), new Set(['a', 'b']));
  assert.equal(calls.filter(k => k.op === 'fill').length, 0);
});

// ── 4. ohlc ──────────────────────────────────────────────────────────────────

test('ohlc draws a high-low bar with open left and close right', () => {
  const calls = draw({
    type: 'ohlc', interval: IV, interval_start: 0,
    percentiles: ['o', 'h', 'l', 'c'],
    roles: { open: 0, high: 1, low: 2, close: 3 },
    data: { 0: { a: [10, 20, 5, 15] } },
  });
  // One series → the bin is not dodged: cx = 50, tick width = 100 * 0.35.
  assert.deepEqual(path(calls), [
    'moveTo 50,95', 'lineTo 50,80',   // wick: low 5 → high 20
    'moveTo 15,90', 'lineTo 50,90',   // open 10, ticked to the left
    'moveTo 50,85', 'lineTo 85,85',   // close 15, ticked to the right
  ]);
});

test('ohlc colours the bar by direction when candleColors is given', () => {
  const bar = dir => draw({
    type: 'ohlc', interval: IV, interval_start: 0,
    percentiles: ['o', 'h', 'l', 'c'],
    roles: { open: 0, high: 1, low: 2, close: 3 },
    candleColors: { up: '#00ff00', down: '#ff0000' },
    data: { 0: { a: dir } },
  }).find(k => k.op === 'stroke');
  assert.equal(bar([10, 20, 5, 15]).stroke, '#00ff00');   // close above open
  assert.equal(bar([15, 20, 5, 10]).stroke, '#ff0000');   // close below open
});

test('ohlc without roles reads open and close off the ladder', () => {
  // [min, avg, max] has a single pair, so there is no separate wick — the bar
  // is just the two ticks over that pair.
  const p = path(draw({
    type: 'ohlc', interval: IV, interval_start: 0,
    percentiles: ['min', 'avg', 'max'],
    data: { 0: { a: [1, 2, 3] } },
  }));
  assert.deepEqual(p, [
    'moveTo 15,99', 'lineTo 50,99',
    'moveTo 50,97', 'lineTo 85,97',
  ]);
});

test('ohlc is declared array-valued, so the core measures it as a ladder', () => {
  assert.equal(isBandedType('ohlc'), true);
});

// ── 5. The registry declaration ──────────────────────────────────────────────

test('isStackedType reports exactly the types that sum their series', () => {
  assert.equal(isStackedType('multibar'), true);
  assert.equal(isStackedType('stackarea'), true);
  assert.equal(isStackedType('multiline'), false);
  assert.equal(isStackedType('quantile-bands'), false);
  assert.equal(isStackedType('nonesuch'), false);
});

test('registering over a type clears a stacked declaration it no longer makes', () => {
  const { registerRenderer } = TimeSeries;
  registerRenderer({ type: 'tmp-stacked', draw() {}, stacked: true });
  assert.equal(TimeSeries.isStackedType('tmp-stacked'), true);
  registerRenderer({ type: 'tmp-stacked', draw() {} });
  assert.equal(TimeSeries.isStackedType('tmp-stacked'), false);
});

// ── 6. Through a real instance: the y-extent ─────────────────────────────────

const START = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const SLOTS = 12;

function scalarSource(type, extra) {
  const data = {};
  for (let i = 0; i < SLOTS; i++) data[i] = { a: 10, b: 20 };
  return Object.assign({
    'source-type': 'artificial', type, name: 'area',
    interval_start: START, interval: 3600, count: SLOTS,
    interval_end: START + SLOTS * 3600,
    data,
    // Deliberately wrong, same trap as in ladder-types.test.mjs: the extent is
    // supposed to come from the slots in the viewport, so if the scan ever
    // stops covering this type, prepare_grid falls back to this number and the
    // silent failure becomes a loud one.
    min: 0, max: 999,
  }, extra);
}

let nextId = 0;
async function build(sources) {
  const id = 'area-' + (nextId++);
  makeCanvas(id);
  const ts = new TimeSeries({ canvas: id, sources, initialView: null });
  await setView(ts, START * 1000, (START + SLOTS * 3600) * 1000);
  return ts;
}

test('stackarea drives the y-extent from the stacked total', async () => {
  // 10 + 20. Without `stacked: true` this comes out 20 and the top of every
  // stack is drawn above the axis — the whole reason the flag is declared.
  const ts = await build([scalarSource('stackarea')]);
  assert.equal(ts.getValueRange().ymax, 30);
});

test('multiline with the same data is measured un-stacked', async () => {
  const ts = await build([scalarSource('multiline')]);
  assert.equal(ts.getValueRange().ymax, 20);
});

test('hiding a series lowers a stackarea extent by that series', async () => {
  const ts = await build([scalarSource('stackarea')]);
  ts.setSeriesHidden('b', true);
  ts.redraw();
  assert.equal(ts.getValueRange().ymax, 10);
});

test('overlapping stackarea blocks concatenate instead of discarding the older', async () => {
  const a = scalarSource('stackarea');
  const b = scalarSource('stackarea', { interval_start: START + 5 * 3600 });
  b.interval_end = START + 17 * 3600;
  const ts = await build([a, b]);
  const older = ts.getActiveData().find(p => p.interval_start === START);
  assert.ok(older, 'the older block was released instead of trimmed');
  assert.equal(older.count, 5);
});

test('a stackarea plot reports its series to the legend', async () => {
  const ts = await build([scalarSource('stackarea')]);
  assert.deepEqual(ts.getSeries().map(s => s.id).sort(), ['a', 'b']);
});
