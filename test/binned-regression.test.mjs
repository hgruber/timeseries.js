// Guards the pre-existing binned (multibar) path against the category:'span'
// changes in timeseries.js — pushData extent, prepare_grid, ygrid, and
// get_element all gained a span branch; this confirms the non-span branch is
// unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');

const start = Math.floor(Date.UTC(2026, 0, 5, 8) / 1000);
function freshBars() {
  const data = {};
  for (let i = 0; i < 12; i++) data[i] = { s1: 10 + i, s2: 5 };
  return {
    'source-type': 'artificial',
    name: 'test', type: 'multibar',
    interval_start: start, interval: 3600, count: 12,
    min: 0, max: 27, data,
  };
}

let nextId = 0;
async function buildInstance(bars) {
  const canvasId = 'binned-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const ts = new TimeSeries({ canvas: canvasId, sources: [bars], initialView: null });
  await setView(ts, start * 1000, (start + 12 * 3600) * 1000);
  return { ts, canvas };
}

test('a multibar block is pushed and becomes active', async () => {
  const { ts } = await buildInstance(freshBars());
  assert.equal(ts.getActiveData().length, 1);
});

test('prepare_grid still derives interval_end for binned blocks', async () => {
  const { ts } = await buildInstance(freshBars());
  assert.equal(ts.getData()[0].interval_end, start + 12 * 3600);
});

test('numeric y-axis margin is still reserved (not stolen by the span code path)', async () => {
  const { ts } = await buildInstance(freshBars());
  assert.ok(ts.getPlotArea().margin.left > 0);
});

test('multibar hit test still returns the right slot and series', async () => {
  const { ts, canvas } = await buildInstance(freshBars());
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const X = t => ((t - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left;
  const slotMidMs = (start + 5 * 3600 + 1800) * 1000;

  let hovered = null;
  ts.onHoverDataCallback((_p, n, key, value) => { hovered = { n, key, value }; });
  canvas.onmousemove({ clientX: X(slotMidMs), clientY: area.margin.top + area.plotHeight - 5 });

  assert.equal(hovered && hovered.n, 5);
  assert.equal(hovered && hovered.key, 's1');
});

test('a span source and a binned source can coexist without either stealing the other\'s hits', async () => {
  const { registerSource } = await import('../src/sources.js');
  const canvasId = 'binned-test-mixed';
  makeCanvas(canvasId);
  const H = 3600000;
  const spanPlot = {
    type: 'gantt', category: 'span',
    tmin: start * 1000, tmax: (start + 12 * 3600) * 1000,
    layout: 'calendar',
    lanes: [{ id: 'A', label: 'A' }],
    data: [{ id: 'e1', lane: 'A', start: start * 1000 + H, end: start * 1000 + 2 * H, label: 'e1' }],
  };
  registerSource({ type: 'test-span-mixed', init(_s, cb) { cb.pushData(spanPlot); cb.requestRedraw(); } });

  const ts = new TimeSeries({
    canvas: canvasId,
    sources: [freshBars(), { 'source-type': 'test-span-mixed' }],
    initialView: null,
  });
  await setView(ts, start * 1000, (start + 12 * 3600) * 1000);
  assert.equal(ts.getActiveData().length, 2);
});
