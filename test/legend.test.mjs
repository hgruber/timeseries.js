// Covers the shipped legend overlay (src/legend.js): that it stays inert until
// attached, renders one clickable row per active series, toggles visibility on
// click, honours each override level, re-themes on setColors, anchors and drags,
// and detaches cleanly. Also pins the onSeriesChange unsubscribe contract it
// relies on to detach.

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
  const canvasId = 'legend-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const ts = new TimeSeries({ canvas: canvasId, sources: [freshBars()], initialView: null });
  await setView(ts, start * 1000, (start + COUNT * INTERVAL) * 1000);
  return { ts, canvas };
}

const rowsOf = lg => lg.el.querySelectorAll('.ts-legend-item');
const swatchOf = row => row.querySelectorAll('.ts-legend-swatch')[0];

test('the library builds no legend until attachLegend is called', async () => {
  const before = document.body.children.length;
  await buildInstance();
  assert.equal(document.body.children.length, before,
    'constructing a chart must not create any DOM');
});

test('the default renders one clickable row per series with swatch and label', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts);

  assert.equal(lg.el.style.display, 'block', 'panel shown once series exist');
  const rows = rowsOf(lg);
  assert.equal(rows.length, 2, 's1 and s2');
  assert.match(rows[0].textContent, /s1/);
  assert.equal(rows[0].getAttribute('aria-pressed'), 'true', 'visible series');
  assert.ok(swatchOf(rows[0]).style.background, 'swatch carries the painted colour');

  lg.destroy();
});

test('no title by default; a title option shows the header', async () => {
  const { ts } = await buildInstance();

  const plain = TimeSeries.attachLegend(ts);
  assert.equal(plain.el.children[0].style.display, 'none', 'header hidden');
  plain.destroy();

  const titled = TimeSeries.attachLegend(ts, { title: 'Series' });
  const header = titled.el.children[0];
  assert.equal(header.style.display, 'block');
  assert.equal(header.textContent, 'Series');
  titled.destroy();
});

test('clicking a row toggles that series and re-renders it dimmed', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts);

  rowsOf(lg)[0].emit('click');

  assert.equal(ts.getSeries().find(s => s.id === 's1').hidden, true, 'series hidden in the model');
  const row = rowsOf(lg)[0];       // itemsEl was rebuilt by onSeriesChange → re-query
  assert.equal(row.getAttribute('aria-pressed'), 'false');
  assert.equal(row.style.opacity, '0.45', 'dimmed');
  assert.equal(swatchOf(row).style.background, 'transparent', 'hollow swatch when hidden');

  lg.destroy();
});

test('labelFor retargets just the label', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts, {
    labelFor: id => ({ s1: 'Germany', s2: 'France' })[id] || id,
  });

  assert.match(lg.el.textContent, /Germany/);
  assert.doesNotMatch(lg.el.textContent, /s1/, 'raw id replaced');
  lg.destroy();
});

test('colorFor retargets just the swatch', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts, { colorFor: () => '#abcdef' });

  assert.equal(swatchOf(rowsOf(lg)[0]).style.background, '#abcdef');
  lg.destroy();
});

test('extra appends a trailing node per row', async () => {
  const { ts } = await buildInstance();
  const totals = { s1: 111, s2: 55 };
  const lg = TimeSeries.attachLegend(ts, { extra: s => String(totals[s.id]) });

  assert.match(rowsOf(lg)[0].textContent, /111/);
  const ex = rowsOf(lg)[0].querySelectorAll('.ts-legend-extra')[0];
  assert.equal(ex.style.marginLeft, 'auto', 'pushed to the right');
  lg.destroy();
});

test('formatter takes over a row and can build on defaultRow; false omits a series', async () => {
  const { ts } = await buildInstance();

  let seen = null;
  const lg = TimeSeries.attachLegend(ts, {
    formatter(ctx) {
      if (ctx.id === 's2') return false;          // drop s2 from the list
      seen = ctx;
      const nodes = ctx.defaultRow();
      const tag = document.createElement('span');
      tag.textContent = ' [' + ctx.id + ']';
      return nodes.concat(tag);
    },
  });

  const rows = rowsOf(lg);
  assert.equal(rows.length, 1, 's2 omitted by the formatter');
  assert.equal(seen.id, 's1');
  assert.ok(seen.color, 'ctx carries the painted colour');
  assert.match(rows[0].textContent, /\[s1\]/, 'formatter output rendered');
  assert.match(rows[0].textContent, /s1/, 'defaultRow still included');

  lg.destroy();
});

