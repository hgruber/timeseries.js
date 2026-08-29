// The laned renderers — heatmap and horizon — and the lane axis they share
// with gantt.
//
// The rework this file guards is that a *categorical y-axis* is now a property
// of the renderer (`lanes: true`) rather than of the data shape. It used to be
// welded to `category === 'span'`, which is why gantt was the only renderer that
// could have one. heatmap and horizon are binned and laned, so they are the
// proof the two concerns actually came apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { plotData, isLanedType, layoutPlot } = await import('../src/renderers.js');

function recorder() {
  const calls = [];
  const rec = (op, args) => calls.push({ op, args, fill: c.fillStyle });
  const c = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect: (...a) => rec('fillRect', a),
    strokeRect: (...a) => rec('strokeRect', a),
    moveTo: (...a) => rec('moveTo', a),
    lineTo: (...a) => rec('lineTo', a),
    fill: () => rec('fill', []),
    stroke: () => rec('stroke', []),
    beginPath() {}, closePath() {}, arc() {}, save() {}, restore() {},
  };
  return { c, calls };
}

// Y maps value v to pixel 100 - 20*v, so with two lanes (value space 0…2) lane 0
// occupies pixels 60…80 and lane 1 occupies 80…100. X is 1px per second and the
// interval is 100, so slot n starts at x = 100n and a bin is 100px wide.
function rctxFor(c, hidden) {
  return {
    c,
    X: t => t / 1000,
    Y: v => 100 - 20 * v,
    ppms: 1 / 1000, ppv: 20,
    margin: { left: 0, top: 0, right: 0, bottom: 0 },
    plotWidth: 1000, plotHeight: 100,
    hidden: hidden || new Set(),
  };
}

const IV = 100;

function lanedBlock(type, extra) {
  return Object.assign({
    type, interval: IV, interval_start: 0,
    data: { 0: { a: 0, b: 10 }, 1: { a: 10, b: 0 } },
  }, extra);
}

const draw = (plot, hidden) => {
  const { c, calls } = recorder();
  plotData([0], [plot], rctxFor(c, hidden));
  return calls;
};

const rects = calls => calls.filter(k => k.op === 'fillRect');

// ── 1. The lane layout ───────────────────────────────────────────────────────

test('a laned block gets one lane per series, labelled top to bottom', () => {
  const plot = lanedBlock('heatmap');
  layoutPlot(plot);
  assert.equal(plot.laneCount, 2);
  // Lane k owns [laneCount-k-1, laneCount-k); the label sits at its centre.
  assert.deepEqual(plot.yticks, [
    { y: 1.5, label: 'a' },
    { y: 0.5, label: 'b' },
  ]);
});

test('plot.lanes fixes the order and the labels', () => {
  const plot = lanedBlock('heatmap', {
    lanes: [{ id: 'b', label: 'Second' }, { id: 'a', label: 'First' }],
  });
  layoutPlot(plot);
  assert.deepEqual(plot.yticks, [
    { y: 1.5, label: 'Second' },
    { y: 0.5, label: 'First' },
  ]);
});

test('the layout is idempotent — it runs every frame', () => {
  const plot = lanedBlock('heatmap');
  layoutPlot(plot);
  const once = JSON.stringify(plot.yticks);
  layoutPlot(plot);
  layoutPlot(plot);
  assert.equal(JSON.stringify(plot.yticks), once);
  assert.equal(plot.laneCount, 2);
});

test('layoutPlot is a no-op for a renderer that declares no layout', () => {
  const plot = { type: 'multiline', interval: IV, interval_start: 0, data: {} };
  layoutPlot(plot);
  assert.equal(plot.laneCount, undefined);
});

test('heatmap and horizon are laned; gantt still is, and the rest are not', () => {
  assert.equal(isLanedType('heatmap'), true);
  assert.equal(isLanedType('horizon'), true);
  // The rework must not have taken the lane axis away from the renderer it
  // originally belonged to.
  assert.equal(isLanedType('gantt'), true);
  assert.equal(isLanedType('multibar'), false);
  assert.equal(isLanedType('stackarea'), false);
});

// ── 2. heatmap ───────────────────────────────────────────────────────────────

test('heatmap fills one cell per slot per lane, spanning the bin and the band', () => {
  const r = rects(draw(lanedBlock('heatmap')));
  assert.equal(r.length, 4);
  // Slot 0, lane a: x 0…100, y 60…80.
  assert.deepEqual(r[0].args, [0, 60, 100, 20]);
  // Slot 0, lane b sits in the band below it.
  assert.deepEqual(r[1].args, [0, 80, 100, 20]);
  // Slot 1 is the next bin along.
  assert.deepEqual(r[2].args, [100, 60, 100, 20]);
});

