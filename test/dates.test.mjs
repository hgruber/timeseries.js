// Covers the date arithmetic the navigation API is built on: Gauss's Easter
// algorithm (which drives the movable holidays), ISO week starts, and the
// week/day presets. These had no tests at all, while being the kind of
// hand-rolled calendar maths that breaks silently.
//
// The presets read "now" via Date.now(), so tests pin it with at(). zoom() is
// animated; restoring the real clock afterwards makes the animation's end time
// lie in the past, so the next frame snaps straight to the target — that is why
// each case pins the clock, calls, unpins, then awaits a short sleep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries, Easter, isoWeekStart } = await import('../src/timeseries.js');

let nextId = 0;
function build() {
  const canvasId = 'dates-test-' + (nextId++);
  makeCanvas(canvasId);
  return new TimeSeries({ canvas: canvasId, sources: [], initialView: null });
}

const realNow = Date.now;
function at(localIso, fn) {
  const fixed = new Date(localIso).getTime();
  Date.now = () => fixed;
  try { fn(); } finally { Date.now = realNow; }
}

// Runs `method` as if "now" were `localIso`, then returns the settled viewport.
async function viewAt(localIso, method) {
  const ts = build();
  at(localIso, () => ts[method]());
  await sleep(60);
  return ts.getViewport();
}

const dayName = ms => new Date(ms).toDateString();

// ── Easter ────────────────────────────────────────────────────────────────────
// Reference values are the published dates of Easter Sunday (Gregorian).
// 2038 is the latest possible date (25 April), 2008 an unusually early one.
test('Easter matches published dates for a spread of years', () => {
  const expected = {
    1943: '25.4', 2008: '23.3', 2011: '24.4', 2024: '31.3',
    2025: '20.4', 2026: '5.4',  2027: '28.3', 2028: '16.4',
    2029: '1.4',  2030: '21.4', 2038: '25.4', 2043: '29.3',
  };
  for (const [year, date] of Object.entries(expected))
    assert.equal(Easter(Number(year)), date, `Easter ${year}`);
});

test('Easter always falls between 22 March and 25 April', () => {
  for (let y = 1900; y <= 2100; y++) {
    const [d, m] = Easter(y).split('.').map(Number);
    assert.ok(m === 3 || m === 4, `${y}: month ${m} out of range`);
    if (m === 3) assert.ok(d >= 22, `${y}: ${d}.3 is before the earliest possible date`);
    else assert.ok(d <= 25, `${y}: ${d}.4 is after the latest possible date`);
  }
});

test('Easter always lands on a Sunday', () => {
  for (let y = 1900; y <= 2100; y++) {
    const [d, m] = Easter(y).split('.').map(Number);
    assert.equal(new Date(y, m - 1, d).getDay(), 0, `Easter ${y} (${d}.${m}) is not a Sunday`);
  }
});

// ── ISO week starts ───────────────────────────────────────────────────────────
test('isoWeekStart returns the Monday of the requested ISO week', () => {
  // 1 Jan 2026 is a Thursday, so ISO week 1 starts in the previous year.
  assert.equal(dayName(isoWeekStart(2026, 1)), 'Mon Dec 29 2025');
  assert.equal(dayName(isoWeekStart(2025, 1)), 'Mon Dec 30 2024');
  // 1 Jan 2021 is a Friday, so week 1 starts on 4 January.
  assert.equal(dayName(isoWeekStart(2021, 1)), 'Mon Jan 04 2021');
});

test('isoWeekStart handles years that really have 53 weeks', () => {
  // 2020 and 2026 both have an ISO week 53.
  assert.equal(dayName(isoWeekStart(2020, 53)), 'Mon Dec 28 2020');
  assert.equal(dayName(isoWeekStart(2026, 53)), 'Mon Dec 28 2026');
});

