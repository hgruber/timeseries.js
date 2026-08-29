// The waterfall renderer: a running total broken into its contributions.
//
// The interesting part is not the geometry but *where the running total starts*.
// It accumulates from the block's first slot, never from the viewport edge —
// otherwise the zero point, and with it every bar, would move as the user pans.
// The y-extent and the hit test both have to agree with the renderer on those
// levels, which is why all three read the same waterfallLevels().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { plotData, waterfallLevels, isCumulativeType } =
  await import('../src/renderers.js');

function recorder() {
  const calls = [];
  const rec = (op, args) => calls.push({ op, args, fill: c.fillStyle, stroke: c.strokeStyle });
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

// X: 1px per second, Y: value v at pixel 100 - v; interval 100 → a 100px bin.
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

function wfBlock(extra) {
  return Object.assign({
    type: 'waterfall', interval: IV, interval_start: 0,
    // +10, +5, -8  →  levels 0→10, 10→15, 15→7
    data: { 0: { a: 10 }, 1: { a: 5 }, 2: { a: -8 } },
  }, extra);
}

const draw = (plot, hidden) => {
  const { c, calls } = recorder();
  plotData([0], [plot], rctxFor(c, hidden));
  return calls;
};

const bars = calls => calls.filter(k => k.op === 'fillRect').map(k => k.args.join(','));

// ── 1. The levels ────────────────────────────────────────────────────────────

test('each bar starts where the previous one ended', () => {
  const lv = waterfallLevels(wfBlock());
  assert.deepEqual(lv[0].a, { base: 0, top: 10, total: false });
  assert.deepEqual(lv[1].a, { base: 10, top: 15, total: false });
  assert.deepEqual(lv[2].a, { base: 15, top: 7, total: false });
});

test('a totals slot restates the running sum from zero and consumes nothing', () => {
  // Slot 2 is a subtotal: it spans 0…15 (the sum so far) and slot 3 carries on
  // from 15, not from 30 — a total that consumed its own value would double it.
  const lv = waterfallLevels(wfBlock({
    data: { 0: { a: 10 }, 1: { a: 5 }, 2: { a: 0 }, 3: { a: 4 } },
    totals: [2],
  }));
  assert.deepEqual(lv[2].a, { base: 0, top: 15, total: true });
  assert.deepEqual(lv[3].a, { base: 15, top: 19, total: false });
});

test('the running total ignores a slot the series is missing from', () => {
  const lv = waterfallLevels(wfBlock({
    data: { 0: { a: 10 }, 1: { b: 99 }, 2: { a: 5 } },
  }));
  assert.equal(lv[1].a, undefined);
  assert.deepEqual(lv[2].a, { base: 10, top: 15, total: false });
});

test('each series accumulates its own running total', () => {
  const lv = waterfallLevels(wfBlock({
    data: { 0: { a: 10, b: 1 }, 1: { a: 5, b: 2 } },
  }));
  assert.deepEqual(lv[1].a, { base: 10, top: 15, total: false });
  assert.deepEqual(lv[1].b, { base: 1, top: 3, total: false });
});

test('waterfallLevels does not mutate the block', () => {
  const plot = wfBlock();
  const before = JSON.stringify(plot);
  waterfallLevels(plot);
  assert.equal(JSON.stringify(plot), before);
});

// ── 2. What it paints ────────────────────────────────────────────────────────

test('a bar is drawn between its own two levels, not up from zero', () => {
  // Bin 1 spans x 100…200, one series → bar width 70% of 100, centred: x 115.
  // Levels 10→15 → y from Y(15)=85, height 5.
  assert.ok(bars(draw(wfBlock())).includes('115,85,70,5'),
    'slot 1 was not drawn between 10 and 15');
  // And the falling bar 15→7 hangs from 15 down to 7: top Y(15)=85, height 8.
  assert.ok(bars(draw(wfBlock())).includes('215,85,70,8'),
    'slot 2 was not drawn between 15 and 7');
});

test('a zero-value step still draws a visible line', () => {
  const b = bars(draw(wfBlock({ data: { 0: { a: 10 }, 1: { a: 0 } } })));
  assert.ok(b.includes('115,90,70,1'), 'the zero step vanished');
});

test('leader lines join one bar to the next and stop at a slot gap', () => {
  const withGap = draw(wfBlock({ data: { 0: { a: 10 }, 1: { a: 5 }, 3: { a: 2 } } }));
  const moves = withGap.filter(k => k.op === 'moveTo');
  // Only slots 0→1 are adjacent; 1→3 is a gap and gets no connector.
  assert.equal(moves.length, 1);
  assert.equal(moves[0].args[1], 90, 'the connector should sit at the level 10');
});

test('connect: false drops the leader lines', () => {
  const calls = draw(wfBlock({ connect: false }));
  assert.equal(calls.filter(k => k.op === 'moveTo').length, 0);
});

test('waterfallColors paints rising, falling and total bars apart', () => {
  const calls = draw(wfBlock({
    data: { 0: { a: 10 }, 1: { a: -4 }, 2: { a: 0 } },
    totals: [2],
    waterfallColors: { up: '#00ff00', down: '#ff0000', total: '#0000ff' },
  }));
  const fills = calls.filter(k => k.op === 'fillRect').map(k => k.fill);
  assert.deepEqual(fills, ['#00ff00', '#ff0000', '#0000ff']);
});

test('a hidden series is neither drawn nor connected', () => {
  const calls = draw(wfBlock({ data: { 0: { a: 10, b: 3 }, 1: { a: 5, b: 4 } } }),
                     new Set(['a']));
  assert.equal(calls.filter(k => k.op === 'fillRect').length, 2, 'only b should draw');
});

// ── 3. The registry declaration ──────────────────────────────────────────────

test('waterfall is declared cumulative, and nothing else is', () => {
  assert.equal(isCumulativeType('waterfall'), true);
  assert.equal(isCumulativeType('multibar'), false);
  assert.equal(isCumulativeType('stackarea'), false);
});

// ── 4. Through a real instance ───────────────────────────────────────────────

const START = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const SLOTS = 6;

function wfSource(extra) {
  return Object.assign({
    'source-type': 'artificial', type: 'waterfall', name: 'wf',
    interval_start: START, interval: 3600, count: SLOTS,
    interval_end: START + SLOTS * 3600,
    // Steps of +10 each: the running total reaches 60, while no single step
    // exceeds 10. Measuring this like an ordinary binned block gives 10.
    data: { 0: { a: 10 }, 1: { a: 10 }, 2: { a: 10 },
            3: { a: 10 }, 4: { a: 10 }, 5: { a: 10 } },
    min: 0, max: 999,
  }, extra);
}

let nextId = 0;
async function build(source) {
  const id = 'wf-' + (nextId++);
  const canvas = makeCanvas(id);
  const ts = new TimeSeries({ canvas: id, sources: [source], initialView: null });
  await setView(ts, START * 1000, (START + SLOTS * 3600) * 1000);
  return { ts, canvas };
}

// Screen coordinates from the instance's public getters.
function probe(ts) {
  const area = ts.getPlotArea(), vp = ts.getViewport(), vr = ts.getValueRange();
  return {
    x: ms => ((ms - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left,
    y: v => area.margin.top + area.plotHeight * ((vr.ymax - v) / (vr.ymax - vr.ymin)),
  };
}

test('the y-extent follows the running total, not the largest step', async () => {
  const { ts } = await build(wfSource());
  assert.equal(ts.getValueRange().ymax, 60);
});

test('the extent reaches below zero when the total goes negative', async () => {
  const { ts } = await build(wfSource({
    data: { 0: { a: 10 }, 1: { a: -30 }, 2: { a: 5 } },
    count: 3, interval_end: START + 3 * 3600,
  }));
  const vr = ts.getValueRange();
  // 0 → 10 → -20 → -15.
  assert.equal(vr.ymax, 10);
  assert.ok(vr.ymin <= -20, `ymin was ${vr.ymin}, expected to reach -20`);
});

test('panning does not move the running total', async () => {
  // The zero point is the block's first slot, so the levels a bar is drawn
  // between must not depend on what is currently on screen.
  const { ts } = await build(wfSource());
  const full = ts.getValueRange().ymax;
  await setView(ts, (START + 3 * 3600) * 1000, (START + SLOTS * 3600) * 1000);
  assert.equal(ts.getValueRange().ymax, full,
    'the total was re-accumulated from the viewport edge');
});

test('the hit test finds a bar between its levels and returns the raw step',
  async () => {
    const { ts, canvas } = await build(wfSource());
    const p = probe(ts);
    let got = null;
    ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, n, key, value }; });
    // Slot 2 spans levels 20…30; probe its middle.
    canvas.onmousemove({ clientX: p.x((START + 2 * 3600 + 1800) * 1000), clientY: p.y(25) });
    assert.ok(got && got.plot, 'callback did not fire on a hit');
    assert.equal(got.n, 2);
    assert.equal(got.key, 'a');
    assert.equal(got.value, 10, 'expected the step, not the level it reached');
  });

test('the hit test misses below a bar that floats above zero', async () => {
  const { ts, canvas } = await build(wfSource());
  const p = probe(ts);
  let got = 'unset';
  ts.onHoverDataCallback((plot) => { got = plot; });
  // Slot 5 spans 50…60. Value 5 is far below it — and would be a hit if the
  // stacked branch, which walks up from zero, had been allowed to answer.
  canvas.onmousemove({ clientX: p.x((START + 5 * 3600 + 1800) * 1000), clientY: p.y(5) });
  assert.equal(got, null);
});
