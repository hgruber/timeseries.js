// Guards the bounded-growth behaviour of data[].
//
// Plot ids are indices into data[] and sources hold on to them across calls
// (replaceData/removeData), so the array is never compacted — that would
// repoint every id a source still holds. Instead, slots freed when a block is
// superseded go on a free list and get handed out again. Without that, a
// polling source pushing on every fetch grows data[] monotonically for the
// life of the page, and prepare_grid rescans the whole thing every frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { registerSource } = await import('../src/sources.js');

const start = Math.floor(Date.UTC(2026, 0, 5, 8) / 1000);
const INTERVAL = 3600, COUNT = 12;

// One block covering the same window every time — each push supersedes the last.
function block(offsetSlots = 0) {
  const data = {};
  for (let i = 0; i < COUNT; i++) data[i] = { s1: 10 + i + offsetSlots, s2: 5 };
  return {
    name: 'poll', type: 'multibar',
    interval_start: start, interval: INTERVAL, count: COUNT,
    min: 0, max: 30, data,
  };
}

let nextId = 0;
async function buildPolling() {
  const canvasId = 'mem-test-' + (nextId++);
  const sourceType = 'mem-poll-' + canvasId;
  makeCanvas(canvasId);
  let push = null;
  registerSource({
    type: sourceType,
    // Mirrors what a real polling source does: push, then ask for a redraw —
    // activePlot is only recomputed inside prepare_grid.
    init(_s, cb) { push = p => { const id = cb.pushData(p); cb.requestRedraw(); return id; }; },
  });
  const ts = new TimeSeries({
    canvas: canvasId,
    sources: [{ 'source-type': sourceType }],
    initialView: null,
  });
  await setView(ts, start * 1000, (start + COUNT * INTERVAL) * 1000);
  return { ts, push };
}

test('repeatedly pushing the same window does not grow data[] without bound', async () => {
  const { ts, push } = await buildPolling();

  push(block(0));
  const afterFirst = ts.getData().length;

  // Simulate a source polling for a long time.
  for (let i = 1; i <= 50; i++) push(block(i));
  const afterFifty = ts.getData().length;

  assert.ok(afterFifty <= afterFirst + 1,
    `data[] grew from ${afterFirst} to ${afterFifty} over 50 pushes — slots are not being reused`);
});

test('only one block stays active after repeated pushes', async () => {
  const { ts, push } = await buildPolling();
  for (let i = 0; i < 20; i++) push(block(i));
  assert.equal(ts.getActiveData().length, 1);
});

test('the newest push is the one that survives', async () => {
  const { ts, push } = await buildPolling();
  for (let i = 0; i < 10; i++) push(block(i));
  const live = ts.getActiveData()[0];
  // block(9) put 10+0+9 = 19 in slot 0.
  assert.equal(live.data[0].s1, 19);
});

test('a recycled slot does not resurrect the dropped plot', async () => {
  const { ts, push } = await buildPolling();
  for (let i = 0; i < 10; i++) push(block(i));
  const all = ts.getData().filter(Boolean);
  // Whatever the array length, no two live entries may be the same object.
  assert.equal(new Set(all).size, all.length, 'duplicate plot objects in data[]');
});

test('dropData frees the slot for reuse', async () => {
  const { ts, push } = await buildPolling();
  push(block(0));
  const lenBefore = ts.getData().length;

  ts.dropData(p => p.name === 'poll');
  assert.equal(ts.getActiveData().length, 0, 'precondition: everything dropped');

  push(block(1));
  assert.ok(ts.getData().length <= lenBefore,
    'a dropped slot should be reused rather than appended past');
  assert.equal(ts.getActiveData().length, 1);
});

test('clearAll resets the free list too, so ids start from zero again', async () => {
  const { ts, push } = await buildPolling();
  for (let i = 0; i < 5; i++) push(block(i));
  ts.clearAll();
  assert.equal(ts.getData().length, 0);

  push(block(99));
  assert.equal(ts.getData().length, 1, 'after clearAll the first push must land in slot 0');
  assert.equal(ts.getActiveData().length, 1);
});
