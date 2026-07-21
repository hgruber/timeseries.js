// Keyboard navigation. The chart was previously unusable without a mouse:
// no key handler at all, and a <canvas> cannot even take focus without an
// explicit tabindex.
//
// Arrow keys page by one screenful snapped to a calendar unit — the same
// behaviour as ts.pan(), so a keyboard user lands on the same boundaries as
// someone clicking the nav buttons.

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
function keyEvent(key) {
  return { key, prevented: false, preventDefault() { this.prevented = true; } };
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

  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const e = keyEvent(key);
    canvas.onkeydown(e);
    assert.equal(e.prevented, true, `${key} should preventDefault (page scroll)`);
    await sleep(700);
  }

  for (const key of ['a', 'Tab', 'Enter', 'ArrowUp', 'ArrowDown']) {
    const e = keyEvent(key);
    canvas.onkeydown(e);
    assert.equal(e.prevented, false, `${key} must be left to the browser`);
  }
});

test('an unhandled key does not move the viewport', async () => {
  const { ts, canvas } = build();
  await setView(ts, MON, NEXT_MON);

  canvas.onkeydown(keyEvent('ArrowUp'));
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
