// Keyboard navigation. The chart was previously unusable without a mouse:
// no key handler at all, and a <canvas> cannot even take focus without an
// explicit tabindex.
//
// Every arrow moves the viewport in whole cells of the labelled x-axis level:
// left/right page, up/down zoom, and shift makes each the single-cell variant.
// A keyboard user therefore lands on the same boundaries as someone clicking
// the nav buttons, at any zoom level.
//
// Five letters enter follow mode, anchored where the letter says: f/F right
// edge, p/P left, c centre. All five end in the same rolling state; shift only
// picks the span left on screen — slide the current width onto now, or pin the
// far edge and stretch to it.
//
// Six more jump to a calendar unit: t today, and d/w/m/y the day, ISO week,
// month or year the middle of the window falls in.
//
// Two are switches rather than movement: l flips the legend overlay, g flips
// whether the arrows snap to the axis grid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');

let nextId = 0;
function build(opts) {
  const canvasId = 'kbd-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const ts = new TimeSeries(Object.assign(
    { canvas: canvasId, sources: [], initialView: null }, opts));
  return { ts, canvas };
}

// A synthetic KeyboardEvent, recording whether the default was prevented.
function keyEvent(key, shiftKey = false, ctrlKey = false) {
  return { key, shiftKey, ctrlKey, prevented: false, preventDefault() { this.prevented = true; } };
}

// Local midnight, not UTC: panFloor/panAdd work in local time, so a window
// pinned to UTC midnight would sit mid-day in most zones and the first pan
// would legitimately widen it out to the surrounding day boundaries.
const MON = new Date(2026, 4, 11).getTime();   // Mon 11 May 2026, 00:00 local
const NEXT_MON = new Date(2026, 4, 18).getTime();

test('the canvas becomes focusable and describes itself', () => {
  const { canvas } = build();
  assert.equal(canvas.tabIndex, 0, 'canvas must be in the tab order');
  assert.equal(canvas.getAttribute('role'), 'application');
  assert.ok(canvas.getAttribute('aria-label'), 'needs an accessible name');
});

test('keyboard: false leaves the canvas untouched and unhandled', () => {
  const { ts, canvas } = build({ keyboard: false });
  assert.notEqual(canvas.tabIndex, 0);
  assert.equal(canvas.getAttribute('role'), null);
  assert.equal(typeof canvas.onkeydown, 'undefined');
  assert.ok(ts, 'instance still constructs');
});

test('a caller-supplied aria-label is not overwritten', () => {
  const canvasId = 'kbd-test-label';
  const canvas = makeCanvas(canvasId);
  canvas.setAttribute('aria-label', 'CPU load, last 24 hours');
  new TimeSeries({ canvas: canvasId, sources: [], initialView: null });
  assert.equal(canvas.getAttribute('aria-label'), 'CPU load, last 24 hours');
});

