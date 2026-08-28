// The bin-local ladder renderers — quantile-steps, error-bars, candlestick —
// and the core plumbing they share with quantile-bands.
//
// Four layers are exercised here:
//   1. ladderPairs, the one reading of `plot.percentiles` all three share.
//   2. What each renderer actually paints, through plotData (never the draw
//      function directly, so the central fade/rate layers stay in the picture).
//   3. That a type declaring `values: 'array'` reaches the core's banded
//      branches — the y-extent one fails *silently* otherwise, which is the
//      whole reason isBandedType exists rather than three more type strings.
//   4. Hit testing and the tooltip, which ladder blocks gained in this change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { plotData, ladderPairs, isBandedType } = await import('../src/renderers.js');

// ── A recording 2D context ───────────────────────────────────────────────────
// The Proxy context in helpers/dom.mjs is a pure no-op and can report neither
// the alpha nor the coordinates a call ran at, which is all this file asks.
function recorder() {
  const calls = [];
  const rec = (op, args) => calls.push({
    op, args,
    alpha: c.globalAlpha, fill: c.fillStyle, stroke: c.strokeStyle,
    lineWidth: c.lineWidth,
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

// X: 1px per second, Y: value v at pixel 100 - v. With interval 100 a bin is
// exactly 100px wide and slot n starts at x = 100n, so every expectation below
// is readable arithmetic rather than a magic number.
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

function block(type, extra) {
  return Object.assign({
    type, interval: IV, interval_start: 0,
    percentiles: ['min', 'avg', 'max'],
    data: { 0: { a: [1, 2, 3] }, 1: { a: [2, 3, 4] } },
  }, extra);
}

const draw = (plot, hidden) => {
  const { c, calls } = recorder();
  plotData([0], [plot], rctxFor(c, hidden));
  return calls;
};

// ── 1. ladderPairs ───────────────────────────────────────────────────────────

test('ladderPairs decomposes a ladder into a centre and nested pairs', () => {
  assert.deepEqual(ladderPairs(2), { centre: null, pairs: [[0, 1]] });
  assert.deepEqual(ladderPairs(3), { centre: 1, pairs: [[0, 2]] });
  assert.deepEqual(ladderPairs(4), { centre: null, pairs: [[0, 3], [1, 2]] });
  assert.deepEqual(ladderPairs(5), { centre: 2, pairs: [[0, 4], [1, 3]] });
});

test('all four ladder renderers declare themselves array-valued', () => {
  for (const t of ['quantile-bands', 'quantile-steps', 'error-bars', 'candlestick'])
    assert.equal(isBandedType(t), true, t + ' must be a banded type');
  for (const t of ['multibar', 'multiline', 'multipoint', 'scatter', 'gantt'])
    assert.equal(isBandedType(t), false, t + ' must not be a banded type');
});

// ── 2. quantile-steps ────────────────────────────────────────────────────────

// Just the shape of a call, for comparing a path step by step.
const pick = k => ({ op: k.op, args: k.args });
const isPath = k => k.op === 'moveTo' || k.op === 'lineTo';
const pathOf = calls => calls.filter(isPath).map(pick);

// The median line is the only one drawn at lineWidth 2, which is what makes it
// separable from the fills and the outer percentile lines in the call log.
const medianPath = calls => calls.filter(k => isPath(k) && k.lineWidth === 2).map(pick);

test('quantile-steps draws each percentile flat across its own bin', () => {
  const path = medianPath(draw(block('quantile-steps')));
  // Slot 0 holds [1,2,3]; the median (index 1) is 2, drawn at Y(2) = 98 from
  // the bin's left edge (x=0) to its right edge (x=100) — not through the
  // slot centre, which is what quantile-bands would do.
  assert.deepEqual(path[0], { op: 'moveTo', args: [0, 98] });
  assert.deepEqual(path[1], { op: 'lineTo', args: [100, 98] });
});

test('quantile-steps joins adjacent bins with a vertical riser', () => {
  const path = medianPath(draw(block('quantile-steps')));
  // One moveTo only: the second bin is reached by a lineTo, and that lineTo
  // sits at the shared edge x=100 — a vertical riser, not a diagonal.
  assert.equal(path.filter(k => k.op === 'moveTo').length, 1);
  assert.deepEqual(path[2], { op: 'lineTo', args: [100, 97] });   // riser to slot 1's 3
  assert.deepEqual(path[3], { op: 'lineTo', args: [200, 97] });
});

test('connect: false drops the risers and leaves the segments free-standing', () => {
  const path = medianPath(draw(block('quantile-steps', { connect: false })));
  assert.equal(path.filter(k => k.op === 'moveTo').length, 2);
  assert.deepEqual(path[2], { op: 'moveTo', args: [100, 97] });
});

test('quantile-steps never bridges a gap in the slot numbering', () => {
  const p = block('quantile-steps', { data: { 0: { a: [1, 2, 3] }, 2: { a: [2, 3, 4] } } });
  const path = medianPath(draw(p));
  // Slots 0 and 2 are not adjacent, so the run breaks even with connect on.
  assert.equal(path.filter(k => k.op === 'moveTo').length, 2);
  assert.deepEqual(path[2], { op: 'moveTo', args: [200, 97] });
});

test('quantile-steps keeps the bands own alphas and the median bold', () => {
  const calls = draw(block('quantile-steps'));
  const fills = calls.filter(k => k.op === 'fill').map(k => k.fill);
  assert.ok(fills.length, 'no band fills');
  // bandAlpha for a 3-rung ladder is 0.25 on both segments.
  for (const f of fills) assert.ok(f.endsWith(',0.25)'), 'band fill alpha: ' + f);
  const strokes = calls.filter(k => k.op === 'stroke');
  assert.ok(strokes.some(k => k.lineWidth === 2 && k.stroke.endsWith(',0.9)')), 'median');
  assert.ok(strokes.some(k => k.lineWidth === 1 && k.stroke.endsWith(',0.55)')), 'outer');
});

test('quantile-steps skips a bin the partial-bin policy dropped', () => {
  const p = block('quantile-steps', {
    _partial: { slot: 1, frac: 0.05, scale: 0, skip: true },
  });
  const xs = draw(p)
    .filter(k => k.op === 'moveTo' || k.op === 'lineTo')
    .map(k => k.args[0]);
  // Only bin 0 (x 0…100) is painted; nothing reaches into slot 1.
  assert.equal(Math.max(...xs), 100);
});

test('quantile-steps narrows the bin holding data_until', () => {
  const p = block('quantile-steps', {
    _partial: { slot: 1, frac: 0.5, scale: 1, skip: false },
  });
  const path = medianPath(draw(p));
  // Slot 1 still starts at 100 but now ends halfway through its bin.
  assert.deepEqual(path[path.length - 1], { op: 'lineTo', args: [150, 97] });
});

// ── 3. error-bars ────────────────────────────────────────────────────────────

test('error-bars draws a whisker over the ladder pair and a marker on its centre', () => {
  const calls = draw(block('error-bars', { data: { 0: { a: [1, 2, 3] } } }));
  const path = pathOf(calls);
  // One series, so the whisker sits at the bin centre x=50, running Y(1)=99
  // to Y(3)=97.
  assert.deepEqual(path[0], { op: 'moveTo', args: [50, 99] });
  assert.deepEqual(path[1], { op: 'lineTo', args: [50, 97] });
  // Caps on the outermost pair: clamped to 12px wide, so ±6 around the stem.
  assert.deepEqual(path[2], { op: 'moveTo', args: [44, 99] });
  assert.deepEqual(path[3], { op: 'lineTo', args: [56, 99] });
  // Marker on the centre rung, value 2 → Y = 98, half-size 3.
  const marker = calls.find(k => k.op === 'fillRect');
  assert.deepEqual(marker.args, [47, 95, 6, 6]);
});

test('error-bars draws no marker for an even ladder, which has no centre', () => {
  const p = block('error-bars', {
    percentiles: [25, 75], data: { 0: { a: [1, 3] } },
  });
  assert.equal(draw(p).filter(k => k.op === 'fillRect').length, 0);
});

test('error-bars dodges several series apart inside the bin', () => {
  const p = block('error-bars', { data: { 0: { a: [1, 2, 3], b: [4, 5, 6] } } });
  const stems = draw(p).filter(k => k.op === 'moveTo').map(k => k.args[0]);
  // Two series share the 100px bin: centres at 25 and 75, not both at 50.
  assert.ok(stems.includes(25), 'first series at 25: ' + stems);
  assert.ok(stems.includes(75), 'second series at 75: ' + stems);
});

test('a hidden series is neither drawn nor counted in the dodge', () => {
  const p = block('error-bars', { data: { 0: { a: [1, 2, 3], b: [4, 5, 6] } } });
  const calls = draw(p, new Set(['b']));
  const stems = calls.filter(k => k.op === 'moveTo').map(k => k.args[0]);
  // The row closes up rather than leaving a hole: the survivor re-centres.
  assert.ok(stems.includes(50), 'survivor re-centres: ' + stems);
  assert.ok(!stems.includes(25) && !stems.includes(75), 'still dodging: ' + stems);
});

// ── 4. candlestick ───────────────────────────────────────────────────────────

test('candlestick reads wick and body out of a five-rung ladder', () => {
  const p = block('candlestick', {
    percentiles: [5, 25, 50, 75, 95], data: { 0: { a: [1, 2, 3, 4, 5] } },
  });
  const calls = draw(p);
  const path = pathOf(calls);
  // Wick from the outermost pair: Y(1)=99 to Y(5)=95, at the bin centre.
  assert.deepEqual(path[0], { op: 'moveTo', args: [50, 99] });
  assert.deepEqual(path[1], { op: 'lineTo', args: [50, 95] });
  // Body from the next pair in: Y(4)=96 down to Y(2)=98, so top 96, height 2.
  // Width is 70% of the bin, centred: 15 … 85.
  const body = calls.find(k => k.op === 'fillRect');
  assert.deepEqual(body.args, [15, 96, 70, 2]);
  // Median tick across the body at Y(3) = 97.
  assert.deepEqual(path[2], { op: 'moveTo', args: [15, 97] });
  assert.deepEqual(path[3], { op: 'lineTo', args: [85, 97] });
});

test('a three-rung ladder becomes a box with no wick, not a bodyless hairline', () => {
  const calls = draw(block('candlestick', { data: { 0: { a: [1, 2, 3] } } }));
  const body = calls.find(k => k.op === 'fillRect');
  assert.deepEqual(body.args, [15, 97, 70, 2]);        // Y(3)=97 … Y(1)=99
  // Only the median tick is stroked; there is no outer pair left for a wick.
  assert.equal(calls.filter(k => k.op === 'stroke').length, 1);
});

test('plot.roles turns the same block into a true OHLC candle', () => {
  const ohlc = (vals) => block('candlestick', {
    percentiles: ['open', 'high', 'low', 'close'],
    roles: { open: 0, high: 1, low: 2, close: 3 },
    data: { 0: { a: vals } },
  });
  // close (3) above open (1): rising, drawn hollow.
  const up = draw(ohlc([1, 3, 0, 3]));
  assert.ok(up.some(k => k.op === 'strokeRect'), 'rising candle must be hollow');
  assert.ok(!up.some(k => k.op === 'fillRect'), 'rising candle must not be filled');
  // close (1) below open (3): falling, drawn filled.
  const down = draw(ohlc([3, 3, 0, 1]));
  assert.ok(down.some(k => k.op === 'fillRect'), 'falling candle must be filled');
  assert.ok(!down.some(k => k.op === 'strokeRect'), 'falling candle must not be hollow');
});

test('candleColors overrides the hollow/filled convention with explicit colours', () => {
  const p = block('candlestick', {
    percentiles: ['open', 'high', 'low', 'close'],
    roles: { open: 0, high: 1, low: 2, close: 3 },
    candleColors: { up: '#00ff00', down: '#ff0000' },
    data: { 0: { a: [1, 3, 0, 3] } },
  });
  const body = draw(p).find(k => k.op === 'fillRect');
  assert.equal(body.fill, '#00ff00');
});

test('a malformed roles map falls back to the ladder instead of drawing NaN', () => {
  const p = block('candlestick', { roles: { open: 0, high: 9, low: 2, close: 3 } });
  const calls = draw(p);
  const body = calls.find(k => k.op === 'fillRect');
  assert.deepEqual(body.args, [15, 97, 70, 2]);        // the 3-rung ladder result
});

// ── 5. The core's banded branches, on a real instance ────────────────────────

const START = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const SLOTS = 12;

function ladderSource(type, extra) {
  const data = {};
  for (let i = 0; i < SLOTS; i++) data[i] = { a: [10, 20, 30] };
  return Object.assign({
    'source-type': 'artificial', type, name: 'lad',
    percentiles: [5, 50, 95],
    interval_start: START, interval: 3600, count: SLOTS,
    interval_end: START + SLOTS * 3600,
    data,
    // Deliberately wrong: the y-extent is supposed to come from the slots in
    // the viewport. If the banded branch ever stops recognising this type, the
    // scan contributes nothing and prepare_grid falls back to exactly this
    // number — so a wrong one here is what makes the silent failure loud.
    min: 0, max: 999,
  }, extra);
}

let nextId = 0;
async function build(sources) {
  const id = 'ladder-' + (nextId++);
  const canvas = makeCanvas(id);
  const ts = new TimeSeries({ canvas: id, sources, initialView: null });
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

for (const type of ['quantile-steps', 'error-bars', 'candlestick']) {
  test(`${type} drives the y-extent from its largest ladder entry`, async () => {
    const { ts } = await build([ladderSource(type)]);
    assert.equal(ts.getValueRange().ymax, 30);
  });
}

test('overlapping ladder blocks concatenate instead of discarding the older one', async () => {
  const a = ladderSource('quantile-steps');
  for (let i = 0; i < SLOTS; i++) a.data[i] = { a: [i, i + 1, i + 2] };
  const b = ladderSource('quantile-steps', { interval_start: START + 5 * 3600 });
  for (let i = 0; i < SLOTS; i++) b.data[i] = { a: [100, 100, 100] };
  b.interval_end = START + 17 * 3600;

  const { ts } = await build([a, b]);
  const active = ts.getActiveData();
  const older = active.find(p => p.interval_start === START);
  assert.ok(older, 'the older block was released instead of trimmed');
  // Slots 5…11 fell inside the newer block's range and were trimmed away.
  assert.equal(older.count, 5);
  // The recomputed extent walks the array entries; the scalar path would have
  // summed arrays into a string here.
  assert.equal(older.min, 0);
  assert.equal(older.max, 6);          // slot 4 holds [4,5,6]
});

// ── 6. Hit testing ───────────────────────────────────────────────────────────

for (const type of ['quantile-bands', 'quantile-steps', 'error-bars', 'candlestick']) {
  test(`${type} hands the whole ladder back on a hover`, async () => {
    const { ts, canvas } = await build([ladderSource(type)]);
    const p = probe(ts);
    let got = null;
    ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, n, key, value }; });
    canvas.onmousemove({ clientX: p.x((START + 5 * 3600 + 1800) * 1000), clientY: p.y(20) });

    assert.ok(got && got.plot, type + ': callback did not fire on a hit');
    assert.equal(got.n, 5);
    assert.equal(got.key, 'a');
    assert.deepEqual(got.value, [10, 20, 30]);
  });
}

test('a pointer outside the ladder is not a hit', async () => {
  const { ts, canvas } = await build([ladderSource('quantile-steps')]);
  const p = probe(ts);
  let got = 'unset';
  ts.onHoverDataCallback((plot) => { got = plot; });
  // Well above the top rung (30); the 4px grab tolerance cannot reach here.
  canvas.onmousemove({ clientX: p.x((START + 5 * 3600 + 1800) * 1000), clientY: p.y(29) - 40 });
  assert.equal(got, null);
});

test('a hidden series is not hittable', async () => {
  const { ts, canvas } = await build([ladderSource('quantile-steps')]);
  const p = probe(ts);
  ts.setSeriesHidden('a', true);
  let got = 'unset';
  ts.onHoverDataCallback((plot) => { got = plot; });
  canvas.onmousemove({ clientX: p.x((START + 5 * 3600 + 1800) * 1000), clientY: p.y(20) });
  assert.equal(got, null);
});

// ── 7. The Zabbix source's render option ─────────────────────────────────────

test('zabbixPlot draws its min/avg/max ladder with whichever ladder type is asked for', async () => {
  const { zabbixPlot } = await import('../src/sources.js');
  const ring = new Map([[10, { 1: { mn: 1, av: 2, mx: 3, n: 1 } }]]);
  const tier = { interval: 3600, kind: 'trends' };

  assert.equal(zabbixPlot(tier, ring, 'cpu', null).type, 'quantile-bands');
  for (const type of ['quantile-steps', 'error-bars', 'candlestick']) {
    const plot = zabbixPlot(tier, ring, 'cpu', null, type);
    assert.equal(plot.type, type);
    assert.deepEqual(plot.percentiles, ['min', 'avg', 'max']);
    assert.deepEqual(plot.data[0]['1'], [1, 2, 3]);
  }
});

// ── 8. The tooltip's ladder rows ─────────────────────────────────────────────

test('the tooltip renders one labelled row per rung, highest first', async () => {
  const { ts, canvas } = await build([ladderSource('quantile-steps')]);
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts);
  canvas.onmousemove({ clientX: p.x((START + 5 * 3600 + 1800) * 1000), clientY: p.y(20) });

  const text = tip.el.textContent;
  for (const rung of ['p5', 'p50', 'p95']) assert.ok(text.includes(rung), rung + ' in ' + text);
  for (const v of ['10', '20', '30']) assert.ok(text.includes(v), v + ' in ' + text);
  assert.ok(text.indexOf('p95') < text.indexOf('p5'), 'highest rung first: ' + text);
  tip.destroy();
});

test('percentileLabel retargets only the rung labels', async () => {
  const { ts, canvas } = await build([ladderSource('quantile-steps')]);
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts, { percentileLabel: e => 'q' + e });
  canvas.onmousemove({ clientX: p.x((START + 5 * 3600 + 1800) * 1000), clientY: p.y(20) });

  assert.ok(tip.el.textContent.includes('q50'), tip.el.textContent);
  tip.destroy();
});
