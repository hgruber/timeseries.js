// Viewport history — back() / forward(), the b and B keys.
//
// The chart had twenty ways to change the window and none to undo one. The
// history is kept the way a browser keeps it: every *new* navigation files the
// window it leaves on a back stack and discards the forward branch; back() and
// forward() move one entry between the two stacks.
//
// Two things are easy to get wrong and are what most of this file guards:
//   - An analogue gesture is ONE navigation. A drag files the window it started
//     from, once, on the first movement — not one entry per mousemove — and a
//     click that never moves files nothing at all.
//   - A rolling window must come back rolling. The entry carries the follow
//     anchor, snapshotted before the doStop() that every pointer handler fires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');

let nextId = 0;
function build(opts) {
  const canvasId = 'hist-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const ts = new TimeSeries(Object.assign(
    { canvas: canvasId, sources: [], initialView: null }, opts));
  return { ts, canvas };
}

function keyEvent(key) {
  return { key, shiftKey: false, ctrlKey: false, prevented: false,
           preventDefault() { this.prevented = true; } };
}

// Local midnight throughout, as in keyboard.test.mjs: the snap grid works in
// local time, so a UTC-pinned window would sit mid-day in most zones.
const MON = new Date(2026, 4, 11).getTime();       // Mon 11 May 2026, 00:00
const NEXT_MON = new Date(2026, 4, 18).getTime();
const TUE = new Date(2026, 4, 12).getTime();
const WED = new Date(2026, 4, 13).getTime();

// setView() goes through ts.zoom(), so it files an entry itself — every test
// that uses it for setup clears the history afterwards.
async function startAt(opts, tmin = MON, tmax = NEXT_MON) {
  const built = build(opts);
  await setView(built.ts, tmin, tmax);
  built.ts.clearHistory();
  return built;
}

function windowOf(ts) {
  const vp = ts.getViewport();
  return [vp.tmin, vp.tmax];
}

test('back() walks the visited windows in reverse', async () => {
  const { ts } = await startAt();
  await setView(ts, TUE, WED);
  await setView(ts, MON, TUE);
  assert.equal(ts.getHistory().back, 2);

  assert.equal(ts.back(), true);
  await sleep(700);
  assert.deepEqual(windowOf(ts), [TUE, WED], 'one step back');

  assert.equal(ts.back(), true);
  await sleep(700);
  assert.deepEqual(windowOf(ts), [MON, NEXT_MON], 'and one more');
});

test('forward() returns into what back() left, and both stop at the ends', async () => {
  const { ts } = await startAt();
  await setView(ts, TUE, WED);

  assert.equal(ts.back(), true);
  await sleep(700);
  assert.deepEqual(windowOf(ts), [MON, NEXT_MON]);
  assert.equal(ts.back(), false, 'nothing left behind this');
  assert.deepEqual(windowOf(ts), [MON, NEXT_MON], 'and the window did not move');

  assert.equal(ts.forward(), true);
  await sleep(700);
  assert.deepEqual(windowOf(ts), [TUE, WED]);
  assert.equal(ts.forward(), false, 'nothing ahead of this');
  assert.deepEqual(windowOf(ts), [TUE, WED]);
});

test('a new navigation after back() discards the forward branch', async () => {
  const { ts } = await startAt();
  await setView(ts, TUE, WED);
  ts.back();
  await sleep(700);
  assert.equal(ts.getHistory().forward, 1);

  await setView(ts, MON, TUE);
  assert.equal(ts.getHistory().forward, 0, 'stepping somewhere new ends the branch');
  assert.equal(ts.forward(), false);
});

test('b and B drive the history and swallow their key', async () => {
  const { ts, canvas } = await startAt();
  await setView(ts, TUE, WED);

  const back = keyEvent('b');
  canvas.onkeydown(back);
  await sleep(700);
  assert.equal(back.prevented, true);
  assert.deepEqual(windowOf(ts), [MON, NEXT_MON]);

  const fwd = keyEvent('B');
  canvas.onkeydown(fwd);
  await sleep(700);
  assert.equal(fwd.prevented, true);
  assert.deepEqual(windowOf(ts), [TUE, WED]);

  // Bound whether or not the stack has anything: what the key does must not
  // depend on where the user has been.
  const spare = keyEvent('B');
  canvas.onkeydown(spare);
  assert.equal(spare.prevented, true);
  assert.deepEqual(windowOf(ts), [TUE, WED]);
});

test('a drag is one entry, filed at the window the drag started from', async () => {
  const { ts, canvas } = await startAt();
  const before = windowOf(ts);

  canvas.onmousedown({ clientX: 500, clientY: 200 });
  canvas.onmousemove({ clientX: 460, clientY: 200 });
  canvas.onmousemove({ clientX: 420, clientY: 200 });
  canvas.onmousemove({ clientX: 380, clientY: 200 });
  canvas.onmouseup({ clientX: 380, clientY: 200 });

  assert.notDeepEqual(windowOf(ts), before, 'the drag moved the window');
  assert.equal(ts.getHistory().back, 1, 'three mousemoves, one entry');

  ts.back();
  await sleep(700);
  assert.deepEqual(windowOf(ts), before, 'back lands exactly where the drag began');
});

