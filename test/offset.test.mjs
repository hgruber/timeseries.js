// Regression: hit testing must survive the canvas moving in the viewport.
//
// Mouse events carry viewport-relative clientX/clientY, so translating them to
// canvas coordinates needs the canvas's *current* bounding rect. That rect was
// only ever read in the ResizeObserver callback, which fires on resize — not on
// scroll. Scrolling the page (or any layout shift that moves the canvas without
// resizing it) left the cached offset stale, and every hit test silently missed:
// no tooltip, no cursor change, no click. It showed up worst on the demo page,
// where the gallery charts are far enough down that you must scroll to reach them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');

const start = Math.floor(Date.UTC(2026, 0, 5, 8) / 1000);
const INTERVAL = 3600, COUNT = 12;

function bars() {
  const data = {};
  for (let i = 0; i < COUNT; i++) data[i] = { s1: 10 + i, s2: 5 };
  return {
    'source-type': 'artificial',
    name: 'test', type: 'multibar',
    interval_start: start, interval: INTERVAL, count: COUNT,
    min: 0, max: 30, data,
  };
}

let nextId = 0;
async function build() {
  const canvasId = 'offset-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const ts = new TimeSeries({ canvas: canvasId, sources: [bars()], initialView: null });
  await setView(ts, start * 1000, (start + COUNT * INTERVAL) * 1000);
  return { ts, canvas };
}

// Move the canvas within the viewport, as scrolling would. Only the rect
// changes — the element keeps its size, so no ResizeObserver callback fires.
function moveCanvasTo(canvas, left, top) {
  canvas.getBoundingClientRect = () => ({
    left, top,
    width: canvas.width, height: canvas.height,
    right: left + canvas.width, bottom: top + canvas.height,
  });
}

// Probe a point that is known to be inside a bar, in canvas coordinates, and
// report which series was hit (or null).
function hitAt(ts, canvas, canvasX, canvasY, rectLeft = 0, rectTop = 0) {
  let key = null;
  ts.onHoverDataCallback((p, n, k) => { key = k; });
  canvas.onmousemove({ clientX: canvasX + rectLeft, clientY: canvasY + rectTop });
  return key;
}

test('hit testing works at the initial position', async () => {
  const { ts, canvas } = await build();
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const x = ((start + 5 * INTERVAL + 1800) * 1000 - vp.tmin) / (vp.tmax - vp.tmin)
            * area.plotWidth + area.margin.left;
  const y = area.margin.top + area.plotHeight - 5;

  assert.equal(hitAt(ts, canvas, x, y), 's1');
});

test('hit testing still works after the canvas scrolls up the viewport', async () => {
  const { ts, canvas } = await build();
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const x = ((start + 5 * INTERVAL + 1800) * 1000 - vp.tmin) / (vp.tmax - vp.tmin)
            * area.plotWidth + area.margin.left;
  const y = area.margin.top + area.plotHeight - 5;

  // Page scrolled down by 500px: the canvas now sits 500px higher, so the same
  // canvas point arrives as a clientY that is 500 smaller.
  moveCanvasTo(canvas, 0, -500);

  assert.equal(hitAt(ts, canvas, x, y, 0, -500), 's1',
    'stale offset — the cached bounding rect was not refreshed');
});

test('hit testing survives a horizontal shift too', async () => {
  const { ts, canvas } = await build();
  const area = ts.getPlotArea(), vp = ts.getViewport();
  const x = ((start + 5 * INTERVAL + 1800) * 1000 - vp.tmin) / (vp.tmax - vp.tmin)
            * area.plotWidth + area.margin.left;
  const y = area.margin.top + area.plotHeight - 5;

  moveCanvasTo(canvas, 220, 90);
  assert.equal(hitAt(ts, canvas, x, y, 220, 90), 's1');
});

test('a miss is still a miss after moving', async () => {
  const { ts, canvas } = await build();
  const area = ts.getPlotArea();
  moveCanvasTo(canvas, 0, -500);

  // Just below the top edge of the plot: above every bar in this data set.
  assert.equal(hitAt(ts, canvas, area.margin.left + 5, area.margin.top + 2, 0, -500), null);
});
