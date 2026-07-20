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

const { panSnapUnit, panFloor, panAdd, panDiff } =
  await import('../src/timeseries.js');

const S = 1000, M = 60000, H = 3600000, D = 86400000;

// Local zone observes DST if January and July offsets differ.
const observesDST =
  new Date(2026, 0, 1).getTimezoneOffset() !== new Date(2026, 6, 1).getTimezoneOffset();

// Northern-hemisphere EU transitions for 2026: 29 Mar (23h day), 25 Oct (25h day).
const springForward = new Date(2026, 2, 29);
const fallBack = new Date(2026, 9, 25);
const isShortDay = d =>
  (new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) - d) / H === 23;
const dstHere = observesDST && isShortDay(springForward);

const local = (...a) => new Date(...a).getTime();
const hhmm = ms => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

// ── panSnapUnit ───────────────────────────────────────────────────────────────
test('panSnapUnit picks the unit matching the visible span', () => {
  assert.equal(panSnapUnit(30 * S), 'second');
  assert.equal(panSnapUnit(30 * M), 'minute');
  assert.equal(panSnapUnit(12 * H), 'hour');
  assert.equal(panSnapUnit(3 * D), 'day');
  assert.equal(panSnapUnit(30 * D), 'week');
  assert.equal(panSnapUnit(200 * D), 'month');
  assert.equal(panSnapUnit(5 * 365 * D), 'year');
});

test('panSnapUnit boundaries fall on the documented side', () => {
  assert.equal(panSnapUnit(90 * S - 1), 'second');
  assert.equal(panSnapUnit(90 * S), 'minute');
  assert.equal(panSnapUnit(36 * H - 1), 'hour');
  assert.equal(panSnapUnit(36 * H), 'day');
  assert.equal(panSnapUnit(14 * D - 1), 'day');
  assert.equal(panSnapUnit(14 * D), 'week');
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