test('heatmap colour follows the value, scaled over the whole block', () => {
  const r = rects(draw(lanedBlock('heatmap')));
  // a=0 is the block minimum and b=10 the maximum, so the two ends of the ramp.
  const alphaOf = s => Number(/,([\d.]+)\)$/.exec(s)[1]);
  assert.ok(alphaOf(r[0].fill) < alphaOf(r[1].fill),
    'the lower value was not drawn fainter');
});

test('colorScale interpolates between hex stops', () => {
  const r = rects(draw(lanedBlock('heatmap', { colorScale: ['#000000', '#ffffff'] })));
  assert.equal(r[0].fill, 'rgb(0,0,0)', 'the block minimum should be the first stop');
  assert.equal(r[1].fill, 'rgb(255,255,255)', 'the maximum should be the last stop');
});

test('vmin/vmax pin the scale so two charts stay comparable', () => {
  const r = rects(draw(lanedBlock('heatmap', {
    colorScale: ['#000000', '#ffffff'], vmin: 0, vmax: 20,
  })));
  // 10 of a 0…20 range is the midpoint, not the top as it would be unpinned.
  assert.equal(r[1].fill, 'rgb(128,128,128)');
});

test('a blank cell is left unpainted', () => {
  const r = rects(draw(lanedBlock('heatmap', {
    data: { 0: { a: 5 }, 1: { a: 5, b: 5 } },
  })));
  assert.equal(r.length, 3, 'the missing b in slot 0 should not be drawn');
});

test('hiding a lane blanks its row but does not move the others', () => {
  const plot = lanedBlock('heatmap');
  const r = rects(draw(plot, new Set(['a'])));
  assert.equal(r.length, 2);
  // b is still in the lower band; the axis did not close up around the hidden a.
  assert.ok(r.every(k => k.args[1] === 80), 'lane b moved when a was hidden');
});

// ── 3. horizon ───────────────────────────────────────────────────────────────

test('horizon folds a value into stacked slices of rising intensity', () => {
  // Range 0…10 over 2 bands → unit 5. a=10 in slot 1 fills both slices whole.
  const r = rects(draw(lanedBlock('horizon', { horizonBands: 2 })));
  const laneA = r.filter(k => k.args[1] >= 60 && k.args[1] < 80);
  // Slot 1's value fills both slices; each is the full 20px band height.
  const full = laneA.filter(k => k.args[3] === 20);
  assert.equal(full.length, 2, 'both slices should be full at the maximum');
  // Slices are drawn darker as they go outward.
  const alphaOf = s => Number(/,([\d.]+)\)$/.exec(s)[1]);
  assert.ok(alphaOf(full[1].fill) > alphaOf(full[0].fill));
});

test('horizon draws a partial slice for a value inside a band', () => {
  const r = rects(draw(lanedBlock('horizon', {
    horizonBands: 2, data: { 0: { a: 2.5 } }, vmin: 0, vmax: 10,
  })));
  // One series → one lane, spanning value 0…1, i.e. pixels 80…100.
  // unit = 5, value 2.5 → half of the first slice, none of the second.
  assert.equal(r.length, 1);
  assert.equal(r[0].args[3], 10, 'expected half the 20px band');
  // …and it grows up from the band's baseline (y 100), not down from its top.
  assert.equal(r[0].args[1], 90);
});

test('horizon mirrors a negative value downward from the band top', () => {
  const r = rects(draw(lanedBlock('horizon', {
    horizonBands: 1, data: { 0: { a: -10 } }, vmin: -10, vmax: 10,
  })));
  assert.equal(r.length, 1);
  // The single lane spans y 80…100; a negative fill hangs from its top edge (80)
  // rather than sitting on its baseline (100), so the two directions never
  // overprint each other.
  assert.equal(r[0].args[1], 80);
  assert.equal(r[0].args[3], 20);
});

test('horizonNegative colours the downward direction apart', () => {
  const r = rects(draw(lanedBlock('horizon', {
    horizonBands: 1, horizonNegative: '#ff0000',
    data: { 0: { a: -10 } }, vmin: -10, vmax: 10,
  })));
  // Alpha rides on the colour, never on globalAlpha — that belongs to the fade.
  assert.ok(r[0].fill.startsWith('#ff0000'), `got ${r[0].fill}`);
});

