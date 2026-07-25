// Zero-size canvases: what happens when a chart sits in a `display:none`
// container (a hidden tab panel).
//
// The regression these pin: a hidden container reports 0×0, but
// readContainerPad() still reads the container's real CSS padding and
// margin.top is always two label rows, so `canvas.width - margin.left -
// margin.right` came out NEGATIVE rather than zero. That made ppms negative,
// mspp = 1/ppms large-negative, and every setTimeout delay derived from it
// non-positive — which the browser clamps to 0, so the self-rescheduling
// redraw timers spun at ~250 fps. Worse, plotAll() broadcasts to the
// viewport-sync group, so one hidden chart dragged every visible peer into the
// same loop and its data sources into an endless refetch.
//
// Two guards now cover it: plotWidth/plotHeight are clamped to >= 1 at every
// assignment site, and both the ResizeObserver callback and plotAll() bail out
// on a zero-area canvas — the observer so the last good geometry survives (and
// with it a sane ppms for the sources' tier choice), plotAll so a hidden
// instance does no drawing work.
//
// The group broadcast deliberately sits *above* plotAll's bail-out, so a hidden
// chart still propagates its viewport: a follow leader that gets hidden keeps
// ticking and is the only thing driving time for the group. Test 7 pins that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installDOM, makeCanvas, resizeCanvas, setView, sleep,
} from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { attachLegend } = await import('../src/legend.js');

// Every delay the library hands to setTimeout, recorded. The helper's own
// override is wrapped rather than replaced, so timers stay unref'd and the
// process still exits.
const delays = [];
const _wrapped = globalThis.setTimeout;
globalThis.setTimeout = function (fn, t, ...rest) {
  delays.push(t);
  return _wrapped.call(this, fn, t, ...rest);
};

// A canvas whose context counts clearRect calls. clearRect is plotAll()'s first
// drawing op, so its count *is* the frame count — the Proxy context in
// helpers/dom.mjs is a pure no-op and cannot report this.
function makeCountingCanvas(id, width = 1000, height = 400, pad = 8) {
  const canvas = makeCanvas(id, width, height, pad);
  const ctx = {
    globalAlpha: 1,
    frames: 0,
    measureText: s => ({ width: 8 * String(s).length, actualBoundingBoxAscent: 9 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    clearRect: () => { ctx.frames++; },
    canvas,
  };
  canvas.getContext = () => new Proxy(ctx, {
    get(t, k) { return k in t ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; },
  });
  Object.defineProperty(canvas, 'frames', { get: () => ctx.frames });
  return canvas;
}

const T0 = new Date(2026, 0, 5).getTime();
const T1 = new Date(2026, 0, 6).getTime();

// A binned block, so prepare_grid has something to scale a y-axis to.
function bars(id) {
  return {
    type: 'multibar',
    interval_start: Math.floor(T0 / 1000),
    interval_end: Math.floor(T1 / 1000),
    interval: 3600,
    count: 24,
    min: 0,
    max: 10,
    data: Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [i, { [id]: 1 + (i % 5) }])),
  };
}

function source(id) {
  return {
    'source-type': 'static-resize-test',
    init(_src, cb) { cb.pushData(bars(id)); cb.requestRedraw(); },
  };
}
TimeSeries.registerSource({
  type: 'static-resize-test',
  init(src, cb) { src.init(src, cb); },
});

// ── 1. the clamp: scales stay positive even with no good geometry to fall back on

test('constructed at 0×0, plotWidth/plotHeight and ppms stay positive', async () => {
  const canvas = makeCountingCanvas('rz-clamp', 0, 0, 8);
  const ts = new TimeSeries({ canvas: 'rz-clamp', sources: [source('a')], initialView: null });

  // No previous size exists here, so the ResizeObserver early-out has nothing
  // to preserve — this isolates the clamp itself.
  let area = ts.getPlotArea();
  assert.ok(area.plotWidth >= 1, 'plotWidth ' + area.plotWidth + ' must not be <= 0');
  assert.ok(area.plotHeight >= 1, 'plotHeight ' + area.plotHeight + ' must not be <= 0');
  assert.ok(ts.getViewport().ppms > 0, 'ppms must stay positive');

  // Unhiding runs a real paint, which is the only path that reaches the two
  // clamp sites inside prepare_grid (the margin.left / margin.bottom recomputes).
  resizeCanvas(canvas, 1000, 400);
  await setView(ts, T0, T1);
  area = ts.getPlotArea();
  assert.ok(area.plotWidth > 100, 'real geometry after unhide, got ' + area.plotWidth);
  assert.ok(area.plotHeight > 100, 'real geometry after unhide, got ' + area.plotHeight);
  assert.ok(ts.getViewport().ppms > 0);
});