test('a click that never moves files nothing', async () => {
  const { ts, canvas } = await startAt();
  canvas.onmousedown({ clientX: 500, clientY: 200 });
  canvas.onmouseup({ clientX: 500, clientY: 200 });
  assert.equal(ts.getHistory().back, 0);
  assert.equal(ts.back(), false);
});

test('a wheel flick is one entry, not one per notch', async () => {
  const { ts, canvas } = await startAt();
  const before = windowOf(ts);

  const wheel = () => canvas.onwheel({ deltaY: -100, clientX: 500, clientY: 200,
                                       shiftKey: false, preventDefault() {} });
  wheel(); wheel(); wheel();

  assert.notDeepEqual(windowOf(ts), before, 'the wheel zoomed');
  assert.equal(ts.getHistory().back, 1);

  ts.back();
  await sleep(700);
  assert.deepEqual(windowOf(ts), before);
});

test('pan then back returns the exact window, grid snapping and all', async () => {
  const { ts } = await startAt();
  const before = windowOf(ts);

  ts.pan(1);
  await sleep(700);
  assert.notDeepEqual(windowOf(ts), before);

  ts.back();
  await sleep(700);
  assert.deepEqual(windowOf(ts), before, 'bit for bit, not merely nearby');
});

test('a window recorded while following comes back rolling', async () => {
  const { ts } = await startAt();
  let following = null;
  ts.onFollow(p => { following = p; });
  ts.onStop(() => { following = null; });

  ts.followNow();
  await sleep(700);
  assert.equal(following, 100, 'rolling at the right edge');
  const width = () => { const [a, b] = windowOf(ts); return b - a; };
  const rollingWidth = width();

  ts.today();                      // a named view leaves follow mode
  await sleep(700);
  assert.equal(following, null);

  ts.back();
  await sleep(700);
  assert.equal(following, 100, 'and the anchor came back with the window');
  assert.ok(Math.abs(width() - rollingWidth) < 2000,
            'restored at the width it was rolling at');
});

test('changing the follow anchor files the window it was rolling at', async () => {
  const { ts } = await startAt();
  let following = null;
  ts.onFollow(p => { following = p; });
  ts.onStop(() => { following = null; });

  ts.followNow();                  // right edge
  await sleep(700);
  ts.centerNow();                  // the anchor moves, the rolling state ends
  await sleep(700);
  assert.equal(following, 50);

  ts.back();
  await sleep(700);
  assert.equal(following, 100, 'back to the anchor it was rolling at, not the new one');
});

test('stop() is undoable: b starts the chart rolling again', async () => {
  const { ts } = await startAt();
  let following = null;
  ts.onFollow(p => { following = p; });
  ts.onStop(() => { following = null; });

  ts.followNow();
  await sleep(700);
  ts.stop();
  assert.equal(following, null);

  ts.back();
  await sleep(700);
  assert.equal(following, 100);
});

test('historyDepth caps the stack, and 0 switches the history off', async () => {
  const { ts } = await startAt({ historyDepth: 2 });
  await setView(ts, TUE, WED);
  await setView(ts, MON, TUE);
  await setView(ts, WED, NEXT_MON);
  assert.deepEqual(ts.getHistory(), { back: 2, forward: 0, depth: 2 });
  assert.equal(ts.back(), true);
  await sleep(700);
  assert.equal(ts.back(), true);
  await sleep(700);
  assert.equal(ts.back(), false, 'only two steps are kept');

  const off = await startAt({ historyDepth: 0 });
  await setView(off.ts, TUE, WED);
  assert.deepEqual(off.ts.getHistory(), { back: 0, forward: 0, depth: 0 });
  assert.equal(off.ts.back(), false);
  const spare = keyEvent('b');
  off.canvas.onkeydown(spare);
  assert.equal(spare.prevented, true, 'the key stays bound, it just has nowhere to go');
});

test('starting up is not navigating', async () => {
  const { ts } = build({ initialView: 'today', follow: true });
  await sleep(1400);              // the deferred dispatch, then applyFollow
  assert.equal(ts.getHistory().back, 0,
               'the default window is not a place the user has been');
});

test('a viewport pushed by a group peer is not recorded', async () => {
  const a = build();
  const b = build();
  await setView(a.ts, MON, NEXT_MON);
  await setView(b.ts, MON, NEXT_MON);
  a.ts.joinGroup('hist-group');
  b.ts.joinGroup('hist-group');
  a.ts.clearHistory();
  b.ts.clearHistory();

  await setView(a.ts, TUE, WED);
  assert.deepEqual(windowOf(b.ts), [TUE, WED], 'the peer followed along');
  assert.equal(b.ts.getHistory().back, 0, 'but recorded nothing of its own');
  assert.equal(a.ts.getHistory().back, 1);

  a.ts.leaveGroup();
  b.ts.leaveGroup();
});
