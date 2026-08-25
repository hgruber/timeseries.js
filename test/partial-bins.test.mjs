// Partial bins (setPartialBins / plot.data_until): a block's data may only
// reach so far — an ETL high-water mark, a source still catching up — and the
// bin holding that point is only partly covered. Drawn at full width it is both
// too short (it holds a fraction of a bin's worth) and too long (it reaches into
// a future that holds no data at all). 'clip' puts its right edge on the mark;
// 'scale' additionally divides the height by the filled fraction, so the bar's
// area still equals the value and its density matches the full bins beside it.
//
// Five layers are exercised:
//   1. the renderer draws the narrow, scaled bar and keeps the stack intact;
//   2. prepare_grid resolves mode × extensive × threshold into `_partial`;
//   3. the extent measures the bar that is actually painted;
//   4. the hit test stops at data_until — bars no longer tile their bin;
//   5. 'full', the default, is a byte-for-byte no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { plotData } = await import('../src/renderers.js');

// ── 1. the renderer, driven by a hand-stamped _partial ───────────────────────
//
// The renderer knows only that field, so these need no instance at all.

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

// interval 60 with ppms 1/1000 makes a full bar 60px wide.
const FULL_W = 60;

function block(data, partial, extra) {
  const p = { type: 'multibar', interval: 60, interval_start: 0, data };
  if (partial) p._partial = partial;
  return Object.assign(p, extra || {});
}

test('a partial bin is drawn narrower and taller, in proportion', () => {
  const { c, calls } = recorder();
  plotData([0], [block({ 2: { a: 10 } }, { slot: 2, frac: 0.25, scale: 4, skip: false })],
           rctxFor(c));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[2], FULL_W * 0.25);   // width
  assert.equal(calls[0].args[3], -40);             // height: ppv * 10 / 0.25
});

test('the area a partial bar covers equals the area of a full one', () => {
  const full = recorder();
  plotData([0], [block({ 2: { a: 10 } })], rctxFor(full.c));
  const ref = Math.abs(full.calls[0].args[2] * full.calls[0].args[3]);

  for (const frac of [0.5, 0.25, 0.1]) {
    const { c, calls } = recorder();
    plotData([0], [block({ 2: { a: 10 } },
                         { slot: 2, frac, scale: 1 / frac, skip: false })], rctxFor(c));
    const area = Math.abs(calls[0].args[2] * calls[0].args[3]);
    assert.ok(Math.abs(area - ref) < 1e-9, 'frac ' + frac + ' → ' + area);
  }
});

test('only the right edge moves — the bar keeps its left edge', () => {
  for (const frac of [1, 0.5, 0.1]) {
    const { c, calls } = recorder();
    const part = frac === 1 ? null : { slot: 2, frac, scale: 1 / frac, skip: false };
    plotData([0], [block({ 2: { a: 10 } }, part)], rctxFor(c));
    assert.equal(calls[0].args[0], 120);           // X(2 * 60_000) = 120
  }
});

test('a stacked segment still sits on the one below it', () => {
  const { c, calls } = recorder();
  plotData([0], [block({ 2: { a: 4, b: 6 } }, { slot: 2, frac: 0.5, scale: 2, skip: false })],
           rctxFor(c));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[3], -8);              // 4 * 2
  assert.equal(calls[1].args[1], 100 - 8);         // second starts where the first ends
  assert.equal(calls[1].args[3], -12);             // 6 * 2
  assert.equal(calls[1].args[2], FULL_W * 0.5);    // and is just as narrow
});

test('a down-stacked series mirrors correctly in a partial bin', () => {
  const { c, calls } = recorder();
  plotData([0], [block({ 2: { a: 4, b: 6 } },
                       { slot: 2, frac: 0.5, scale: 2, skip: false },
                       { series_directions: { b: 'down' } })], rctxFor(c));
  const down = calls[1];
  assert.equal(down.args[1], 100);                 // Y(-0), baseline
  assert.equal(down.args[3], 12);                  // positive height = downward
  assert.equal(down.args[2], FULL_W * 0.5);
});

test('a bin below the fill threshold is not drawn at all', () => {
  const { c, calls } = recorder();
  plotData([0], [block({ 1: { a: 5 }, 2: { a: 10 } },
                       { slot: 2, frac: 0.03, scale: 0, skip: true })], rctxFor(c));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 60);              // only slot 1 survived
});

test('without _partial the geometry is byte-for-byte what it always was', () => {
  const data = { 0: { a: 3 }, 1: { a: 7, b: 2 }, 2: { a: 10 } };
  const a = recorder();
  plotData([0], [block(data)], rctxFor(a.c));
  const b = recorder();
  plotData([0], [block(data, null)], rctxFor(b.c));
  assert.deepEqual(a.calls, b.calls);
  // and every bar is full width
  for (const k of a.calls) assert.equal(k.args[2], FULL_W);
});

