// Covers the snap-grid arithmetic (pickGridLevel/floorToGrid/addGrid) and the
// calendar helpers below it (panFloor/panAdd/panDiff) that ts.pan() is built
// on, with particular attention to DST transitions — the
// comment at the top of that block claims DST-safety, and panDiff does in fact
// divide by fixed millisecond constants. These tests pin what actually happens.
//
// The DST cases only mean something in a zone that observes it, so they are
// skipped under TZ=UTC and friends. Run `TZ=Europe/Berlin npm test` to exercise
// them; `TZ=UTC npm test` must also stay green.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickGridLevel, floorToGrid, addGrid, panFloor, panAdd, panDiff } =
  await import('../src/timeseries.js');

const S = 1000, M = 60000, H = 3600000, D = 86400000;

// Local zone observes DST if January and July offsets differ.
const observesDST =
  new Date(2026, 0, 1).getTimezoneOffset() !== new Date(2026, 6, 1).getTimezoneOffset();

// Northern-hemisphere EU transition for 2026: 29 Mar is a 23-hour day. Zones
// that observe DST on another date (e.g. the southern hemisphere) skip these.
const springForward = new Date(2026, 2, 29);
const isShortDay = d =>
  (new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) - d) / H === 23;
const dstHere = observesDST && isShortDay(springForward);

const local = (...a) => new Date(...a).getTime();
const hhmm = ms => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

// ── pickGridLevel ─────────────────────────────────────────────────────────────
// The level list is what labelledLevels() produces inside an instance: the
// x-axis levels that are currently labelled, coarsest first. Passing it in
// explicitly keeps these tests free of any canvas.
const ALL = [
  ['year', 1], ['month', 1], ['week', 1], ['day', 1],
  ['hour', 1], ['minute', 1], ['second', 1], ['ms', 1],
];

// The window the whole feature exists for: 18:55-20:04 is not 69 minutes worth
// of anything, it is one hour read off a clock. The coarsest level that fits
// once wins, so the hour does.
test('pickGridLevel reads a near-hour window as one hour cell', () => {
  const t0 = local(2026, 4, 11, 18, 55), t1 = local(2026, 4, 11, 20, 4);
  const g = pickGridLevel(ALL, t0, t1 - t0);
  assert.equal(g.unit, 'hour');
  assert.equal(g.k, 1);
  assert.equal(g.lo, local(2026, 4, 11, 19));
  assert.equal(g.hi, local(2026, 4, 11, 20));
});

// A six-hour window is six hour cells, not three two-hour ones: the level
// carries the anchor, so reading it coarser would park the edges on even hours
// (04:00) instead of on the nearer full hour (03:00).
test('pickGridLevel keeps a six-hour window six cells wide', () => {
  const t0 = local(2026, 4, 11, 3, 20), t1 = local(2026, 4, 11, 9, 20);
  const g = pickGridLevel(ALL, t0, t1 - t0);
  assert.equal(g.unit, 'hour');
  assert.equal(g.k, 6);
  assert.equal(g.lo, local(2026, 4, 11, 3));
  assert.equal(g.hi, local(2026, 4, 11, 9));
});

test('pickGridLevel picks the coarsest level that fits at least once', () => {
  const t0 = local(2026, 4, 11);
  const at = span => pickGridLevel(ALL, t0, span);
  assert.equal(at(20 * S).unit, 'second');
  assert.equal(at(5 * M).unit, 'minute');
  assert.equal(at(6 * H).unit, 'hour');
  assert.equal(at(3 * D).unit, 'day');
  assert.equal(at(7 * D).unit, 'week');
  assert.equal(at(31 * D).unit, 'month');
  assert.equal(at(365 * D).unit, 'year');
});

// The tolerance is what stops the coarsest-wins rule from swallowing the zoom:
// ten days would otherwise collapse onto one calendar week.
test('pickGridLevel falls to a finer level when rounding would distort too much', () => {
  const t0 = local(2026, 4, 11);
  const g = pickGridLevel(ALL, t0, 10 * D);
  assert.equal(g.unit, 'day');
  assert.equal(g.k, 10, 'ten days stay ten days');
  assert.equal(g.hi - g.lo, 10 * D);
});

