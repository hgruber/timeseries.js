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
