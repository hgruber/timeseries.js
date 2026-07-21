// Covers series visibility (the data side of a legend) and the point-plot hit
// test. Both are new API surface a caller builds a legend and a tooltip on.
//
// The hit test deliberately mirrors POINT_RADIUS in renderers.js rather than
// re-deriving marker sizes — these tests assert the two agree, the same way
// gantt-hittest.test.mjs pins barRect() against get_element().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { registerSource } = await import('../src/sources.js');
const { POINT_RADIUS, plotSeriesIds } = await import('../src/renderers.js');

const T0 = Date.UTC(2026, 0, 5, 8);
const H = 3600000;
const startSec = Math.floor(T0 / 1000);

// ── Fixtures ──────────────────────────────────────────────────────────────────
function binnedPlot() {
  const data = {};
  for (let i = 0; i < 12; i++) data[i] = { alpha: 10, beta: 100 };
  return {
    name: 'binned', type: 'multibar',
    interval_start: startSec, interval: 3600, count: 12,
    min: 0, max: 110, data,
  };
}

function pointPlot(type = 'scatter') {
  const data = [];
  for (let i = 0; i < 12; i++)
    data.push({ t: T0 + i * H, values: { up: 10 + i, down: 50 - i } });
  return {
    name: 'points', type, category: 'point',
    tmin: T0, tmax: T0 + 11 * H,
    min: 0, max: 60, data,
  };
}

let nextId = 0;
async function build(plot) {
  const canvasId = 'series-test-' + (nextId++);
  const sourceType = 'series-src-' + canvasId;
  const canvas = makeCanvas(canvasId);
  registerSource({
    type: sourceType,
    init(_s, cb) { cb.pushData(plot); cb.requestRedraw(); },
  });
  const ts = new TimeSeries({
    canvas: canvasId,
    sources: [{ 'source-type': sourceType }],
    initialView: null,
  });
  await setView(ts, T0, T0 + 11 * H);
  return { ts, canvas };
}

// ── plotSeriesIds ─────────────────────────────────────────────────────────────
test('plotSeriesIds finds the union of keys in a binned plot', () => {
  const p = binnedPlot();
  p.data[3] = { alpha: 1 };            // sparse slot omitting beta
  p.data[4] = { gamma: 7 };            // a series appearing only later
  assert.deepEqual(plotSeriesIds(p).sort(), ['alpha', 'beta', 'gamma']);
});

test('plotSeriesIds reads point plots from the values keys', () => {
  assert.deepEqual(plotSeriesIds(pointPlot()).sort(), ['down', 'up']);
});

test('plotSeriesIds prefers explicit series metadata when present', () => {
  const p = pointPlot();
  p.series = [{ id: 'up' }, { id: 'down' }];
  assert.deepEqual(plotSeriesIds(p), ['up', 'down']);
});

test('plotSeriesIds tolerates an empty or missing plot', () => {
  assert.deepEqual(plotSeriesIds(null), []);
  assert.deepEqual(plotSeriesIds({ category: 'point', data: [] }), []);
});