test('pickGridLevel rounds a near-calendar-month window onto the month', () => {
  const t0 = local(2026, 3, 3), t1 = local(2026, 4, 2);   // 29d, April is 30d
  const g = pickGridLevel(ALL, t0, t1 - t0);
  assert.equal(g.unit, 'month');
  assert.equal(g.k, 1);
  assert.equal(g.lo, local(2026, 3, 1));
  assert.equal(g.hi, local(2026, 4, 1));
});

// Sub-second windows used to pan by a whole second — 25 screenfuls at maximum
// zoom — because the finest unit available was 'second'.
test('pickGridLevel resolves a sub-second window in milliseconds', () => {
  const t0 = local(2026, 4, 11, 18, 57, 3, 412);
  const g = pickGridLevel(ALL, t0, 40);
  assert.equal(g.unit, 'ms');
  assert.equal(g.hi - g.lo, 40);
});

// A level that is not in the list cannot be chosen, which is how a level the
// axis has stopped labelling drops out: what is left takes over.
test('pickGridLevel only chooses from the levels it is given', () => {
  const t0 = local(2026, 4, 11, 22);
  const g = pickGridLevel([['day', 1]], t0, 25 * H);
  assert.equal(g.unit, 'day');
  assert.equal(g.k, 1);
  assert.equal(g.lo, local(2026, 4, 12), 'nearest midnight');
});

// Nothing offered fits (a canvas too narrow to label anything at all). The
// window must survive unchanged rather than being dragged onto some level that
// is far too coarse for it.
test('pickGridLevel leaves the window alone when no level fits', () => {
  const t0 = local(2026, 4, 11, 3, 20);
  const g = pickGridLevel([['day', 1]], t0, 6 * H);
  assert.equal(g.unit, 'ms');
  assert.equal(g.lo, t0);
  assert.equal(g.hi - g.lo, 6 * H, 'width untouched');
});

test('pickGridLevel always returns at least one cell', () => {
  const t0 = local(2026, 4, 11);
  for (const span of [0, 1, 7, 999]) {
    const g = pickGridLevel(ALL, t0, span);
    assert.ok(g.k >= 1, `span ${span} must still yield a usable window`);
    assert.ok(g.hi > g.lo);
  }
});

// ── floorToGrid / addGrid ─────────────────────────────────────────────────────
// Sub-multiples anchor inside their parent unit exactly the way the drawn axis
// anchors its lines (grid[1..3] test `s % part`, `m % part`, `h % part`), so a
// snapped edge lands on a line that is actually drawn.
test('floorToGrid anchors multiples inside the parent unit', () => {
  const t = local(2026, 4, 14, 15, 47, 23, 456);
  assert.equal(floorToGrid(t, 'hour', 2),    local(2026, 4, 14, 14));
  assert.equal(floorToGrid(t, 'hour', 4),    local(2026, 4, 14, 12));
  assert.equal(floorToGrid(t, 'hour', 12),   local(2026, 4, 14, 12));
  assert.equal(floorToGrid(t, 'minute', 15), local(2026, 4, 14, 15, 45));
  assert.equal(floorToGrid(t, 'minute', 30), local(2026, 4, 14, 15, 30));
  assert.equal(floorToGrid(t, 'second', 5),  local(2026, 4, 14, 15, 47, 20));
});

