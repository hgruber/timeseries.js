// Covers the shipped tooltip overlay (src/tooltip.js): that it stays inert
// until attached, renders the default body, honours each override level,
// re-themes on setColors, positions itself against the viewport edges, and
// detaches cleanly. Also pins the multi-subscriber hover contract it depends
// on — an app must be able to keep its own onHoverData handler alongside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, ELEMENT_WIDTH } from './helpers/dom.mjs';

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
  const canvasId = 'tooltip-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const ts = new TimeSeries({ canvas: canvasId, sources: [freshBars()], initialView: null });
  await setView(ts, start * 1000, (start + COUNT * INTERVAL) * 1000);
  return { ts, canvas };
}

// Screen x for a ms timestamp, plus a y inside the lowest (first) series.
function probe(ts) {
  const area = ts.getPlotArea(), vp = ts.getViewport();
  return {
    x: ms => ((ms - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left,
    yBottom: area.margin.top + area.plotHeight - 5,
    area,
  };
}

// Drive a real hover: the pointer move the overlay tracks, then the library's
// own handler that runs the hit test.
function hover(canvas, x, y) {
  canvas.emit('mousemove', { clientX: x, clientY: y });
  canvas.onmousemove({ clientX: x, clientY: y });
}

const HIT_MS = (start + 5 * INTERVAL + 1800) * 1000;

test('the library builds no tooltip until attachTooltip is called', async () => {
  const before = document.body.children.length;
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);

  hover(canvas, p.x(HIT_MS), p.yBottom);

  assert.equal(document.body.children.length, before,
    'constructing and hovering a chart must not create any DOM');
});

test('the default body shows swatch, series label, value and interval', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts);

  assert.equal(tip.el.style.display, 'none', 'starts hidden');
  hover(canvas, p.x(HIT_MS), p.yBottom);

  assert.equal(tip.el.style.display, 'block');
  const text = tip.el.textContent;
  assert.match(text, /s1/, 'series label');
  assert.match(text, /15/, 'value (10 + slot 5)');
  assert.match(text, /1h/, 'interval, formatted in exact units');

  // Title row: swatch + label + meta; second row is the timestamp.
  const [title, time] = tip.el.children;
  assert.equal(title.className, 'ts-tooltip-title');
  assert.equal(title.children[0].className, 'ts-tooltip-swatch');
  assert.ok(title.children[0].style.background, 'swatch carries the painted colour');
  assert.equal(time.className, 'ts-tooltip-time');
  assert.ok(time.textContent.length > 0, 'timestamp row is filled');

  tip.destroy();
});

test('a miss and a mouseleave both hide it', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts);

  hover(canvas, p.x(HIT_MS), p.yBottom);
  assert.equal(tip.el.style.display, 'block', 'precondition: shown');

  hover(canvas, p.x(start * 1000 + 60000), p.area.margin.top + 2);
  assert.equal(tip.el.style.display, 'none', 'empty space hides it');

  hover(canvas, p.x(HIT_MS), p.yBottom);
  canvas.onmouseleave();
  assert.equal(tip.el.style.display, 'none', 'leaving the canvas hides it');

  tip.destroy();
});

test('labelFor retargets just the label, keeping the default body', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts, {
    labelFor: key => ({ s1: 'Germany', s2: 'France' })[key] || key,
  });

  hover(canvas, p.x(HIT_MS), p.yBottom);

  assert.match(tip.el.textContent, /Germany/);
  assert.doesNotMatch(tip.el.textContent, /s1/, 'raw key replaced');
  assert.match(tip.el.textContent, /15/, 'value still rendered by the default body');

  tip.destroy();
});

test('formatter takes over completely and can build on defaultContent', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);

  let seen = null;
  const tip = TimeSeries.attachTooltip(ts, {
    formatter(ctx) {
      seen = ctx;
      const nodes = ctx.defaultContent();
      const extra = document.createElement('div');
      extra.textContent = 'slot ' + ctx.n;
      return nodes.concat(extra);
    },
  });

  hover(canvas, p.x(HIT_MS), p.yBottom);

  assert.equal(seen.key, 's1');
  assert.equal(seen.value, 15);
  assert.equal(seen.n, 5);
  assert.equal(seen.interval, INTERVAL);
  assert.ok(seen.time instanceof Date, 'ctx carries a resolved Date');
  assert.ok(seen.color, 'ctx carries the painted colour');
  assert.match(tip.el.textContent, /slot 5/, 'formatter output rendered');
  assert.match(tip.el.textContent, /s1/, 'defaultContent still included');

  tip.destroy();
});