// ── getSeries ─────────────────────────────────────────────────────────────────
test('getSeries lists the active series with colour and hidden state', async () => {
  const { ts } = await build(binnedPlot());
  const series = ts.getSeries();
  assert.equal(series.length, 2);
  const alpha = series.find(s => s.id === 'alpha');
  assert.ok(alpha, 'alpha missing');
  assert.equal(alpha.hidden, false);
  assert.match(alpha.color, /^hsla\(/, 'expected an auto-assigned hsla colour');
});

test('getSeries honours a per-plot colour override', async () => {
  const plot = binnedPlot();
  plot.series_colors = { alpha: '#ff0000' };
  const { ts } = await build(plot);
  const alpha = ts.getSeries().find(s => s.id === 'alpha');
  assert.ok(alpha.color.startsWith('#ff0000'), `got ${alpha.color}`);
});

test('getSeries reflects hidden state after setSeriesHidden', async () => {
  const { ts } = await build(binnedPlot());
  ts.setSeriesHidden('beta', true);
  assert.equal(ts.getSeries().find(s => s.id === 'beta').hidden, true);
  assert.equal(ts.getSeries().find(s => s.id === 'alpha').hidden, false);
});

// ── Hiding and the y-axis ─────────────────────────────────────────────────────
test('hiding the tallest series rescales the y-axis', async () => {
  // Probed through the hit test, which is the only way the resolved axis is
  // observable from outside. multibar stacks alpha (10) under beta (100):
  // with both visible the axis spans 110, so alpha occupies just the bottom
  // ~9% and the vertical middle of the plot is inside beta. Hide beta and the
  // axis must shrink to 10, putting alpha under the middle instead.
  const { ts, canvas } = await build(binnedPlot());
  const area = ts.getPlotArea();
  const midX = area.margin.left + area.plotWidth / 2;
  const midY = area.margin.top + area.plotHeight / 2;

  let key = null;
  ts.onHoverDataCallback((p, n, k) => { key = k; });

  canvas.onmousemove({ clientX: midX, clientY: midY });
  assert.equal(key, 'beta', 'precondition: mid-height is inside beta while the axis spans 110');

  ts.setSeriesHidden('beta', true);
  key = null;
  canvas.onmousemove({ clientX: midX, clientY: midY });
  assert.equal(key, 'alpha',
    'after hiding beta the axis should span only alpha, putting it under mid-height');
});

test('toggleSeries flips visibility both ways', async () => {
  const { ts } = await build(binnedPlot());
  ts.toggleSeries('alpha');
  assert.equal(ts.getSeries().find(s => s.id === 'alpha').hidden, true);
  ts.toggleSeries('alpha');
  assert.equal(ts.getSeries().find(s => s.id === 'alpha').hidden, false);
});

test('showAllSeries clears every hidden series', async () => {
  const { ts } = await build(binnedPlot());
  ts.setSeriesHidden('alpha', true);
  ts.setSeriesHidden('beta', true);
  ts.showAllSeries();
  assert.ok(ts.getSeries().every(s => !s.hidden));
});

test('onSeriesChange fires on a real change only', async () => {
  const { ts } = await build(binnedPlot());
  let calls = 0;
  ts.onSeriesChange(() => calls++);

  ts.setSeriesHidden('alpha', true);
  assert.equal(calls, 1);
  ts.setSeriesHidden('alpha', true);      // already hidden — no-op
  assert.equal(calls, 1, 'a no-op must not notify');
  ts.setSeriesHidden('alpha', false);
  assert.equal(calls, 2);
});

// ── Point hit test ────────────────────────────────────────────────────────────
test('hovering a scatter point reports its series and value', async () => {
  const plot = pointPlot('scatter');
  const { ts, canvas } = await build(plot);
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const X = t => ((t - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left;

  let got;   // set by the callback below, reset per probe
  ts.onHoverDataCallback((p, n, key, value) => { got = { p, n, key, value }; });

  // Aim at point 5 of series 'up'. Scanning the column beats duplicating the
  // Y transform here — the test should not need to know the axis extent.
  const pt = plot.data[5];
  let found = false;
  for (let y = area.margin.top; y < area.margin.top + area.plotHeight; y++) {
    got = null;
    canvas.onmousemove({ clientX: X(pt.t), clientY: y });
    if (got && got.key === 'up' && got.value === pt.values.up) { found = true; break; }
  }
  assert.ok(found, "never hit series 'up' anywhere in that column");
});

test('a hidden series cannot be hovered', async () => {
  const plot = pointPlot('scatter');
  const { ts, canvas } = await build(plot);
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const X = t => ((t - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left;
  ts.setSeriesHidden('up', true);

  const pt = plot.data[5];
  let hitUp = false;
  for (let y = area.margin.top; y < area.margin.top + area.plotHeight; y++) {
    let got = null;
    ts.onHoverDataCallback((p, n, key) => { got = key; });
    canvas.onmousemove({ clientX: X(pt.t), clientY: y });
    if (got === 'up') { hitUp = true; break; }
  }
  assert.equal(hitUp, false, 'a hidden series must not be hit-testable');
});

test('empty space between points reports no hit', async () => {
  const plot = pointPlot('scatter');
  const { ts, canvas } = await build(plot);
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const X = t => ((t - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left;

  // Halfway between two samples: points sit an hour apart, which is tens of
  // pixels here, so no y in that column can be within the grab radius.
  const between = X(T0 + 5.5 * H);
  for (let y = area.margin.top + 1; y < area.margin.top + area.plotHeight; y += 5) {
    let got = 'unset';
    ts.onHoverDataCallback((p, n, key) => { got = key; });
    canvas.onmousemove({ clientX: between, clientY: y });
    assert.equal(got, null, `unexpected hit at y=${y}`);
  }
});

test('the marker radius used for hit testing matches the renderer table', () => {
  // Guards against the table drifting from the renderers that draw from it.
  assert.equal(POINT_RADIUS.scatter, 3);
  assert.equal(POINT_RADIUS.multipoint, 2);
  assert.ok(POINT_RADIUS.default > 0);
});
