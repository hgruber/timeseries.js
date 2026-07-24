// Rate axis (setRateUnit): a block marked `extensive` carries an amount
// accumulated over its bin, so its raw values scale with the bin length. Two
// resolution tiers of one signal are then on different value scales — 60× apart
// on a 60s→3600s ladder — and the cross-fade has to travel the axis between
// them, which makes the bars visibly breathe through the dissolve. Drawing per
// unit time instead puts both tiers on one scale: same heights, and the tier
// switch is left to change only what is *printed* on the axis.
//
// Four layers are exercised:
//   1. prepare_grid stamps `_vscale` and measures the extent in drawn space;
//   2. plotData applies it centrally, so every renderer scales without knowing;
//   3. the hit test scales the stack but still hands back the raw value;
//   4. the unit swap dissolves the old tick set into the new one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, sleep } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { plotData } = await import('../src/renderers.js');

// ── 1. plotData applies _vscale through the render context ───────────────────

// Records the geometry each paint op ran at. The Proxy context in
// helpers/dom.mjs is a pure no-op and cannot answer this.
function recorder() {
  const calls = [];
  const c = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect: (...args) => calls.push({ op: 'fillRect', alpha: c.globalAlpha, args }),
    moveTo: (x, y) => calls.push({ op: 'moveTo', args: [x, y] }),
    lineTo: (x, y) => calls.push({ op: 'lineTo', args: [x, y] }),
    fill: () => calls.push({ op: 'fill' }),
    stroke: () => calls.push({ op: 'stroke' }),
    beginPath() {}, closePath() {}, arc() {},
  };
  return { c, calls };
}

function rctxFor(c) {
  return {
    c,
    X: t => t / 1000,
    Y: v => 100 - v,
    ppms: 1 / 1000, ppv: 1,
    margin: { left: 0, top: 0, right: 0, bottom: 0 },
    plotWidth: 1000, plotHeight: 100,
    hidden: new Set(),
  };
}

function block(type, vscale, data) {
  const p = { type, interval: 60, interval_start: 0, data };
  if (vscale !== undefined) p._vscale = vscale;
  return p;
}

test('multibar draws at the block\'s _vscale — base and height together', () => {
  const { c, calls } = recorder();
  plotData([0], [block('multibar', 0.5, { 0: { a: 5 } })], rctxFor(c));
  assert.equal(calls.length, 1);
  // Y(0 * 0.5) = 100 for the baseline, -(ppv * 0.5) * 5 for the height.
  assert.equal(calls[0].args[1], 100);
  assert.equal(calls[0].args[3], -2.5);
});

test('without _vscale the geometry is untouched', () => {
  const { c, calls } = recorder();
  plotData([0], [block('multibar', undefined, { 0: { a: 5 } })], rctxFor(c));
  assert.equal(calls[0].args[3], -5);
});

test('a stacked bar keeps sitting on the segment below it', () => {
  const { c, calls } = recorder();
  plotData([0], [block('multibar', 0.5, { 0: { a: 4, b: 6 } })], rctxFor(c));
  assert.equal(calls.length, 2);
  // Second segment starts where the first ends: Y(4 * 0.5) = 98.
  assert.equal(calls[1].args[1], 98);
  assert.equal(calls[1].args[3], -3);
});

test('multiline and multipoint scale too, without knowing about _vscale', () => {
  const { c, calls } = recorder();
  plotData([0], [block('multiline', 0.5, { 0: { a: 10 }, 1: { a: 20 } })], rctxFor(c));
  const ys = calls.filter(k => k.op === 'moveTo' || k.op === 'lineTo').map(k => k.args[1]);
  assert.deepEqual(ys, [95, 90]);   // Y(10*0.5), Y(20*0.5)

  const pts = recorder();
  plotData([0], [block('multipoint', 0.5, { 0: { a: 10 } })], rctxFor(pts.c));
  // fillRect(x - r, Y(v) - r, ...) with r = 2 → Y(5) - 2 = 93.
  assert.equal(pts.calls[0].args[1], 93);
});

test('the render context is not mutated for the next block', () => {
  const { c, calls } = recorder();
  const rctx = rctxFor(c);
  plotData([0, 1], [block('multibar', 0.5, { 0: { a: 5 } }),
                    block('multibar', undefined, { 0: { a: 5 } })], rctx);
  assert.equal(rctx.ppv, 1);
  assert.equal(rctx.Y(5), 95);
  const heights = calls.map(k => k.args[3]).sort((a, b) => a - b);
  assert.deepEqual(heights, [-5, -2.5]);
});

// ── 2 & 3. extent and hit test, on a real instance ───────────────────────────
//
// Two multibar tiers of one signal: 60s bars worth 1 and 3600s bars worth 60,
// i.e. the same rate of 1 per minute expressed at two resolutions.

const START_S = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const DAYS = 4;
const MID_MS = (START_S + DAYS * 86400 / 2) * 1000;
const FINE_V = 1, COARSE_V = 60;

