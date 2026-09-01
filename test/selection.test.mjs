// Tests for the persistent selection (setSelection / getSelection /
// clearSelection). Identity is (slotSec, key). The outline paints only while
// the referenced bar is actually drawn — same exclusion rules as the hit test.
//
// Layers:
//   1. resolveSelection against hand-built blocks (pure function);
//   2. drawSelection with a recording canvas context;
//   3. the instance API, headlessly, with a real multibar source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { resolveSelection, drawSelection } = await import('../src/renderers.js');

const START = 1767600000;
const INTERVAL = 60;

// ── 1. resolveSelection ──

function bars(data, extra) {
  return Object.assign({
    type: 'multibar', interval: INTERVAL, interval_start: START, data,
  }, extra || {});
}

test('resolveSelection finds the slot for a matching (slotSec, key)', () => {
  const p = bars({ 0: { s1: 10 }, 1: { s1: 20 } }, {});
  const n = resolveSelection(p, { slotSec: START + 60, key: 's1' }, null);
  assert.equal(n, 1);
});

test('null when the series key is absent from the slot', () => {
  const p = bars({ 0: { s1: 10 } }, {});
  assert.equal(resolveSelection(p, { slotSec: START, key: 's9' }, null), null);
});

test('null when slotSec is not aligned to the block grid (tier switch)', () => {
  const p = bars({ 0: { s1: 10 } }, {});
  assert.equal(resolveSelection(p, { slotSec: START + 30, key: 's1' }, null), null);
});

test('null when the series is hidden', () => {
  const p = bars({ 0: { s1: 10 } }, {});
  const hidden = new Set(['s1']);
  assert.equal(resolveSelection(p, { slotSec: START, key: 's1' }, hidden), null);
});

test('null when the partial bin is skipped (not drawn → not selectable)', () => {
  const p = bars({ 0: { s1: 10 } }, { _partial: { slot: 0, skip: true } });
  assert.equal(resolveSelection(p, { slotSec: START, key: 's1' }, null), null);
});

test('null in the underlaid half of a cross-fade, resolves in the dominant one', () => {
  const p = bars({ 0: { s1: 10 } }, { _fade: 0.3 });
  assert.equal(resolveSelection(p, { slotSec: START, key: 's1' }, null), null);
  const p2 = bars({ 0: { s1: 10 } }, { _fade: 0.7 });
  assert.equal(resolveSelection(p2, { slotSec: START, key: 's1' }, null), 0);
});

// ── 2. drawSelection with a recording context ──
// Modeled on the recorder in partial-bins.test.mjs: capture the strokeRect
// call the outline mode makes.

function recorder() {
  const calls = [];
  const c = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect: (...args) => calls.push({ op: 'fillRect', alpha: c.globalAlpha, args }),
    strokeRect: (...args) => calls.push({ op: 'strokeRect', alpha: c.globalAlpha, args }),
  };
  return { c, calls };
}

function rctxFor(c, extra) {
  return Object.assign({
    c,
    // 1px per second, with the block's interval_start at x=0 — keeps the bar
    // inside the 1000px plot area the clip check looks at.
    X: t => (t - START * 1000) / 1000,
    Y: v => 100 - v,            // 1px per unit, baseline at y=100
    ppms: 1 / 1000, ppv: 1,
    margin: { left: 0, top: 0, right: 0, bottom: 0 },
    plotWidth: 1000, plotHeight: 100,
    hidden: new Set(),
    colors: { selection: '#112233' },
  }, extra || {});
}

test('drawSelection strokes the bar rect, 1px outside its own rect', () => {
  const { c, calls } = recorder();
  const p = bars({ 0: { s1: 10 } }, {});
  drawSelection([0], [p], rctxFor(c), { slotSec: START, key: 's1' });
  const s = calls.find(x => x.op === 'strokeRect');
  assert.ok(s, 'no strokeRect recorded');
  // bar: x=0, w=60, top=Y(10)=90, height 10 → rect x-1, top-1, w+2, h+2
  assert.deepEqual(s.args, [-1, 89, 62, 12]);
});

test('outline does not fill, and carries the palette key selection', () => {
  const { c, calls } = recorder();
  const p = bars({ 0: { s1: 10 } }, {});
  drawSelection([0], [p], rctxFor(c), { slotSec: START, key: 's1' });
  const fills = calls.filter(x => x.op === 'fillRect');
  assert.deepEqual(fills, []);
  const s = calls.find(x => x.op === 'strokeRect');
  assert.ok(s, 'no strokeRect recorded');
  assert.equal(c.strokeStyle, '#112233');
});

// ── 3. the instance API ──

let nextId = 0;
async function buildInstance() {
  const canvasId = 'selection-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const data = {};
  for (let i = 0; i < 12; i++) data[i] = { s1: 10 + i, s2: 5 };
  const ts = new TimeSeries({
    canvas: canvasId,
    sources: [{
      'source-type': 'artificial',
      name: 'test', type: 'multibar',
      interval_start: START, interval: INTERVAL, count: 12,
      min: 0, max: 27, data,
    }],
    initialView: null,
  });
  await setView(ts, START * 12, (START + 12 * INTERVAL) * 1000);
  return { ts, canvas };
}

test('round-trip: set → get reports resolved, clear → get returns null', async () => {
  const { ts } = await buildInstance();
  ts.setSelection({ slotSec: START + 5 * INTERVAL, key: 's1' });
  const sel = ts.getSelection();
  assert.equal(sel.slotSec, START + 5 * 60);
  assert.equal(sel.key, 's1');
  assert.equal(sel.resolved, true);
  ts.clearSelection();
  assert.equal(ts.getSelection(), null);
});