test('onItemClick replaces the default toggle', async () => {
  const { ts } = await buildInstance();
  let clicked = null;
  const lg = TimeSeries.attachLegend(ts, { onItemClick: id => { clicked = id; } });

  rowsOf(lg)[0].emit('click');

  assert.equal(clicked, 's1', 'custom handler ran');
  assert.equal(ts.getSeries().find(s => s.id === 's1').hidden, false,
    'default toggle suppressed');
  lg.destroy();
});

test('setColors re-themes the legend through onColorsChange', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts);

  assert.equal(lg.el.style.background, TimeSeries.themes.light.legendBg);

  ts.setColors(TimeSeries.themes.dark);
  assert.equal(lg.el.style.background, TimeSeries.themes.dark.legendBg);
  assert.equal(lg.el.style.borderColor, TimeSeries.themes.dark.legendBorder);
  assert.equal(lg.el.style.color, TimeSeries.themes.dark.legendText);

  lg.destroy();
});

test('an explicit colors option wins over the palette', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts, { colors: { legendBg: '#012345' } });

  assert.equal(lg.el.style.background, '#012345');
  ts.setColors(TimeSeries.themes.dark);
  assert.equal(lg.el.style.background, '#012345', 'override survives a theme switch');
  lg.destroy();
});

test('show / hide / toggle drive the panel visibility', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts);

  assert.equal(lg.el.style.display, 'block');
  lg.hide();
  assert.equal(lg.el.style.display, 'none');
  lg.toggle();
  assert.equal(lg.el.style.display, 'block');
  lg.hide(); lg.show();
  assert.equal(lg.el.style.display, 'block');
  lg.destroy();
});

test('an empty series list hides the panel', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts);
  assert.equal(lg.el.style.display, 'block');

  ts.clearAll();
  lg.refresh();
  assert.equal(lg.el.style.display, 'none', 'no series → hidden even when wantVisible');
  lg.destroy();
});

test('the panel anchors to the top-right of the chart', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts);

  assert.equal(lg.el.style.left, 'auto');
  assert.match(lg.el.style.right, /px$/);
  assert.match(lg.el.style.top, /px$/);
  assert.match(lg.el.style.maxHeight, /px$/, 'height clamped to the canvas');
  lg.destroy();
});

test('dragging moves the panel and pins it against re-anchoring; a row click does not drag', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts);

  // A mousedown that starts on a row must toggle, never drag.
  lg.el.emit('mousedown', { target: rowsOf(lg)[0], clientX: 5, clientY: 5, preventDefault() {} });
  assert.equal(lg.el.classList.contains('ts-legend-dragging'), false, 'row press is not a drag');

  // A mousedown on the panel chrome starts a drag.
  lg.el.emit('mousedown', { target: lg.el, clientX: 500, clientY: 100, preventDefault() {} });
  assert.equal(lg.el.classList.contains('ts-legend-dragging'), true);
  assert.equal(lg.el.style.cursor, 'grabbing');

  document.emit('mousemove', { clientX: 600, clientY: 160 });
  assert.equal(lg.el.style.left, '100px');
  assert.equal(lg.el.style.top, '60px');
  assert.equal(lg.el.style.right, 'auto');

  document.emit('mouseup', {});
  assert.equal(lg.el.classList.contains('ts-legend-dragging'), false);

  lg.refresh();
  assert.equal(lg.el.style.left, '100px', 'a dragged panel is not re-anchored on refresh');
  lg.destroy();
});

test('destroy removes the element and unsubscribes from series changes', async () => {
  const { ts } = await buildInstance();
  const lg = TimeSeries.attachLegend(ts);
  assert.equal(lg.el.parentNode, document.body);
  const row = rowsOf(lg)[0];
  assert.equal(row.getAttribute('aria-pressed'), 'true');

  lg.destroy();
  assert.equal(lg.el.parentNode, null, 'element detached');

  // A later series change must not rebuild the detached legend.
  ts.toggleSeries('s1');
  assert.equal(row.getAttribute('aria-pressed'), 'true',
    'stale row untouched — refresh unsubscribed');
});

test('onSeriesChange hands back a working unsubscribe', async () => {
  const { ts } = await buildInstance();

  let calls = 0;
  const off = ts.onSeriesChange(() => { calls++; });
  ts.toggleSeries('s1');
  assert.equal(calls, 1);

  off();
  ts.toggleSeries('s1');
  assert.equal(calls, 1, 'no further calls after unsubscribing');
});