// ── 2. no timer is ever scheduled with a non-positive delay ──────────────────

test('no timer is scheduled with a non-positive or NaN delay', async () => {
  const canvas = makeCountingCanvas('rz-delay', 1000, 400, 8);
  const ts = new TimeSeries({ canvas: 'rz-delay', sources: [source('a')], initialView: null });
  await setView(ts, T0, T1);

  const mark = delays.length;
  resizeCanvas(canvas, 0, 0);       // hide
  await sleep(120);
  resizeCanvas(canvas, 1000, 400);  // show
  await sleep(120);

  // The end-to-end invariant: whatever the geometry does, nothing non-positive
  // reaches setTimeout. Note this passes on clampPlot() alone — with plotWidth
  // floored, mspp is already positive, so tickDelay()'s own floor is genuinely
  // unreachable from here and is defence-in-depth rather than something this
  // test distinguishes. The one argument that can still be negative on its own
  // is follow_view's `now - rT(0)` (the sign inversion flagged in the source),
  // and that branch is all but unreachable, so it is not driven here either.
  const bad = delays.slice(mark).filter(t => !(t > 0));
  assert.deepEqual(bad, [], 'non-positive delays scheduled: ' + JSON.stringify(bad));
});

// ── 3. a hidden chart does not spin ─────────────────────────────────────────

test('a hidden chart neither repaints nor re-arms its redraw timer', async () => {
  const canvas = makeCountingCanvas('rz-spin', 1000, 400, 8);
  const ts = new TimeSeries({ canvas: 'rz-spin', sources: [source('a')], initialView: null });
  await setView(ts, T0, T1);

  resizeCanvas(canvas, 0, 0);
  const framesAtHide = canvas.frames;
  const delaysAtHide = delays.length;
  await sleep(250);

  // Pre-guard both of these ran into the hundreds over 250 ms; post-guard the
  // now-line timer is not even re-armed. Two orders of magnitude apart, so this
  // is robust rather than timing-sensitive.
  assert.equal(canvas.frames - framesAtHide, 0, 'hidden chart drew frames');
  assert.ok(delays.length - delaysAtHide < 5,
    'hidden chart scheduled ' + (delays.length - delaysAtHide) + ' timers');
});

// ── 4. a group peer is not dragged along ────────────────────────────────────

test('a hidden group member does not drag its visible peer, but still tracks the viewport', async () => {
  const cA = makeCountingCanvas('rz-grp-a', 1000, 400, 8);
  const cB = makeCountingCanvas('rz-grp-b', 1000, 400, 8);
  // _groups is module-level and shared across the whole test process, and there
  // is no destroy() — hence a unique name per test plus leaveGroup() below.
  const tsA = new TimeSeries({ canvas: 'rz-grp-a', sources: [source('a')], initialView: null, group: 'rz-pair' });
  const tsB = new TimeSeries({ canvas: 'rz-grp-b', sources: [source('b')], initialView: null, group: 'rz-pair' });
  await setView(tsA, T0, T1);

  resizeCanvas(cB, 0, 0);           // hide B
  const framesA = cA.frames;
  await sleep(250);
  assert.equal(cA.frames - framesA, 0, 'hidden B dragged visible A into repainting');

  // B must still adopt a broadcast viewport — setViewport applies tmin/tmax
  // before it calls plotAll, so bailing out of the paint strands no state.
  const t0 = new Date(2026, 1, 10).getTime();
  const t1 = new Date(2026, 1, 11).getTime();
  const framesB = cB.frames;
  await setView(tsA, t0, t1);
  assert.equal(cB.frames - framesB, 0, 'hidden B repainted on a peer broadcast');
  assert.equal(tsB.getViewport().tmin, t0, 'hidden B did not track the group viewport');
  assert.equal(tsB.getViewport().tmax, t1);

  tsA.leaveGroup();
  tsB.leaveGroup();
});

// ── 5. recovery on unhide ───────────────────────────────────────────────────

