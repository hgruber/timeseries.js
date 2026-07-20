// Pins the onHoverData contract that tooltip consumers rely on: which
// arguments arrive on a hit, what signals "nothing hit", and that the slot
// index can be turned back into a wall-clock time. demo/index.html builds its
// tooltip on exactly these four assumptions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');

const start = Math.floor(Date.UTC(2026, 0, 5, 8) / 1000);
const INTERVAL = 3600;
const COUNT = 12;

function freshBars() {
  const data = {};
  for (let i = 0; i < COUNT; i++) data[i] = { s1: 10 + i, s2: 5 };
  return {
    'source-type': 'artificial',
    name: 'test', type: 'multibar',
    interval_start: start, interval: INTERVAL, count: COUNT,
    min: 0, max: 27, data,
  };
}

let nextId = 0;
async function buildInstance() {
  const canvasId = 'hover-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const ts = new TimeSeries({ canvas: canvasId, sources: [freshBars()], initialView: null });
  await setView(ts, start * 1000, (start + COUNT * INTERVAL) * 1000);
  return { ts, canvas };
}

// Screen x for a given ms timestamp, and a y inside the lowest (first) series.
function probe(ts) {
  const area = ts.getPlotArea(), vp = ts.getViewport();
  return {
    x: ms => ((ms - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left,
    yBottom: area.margin.top + area.plotHeight - 5,
    area,
  };
}

test('a hit delivers the plot, slot index, series id and numeric value', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);

  let got = null;
  ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, n, key, value }; });
  canvas.onmousemove({ clientX: p.x((start + 5 * INTERVAL + 1800) * 1000), clientY: p.yBottom });

  assert.ok(got, 'callback did not fire');
  assert.equal(got.n, 5);
  assert.equal(got.key, 's1');
  assert.equal(typeof got.value, 'number');
  assert.equal(got.value, 15);          // 10 + slot 5
  assert.ok(got.plot, 'plot argument must not be null on a hit');
});

test('the hovered plot carries the fields needed to reconstruct the slot time', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);

  let got = null;
  ts.onHoverDataCallback((plot, n) => { got = { plot, n }; });
  canvas.onmousemove({ clientX: p.x((start + 5 * INTERVAL + 1800) * 1000), clientY: p.yBottom });

  // A tooltip needs both of these to be numbers; without them it cannot show a time.
  assert.equal(typeof got.plot.interval_start, 'number');
  assert.equal(typeof got.plot.interval, 'number');
});

test('interval_start + n * interval lands inside the hovered slot', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const hoveredMs = (start + 5 * INTERVAL + 1800) * 1000;

  let got = null;
  ts.onHoverDataCallback((plot, n) => { got = { plot, n }; });
  canvas.onmousemove({ clientX: p.x(hoveredMs), clientY: p.yBottom });

  const slotStartMs = (got.plot.interval_start + got.n * got.plot.interval) * 1000;
  assert.ok(slotStartMs <= hoveredMs, 'slot start must not be after the hovered time');
  assert.ok(hoveredMs < slotStartMs + got.plot.interval * 1000,
    'hovered time must fall before the next slot');
});

test('hovering empty space above the bars reports nothing hit', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);

  let got = 'unset';
  ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, n, key, value }; });
  // Just below the top edge of the plot area — well above the tallest bar (27 of max 27
  // would reach the top, so stay inside the frame but above the stack at slot 0).
  canvas.onmousemove({ clientX: p.x(start * 1000 + 60000), clientY: p.area.margin.top + 2 });

  assert.notEqual(got, 'unset', 'callback must fire even when nothing is hit');
  assert.equal(got.plot, null);
  assert.equal(got.key, null);
});

test('leaving the canvas clears the tooltip', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);

  let got = null;
  ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, n, key, value }; });
  canvas.onmousemove({ clientX: p.x((start + 5 * INTERVAL + 1800) * 1000), clientY: p.yBottom });
  assert.ok(got.key, 'precondition: something was hovered');

  canvas.onmouseleave();
  assert.equal(got.plot, null);
  assert.equal(got.key, null);
});
