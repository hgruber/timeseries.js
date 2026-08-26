// The invariants that make the snap grid "consistent" rather than merely
// "usually right". Two earlier designs failed exactly here and the tests below
// are shaped by how:
//
//   1. Reading the window as a multiple of a coarser step (6h as 3x2h) makes the
//      step carry the anchor, so edges land on even hours instead of the nearer
//      full hour. Hence: the level a window sits on must be stable under paging.
//   2. Deriving the grid from the viewport on every call feeds back on itself —
//      rounding changes the width, the width picks the level (100s -> 105s ->
//      120s, and a fixpoint iteration does not converge). Hence: attaching a
//      grid rounds once, bounded, and never again.
//
// The DST cases only mean something in a zone that observes it; run
// `TZ=Europe/Berlin npm test` to exercise them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries, floorToGrid, pickGridLevel, addGrid, gridCell } =
  await import('../src/timeseries.js');

const H = 3600000, D = 86400000;
const local = (...a) => new Date(...a).getTime();

const observesDST =
  new Date(2026, 0, 1).getTimezoneOffset() !== new Date(2026, 6, 1).getTimezoneOffset();
const isShortDay = d =>
  (new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) - d) / H === 23;
const dstHere = observesDST && isShortDay(new Date(2026, 2, 29));

let nextId = 0;
function build(opts) {
  const id = 'snapgrid-' + (nextId++);
  const canvas = makeCanvas(id, (opts && opts.width) || 1000, 400);
  const ts = new TimeSeries(Object.assign(
    { canvas: id, sources: [], initialView: null }, opts));
  return { ts, canvas };
}

// ── Invariant 1: paging never leaves the grid ─────────────────────────────────
test('paging keeps the level, the width and every edge on the grid', async () => {
  const { ts } = build();
  await setView(ts, local(2026, 4, 11, 3, 20), local(2026, 4, 11, 9, 20));

  const g0 = ts.getSnapGrid();
  const width = g0.tmax - g0.tmin;

  // A deliberately mixed sequence: pages and single cells, both directions.
  const moves = [1, 1, -1, 1, -1, -1, 1, 1, 1, -1];
  for (let i = 0; i < moves.length; i++) {
    ts.pan(moves[i], i % 3 === 0 ? { cells: 1 } : undefined);
    await sleep(700);
    const g = ts.getSnapGrid();
    assert.equal(g.unit, g0.unit, `level must not drift (move ${i})`);
    assert.equal(g.mult, g0.mult, `step must not drift (move ${i})`);
    assert.equal(g.k, g0.k, `cell count must not drift (move ${i})`);
    assert.equal(g.tmax - g.tmin, width, `width must not drift (move ${i})`);
    assert.equal(floorToGrid(g.tmin, g.unit, g.mult), g.tmin,
      `left edge must stay on the grid (move ${i})`);
  }
});

test('paging out and back returns to exactly the same window', async () => {
  const { ts } = build();
  await setView(ts, local(2026, 4, 11, 3, 20), local(2026, 4, 11, 9, 20));

  ts.snapView();
  await sleep(700);
  const start = ts.getViewport();

  for (let i = 0; i < 4; i++) { ts.pan(1); await sleep(700); }
  for (let i = 0; i < 4; i++) { ts.pan(-1); await sleep(700); }

  const back = ts.getViewport();
  assert.equal(back.tmin, start.tmin);
  assert.equal(back.tmax, start.tmax);
});

// ── Invariant 2: attaching a grid rounds once, and within bounds ──────────────
test('snapping is idempotent — a snapped window snaps to itself', async () => {
  const { ts } = build();
  await setView(ts, local(2026, 4, 11, 18, 55), local(2026, 4, 11, 20, 4));

  ts.snapView();
  await sleep(700);
  const once = ts.getViewport();

  ts.snapView();
  await sleep(700);
  const twice = ts.getViewport();

  assert.equal(twice.tmin, once.tmin, 'the second snap must be a no-op');
  assert.equal(twice.tmax, once.tmax);
});

test('attaching a grid never distorts the width by more than the tolerance', () => {
  // Driven straight through pickGridLevel over a wide spread of windows: the
  // instance path adds nothing to the arithmetic and this covers far more
  // ground per second.
  const levels = [
    ['year', 1], ['month', 1], ['week', 1], ['day', 1],
    ['hour', 1], ['minute', 1], ['second', 1], ['ms', 1],
  ];
  const base = local(2026, 0, 1);
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    // Log-uniform spans from 2ms to ~10 years, at arbitrary offsets.
    const span = Math.round(Math.exp(Math.random() * Math.log(10 * 365 * D / 2) + Math.log(2)));
    const t = base + Math.floor(Math.random() * 3 * 365 * D);
    const g = pickGridLevel(levels, t, span);
    assert.ok(g.k >= 1 && g.hi > g.lo, 'must always produce a usable window');
    assert.equal(floorToGrid(g.lo, g.unit, g.mult), g.lo, 'left edge on the grid');
    const d = Math.abs((g.hi - g.lo) - span) / span;
    if (d > worst) worst = d;
  }
  assert.ok(worst <= 0.2, `width distortion stayed within tolerance (worst ${worst})`);
});