test('ArrowRight pages forward by one screenful, snapped', async () => {
  const { ts, canvas } = build();
  await setView(ts, MON, NEXT_MON);

  canvas.onkeydown(keyEvent('ArrowRight'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(new Date(vp.tmin).toDateString(), 'Mon May 18 2026');
  assert.equal(new Date(vp.tmax).toDateString(), 'Mon May 25 2026');
});

test('ArrowLeft pages backward by one screenful, snapped', async () => {
  const { ts, canvas } = build();
  await setView(ts, MON, NEXT_MON);

  canvas.onkeydown(keyEvent('ArrowLeft'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(new Date(vp.tmin).toDateString(), 'Mon May 04 2026');
  assert.equal(new Date(vp.tmax).toDateString(), 'Mon May 11 2026');
});

test('left then right returns to the original window', async () => {
  const { ts, canvas } = build();
  await setView(ts, MON, NEXT_MON);

  canvas.onkeydown(keyEvent('ArrowRight'));
  await sleep(700);
  canvas.onkeydown(keyEvent('ArrowLeft'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, MON);
  assert.equal(vp.tmax, NEXT_MON);
});

test('arrow keys suppress the browser default, other keys do not', async () => {
  const { ts, canvas } = build();
  await setView(ts, MON, NEXT_MON);

  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    const e = keyEvent(key);
    canvas.onkeydown(e);
    assert.equal(e.prevented, true, `${key} should preventDefault (page scroll)`);
    await sleep(700);
  }

  for (const key of ['a', 'Tab', 'Enter', 'Home', 'PageDown']) {
    const e = keyEvent(key);
    canvas.onkeydown(e);
    assert.equal(e.prevented, false, `${key} must be left to the browser`);
  }
});

test('an unhandled key does not move the viewport', async () => {
  const { ts, canvas } = build();
  await setView(ts, MON, NEXT_MON);

  canvas.onkeydown(keyEvent('a'));
  await sleep(100);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, MON);
  assert.equal(vp.tmax, NEXT_MON);
});

test('the snap unit follows the zoom level', async () => {
  // A 6-hour window snaps to hours, not days: paging must land on an hour
  // boundary and move by roughly the window width.
  const { ts, canvas } = build();
  const t0 = Date.UTC(2026, 4, 11, 9);
  await setView(ts, t0, t0 + 6 * 3600000);

  canvas.onkeydown(keyEvent('ArrowRight'));
  await sleep(700);

  const vp = ts.getViewport();
  const d = new Date(vp.tmin);
  assert.equal(d.getMinutes(), 0, 'should land on an hour boundary');
  assert.equal(d.getSeconds(), 0);
  assert.ok(vp.tmin > t0, 'should have moved forward');
});

// ── Zoom and the shift variants ───────────────────────────────────────────────
test('up/down zoom in and out around the centre', async () => {
  const { ts, canvas } = build();
  const t0 = new Date(2026, 4, 11, 3).getTime();
  await setView(ts, t0, t0 + 6 * 3600000);          // 6 h

  canvas.onkeydown(keyEvent('ArrowUp'));
  await sleep(700);
  const zoomedIn = ts.getViewport();
  assert.ok(zoomedIn.tmax - zoomedIn.tmin < 6 * 3600000, 'up must zoom in');

  canvas.onkeydown(keyEvent('ArrowDown'));
  await sleep(700);
  const back = ts.getViewport();
  assert.ok(back.tmax - back.tmin > zoomedIn.tmax - zoomedIn.tmin, 'down must zoom out');
});

test('shift+left/right steps a single cell, not a whole page', async () => {
  const { ts, canvas } = build();
  const t0 = new Date(2026, 4, 11, 3).getTime();
  await setView(ts, t0, t0 + 6 * 3600000);          // 6 cells of one hour

  const g = ts.getSnapGrid();
  assert.equal(g.unit, 'hour');
  assert.equal(g.k, 6);

  canvas.onkeydown(keyEvent('ArrowRight', true));
  await sleep(700);
  const vp = ts.getViewport();
  assert.equal(vp.tmin, t0 + 3600000, 'one hour cell forward, not six');
  assert.equal(vp.tmax - vp.tmin, 6 * 3600000, 'width must not change');
});

test('shift+up/down changes the cell count by one', async () => {
  const { ts, canvas } = build();
  const t0 = new Date(2026, 4, 11, 3).getTime();
  await setView(ts, t0, t0 + 6 * 3600000);

  canvas.onkeydown(keyEvent('ArrowUp', true));
  await sleep(700);
  let g = ts.getSnapGrid();
  assert.equal(g.k, 5, 'one cell fewer');
  assert.equal(g.tmin, t0, 'left edge stays put');

  canvas.onkeydown(keyEvent('ArrowDown', true));
  await sleep(700);
  g = ts.getSnapGrid();
  assert.equal(g.k, 6, 'and back');
});

test('panSnap: off pans by the exact width instead of snapping', async () => {
  const { ts, canvas } = build({ panSnap: 'off' });
  const t0 = new Date(2026, 4, 11, 18, 55).getTime();
  const t1 = new Date(2026, 4, 11, 20, 4).getTime();
  await setView(ts, t0, t1);

  canvas.onkeydown(keyEvent('ArrowRight'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, t1, 'continuous pan starts where the window ended');
  assert.equal(vp.tmax - vp.tmin, t1 - t0, 'width preserved exactly');
});
// ── The follow keys ───────────────────────────────────────────────────────────
// Follow mode keeps rolling once entered, so every test below stops it again:
// follower_tick re-arms itself and would otherwise outlive the test.

const HOUR = 3600000;

test('f, p and c roll with now at the right edge, the left and the centre', async () => {
  for (const [key, pct] of [['f', 100], ['p', 0], ['c', 50]]) {
    const { ts, canvas } = build();
    const t0 = Date.now() - 6 * HOUR;
    await setView(ts, t0, t0 + HOUR);

    let anchor = null;
    ts.onFollow(p => { anchor = p; });

    const e = keyEvent(key);
    canvas.onkeydown(e);
    assert.equal(e.prevented, true, `${key} should preventDefault`);
    await sleep(700);

    assert.equal(anchor, pct, `${key} anchors at ${pct}%`);
    const vp = ts.getViewport();
    const span = vp.tmax - vp.tmin;
    assert.ok(Math.abs(span - HOUR) < 1000, `${key} keeps the window width`);
    const at = 100 * (Date.now() - vp.tmin) / span;
    assert.ok(Math.abs(at - pct) < 2, `${key}: now sits at ${pct}%, got ${at.toFixed(1)}%`);
    ts.stop();
  }
});

test('F stretches the right edge onto now and holds the left', async () => {
  const { ts, canvas } = build();
  const t0 = Date.now() - 6 * HOUR;          // a one-hour window, six hours back
  await setView(ts, t0, t0 + HOUR);

  let anchor = null;
  ts.onFollow(p => { anchor = p; });
  canvas.onkeydown(keyEvent('F'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(anchor, 100, 'anchors at the right edge, exactly like f');
  assert.ok(Math.abs(vp.tmin - t0) < 2000, 'the left edge stayed where it was');
  assert.ok(Math.abs(vp.tmax - Date.now()) < 2000, 'the right edge reached now');
  assert.ok(vp.tmax - vp.tmin > 5 * HOUR, 'so the window grew rather than slid');
  ts.stop();
});

test('P stretches the left edge onto now and holds the right', async () => {
  const { ts, canvas } = build();
  const t1 = Date.now() + 6 * HOUR;          // a one-hour window, six hours ahead
  await setView(ts, t1 - HOUR, t1);

  let anchor = null;
  ts.onFollow(p => { anchor = p; });
  canvas.onkeydown(keyEvent('P'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(anchor, 0, 'anchors at the left edge, exactly like p');
  assert.ok(Math.abs(vp.tmax - t1) < 2000, 'the right edge stayed where it was');
  assert.ok(Math.abs(vp.tmin - Date.now()) < 2000, 'the left edge reached now');
  assert.ok(vp.tmax - vp.tmin > 5 * HOUR, 'so the window grew rather than slid');
  ts.stop();
});

test('F on a window entirely in the future falls back to f', async () => {
  // now - tmin is negative here: stretching would give an inverted window, which
  // clampRange would silently flip. The slide is what is left.
  const { ts, canvas } = build();
  const t0 = Date.now() + 6 * HOUR;
  await setView(ts, t0, t0 + HOUR);

  canvas.onkeydown(keyEvent('F'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.ok(Math.abs((vp.tmax - vp.tmin) - HOUR) < 1000, 'width kept, as f does');
  assert.ok(Math.abs(vp.tmax - Date.now()) < 2000, 'now at the right edge');
  ts.stop();
});

test('P on a window entirely in the past falls back to p', async () => {
  const { ts, canvas } = build();
  const t1 = Date.now() - 6 * HOUR;
  await setView(ts, t1 - HOUR, t1);

  canvas.onkeydown(keyEvent('P'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.ok(Math.abs((vp.tmax - vp.tmin) - HOUR) < 1000, 'width kept, as p does');
  assert.ok(Math.abs(vp.tmin - Date.now()) < 2000, 'now at the left edge');
  ts.stop();
});

test('a modifier hands the key back to the browser', async () => {
  // Ctrl+F is Find and Ctrl+P is Print; a focused chart must not swallow either.
  const { ts, canvas } = build();
  const t0 = new Date(2026, 4, 11).getTime();
  await setView(ts, t0, t0 + 7 * 24 * HOUR);

  for (const key of ['f', 'p', 'c', 'm', 'w', 'ArrowRight']) {
    const e = keyEvent(key, false, true);
    canvas.onkeydown(e);
    assert.equal(e.prevented, false, `Ctrl+${key} must be left to the browser`);
  }
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, t0, 'and must not move the viewport');
  assert.equal(vp.tmax, t0 + 7 * 24 * HOUR);
});

// -- The calendar keys ---------------------------------------------------------
// t jumps to today; d/w/m/y to the day, ISO week, month or year the middle of
// the window falls in. Unlike the follow keys these land on exact calendar
// boundaries and stay there, so the assertions are exact.

// Wed 13 May 2026, 06:00-18:00 local: the middle is Wed 12:00, and no edge of
// this window is already a day, week, month or year boundary — zoom() returns
// early when the target equals the current window, which would make a key that
// did nothing look like it worked.
const WED = new Date(2026, 4, 13, 6, 0).getTime();
const WED_END = new Date(2026, 4, 13, 18, 0).getTime();

async function pressOn(key, t0, t1) {
  const { ts, canvas } = build();
  await setView(ts, t0, t1);
  const e = keyEvent(key);
  canvas.onkeydown(e);
  assert.equal(e.prevented, true, `${key} should preventDefault`);
  await sleep(700);
  return ts.getViewport();
}

test('d goes to the day the middle of the window is in', async () => {
  const vp = await pressOn('d', WED, WED_END);
  assert.equal(vp.tmin, new Date(2026, 4, 13).getTime(), 'local midnight, Wed');
  assert.equal(vp.tmax, new Date(2026, 4, 14).getTime(), 'to local midnight, Thu');
});

test('w goes to the ISO week the middle of the window is in', async () => {
  const vp = await pressOn('w', WED, WED_END);
  assert.equal(vp.tmin, new Date(2026, 4, 11).getTime(), 'Monday starts the week');
  assert.equal(vp.tmax, new Date(2026, 4, 18).getTime(), 'to the Monday after');
});

test('m goes to the month the middle of the window is in', async () => {
  const vp = await pressOn('m', WED, WED_END);
  assert.equal(vp.tmin, new Date(2026, 4, 1).getTime());
  assert.equal(vp.tmax, new Date(2026, 5, 1).getTime());
});

test('y goes to the year the middle of the window is in', async () => {
  const vp = await pressOn('y', WED, WED_END);
  assert.equal(vp.tmin, new Date(2026, 0, 1).getTime());
  assert.equal(vp.tmax, new Date(2027, 0, 1).getTime());
});

test('t goes to today, whatever the window was showing', async () => {
  const vp = await pressOn('t', WED, WED_END);
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const tomorrow = new Date(midnight);
  tomorrow.setDate(midnight.getDate() + 1);
  assert.equal(vp.tmin, midnight.getTime());
  assert.equal(vp.tmax, tomorrow.getTime());
});

test('w across new year uses the ISO week-numbering year, not the calendar one', async () => {
  // Wed 31 Dec 2025 is in ISO week 1 of *2026*, which starts Mon 29 Dec 2025.
  // Going through zoomWeek(getFullYear(), getWeek(...)) would ask for week 1 of
  // 2025 and land a year early; walking back to the Monday never names a year.
  const t0 = new Date(2025, 11, 31, 6, 0).getTime();
  const vp = await pressOn('w', t0, t0 + 12 * HOUR);
  assert.equal(vp.tmin, new Date(2025, 11, 29).getTime(), 'Mon 29 Dec 2025');
  assert.equal(vp.tmax, new Date(2026, 0, 5).getTime(), 'to Mon 5 Jan 2026');
});

test('d lands on local midnight across a DST transition', async () => {
  // 29 Mar 2026 is the spring-forward Sunday in Europe/Berlin: the day is 23
  // hours long. Comparing against Date's own boundaries keeps this exact in
  // every zone, and catches any attempt to reach the next day by adding 864e5.
  const t0 = new Date(2026, 2, 29, 6, 0).getTime();
  const vp = await pressOn('d', t0, t0 + 6 * HOUR);
  const start = new Date(2026, 2, 29).getTime();
  const end = new Date(2026, 2, 30).getTime();
  assert.equal(vp.tmin, start, 'starts at local midnight, not 01:00');
  assert.equal(vp.tmax, end);
  if (end - start !== 24 * HOUR)
    assert.equal(end - start, 23 * HOUR, 'a DST zone gives a 23-hour day');
});

test('a calendar key leaves follow mode instead of entering it', async () => {
  const { ts, canvas } = build();
  await setView(ts, WED, WED_END);
  let followed = false;
  ts.onFollow(() => { followed = true; });

  canvas.onkeydown(keyEvent('m'));
  await sleep(700);

  assert.equal(followed, false, 'm is the month now, not centerNow()');
  const vp = ts.getViewport();
  assert.equal(vp.tmin, new Date(2026, 4, 1).getTime(), 'and the window stays put');
  await sleep(200);
  assert.equal(ts.getViewport().tmin, vp.tmin, 'nothing is rolling it along');
});

// -- The switches --------------------------------------------------------------
// Neither moves the viewport. g flips the snap policy, which only shows on the
// next arrow press; l flips the legend, and is bound whether or not one is
// attached so the binding never depends on what the host hung off the chart.

test('g flips the snap policy back and forth', async () => {
  const { ts, canvas } = build();
  assert.equal(ts.getPanSnap(), 'grid', 'grid is the default');

  let e = keyEvent('g');
  canvas.onkeydown(e);
  assert.equal(e.prevented, true);
  assert.equal(ts.getPanSnap(), 'off');

  e = keyEvent('g');
  canvas.onkeydown(e);
  assert.equal(e.prevented, true);
  assert.equal(ts.getPanSnap(), 'grid', 'and back');
});

test('after g the arrows pan unsnapped, by the exact width', async () => {
  // The same assertion as the panSnap: 'off' constructor test, reached through
  // the key instead — proof that g moves the real policy, not just a flag.
  const { ts, canvas } = build();
  const t0 = new Date(2026, 4, 11, 18, 55).getTime();
  const t1 = new Date(2026, 4, 11, 20, 4).getTime();
  await setView(ts, t0, t1);

  canvas.onkeydown(keyEvent('g'));
  canvas.onkeydown(keyEvent('ArrowRight'));
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, t1, 'continuous pan starts where the window ended');
  assert.equal(vp.tmax - vp.tmin, t1 - t0, 'width preserved exactly');
});

test('l toggles whatever legend is registered with the chart', async () => {
  // Against the registered controller rather than a real legend: this chart has
  // no series, and an empty legend hides itself regardless of the key. That the
  // shipped legend registers itself, and that toggling it moves the actual
  // element, is covered end to end in legend.test.mjs.
  const { ts, canvas } = build();
  let flips = 0;
  ts.setLegend({ toggle() { flips++; } });

  const e = keyEvent('l');
  canvas.onkeydown(e);
  assert.equal(e.prevented, true);
  assert.equal(flips, 1);

  canvas.onkeydown(keyEvent('l'));
  assert.equal(flips, 2, 'it is a toggle, not a one-way switch');
});

test('l is harmless when no legend is attached', async () => {
  const { ts, canvas } = build();
  const t0 = new Date(2026, 4, 11).getTime();
  const t1 = new Date(2026, 4, 18).getTime();
  await setView(ts, t0, t1);

  const e = keyEvent('l');
  canvas.onkeydown(e);          // must not throw
  await sleep(200);

  assert.equal(e.prevented, true, 'bound regardless of what the host attached');
  const vp = ts.getViewport();
  assert.equal(vp.tmin, t0, 'and moves nothing');
  assert.equal(vp.tmax, t1);
});