test('a formatter returning null hides the tooltip for that hit', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts, { formatter: () => null });

  hover(canvas, p.x(HIT_MS), p.yBottom);

  assert.equal(tip.el.style.display, 'none');
  tip.destroy();
});

test('a string formatter is inserted as text, not markup', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts, { formatter: () => '<b>x</b>' });

  hover(canvas, p.x(HIT_MS), p.yBottom);

  assert.equal(tip.el.textContent, '<b>x</b>', 'escaped by going through textContent');
  assert.equal(tip.el.innerHTML, '', 'innerHTML untouched');
  tip.destroy();
});

test('plotTypes restricts which plots get a tooltip', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts, { plotTypes: ['multipoint'] });

  hover(canvas, p.x(HIT_MS), p.yBottom);

  assert.equal(tip.el.style.display, 'none', 'multibar hit rejected');
  tip.destroy();
});

test('setColors re-themes the tooltip through onColorsChange', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts);

  hover(canvas, p.x(HIT_MS), p.yBottom);
  assert.equal(tip.el.style.background, TimeSeries.themes.light.tooltipBg);

  ts.setColors(TimeSeries.themes.dark);
  assert.equal(tip.el.style.background, TimeSeries.themes.dark.tooltipBg);
  assert.equal(tip.el.style.borderColor, TimeSeries.themes.dark.tooltipBorder);
  assert.equal(tip.el.style.color, TimeSeries.themes.dark.tooltipText);

  tip.destroy();
});

test('an explicit colors option wins over the palette', async () => {
  const { ts } = await buildInstance();
  const tip = TimeSeries.attachTooltip(ts, { colors: { tooltipBg: '#abcdef' } });

  assert.equal(tip.el.style.background, '#abcdef');
  ts.setColors(TimeSeries.themes.dark);
  assert.equal(tip.el.style.background, '#abcdef', 'override survives a theme switch');

  tip.destroy();
});

test('it flips to the left of the cursor near the right viewport edge', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts);

  // Far left: placed to the right of the cursor.
  const x = p.x(HIT_MS);
  hover(canvas, x, p.yBottom);
  assert.equal(tip.el.style.left, (x + 14) + 'px');

  // The pointer tracker takes clientX straight from the event, so a position
  // near window.innerWidth (1024) forces the flip regardless of the hit x.
  canvas.emit('mousemove', { clientX: 1000, clientY: p.yBottom });
  canvas.onmousemove({ clientX: x, clientY: p.yBottom });
  assert.equal(tip.el.style.left, (1000 - ELEMENT_WIDTH - 14) + 'px');

  tip.destroy();
});

test('destroy removes the element and unsubscribes', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);
  const tip = TimeSeries.attachTooltip(ts);

  hover(canvas, p.x(HIT_MS), p.yBottom);
  assert.equal(tip.el.parentNode, document.body);

  tip.destroy();
  assert.equal(tip.el.parentNode, null, 'element detached');
  assert.equal(canvas.listeners.get('mousemove').length, 0, 'pointer listener removed');

  // A later hover must not resurrect it.
  tip.el.style.display = 'none';
  hover(canvas, p.x(HIT_MS), p.yBottom);
  assert.equal(tip.el.style.display, 'none', 'hover handler unsubscribed');
});

test('the tooltip coexists with an app-owned hover handler', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);

  let appSaw = null;
  ts.onHoverDataCallback((plot, n, key) => { appSaw = key; });
  const tip = TimeSeries.attachTooltip(ts);

  hover(canvas, p.x(HIT_MS), p.yBottom);

  assert.equal(appSaw, 's1', 'app handler still fires');
  assert.equal(tip.el.style.display, 'block', 'tooltip fires too');

  tip.destroy();
});

test('onHoverDataCallback hands back a working unsubscribe', async () => {
  const { ts, canvas } = await buildInstance();
  const p = probe(ts);

  let calls = 0;
  const off = ts.onHoverDataCallback(() => { calls++; });
  hover(canvas, p.x(HIT_MS), p.yBottom);
  assert.equal(calls, 1);

  off();
  hover(canvas, p.x(HIT_MS), p.yBottom);
  assert.equal(calls, 1, 'no further calls after unsubscribing');
});