function tier(interval, value, extensive) {
  const data = {};
  for (let i = 0; i < (DAYS * 86400) / interval; i++) data[i] = { a: value };
  const p = {
    'source-type': 'artificial', type: 'multibar', name: 'm',
    interval, interval_start: START_S, data, min: 0, max: value,
  };
  if (extensive) p.extensive = true;
  return p;
}

let nextId = 0;
async function build(extensive, canvasFactory) {
  const id = 'rate-' + (nextId++);
  const canvas = (canvasFactory || makeCanvas)(id);
  const ts = new TimeSeries({
    canvas: id,
    sources: [tier(3600, COARSE_V, extensive), tier(60, FINE_V, extensive)],
    initialView: null,
  });
  await setView(ts, MID_MS - 6e6, MID_MS + 6e6);         // settle the margins
  return { ts, canvas, plotWidth: ts.getPlotArea().plotWidth };
}

// Window width (ms) that makes the fine (60s) bucket exactly `px` pixels wide.
const widthForFinePx = (pw, px) => (60 * 1000 * pw) / px;

async function atFinePx(built, px) {
  const w = widthForFinePx(built.plotWidth, px);
  await setView(built.ts, MID_MS - w / 2, MID_MS + w / 2);
  return built;
}

test('without a rate unit the axis still travels between the tiers', async () => {
  const built = await build(true);
  await atFinePx(built, 1.5);
  const ymax = built.ts.getValueRange().ymax;
  assert.ok(ymax > FINE_V && ymax < COARSE_V, 'ymax ' + ymax);
});

test('a rate unit puts both tiers on one scale, so the axis holds still', async () => {
  const built = await build(true);
  built.ts.setRateUnit(60);                      // per minute
  for (const px of [5, 1.8, 1.5, 1.2, 0.3]) {
    await atFinePx(built, px);
    const ymax = built.ts.getValueRange().ymax;
    assert.ok(Math.abs(ymax - 1) < 1e-9, `ymax ${ymax} at ${px}px/bar`);
  }
});

test('the two tiers are both active mid-band and both scaled to 1', async () => {
  const built = await build(true);
  built.ts.setRateUnit(60);
  await atFinePx(built, 1.5);
  const active = built.ts.getActiveData();
  assert.equal(active.length, 2);
  const fine = active.find(p => p.interval === 60);
  const coarse = active.find(p => p.interval === 3600);
  assert.equal(fine._vscale, 1);
  assert.ok(Math.abs(coarse._vscale - 1 / 60) < 1e-12, '_vscale ' + coarse._vscale);
  assert.ok(fine._fade > 0 && coarse._fade > 0, 'both drawn');
});

test('the rate unit only picks the numbers, never the heights', async () => {
  // Per hour instead of per minute: every value is 60× larger and so is ymax,
  // which is exactly why the bars do not move.
  const built = await build(true);
  built.ts.setRateUnit(3600);
  await atFinePx(built, 1.5);
  assert.ok(Math.abs(built.ts.getValueRange().ymax - 60) < 1e-9);
});

test('blocks not marked extensive are left alone', async () => {
  // An average or a percentile is already per-unit; scaling it would be wrong.
  const built = await build(false);
  built.ts.setRateUnit(60);
  await atFinePx(built, 1.5);
  for (const p of built.ts.getActiveData()) assert.equal(p._vscale, 1);
  const ymax = built.ts.getValueRange().ymax;
  assert.ok(ymax > FINE_V && ymax < COARSE_V, 'ymax ' + ymax);
});

test('setRateUnit(null) restores the raw values', async () => {
  const built = await build(true);
  built.ts.setRateUnit(60);
  await atFinePx(built, 0.3);
  assert.ok(Math.abs(built.ts.getValueRange().ymax - 1) < 1e-9);
  built.ts.setRateUnit(null);
  assert.equal(built.ts.getRateUnit(), null);
  assert.equal(built.ts.getValueRange().ymax, COARSE_V);
});

test('setRateUnit refuses a unit that would poison the scale', async () => {
  const built = await build(true);
  built.ts.setRateUnit(60);
  for (const bad of [0, -60, NaN, 'x']) {
    built.ts.setRateUnit(bad);
    assert.equal(built.ts.getRateUnit(), 60, 'accepted ' + String(bad));
  }
});

test('the hit test scales the stack but reports the raw value', async () => {
  const built = await build(true);
  built.ts.setRateUnit(60);
  await atFinePx(built, 5);                     // fine tier alone, one bar/slot
  const area = built.ts.getPlotArea();
  let got = null;
  built.ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, key, value }; });
  built.canvas.onmousemove({
    clientX: area.margin.left + area.plotWidth / 2,
    clientY: area.margin.top + area.plotHeight - 2,
  });
  assert.ok(got, 'nothing hovered');
  assert.equal(got.key, 'a');
  assert.equal(got.value, FINE_V);              // raw count in the bin, not the rate
  assert.equal(got.plot.interval, 60);
});