test('_partial only touches its own slot', () => {
  const { c, calls } = recorder();
  plotData([0], [block({ 2: { a: 10 }, 3: { a: 10 } },
                       { slot: 2, frac: 0.5, scale: 2, skip: false })], rctxFor(c));
  const [narrow, wide] = calls;
  assert.equal(narrow.args[2], FULL_W * 0.5);
  assert.equal(narrow.args[3], -20);
  assert.equal(wide.args[2], FULL_W);
  assert.equal(wide.args[3], -10);
});

test('_partial.scale and _vscale compose, neither applied twice', () => {
  const { c, calls } = recorder();
  plotData([0], [block({ 2: { a: 10 } },
                       { slot: 2, frac: 0.25, scale: 4, skip: false },
                       { _vscale: 0.5 })], rctxFor(c));
  assert.equal(calls[0].args[3], -20);             // 10 * 4 * 0.5
  assert.equal(calls[0].args[2], FULL_W * 0.25);   // width untouched by _vscale
});

test('a hidden series occupies no stack height in a partial bin either', () => {
  const { c, calls } = recorder();
  const rctx = rctxFor(c);
  rctx.hidden = new Set(['a']);
  plotData([0], [block({ 2: { a: 4, b: 6 } }, { slot: 2, frac: 0.5, scale: 2, skip: false })],
           rctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], 100);             // b sits on the axis, not on a
  assert.equal(calls[0].args[3], -12);
});

// ── 2-5. mode resolution, extent and hit test, on a real instance ────────────

const START_S = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const IV = 60;
const SLOTS = 240;                                  // 4 hours of 60s bins
const SPAN_MS = SLOTS * IV * 1000;

// The last bin is `lastValue`; every other bin is `value`.
function source(opts) {
  const o = opts || {};
  const data = {};
  for (let i = 0; i < SLOTS; i++) data[i] = { a: o.value != null ? o.value : 30 };
  if (o.lastValue != null) data[SLOTS - 1] = { a: o.lastValue };
  const p = {
    'source-type': 'artificial', type: 'multibar', name: 'm',
    interval: IV, interval_start: START_S, data, min: 0, max: 1000,
  };
  if (o.extensive) p.extensive = true;
  if (o.dataUntil !== undefined) p.data_until = o.dataUntil;
  return p;
}

// data_until placed `frac` of the way into the final bin.
const untilFrac = frac => START_S + (SLOTS - 1) * IV + IV * frac;

let nextId = 0;
async function build(opts) {
  const id = 'partial-' + (nextId++);
  const canvas = makeCanvas(id);
  const ts = new TimeSeries({
    canvas: id,
    sources: [source(opts)],
    initialView: null,
    ...(opts && opts.mode ? { partialBins: opts.mode } : {}),
  });
  await setView(ts, START_S * 1000, START_S * 1000 + SPAN_MS);
  return { ts, canvas };
}

const stamp = ts => ts.getActiveData()[0]._partial;

test('the default is "full" and stamps nothing', async () => {
  const { ts } = await build({ extensive: true, dataUntil: untilFrac(0.25) });
  assert.equal(ts.getPartialBins(), 'full');
  assert.equal(stamp(ts), null);
});

test('"scale" resolves slot, fraction and factor', async () => {
  const { ts } = await build({ extensive: true, dataUntil: untilFrac(0.25) });
  ts.setPartialBins('scale');
  const p = stamp(ts);
  assert.equal(p.slot, SLOTS - 1);
  assert.ok(Math.abs(p.frac - 0.25) < 1e-12, 'frac ' + p.frac);
  assert.ok(Math.abs(p.scale - 4) < 1e-12, 'scale ' + p.scale);
  assert.equal(p.skip, false);
});

test('"clip" narrows the bar but never scales it', async () => {
  const { ts } = await build({ extensive: true, dataUntil: untilFrac(0.25) });
  ts.setPartialBins('clip');
  const p = stamp(ts);
  assert.ok(Math.abs(p.frac - 0.25) < 1e-12);
  assert.equal(p.scale, 1);
});

test('an intensive block clips but is never extrapolated', async () => {
  // No `extensive`: an average over a short window is already the right number,
  // and dividing it by the fill fraction would invent a spike.
  const { ts } = await build({ dataUntil: untilFrac(0.25) });
  ts.setPartialBins('scale');
  const p = stamp(ts);
  assert.ok(Math.abs(p.frac - 0.25) < 1e-12);
  assert.equal(p.scale, 1);
});

test('the extent measures the scaled bar', async () => {
  const { ts } = await build({ extensive: true, value: 30, lastValue: 10,
                               dataUntil: untilFrac(0.25) });
  assert.equal(ts.getValueRange().ymax, 30);       // 'full': the neighbours win
  ts.setPartialBins('scale');
  assert.equal(ts.getValueRange().ymax, 40);       // 10 / 0.25 now tops them
});

