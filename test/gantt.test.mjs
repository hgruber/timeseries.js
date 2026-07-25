// Row assignment for span plots (src/gantt.js: layoutSpans, pack).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutSpans } from '../src/gantt.js';

const H = 3600000;
const T0 = Date.UTC(2026, 0, 5, 8);
const mk = (id, lane, h0, h1) => ({ id, lane, start: T0 + h0 * H, end: T0 + h1 * H, label: id });

function freshPlot(layout) {
  return {
    type: 'gantt', category: 'span', layout,
    tmin: T0, tmax: T0 + 12 * H,
    lanes: [{ id: 'A', label: 'Lane A' }, { id: 'B', label: 'Lane B' }, { id: 'C', label: 'Empty C' }],
    data: [
      mk('a1', 'A', 0, 4), mk('a2', 'A', 1, 5), mk('a3', 'A', 2, 6),
      mk('b1', 'B', 0, 2), mk('b2', 'B', 3, 5),
    ],
  };
}

test('calendar layout: overlapping events in one lane get distinct rows', () => {
  const plot = freshPlot('calendar');
  layoutSpans(plot);
  const row = id => plot.data.find(e => e.id === id)._row;
  assert.equal(new Set([row('a1'), row('a2'), row('a3')]).size, 3);
});

test('calendar layout: disjoint events in a lane share a row', () => {
  const plot = freshPlot('calendar');
  layoutSpans(plot);
  const row = id => plot.data.find(e => e.id === id)._row;
  assert.equal(row('b1'), row('b2'));
});

test('calendar layout: lanes occupy contiguous, ordered row blocks', () => {
  const plot = freshPlot('calendar');
  layoutSpans(plot);
  const row = id => plot.data.find(e => e.id === id)._row;
  assert.equal(row('b1'), 3); // lane A used rows 0-2
});

test('calendar layout: an empty lane still reserves one row', () => {
  const plot = freshPlot('calendar');
  layoutSpans(plot);
  assert.equal(plot.laneCount, 5); // 3 (A) + 1 (B) + 1 (C, empty)
});

test('calendar layout: yticks are one per lane, centred, and inside the range', () => {
  const plot = freshPlot('calendar');
  layoutSpans(plot);
  assert.equal(plot.yticks.length, 3);
  assert.deepEqual(plot.yticks.map(t => t.label), ['Lane A', 'Lane B', 'Empty C']);
  assert.equal(plot.yticks[0].y, 3.5); // lane A spans rows 0-3
  for (const t of plot.yticks) assert.ok(t.y > 0 && t.y < plot.laneCount);
});

test('calendar layout: laneBounds excludes the final plot edge', () => {
  const plot = freshPlot('calendar');
  layoutSpans(plot);
  assert.deepEqual(plot.laneBounds, [3, 4]);
});

test('layoutSpans is idempotent', () => {
  const plot = freshPlot('calendar');
  layoutSpans(plot);
  const stamp = plot._laidOut;
  const rowsBefore = plot.data.map(e => e._row).join(',');
  layoutSpans(plot);
  assert.equal(plot._laidOut, stamp);
  assert.equal(plot.data.map(e => e._row).join(','), rowsBefore);
});

test('packed layout uses the minimum rows (max concurrency), fewer than calendar', () => {
  const plot = freshPlot('packed');
  layoutSpans(plot);
  // Sweep: at t=3.5h, a1/a2/a3/b2 are all live — peak concurrency is 4.
  const peak = Math.max(...plot.data.map(e =>
    plot.data.filter(o => o.start <= e.start && o.end > e.start).length));
  assert.equal(plot.laneCount, peak);
  assert.equal(plot.laneCount, 4);
});

test('packed layout emits no lane ticks but still separates true overlaps', () => {
  const plot = freshPlot('packed');
  layoutSpans(plot);
  assert.equal(plot.yticks.length, 0);
  const row = id => plot.data.find(e => e.id === id)._row;
  assert.equal(new Set([row('a1'), row('a2'), row('a3')]).size, 3);
});

test('an event whose lane is not in `lanes` is appended, not dropped', () => {
  const plot = {
    type: 'gantt', category: 'span', layout: 'calendar',
    tmin: T0, tmax: T0 + 8 * H,
    lanes: [{ id: 'A', label: 'A' }],
    data: [mk('a1', 'A', 0, 1), mk('x1', 'GHOST', 0, 1)],
  };
  layoutSpans(plot);
  assert.equal(plot.lanes.length, 2);
  assert.ok(plot.data.every(e => typeof e._row === 'number'));
});

test('an empty plot does not throw', () => {
  assert.doesNotThrow(() => layoutSpans({ type: 'gantt', category: 'span', data: [], lanes: [] }));
});

// ── `group`: repeated occurrences of one thing stay in one row ───────────────