test('mid-fade the coarse tier is hittable and reports its own raw value', async () => {
  const built = await build(true);
  built.ts.setRateUnit(60);
  await atFinePx(built, 1.2);                   // fine faded to 0.2, coarse dominant
  const area = built.ts.getPlotArea();
  let got = null;
  built.ts.onHoverDataCallback((plot, n, key, value) => { got = { plot, value }; });
  built.canvas.onmousemove({
    clientX: area.margin.left + area.plotWidth / 2,
    clientY: area.margin.top + area.plotHeight - 2,
  });
  assert.ok(got, 'nothing hovered');
  assert.equal(got.plot.interval, 3600);
  assert.equal(got.value, COARSE_V);
});

// ── 4. the unit swap dissolves ───────────────────────────────────────────────

// A canvas whose context records the text it draws, so a test can see which
// tick sets and unit labels were on screen in a given frame.
function makeRecordingCanvas(id) {
  const canvas = makeCanvas(id);
  const texts = [];
  const ctx = {
    globalAlpha: 1,
    measureText: s => ({ width: 8 * String(s).length, actualBoundingBoxAscent: 9 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillText: (s) => texts.push({ text: String(s), alpha: ctx.globalAlpha }),
    canvas,
  };
  canvas.texts = texts;
  canvas.getContext = () => new Proxy(ctx, {
    get(t, k) { return k in t ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; },
  });
  return canvas;
}

// Every unit label drawn since the marker, with the alpha it was drawn at.
function unitsSince(canvas, from) {
  return canvas.texts.slice(from).filter(t => t.text.includes('/'));
}

test('a unit swap holds the old tick set on screen and fades it out', async () => {
  const built = await build(true, makeRecordingCanvas);
  built.ts.setRateUnit(60, { label: 'txn/min' });
  await atFinePx(built, 1.5);

  let mark = built.canvas.texts.length;
  built.ts.setRateUnit(3600, { label: 'txn/h', transition: 300 });
  let units = unitsSince(built.canvas, mark);
  assert.ok(units.some(u => u.text === 'txn/min'), 'old unit gone immediately');
  assert.ok(units.some(u => u.text === 'txn/h'), 'new unit missing');
  // Outgoing starts opaque, incoming starts invisible.
  assert.ok(units.find(u => u.text === 'txn/min').alpha >
            units.find(u => u.text === 'txn/h').alpha, 'dissolve runs backwards');

  await sleep(160);
  mark = built.canvas.texts.length;
  built.ts.redraw();
  units = unitsSince(built.canvas, mark);
  const half = units.find(u => u.text === 'txn/h');
  assert.ok(half && half.alpha > 0.2 && half.alpha < 0.9, 'mid-dissolve alpha ' + (half && half.alpha));

  await sleep(300);
  mark = built.canvas.texts.length;
  built.ts.redraw();
  units = unitsSince(built.canvas, mark);
  assert.ok(!units.some(u => u.text === 'txn/min'), 'old unit never left');
  assert.equal(units.find(u => u.text === 'txn/h').alpha, 1);
});

test('the outgoing ticks keep their numbers and their pixels', async () => {
  // Per minute the axis reads 1; per hour the same bars read 60. The old "1"
  // has to stay printed where it was until it has faded out, or the swap reads
  // as the bars having jumped.
  const built = await build(true, makeRecordingCanvas);
  built.ts.setRateUnit(60, { label: 'txn/min' });
  await atFinePx(built, 1.5);
  const mark = built.canvas.texts.length;
  built.ts.setRateUnit(3600, { label: 'txn/h', transition: 300 });
  const drawn = built.canvas.texts.slice(mark).map(t => t.text);
  assert.ok(drawn.includes('1'), 'old tick value gone: ' + drawn.join(','));
  assert.ok(drawn.includes('60'), 'new tick value missing: ' + drawn.join(','));
});

test('switching the rate axis on or off snaps instead of dissolving', async () => {
  // The factor between raw values and a rate is per block (it depends on the
  // block's own interval), so there is no single ratio to hold the old ticks at.
  const built = await build(true, makeRecordingCanvas);
  built.ts.setRateUnit(60, { label: 'txn/min' });
  await atFinePx(built, 1.5);
  const mark = built.canvas.texts.length;
  built.ts.setRateUnit(null, { label: 'txn/bar', transition: 300 });
  const units = unitsSince(built.canvas, mark);
  assert.ok(units.every(u => u.text === 'txn/bar'), 'old unit lingered: ' +
            units.map(u => u.text).join(','));
});

test('a transition-less swap replaces the tick set outright', async () => {
  const built = await build(true, makeRecordingCanvas);
  built.ts.setRateUnit(60, { label: 'txn/min' });
  await atFinePx(built, 1.5);
  const mark = built.canvas.texts.length;
  built.ts.setRateUnit(3600, { label: 'txn/h' });
  const units = unitsSince(built.canvas, mark);
  assert.ok(units.length && units.every(u => u.text === 'txn/h'));
});

test('setRateUnit leaves the label alone unless given one', async () => {
  const built = await build(true, makeRecordingCanvas);
  built.ts.setYAxisLabel('txn/min');
  await atFinePx(built, 1.5);
  const mark = built.canvas.texts.length;
  built.ts.setRateUnit(60);
  assert.ok(unitsSince(built.canvas, mark).every(u => u.text === 'txn/min'));
});