test('every isoWeekStart is a Monday', () => {
  for (let y = 2020; y <= 2030; y++)
    for (let w = 1; w <= 52; w++)
      assert.equal(isoWeekStart(y, w).getDay(), 1, `${y} week ${w}`);
});

// ── Week presets ──────────────────────────────────────────────────────────────
// The week of Mon 5 Jan 2026 through Sun 11 Jan 2026. Every day in it must
// resolve to the same Monday-to-Monday window — Sunday is the case that the
// `|| 7` in `(d.getDay() || 7)` exists for.
const WEEK_DAYS = [
  ['2026-01-05T10:00:00', 'Monday'],
  ['2026-01-06T10:00:00', 'Tuesday'],
  ['2026-01-07T10:00:00', 'Wednesday'],
  ['2026-01-08T10:00:00', 'Thursday'],
  ['2026-01-09T10:00:00', 'Friday'],
  ['2026-01-10T10:00:00', 'Saturday'],
  ['2026-01-11T10:00:00', 'Sunday'],
];

for (const [iso, label] of WEEK_DAYS) {
  test(`thisWeek from ${label} spans Mon 5 Jan to Mon 12 Jan`, async () => {
    const vp = await viewAt(iso, 'thisWeek');
    assert.equal(dayName(vp.tmin), 'Mon Jan 05 2026');
    assert.equal(dayName(vp.tmax), 'Mon Jan 12 2026');
  });
}

test('lastWeek from Sunday still means the week before, not the current one', async () => {
  const vp = await viewAt('2026-01-11T10:00:00', 'lastWeek');
  assert.equal(dayName(vp.tmin), 'Mon Dec 29 2025');
  assert.equal(dayName(vp.tmax), 'Mon Jan 05 2026');
});

test('nextWeek from Monday means the following week', async () => {
  const vp = await viewAt('2026-01-05T10:00:00', 'nextWeek');
  assert.equal(dayName(vp.tmin), 'Mon Jan 12 2026');
  assert.equal(dayName(vp.tmax), 'Mon Jan 19 2026');
});

test('nextWeek from Sunday means the following week', async () => {
  const vp = await viewAt('2026-01-11T10:00:00', 'nextWeek');
  assert.equal(dayName(vp.tmin), 'Mon Jan 12 2026');
  assert.equal(dayName(vp.tmax), 'Mon Jan 19 2026');
});

// ── Day presets ───────────────────────────────────────────────────────────────
test('today spans local midnight to midnight', async () => {
  const vp = await viewAt('2026-01-07T14:30:00', 'today');
  assert.equal(dayName(vp.tmin), 'Wed Jan 07 2026');
  assert.equal(dayName(vp.tmax), 'Thu Jan 08 2026');
  assert.equal(new Date(vp.tmin).getHours(), 0);
});

test('yesterday and tomorrow sit either side of today', async () => {
  const y = await viewAt('2026-01-07T14:30:00', 'yesterday');
  assert.equal(dayName(y.tmin), 'Tue Jan 06 2026');
  assert.equal(dayName(y.tmax), 'Wed Jan 07 2026');

  const t = await viewAt('2026-01-07T14:30:00', 'tomorrow');
  assert.equal(dayName(t.tmin), 'Thu Jan 08 2026');
  assert.equal(dayName(t.tmax), 'Fri Jan 09 2026');
});

test('day presets cross a month boundary correctly', async () => {
  const vp = await viewAt('2026-01-31T09:00:00', 'tomorrow');
  assert.equal(dayName(vp.tmin), 'Sun Feb 01 2026');
  assert.equal(dayName(vp.tmax), 'Mon Feb 02 2026');
});

test('day presets cross a year boundary correctly', async () => {
  const vp = await viewAt('2025-12-31T09:00:00', 'tomorrow');
  assert.equal(dayName(vp.tmin), 'Thu Jan 01 2026');
  assert.equal(dayName(vp.tmax), 'Fri Jan 02 2026');
});