test('floorToGrid with mult 1 is panFloor', () => {
  const t = local(2026, 4, 14, 15, 47, 23);
  for (const u of ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'])
    assert.equal(floorToGrid(t, u, 1), panFloor(t, u), u);
});

test('floorToGrid anchors quarters on January and decades on the round year', () => {
  assert.equal(floorToGrid(local(2026, 4, 14), 'month', 3), local(2026, 3, 1));
  assert.equal(floorToGrid(local(2026, 4, 14), 'year', 10), local(2020, 0, 1));
});

test('addGrid steps whole multiples and is idempotent with floorToGrid', () => {
  const t = floorToGrid(local(2026, 4, 14, 15, 47), 'minute', 15);
  assert.equal(addGrid(t, 'minute', 15, 2), local(2026, 4, 14, 16, 15));
  assert.equal(addGrid(t, 'minute', 15, -1), local(2026, 4, 14, 15, 30));
  assert.equal(floorToGrid(addGrid(t, 'minute', 15, 3), 'minute', 15),
               addGrid(t, 'minute', 15, 3));
});

test('addGrid on milliseconds is plain arithmetic', () => {
  assert.equal(addGrid(1000, 'ms', 10, 4), 1040);
  assert.equal(floorToGrid(1047, 'ms', 10), 1040);
});


// ── panFloor ──────────────────────────────────────────────────────────────────
test('panFloor snaps down to the start of each unit', () => {
  const t = local(2026, 4, 14, 15, 47, 23, 456); // Thu 14 May 2026, 15:47:23.456
  assert.equal(panFloor(t, 'second'), local(2026, 4, 14, 15, 47, 23));
  assert.equal(panFloor(t, 'minute'), local(2026, 4, 14, 15, 47));
  assert.equal(panFloor(t, 'hour'),   local(2026, 4, 14, 15));
  assert.equal(panFloor(t, 'day'),    local(2026, 4, 14));
  assert.equal(panFloor(t, 'month'),  local(2026, 4, 1));
  assert.equal(panFloor(t, 'year'),   local(2026, 0, 1));
});

test('panFloor week snaps back to Monday, from any weekday', () => {
  // Mon 11 May 2026 through Sun 17 May 2026 all floor to Mon 11 May.
  for (let i = 0; i < 7; i++)
    assert.equal(panFloor(local(2026, 4, 11 + i, 13), 'week'), local(2026, 4, 11),
      `day offset ${i}`);
});

test('panFloor week from a Monday is a no-op, not a jump back a week', () => {
  assert.equal(panFloor(local(2026, 4, 11), 'week'), local(2026, 4, 11));
});

// ── panAdd ────────────────────────────────────────────────────────────────────
test('panAdd steps whole calendar units', () => {
  assert.equal(panAdd(local(2026, 0, 15), 'month', 1), local(2026, 1, 15));
  assert.equal(panAdd(local(2026, 0, 15), 'year', 1),  local(2027, 0, 15));
  assert.equal(panAdd(local(2026, 4, 11), 'week', 2),  local(2026, 4, 25));
});

// Documents a sharp edge rather than endorsing it: Date#setMonth overflows a
// short month, so 31 Jan + 1 month is 3 March, not 28 Feb. pan() never hits
// this because it only ever calls panAdd on a panFloor result — always the 1st
// of a month — but a caller using panAdd directly would.
test('panAdd month overflows out of a short month, as Date#setMonth does', () => {
  assert.equal(panAdd(local(2026, 0, 31), 'month', 1), local(2026, 2, 3));
  assert.equal(panAdd(local(2026, 0, 1), 'month', 1), local(2026, 1, 1));
});

test('panAdd crosses month and year boundaries', () => {
  assert.equal(panAdd(local(2026, 11, 31), 'day', 1), local(2027, 0, 1));
  assert.equal(panAdd(local(2026, 0, 1), 'day', -1),  local(2025, 11, 31));
});

// ── DST ───────────────────────────────────────────────────────────────────────
test('panAdd day keeps local midnight across spring-forward', { skip: !dstHere }, () => {
  // 29 Mar 2026 is a 23-hour day. Adding a day must land on local midnight,
  // not on 01:00 as a fixed +86400000 would.
  const t = panAdd(local(2026, 2, 29), 'day', 1);
  assert.equal(hhmm(t), '00:00');
  assert.equal(t, local(2026, 2, 30));
});

test('panAdd day keeps local midnight across fall-back', { skip: !dstHere }, () => {
  const t = panAdd(local(2026, 9, 25), 'day', 1);
  assert.equal(hhmm(t), '00:00');
  assert.equal(t, local(2026, 9, 26));
});

test('panAdd week keeps local midnight across a DST change', { skip: !dstHere }, () => {
  const t = panAdd(local(2026, 2, 23), 'week', 1); // Mon 23 Mar → Mon 30 Mar
  assert.equal(hhmm(t), '00:00');
  assert.equal(t, local(2026, 2, 30));
});

test('panFloor day on the DST day itself gives local midnight', { skip: !dstHere }, () => {
  assert.equal(hhmm(panFloor(local(2026, 2, 29, 14), 'day')), '00:00');
  assert.equal(hhmm(panFloor(local(2026, 9, 25, 14), 'day')), '00:00');
});

// panDiff divides by fixed constants for day/week. Across a 23h or 25h day the
// quotient is off by ~4%, which Math.round absorbs — so the step count is still
// correct. This test exists so that a future change to panDiff cannot break it
// unnoticed.
test('panDiff counts whole days correctly across a DST change', { skip: !dstHere }, () => {
  assert.equal(panDiff(local(2026, 2, 29), local(2026, 2, 30), 'day'), 1);   // 23h span
  assert.equal(panDiff(local(2026, 9, 25), local(2026, 9, 26), 'day'), 1);   // 25h span
  assert.equal(panDiff(local(2026, 2, 1), local(2026, 3, 1), 'day'), 31);    // March, 31 days
  assert.equal(panDiff(local(2026, 9, 1), local(2026, 10, 1), 'day'), 31);   // October, 31 days
});

test('panDiff counts whole weeks correctly across a DST change', { skip: !dstHere }, () => {
  assert.equal(panDiff(local(2026, 2, 23), local(2026, 2, 30), 'week'), 1);
  assert.equal(panDiff(local(2026, 9, 19), local(2026, 9, 26), 'week'), 1);
  assert.equal(panDiff(local(2026, 2, 2), local(2026, 3, 6), 'week'), 5);
});

// ── panDiff, DST-independent ──────────────────────────────────────────────────
test('panDiff counts month and year steps from calendar fields', () => {
  assert.equal(panDiff(local(2026, 0, 1), local(2026, 6, 1), 'month'), 6);
  assert.equal(panDiff(local(2025, 10, 1), local(2026, 1, 1), 'month'), 3); // across new year
  assert.equal(panDiff(local(2020, 0, 1), local(2026, 0, 1), 'year'), 6);
});

test('panDiff counts sub-day units exactly', () => {
  assert.equal(panDiff(0, 45 * S, 'second'), 45);
  assert.equal(panDiff(0, 45 * M, 'minute'), 45);
  assert.equal(panDiff(0, 5 * H, 'hour'), 5);
});

// ── End to end through the public API ─────────────────────────────────────────
test('pan(+1)/pan(-1) round-trips back to the same window', async () => {
  const { installDOM, makeCanvas, setView, sleep } = await import('./helpers/dom.mjs');
  installDOM();
  const { default: TimeSeries } = await import('../src/timeseries.js');

  makeCanvas('pan-e2e');
  const ts = new TimeSeries({ canvas: 'pan-e2e', sources: [], initialView: null });

  const t0 = local(2026, 4, 11), t1 = local(2026, 4, 18); // Mon → Mon, one week
  await setView(ts, t0, t1);

  ts.pan(1);
  await sleep(700);   // zoomDuration is 500ms; read only once it has settled
  const after = ts.getViewport();
  assert.notEqual(after.tmin, t0, 'pan(+1) should have moved the window');

  ts.pan(-1);
  await sleep(700);   // zoomDuration is 500ms; read only once it has settled
  const back = ts.getViewport();
  assert.equal(back.tmin, t0, 'pan(-1) should return to the original window');
  assert.equal(back.tmax, t1);
});

test('pan(-1) on a full calendar month steps back one whole month', async () => {
  const { installDOM, makeCanvas, setView, sleep } = await import('./helpers/dom.mjs');
  installDOM();
  const { default: TimeSeries } = await import('../src/timeseries.js');

  makeCanvas('pan-month-e2e');
  const ts = new TimeSeries({ canvas: 'pan-month-e2e', sources: [], initialView: null });

  await setView(ts, local(2026, 3, 1), local(2026, 4, 1)); // April
  ts.pan(-1);
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 2, 1), 'should land on 1 March');
  assert.equal(vp.tmax, local(2026, 3, 1), 'should land on 1 April');
});