test('a bin below the threshold is left out of the extent', async () => {
  // 0.05 < PARTIAL_MIN_FRAC. Area-true it would be 10/0.05 = 200; skipped, the
  // full neighbours at 30 set the axis. They also keep the `|| plot.max`
  // fallback from firing.
  const { ts } = await build({ extensive: true, value: 30, lastValue: 10,
                               dataUntil: untilFrac(0.05) });
  ts.setPartialBins('scale');
  const p = stamp(ts);
  assert.equal(p.skip, true);
  assert.equal(ts.getValueRange().ymax, 30);
});

test('the area-true factor is also the rate-correct one', async () => {
  // A bin filled to `frac` holding `frac * V` is the same rate as a full bin
  // holding V, so under a rate unit it must reach exactly the same height.
  const frac = 0.5, V = 30;
  const { ts } = await build({ extensive: true, value: V, lastValue: frac * V,
                               dataUntil: untilFrac(frac) });
  ts.setRateUnit(IV);
  ts.setPartialBins('scale');
  const r = ts.getValueRange();
  assert.ok(Math.abs(r.ymax - V) < 1e-9, 'ymax ' + r.ymax + ' should stay at ' + V);
});

test('a stale data_until, not on the last populated bin, is inert', async () => {
  const { ts } = await build({ extensive: true, dataUntil: untilFrac(0.25) - 10 * IV });
  ts.setPartialBins('scale');
  assert.equal(stamp(ts), null);
});

test('a data_until exactly on a bin boundary is not partial', async () => {
  const { ts } = await build({ extensive: true, dataUntil: START_S + SLOTS * IV });
  ts.setPartialBins('scale');
  assert.equal(stamp(ts), null);
});

test('nonsense in data_until is ignored rather than thrown on', async () => {
  for (const bad of [START_S - 1e6, NaN, 'x', null]) {
    const { ts } = await build({ extensive: true, dataUntil: bad });
    ts.setPartialBins('scale');
    assert.equal(stamp(ts), null, 'accepted ' + String(bad));
  }
});

test('setPartialBins refuses an unknown mode and keeps the current one', async () => {
  const { ts } = await build({ extensive: true, dataUntil: untilFrac(0.25) });
  ts.setPartialBins('scale');
  for (const bad of ['bogus', '', null, true, 1]) {
    ts.setPartialBins(bad);
    assert.equal(ts.getPartialBins(), 'scale', 'accepted ' + String(bad));
  }
});

test('going back to "full" clears the stamp', async () => {
  const { ts } = await build({ extensive: true, dataUntil: untilFrac(0.25) });
  ts.setPartialBins('scale');
  assert.ok(stamp(ts));
  ts.setPartialBins('full');
  assert.equal(stamp(ts), null);
});

// ── the hit test: bars no longer tile their bin ──────────────────────────────
//
// The final bin spans the right edge of the view, so its left quarter is inside
// the drawn bar and its right part is the emptied strip.

async function hoverAt(built, fracOfBin) {
  const area = built.ts.getPlotArea();
  const t = (START_S + (SLOTS - 1) * IV + IV * fracOfBin) * 1000;
  const x = area.margin.left + area.plotWidth * ((t - START_S * 1000) / SPAN_MS);
  // A miss notifies with (null, null, null, null) rather than staying silent,
  // so "nothing hovered" is a null plot, not an absent call.
  let got = null;
  built.ts.onHoverDataCallback((plot, n, key, value) => {
    got = plot ? { n, key, value } : null;
  });
  built.canvas.onmousemove({
    clientX: x,
    clientY: area.margin.top + area.plotHeight - 2,
  });
  return got;
}

test('the hit test still finds the bar left of data_until, and reports it raw', async () => {
  const built = await build({ extensive: true, value: 30, lastValue: 10,
                              dataUntil: untilFrac(0.5) });
  built.ts.setPartialBins('scale');
  const got = await hoverAt(built, 0.2);
  assert.ok(got, 'nothing hovered inside the drawn bar');
  assert.equal(got.n, SLOTS - 1);
  assert.equal(got.key, 'a');
  assert.equal(got.value, 10);        // the amount in the bin, not 10/0.5
});

test('nothing is hittable right of data_until — that strip is empty', async () => {
  const built = await build({ extensive: true, value: 30, lastValue: 10,
                              dataUntil: untilFrac(0.5) });
  built.ts.setPartialBins('scale');
  const got = await hoverAt(built, 0.8);
  assert.equal(got, null, 'hit a bar that was never drawn');
});

test('under "full" that same strip is still hittable', async () => {
  const built = await build({ extensive: true, value: 30, lastValue: 10,
                              dataUntil: untilFrac(0.5) });
  const got = await hoverAt(built, 0.8);
  assert.ok(got, 'the pre-0.9.1 behaviour changed');
  assert.equal(got.n, SLOTS - 1);
});

test('a skipped bin is not hittable anywhere', async () => {
  const built = await build({ extensive: true, value: 30, lastValue: 10,
                              dataUntil: untilFrac(0.05) });
  built.ts.setPartialBins('scale');
  for (const f of [0.01, 0.03, 0.5]) {
    assert.equal(await hoverAt(built, f), null, 'hit at ' + f);
  }
});