test('horizon leaves globalAlpha alone for the tier cross-fade', () => {
  const { c, calls } = recorder();
  plotData([0], [lanedBlock('horizon', { _fade: 0.5 })], rctxFor(c));
  // Every draw call must run at the fade the core set, not at one horizon chose.
  assert.ok(calls.length > 0);
  assert.equal(c.globalAlpha, 1, 'globalAlpha was not restored after the block');
});

// ── 4. Through a real instance ───────────────────────────────────────────────

const START = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const SLOTS = 6;

function lanedSource(type, extra) {
  const data = {};
  for (let i = 0; i < SLOTS; i++) data[i] = { a: i, b: SLOTS - i, c: 3 };
  return Object.assign({
    'source-type': 'artificial', type, name: 'laned',
    interval_start: START, interval: 3600, count: SLOTS,
    interval_end: START + SLOTS * 3600,
    data, min: 0, max: 999,
  }, extra);
}

let nextId = 0;
async function build(source) {
  const id = 'laned-' + (nextId++);
  const canvas = makeCanvas(id);
  const ts = new TimeSeries({ canvas: id, sources: [source], initialView: null });
  await setView(ts, START * 1000, (START + SLOTS * 3600) * 1000);
  return { ts, canvas };
}

for (const type of ['heatmap', 'horizon']) {
  test(`${type} puts the axis on 0…laneCount, not on its values`, async () => {
    const { ts } = await build(lanedSource(type));
    const vr = ts.getValueRange();
    // Three series → three lanes, regardless of the values (which reach 6) and
    // regardless of the deliberately wrong plot.max of 999.
    assert.equal(vr.ymax, 3);
    // `+ 0` normalises the -0 that falls out of `ymin = -_downMax` when nothing
    // reaches below the axis; -0 and 0 are the same number to everything except
    // a strict assertion.
    assert.equal(vr.ymin + 0, 0);
  });

  test(`${type} stamps lane names for the axis to label with`, async () => {
    // prepare_grid feeds exactly these yticks into ygrid, so asserting on them
    // is asserting on what gets printed — without needing a recording context.
    const { ts } = await build(lanedSource(type));
    const plot = ts.getActiveData()[0];
    assert.deepEqual(plot.yticks.map(t => t.label), ['a', 'b', 'c']);
    assert.deepEqual(plot.yticks.map(t => t.y), [2.5, 1.5, 0.5]);
  });

  test(`${type} hit-tests by lane and slot, returning the cell value`, async () => {
    const { ts, canvas } = await build(lanedSource(type));
    const area = ts.getPlotArea(), vp = ts.getViewport(), vr = ts.getValueRange();
    const X = ms => ((ms - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left;
    const Y = v => area.margin.top + area.plotHeight * ((vr.ymax - v) / (vr.ymax - vr.ymin));
    let got = null;
    ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, n, key, value }; });
    // Lane 'b' is the middle row: value band 1…2, so probe its centre at 1.5.
    canvas.onmousemove({ clientX: X((START + 4 * 3600 + 1800) * 1000), clientY: Y(1.5) });
    assert.ok(got && got.plot, `${type}: no hit`);
    assert.equal(got.key, 'b');
    assert.equal(got.n, 4);
    assert.equal(got.value, SLOTS - 4);
  });
}

test('a hidden lane is not hittable', async () => {
  const { ts, canvas } = await build(lanedSource('heatmap'));
  const area = ts.getPlotArea(), vp = ts.getViewport(), vr = ts.getValueRange();
  const X = ms => ((ms - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left;
  const Y = v => area.margin.top + area.plotHeight * ((vr.ymax - v) / (vr.ymax - vr.ymin));
  ts.setSeriesHidden('b', true);
  ts.redraw();
  let got = 'unset';
  ts.onHoverDataCallback((plot) => { got = plot; });
  canvas.onmousemove({ clientX: X((START + 4 * 3600 + 1800) * 1000), clientY: Y(1.5) });
  assert.equal(got, null);
});

test('hiding a lane does not change the lane count', async () => {
  // The axis has to stay put: closing up the row would relabel every lane below.
  const { ts } = await build(lanedSource('heatmap'));
  ts.setSeriesHidden('b', true);
  ts.redraw();
  assert.equal(ts.getValueRange().ymax, 3);
});

test('a laned plot reports its series to the legend', async () => {
  const { ts } = await build(lanedSource('heatmap'));
  assert.deepEqual(ts.getSeries().map(s => s.id).sort(), ['a', 'b', 'c']);
});