test('geometry is preserved while hidden and repaints on unhide', async () => {
  makeCountingCanvas('rz-rec-a', 1000, 400, 8);   // peer A: only ever the sender
  const cB = makeCountingCanvas('rz-rec-b', 1000, 400, 8);
  const tsA = new TimeSeries({ canvas: 'rz-rec-a', sources: [source('a')], initialView: null, group: 'rz-rec' });
  const tsB = new TimeSeries({ canvas: 'rz-rec-b', sources: [source('b')], initialView: null, group: 'rz-rec' });
  await setView(tsA, T0, T1);

  const before = tsB.getPlotArea();
  const ppmsBefore = tsB.getViewport().ppms;

  resizeCanvas(cB, 0, 0);
  await sleep(60);
  // Preserved, not recomputed from nothing: this is what keeps the sources on
  // their resolution tier instead of dropping to the coarsest one.
  assert.equal(tsB.getPlotArea().plotWidth, before.plotWidth, 'geometry lost while hidden');
  assert.equal(tsB.getPlotArea().plotHeight, before.plotHeight);
  assert.equal(tsB.getViewport().ppms, ppmsBefore, 'ppms lost while hidden');

  const framesB = cB.frames;
  resizeCanvas(cB, 1000, 400);
  await sleep(60);
  assert.ok(cB.frames > framesB, 'no repaint on unhide');
  assert.equal(tsB.getPlotArea().plotWidth, before.plotWidth, 'geometry differs after unhide');
  assert.equal(tsB.getViewport().tmin, tsA.getViewport().tmin, 'lost sync with the group');

  tsA.leaveGroup();
  tsB.leaveGroup();
});

// ── 6. the public getters survive a zero-size construction ──────────────────

test('getActiveData/getSeries/attachLegend do not throw on a chart built at 0×0', () => {
  makeCountingCanvas('rz-getters', 0, 0, 8);
  const ts = new TimeSeries({ canvas: 'rz-getters', sources: [source('a')], initialView: null });

  // prepare_grid never ran, so activePlot is only defined because it is now
  // initialised at declaration. attachLegend calls ts.getSeries() at attach
  // time, which reaches getActiveData() → activePlot.map(...).
  assert.doesNotThrow(() => ts.getActiveData(), 'getActiveData threw');
  assert.doesNotThrow(() => ts.getSeries(), 'getSeries threw');
  assert.deepEqual(ts.getActiveData(), []);
  let legend;
  assert.doesNotThrow(() => { legend = attachLegend(ts); }, 'attachLegend threw');
  legend.destroy();
});

// ── 7. a hidden follow leader still drives its visible peers ────────────────

test('a hidden follow leader keeps the group moving', async () => {
  // Follow mode is live here, unlike every test above — and it is not an exotic
  // path: last24(), the default initialView, calls doFollow() + start_follower().
  // The leader is elected once, by canvas width, and never re-elected, so the
  // chart that leads can afterwards be the hidden one.
  //
  // The window is deliberately narrow before follow starts. The tick interval is
  // one redraw per pixel of now-line travel, tickDelay(mspp), which over a 24 h
  // window sits on the 5 s ceiling — and the chain only picks up a new interval
  // on its next fire, so narrowing *after* follow starts would still make the
  // first tick up to 5 s away. Two seconds across ~1000 px puts it on the 16 ms
  // floor from the outset, and follower_tick carries the range forward.
  const cA = makeCountingCanvas('rz-lead-a', 1000, 400, 8);
  const cB = makeCountingCanvas('rz-lead-b', 800, 400, 8);
  const tsA = new TimeSeries({ canvas: 'rz-lead-a', sources: [source('a')], initialView: null, group: 'rz-lead' });
  const tsB = new TimeSeries({ canvas: 'rz-lead-b', sources: [source('b')], initialView: null, group: 'rz-lead' });
  const nowMs = Date.now();
  await setView(tsA, nowMs - 2000, nowMs);
  tsA.follow(100);            // synchronous: doFollow + start_follower + plotAll
  await sleep(100);

  // A is the wider canvas, so A won the election and is the group's time driver.
  // B is a non-leader: follower_tick returns on _suppressTick *before* it
  // re-arms, so B's own tick chain is dead and the only thing that can move it
  // is a broadcast from A.
  const tminBefore = tsB.getViewport().tmin;
  const framesB = cB.frames;
  const framesA = cA.frames;
  resizeCanvas(cA, 0, 0);     // hide the leader
  await sleep(200);

  // Before the broadcast was hoisted above plotAll's zero-area bail-out, the
  // hidden leader kept advancing its own window and told nobody: B's viewport
  // froze and it stopped repainting until the user next interacted.
  assert.ok(tsB.getViewport().tmin > tminBefore,
    'visible peer froze while the follow leader was hidden');
  assert.ok(cB.frames > framesB, 'visible peer stopped repainting');
  assert.equal(cA.frames, framesA, 'hidden leader drew frames');

  tsA.stop();
  tsA.leaveGroup();
  tsB.leaveGroup();
});