const gmk = (id, lane, h0, h1, group) => Object.assign(mk(id, lane, h0, h1), { group });
const rowOf = (plot, id) => plot.data.find(e => e.id === id)._row;
const lanePlot = data => ({
  type: 'gantt', category: 'span', layout: 'calendar',
  tmin: T0, tmax: T0 + 12 * H, lanes: [{ id: 'A', label: 'Lane A' }], data,
});

test('group: disjoint occurrences of one group share a row', () => {
  const plot = lanePlot([
    gmk('g1', 'A', 0, 1, 'g'), gmk('g2', 'A', 4, 5, 'g'), gmk('g3', 'A', 8, 9, 'g'),
  ]);
  layoutSpans(plot);
  assert.equal(new Set(plot.data.map(e => e._row)).size, 1);
});

test('group: a foreign event cannot wedge into a gap the group needs again', () => {
  // Chronologically: g1 claims row 0, then `x` arrives while row 0 merely
  // *looks* idle, then g2 comes back. Reserving row 0 for the group's whole
  // season is what keeps g2 out of a second row.
  const plot = lanePlot([
    gmk('g1', 'A', 0, 1, 'g'), mk('x', 'A', 2, 3), gmk('g2', 'A', 4, 5, 'g'),
  ]);
  layoutSpans(plot);
  assert.equal(rowOf(plot, 'g1'), rowOf(plot, 'g2'), 'group split across rows');
  assert.notEqual(rowOf(plot, 'x'), rowOf(plot, 'g1'), 'foreign event took the group row');
  assert.equal(plot.laneCount, 2);
});

test('group: the door-sensor shape — many brief firings plus a long problem', () => {
  // What examples/zabbix.html hits: one trigger firing briefly all day while an
  // unrelated problem stays open across the whole window.
  const door = [0, 2, 4, 6, 8, 10].map((h, i) => gmk('d' + i, 'A', h, h + 0.01, 'door'));
  const plot = lanePlot([mk('long', 'A', 0, 12), ...door]);
  layoutSpans(plot);
  assert.equal(new Set(door.map(e => rowOf(plot, e.id))).size, 1, 'firings scattered across rows');
  assert.notEqual(rowOf(plot, 'd0'), rowOf(plot, 'long'));
  assert.equal(plot.laneCount, 2, 'one row for the long problem, one for the group');
});

test('group: zero-length occurrences still pack into the one row', () => {
  const plot = lanePlot([0, 3, 6].map((h, i) => gmk('z' + i, 'A', h, h, 'g')));
  layoutSpans(plot);
  assert.equal(new Set(plot.data.map(e => e._row)).size, 1);
});

test('group: groups do not leak across lanes', () => {
  // pack() runs per lane in calendar layout, so the same group id in two lanes
  // is two independent groups — and each stays inside its own lane's block.
  const plot = {
    type: 'gantt', category: 'span', layout: 'calendar',
    tmin: T0, tmax: T0 + 12 * H,
    lanes: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    data: [
      gmk('a1', 'A', 0, 6, 'g'),
      gmk('b1', 'B', 0, 1, 'g'), gmk('b2', 'B', 3, 4, 'g'),
    ],
  };
  layoutSpans(plot);
  assert.equal(rowOf(plot, 'b1'), rowOf(plot, 'b2'));
  assert.notEqual(rowOf(plot, 'a1'), rowOf(plot, 'b1'), 'lanes share a row');
  assert.equal(plot.laneCount, 2);
});

test('group: ungrouped events pack exactly as before', () => {
  // Same fixture as the plain calendar tests, so a `group` regression that
  // changed the ungrouped path would show up here.
  const plot = freshPlot('calendar');
  layoutSpans(plot);
  assert.equal(rowOf(plot, 'b1'), rowOf(plot, 'b2'));
  assert.equal(new Set([rowOf(plot, 'a1'), rowOf(plot, 'a2'), rowOf(plot, 'a3')]).size, 3);
  assert.equal(plot.laneCount, 5);
});

test('group: no two events in one row ever overlap', () => {
  const plot = lanePlot([
    gmk('g1', 'A', 0, 2, 'g'), mk('x1', 'A', 1, 3), gmk('g2', 'A', 4, 6, 'g'),
    mk('x2', 'A', 5, 7), gmk('h1', 'A', 0, 1, 'h'), gmk('h2', 'A', 8, 9, 'h'),
  ]);
  layoutSpans(plot);
  const byRow = new Map();
  for (const e of plot.data) {
    if (!byRow.has(e._row)) byRow.set(e._row, []);
    byRow.get(e._row).push(e);
  }
  for (const evs of byRow.values()) {
    evs.sort((a, b) => a.start - b.start);
    for (let i = 1; i < evs.length; i++)
      assert.ok(evs[i].start >= evs[i - 1].end, evs[i - 1].id + ' overlaps ' + evs[i].id);
  }
});