test('stepping cells keeps the left edge on the grid across a DST transition',
  { skip: !dstHere }, () => {
  // panAdd on an hour grid with mult > 1 can land on an odd hour across the
  // spring-forward gap; gridWindow() re-floors for exactly this reason.
  let lo = floorToGrid(local(2026, 2, 28, 12), 'hour', 2);
  for (let i = 0; i < 40; i++) {
    lo = floorToGrid(addGrid(lo, 'hour', 2, 1), 'hour', 2);
    assert.equal(floorToGrid(lo, 'hour', 2), lo, `step ${i} must stay on the grid`);
  }
});

// ── Invariant 3: the level follows what the axis labels ───────────────────────
test('the grid moves up to day boundaries when finer labels no longer fit', async () => {
  // A 36-hour window: on a wide canvas the hour level is still labelled and
  // carries the grid; squeeze the canvas and it has to give way to something
  // coarser. Either way the edges stay on whatever level is legible.
  const wide = build({ width: 1400 });
  await setView(wide.ts, local(2026, 4, 11, 14), local(2026, 4, 13, 2));
  const gw = wide.ts.getSnapGrid();

  const narrow = build({ width: 260 });
  await setView(narrow.ts, local(2026, 4, 11, 14), local(2026, 4, 13, 2));
  const gn = narrow.ts.getSnapGrid();

  const cell = g => gridCell(g.tmin, g.unit, g.mult);
  assert.ok(cell(gn) >= cell(gw),
    'a narrower canvas can only ever move the grid coarser, never finer');
  assert.equal(floorToGrid(gn.tmin, gn.unit, gn.mult), gn.tmin);
  assert.equal(floorToGrid(gw.tmin, gw.unit, gw.mult), gw.tmin);
});

test('day paging stays on local midnight across spring-forward',
  { skip: !dstHere }, async () => {
  const { ts } = build();
  await setView(ts, local(2026, 2, 26), local(2026, 2, 27));
  for (let i = 0; i < 5; i++) { ts.pan(1); await sleep(700); }

  const vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 2, 31));
  assert.equal(vp.tmax, local(2026, 3, 1));
});

test('day paging stays on local midnight across fall-back',
  { skip: !dstHere }, async () => {
  const { ts } = build();
  await setView(ts, local(2026, 9, 23), local(2026, 9, 24));
  for (let i = 0; i < 5; i++) { ts.pan(1); await sleep(700); }

  const vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 9, 28));
  assert.equal(vp.tmax, local(2026, 9, 29));
});

// ── Invariant 4: analogue input hands control back ────────────────────────────
test('zoom steps stay on the grid all the way down and back up', async () => {
  const { ts } = build();
  await setView(ts, local(2026, 4, 11, 3), local(2026, 4, 11, 9));

  let prev = ts.getSnapGrid();
  for (let i = 0; i < 5; i++) {
    ts.zoomStep(1);
    await sleep(700);
    const g = ts.getSnapGrid();
    assert.equal(floorToGrid(g.tmin, g.unit, g.mult), g.tmin, `zoom in ${i}: on grid`);
    assert.ok(g.tmax - g.tmin < prev.tmax - prev.tmin, `zoom in ${i}: narrower`);
    prev = g;
  }
  for (let i = 0; i < 5; i++) {
    ts.zoomStep(-1);
    await sleep(700);
    const g = ts.getSnapGrid();
    assert.equal(floorToGrid(g.tmin, g.unit, g.mult), g.tmin, `zoom out ${i}: on grid`);
    assert.ok(g.tmax - g.tmin > prev.tmax - prev.tmin, `zoom out ${i}: wider`);
    prev = g;
  }
});

test('a wheel gesture releases the grid and the next key press re-attaches one',
  async () => {
  const { ts, canvas } = build();
  await setView(ts, local(2026, 4, 11, 3), local(2026, 4, 11, 9));

  canvas.onwheel({
    deltaY: 120, clientX: 500, clientY: 200, preventDefault() {},
  });
  const free = ts.getViewport();
  assert.notEqual(free.tmax - free.tmin, 6 * H, 'the wheel zooms continuously');

  ts.pan(1);
  await sleep(700);
  const g = ts.getSnapGrid();
  assert.equal(floorToGrid(g.tmin, g.unit, g.mult), g.tmin,
    'the key press re-attaches a grid rather than inheriting a ragged edge');
});

test('shift+wheel pans continuously without snapping', async () => {
  const { ts, canvas } = build();
  const t0 = local(2026, 4, 11, 3), t1 = local(2026, 4, 11, 9);
  await setView(ts, t0, t1);

  canvas.onwheel({
    shiftKey: true, deltaY: 100, clientX: 500, clientY: 200, preventDefault() {},
  });

  const vp = ts.getViewport();
  assert.equal(vp.tmax - vp.tmin, t1 - t0, 'panning must not change the width');
  assert.ok(vp.tmin > t0, 'a positive delta moves forward in time');
  assert.notEqual(vp.tmin, local(2026, 4, 11, 4), 'and it does not land on a cell');
});
