// Covers the pan snapping arithmetic (panSnapUnit/panFloor/panAdd/panDiff) that
// ts.pan() is built on, with particular attention to DST transitions — the
// comment at the top of that block claims DST-safety, and panDiff does in fact
// divide by fixed millisecond constants. These tests pin what actually happens.
//
// The DST cases only mean something in a zone that observes it, so they are
// skipped under TZ=UTC and friends. Run `TZ=Europe/Berlin npm test` to exercise
// them; `TZ=UTC npm test` must also stay green.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { panSnapUnit, panSnapEdge, panFloor, panAdd, panDiff } =
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

// ── panSnapUnit ───────────────────────────────────────────────────────────────
// ANCHOR is an arbitrary Monday, irrelevant for the sub-month spans below —
// calendar-anchored detection only kicks in once a span is roughly a month
// or more (see panSnapUnit's calendarUnitMatches check).
const ANCHOR = local(2026, 4, 11);

test('panSnapUnit picks the unit matching the visible span', () => {
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 30 * S), 'second');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 30 * M), 'minute');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 12 * H), 'hour');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 3 * D), 'day');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 45 * D), 'week');
  assert.equal(panSnapUnit(local(2026, 0, 1), local(2026, 0, 1) + 200 * D), 'month');
  assert.equal(panSnapUnit(local(2026, 0, 1), local(2026, 0, 1) + 5 * 365 * D), 'year');
});

test('panSnapUnit boundaries fall on the documented side', () => {
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 90 * S - 1), 'second');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 90 * S),     'minute');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 36 * H - 1), 'hour');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 36 * H),     'day');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 14 * D - 1), 'day');
  assert.equal(panSnapUnit(ANCHOR, ANCHOR + 14 * D),     'week');
});

// ── panSnapUnit, calendar-aware month/year detection ───────────────────────────
// A calendar month is only 28-31 days and a calendar year only 365-366 days —
// both fall entirely inside the old fixed-ms 'week'/'month' buckets. These
// tests guard the bug where a full month/year view was misclassified as a
// shorter unit, which made ts.pan() (arrow-key paging) snap to the wrong
// boundaries — see CLAUDE.md and the pan-snapping comment block.
test('panSnapUnit recognizes an exact calendar month regardless of length', () => {
  assert.equal(panSnapUnit(local(2026, 3, 1), local(2026, 4, 1)), 'month'); // April, 30d
  assert.equal(panSnapUnit(local(2026, 1, 1), local(2026, 2, 1)), 'month'); // Feb, 28d
  assert.equal(panSnapUnit(local(2026, 0, 1), local(2026, 1, 1)), 'month'); // Jan, 31d
});

test('panSnapUnit recognizes an exact calendar year regardless of length', () => {
  assert.equal(panSnapUnit(local(2026, 0, 1), local(2027, 0, 1)), 'year');
  assert.equal(panSnapUnit(local(2027, 0, 1), local(2028, 0, 1)), 'year'); // 2028 leap
});

test('panSnapUnit recognizes a two-month span even though it is under 60 days', () => {
  assert.equal(panSnapUnit(local(2026, 0, 1), local(2026, 2, 1)), 'month'); // Jan+Feb, 59d
});

test('panSnapUnit tolerates a near-month span within 5%', () => {
  assert.equal(panSnapUnit(local(2026, 3, 3), local(2026, 4, 2)), 'month'); // 29d vs 30d April
});

test('panSnapUnit does not snap a span clearly outside the 5% month tolerance', () => {
  assert.equal(panSnapUnit(local(2026, 3, 1), local(2026, 3, 1) + 32 * D), 'week');
});

// ── panSnapUnit, calendar-aware day detection (under-36h bug fix) ──────────────
// A single calendar day is 23-25h depending on DST, all under the old flat
// 36h hour/day threshold, so it used to be misclassified as 'hour'. That's
// normally invisible (a 24h 'hour'-unit step still overflows correctly), but
// on a DST transition day the real hour count (23 or 25) doesn't force
// Date#setHours to roll to the next day, and the viewport silently drifts by
// 1h — the bug reported against ts.pan() day-paging across the last Sunday
// of March/October. These guard the fix directly, without relying on
// the DST calendar shifting under a real end-to-end pan().
test('panSnapUnit prefers day over hour for a midnight-aligned single day', () => {
  assert.equal(panSnapUnit(local(2026, 4, 11), local(2026, 4, 12)), 'day'); // ordinary 24h day
});

test('panSnapUnit prefers day over hour for a 23h spring-forward day', { skip: !dstHere }, () => {
  assert.equal(panSnapUnit(local(2026, 2, 29), local(2026, 2, 30)), 'day');
});

test('panSnapUnit prefers day over hour for a 25h fall-back day', { skip: !dstHere }, () => {
  assert.equal(panSnapUnit(local(2026, 9, 25), local(2026, 9, 26)), 'day');
});

test('panSnapUnit keeps hour for a non-midnight-aligned rolling 24h window', () => {
  const t = local(2026, 4, 11, 14, 32); // arbitrary time of day, e.g. last24()
  assert.equal(panSnapUnit(t, t + 24 * H), 'hour');
});

// ── panSnapEdge ─────────────────────────────────────────────────────────────────
test('panSnapEdge leaves an already-aligned edge unchanged', () => {
  const apr1 = local(2026, 3, 1);
  assert.equal(panSnapEdge(apr1, 'month', false), apr1);
  assert.equal(panSnapEdge(apr1, 'month', true), apr1);
});

test('panSnapEdge snaps down when within tolerance of the lower boundary', () => {
  // 2 May is 1 day into a 31-day May -> within 5% (1.55d) of 1 May.
  assert.equal(panSnapEdge(local(2026, 4, 2), 'month', true), local(2026, 4, 1));
});

test('panSnapEdge snaps up when within tolerance of the upper boundary', () => {
  // 30 Apr is 1 day before 1 May -> within 5% (1.5d) of the April/May boundary.
  assert.equal(panSnapEdge(local(2026, 3, 30), 'month', false), local(2026, 4, 1));
});

test('panSnapEdge falls back to floor/ceil when not near either boundary', () => {
  const mid = local(2026, 3, 15); // 15 days into April either side, well outside 5%
  assert.equal(panSnapEdge(mid, 'month', false), local(2026, 3, 1));   // floor
  assert.equal(panSnapEdge(mid, 'month', true),  local(2026, 4, 1));   // ceil
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