test('pan(-1) on a full calendar year steps back one whole year', async () => {
  const { installDOM, makeCanvas, setView, sleep } = await import('./helpers/dom.mjs');
  installDOM();
  const { default: TimeSeries } = await import('../src/timeseries.js');

  makeCanvas('pan-year-e2e');
  const ts = new TimeSeries({ canvas: 'pan-year-e2e', sources: [], initialView: null });

  await setView(ts, local(2026, 0, 1), local(2027, 0, 1));
  ts.pan(-1);
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, local(2025, 0, 1));
  assert.equal(vp.tmax, local(2026, 0, 1));
});

test('pan(-1) on a near-month view snaps to the enclosing month first, then steps back', async () => {
  const { installDOM, makeCanvas, setView, sleep } = await import('./helpers/dom.mjs');
  installDOM();
  const { default: TimeSeries } = await import('../src/timeseries.js');

  makeCanvas('pan-nearmonth-e2e');
  const ts = new TimeSeries({ canvas: 'pan-nearmonth-e2e', sources: [], initialView: null });

  // 3 Apr - 2 May: within tolerance of April, so pan() should snap the
  // baseline to 1 Apr - 1 May *before* applying the shift, not widen to
  // two full months (1 Apr - 1 Jun).
  await setView(ts, local(2026, 3, 3), local(2026, 4, 2));
  ts.pan(-1);
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 2, 1), 'should land on 1 March, not 23 Feb or similar');
  assert.equal(vp.tmax, local(2026, 3, 1), 'should land on 1 April, not 1 May');
});

test('pan(1) day-paging across spring-forward keeps every boundary at local midnight', { skip: !dstHere }, async () => {
  const { installDOM, makeCanvas, setView, sleep } = await import('./helpers/dom.mjs');
  installDOM();
  const { default: TimeSeries } = await import('../src/timeseries.js');

  makeCanvas('pan-day-dst-spring-e2e');
  const ts = new TimeSeries({ canvas: 'pan-day-dst-spring-e2e', sources: [], initialView: null });

  // 26 Mar 2026 -> page forward day by day through 29/30 Mar, the 23h
  // spring-forward day. Every edge must stay at local midnight; the old
  // 'hour'-unit bug parked day 4's edges at 23:00 instead.
  await setView(ts, local(2026, 2, 26), local(2026, 2, 27));
  for (let i = 0; i < 5; i++) {
    ts.pan(1);
    await sleep(700);
  }

  const vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 2, 31));
  assert.equal(vp.tmax, local(2026, 3, 1));
});

test('pan(1) day-paging across fall-back keeps every boundary at local midnight', { skip: !dstHere }, async () => {
  const { installDOM, makeCanvas, setView, sleep } = await import('./helpers/dom.mjs');
  installDOM();
  const { default: TimeSeries } = await import('../src/timeseries.js');

  makeCanvas('pan-day-dst-fall-e2e');
  const ts = new TimeSeries({ canvas: 'pan-day-dst-fall-e2e', sources: [], initialView: null });

  // 23 Oct 2026 -> page forward day by day through 25/26 Oct, the 25h
  // fall-back day. The old bug landed 1h past midnight from here on.
  await setView(ts, local(2026, 9, 23), local(2026, 9, 24));
  for (let i = 0; i < 5; i++) {
    ts.pan(1);
    await sleep(700);
  }

  const vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 9, 28));
  assert.equal(vp.tmax, local(2026, 9, 29));
});

// ── The windows this feature was built for ────────────────────────────────────
async function instance(id) {
  const { installDOM, makeCanvas, setView, sleep } = await import('./helpers/dom.mjs');
  installDOM();
  const { default: TimeSeries } = await import('../src/timeseries.js');
  makeCanvas(id);
  return { ts: new TimeSeries({ canvas: id, sources: [], initialView: null }), setView, sleep };
}

test('pan(1) on a near-hour window lands on the next full hour', async () => {
  const { ts, setView, sleep } = await instance('pan-hour-e2e');

  // 18:55-20:04 is one hour read off a clock, not 69 minutes of anything.
  await setView(ts, local(2026, 4, 11, 18, 55), local(2026, 4, 11, 20, 4));
  ts.pan(1);
  await sleep(700);

  let vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 4, 11, 20));
  assert.equal(vp.tmax, local(2026, 4, 11, 21));

  await setView(ts, local(2026, 4, 11, 18, 55), local(2026, 4, 11, 20, 4));
  ts.pan(-1);
  await sleep(700);

  vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 4, 11, 18));
  assert.equal(vp.tmax, local(2026, 4, 11, 19));
});

test('paging a six-hour window keeps it six hours wide', async () => {
  const { ts, setView, sleep } = await instance('pan-6h-e2e');

  // The old edge-snapping grew this window by an hour on the first press and
  // parked it on 10:00-17:00.
  await setView(ts, local(2026, 4, 11, 3, 20), local(2026, 4, 11, 9, 20));
  for (let i = 0; i < 3; i++) {
    ts.pan(1);
    await sleep(700);
    const v = ts.getViewport();
    assert.equal(v.tmax - v.tmin, 6 * H, `width must not drift (press ${i + 1})`);
    assert.equal(new Date(v.tmin).getMinutes(), 0, 'edges stay on full hours');
  }
  assert.equal(ts.getViewport().tmin, local(2026, 4, 11, 21), 'three pages on from 03:00');
});

test('a sub-second window pans by its own width, not by a whole second', async () => {
  const { ts, setView, sleep } = await instance('pan-ms-e2e');

  const t0 = local(2026, 4, 11, 18, 57, 3, 412);
  await setView(ts, t0, t0 + 40);
  const before = ts.getViewport();
  ts.pan(1);
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmax - vp.tmin, before.tmax - before.tmin, 'width preserved');
  assert.ok(vp.tmin - before.tmin <= 50,
    'must move about one screenful, not a full second');
});

test('snapView() aligns the window without paging', async () => {
  const { ts, setView, sleep } = await instance('pan-snapview-e2e');

  await setView(ts, local(2026, 4, 11, 3, 20), local(2026, 4, 11, 9, 20));
  ts.snapView();
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, local(2026, 4, 11, 3), 'snapped, not paged');
  assert.equal(vp.tmax, local(2026, 4, 11, 9));
});

test('panSnap: off moves by the exact width and never snaps', async () => {
  const { installDOM, makeCanvas, setView, sleep } = await import('./helpers/dom.mjs');
  installDOM();
  const { default: TimeSeries } = await import('../src/timeseries.js');
  makeCanvas('pan-off-e2e');
  const ts = new TimeSeries({
    canvas: 'pan-off-e2e', sources: [], initialView: null, panSnap: 'off' });

  const t0 = local(2026, 4, 11, 18, 55), t1 = local(2026, 4, 11, 20, 4);
  await setView(ts, t0, t1);
  ts.pan(1);
  await sleep(700);

  const vp = ts.getViewport();
  assert.equal(vp.tmin, t1);
  assert.equal(vp.tmax, t1 + (t1 - t0));

  ts.setPanSnap('grid');
  assert.equal(ts.getPanSnap(), 'grid');
});
