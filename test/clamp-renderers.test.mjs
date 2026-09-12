// Outlier clamping ("Kappung") — the renderer side, as paint assertions.
//
// The ink policy is split by family:
//   • bars (multibar): the crossing segment clamps at the limit, the SHAFT
//     tops out CLAMP_HEAD (9) px below the plot edge (pixel-clamped, not
//     value-clamped), and the crossing series' arrowhead touches the edge
//     (apex at the edge, base CLAMP_HEAD px inward, at x + barWidth/2).
//   • the point family (scatter, multipoint) draws a clamped marker as the
//     arrow's shaft: CLAMP_HEAD + r px below the edge, apex at the edge.
//   • glyphs (error-bars, candlestick, ohlc) clamp at the limit via clampY: a
//     cut value sits at the shaft line; an arrow with apex at the edge marks it.
//   • the line/area family (multiline, stackarea, quantile-bands, quantile-
//     steps) draws through the TRUE values — a clamped vertex/band/ribbon
//     leaves the plot box upward — AND marks each clamped value with an
//     arrowhead at the x where its ink leaves the box: one per series and
//     direction, at least MIN_GAP (14 px) apart (greedy — a dense run
//     collapses to one at its entry). The ink part and the mark part are
//     asserted separately: the ink path is byte-identical to the unclamped
//     draw, the arrow ops come on top.
// Draws are deterministic (same input -> same recorded calls) and no draw here
// uses ctx.clip() — the recorder records it, so that is asserted rather than
// implied by "the draw did not throw".
//
// The recording context and the coordinate convention are the ones
// test/area-types.test.mjs introduced: X: 1px per second, interval 100 -> a
// 100px bin, so slot n starts at x = 100n and every expectation is readable
// arithmetic instead of a magic number. The clamped-axis context models the
// standard fixture's axis: bulk 30 -> limit 50 AT the plot edge, so on a 100px
// plot Y(v) = 100 - 2v (the bulk line at 20px from the top — the bulk at 0.8
// of the plot height — and the edge itself at value 50).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM } from './helpers/dom.mjs';

installDOM();

const { plotData, highlight, layoutPlot, CLAMP_HEAD_PX } =
  await import('../src/renderers.js');

// ── A recording 2D context ──────────────────────────────────────────────────
// Same reason as in ladder-types.test.mjs: the Proxy context in helpers/dom.mjs
// is a no-op and can report neither coordinates nor alphas.
function recorder() {
  const calls = [];
  const rec = (op, args) => calls.push({
    op, args,
    alpha: c.globalAlpha, fill: c.fillStyle, stroke: c.strokeStyle,
    lineWidth: c.lineWidth,
  });
  const c = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect: (...a) => rec('fillRect', a),
    strokeRect: (...a) => rec('strokeRect', a),
    moveTo: (...a) => rec('moveTo', a),
    lineTo: (...a) => rec('lineTo', a),
    fill: () => rec('fill', []),
    stroke: () => rec('stroke', []),
    arc: (...a) => rec('arc', a),
    beginPath() {}, closePath() {}, save() {}, restore() {},
    // Recorded so the no-clip invariant can be asserted rather than implied by
    // "the draw did not throw".
    clip: () => calls.push({ op: 'clip', args: [] }),
  };
  return { c, calls };
}

// The UNCLAMPED-axis context (the area-types convention): Y(v) = 100 - v.
// Used for the off-invariant paint test, where the arithmetic must be today's.
function rctxFor(c, hidden) {
  return {
    c,
    X: t => t / 1000,
    Y: v => 100 - v,
    ppms: 1 / 1000, ppv: 1,
    margin: { left: 0, top: 0, right: 0, bottom: 0 },
    plotWidth: 1000, plotHeight: 100,
    hidden: hidden || new Set(),
  };
}

// The CLAMPED-axis context for the standard fixture: limit 50 at the plot
// edge, bulk 40 -> Y(40) = 20, so the bulk sits at 0.8 of the plot height.
function rctxCl(c, hidden) {
  return {
    c,
    X: t => t / 1000,
    Y: v => 100 - 2 * v,
    ppms: 1 / 1000, ppv: 2,
    margin: { left: 0, top: 0, right: 0, bottom: 0 },
    plotWidth: 1000, plotHeight: 100,
    hidden: hidden || new Set(),
  };
}

const draw = (plot, rctx) => {
  const { c, calls } = recorder();
  plotData([0], [plot], rctx || rctxCl(c));
  return calls;
};

// The record prepare_grid stamps when the detection finds an outlier group:
// bulk 30 -> limit 50 = bulk / bulkFrac, the value AT the plot edge. Every
// fixture gets a fresh object so a mutating draw cannot couple two tests.
const clOf = () => ({ up: { bulk: 40, limit: 50 }, down: null });
const lineCl = () => ({ up: { bulk: 20, limit: 20 / 0.8 }, down: null });

const fillRects = calls => calls.filter(k => k.op === 'fillRect').map(k => k.args);
const path = calls => calls
  .filter(k => k.op === 'moveTo' || k.op === 'lineTo')
  .map(k => `${k.op} ${k.args[0]},${k.args[1]}`);
// The last index at which an op was recorded — the arrowhead and the hatch
// overlay are always drawn last within their family, after the data ink.
const lastOp = (calls, op) => {
  for (var i = calls.length - 1; i >= 0; i--) if (calls[i].op === op) return i;
  return -1;
};

// ── multibar ────────────────────────────────────────────────────────────────

const barPlot = extra => Object.assign({
  type: 'multibar', interval: 100, interval_start: 0,
  data: { 0: { a: 20, b: 20 }, 1: { a: 300, b: 20 } },
}, extra);

test('multibar: the shaft tops out at the head line and the arrowhead touches the edge',
     () => {
  const calls = draw(barPlot({ _clamped: clOf() }));
  // Slot 0 draws both segments whole (the shaft rule only moves a segment that
  // would reach the edge); slot 1: a is truncated — the shaft tops out at the
  // shaft line (y = 9) — and b, past the limit, is skipped entirely. No hatch:
  // the arrowhead alone marks the truncation.
  assert.deepEqual(fillRects(calls), [
    [0, 60, 100, 40],
    [0, 20, 100, 40],
    [100, 9, 100, 91],
  ]);
  // The shaft never reaches into the head: no bar fillRect above the shaft
  // line on the up side.
  for (const r of fillRects(calls)) {
    assert.ok(r[1] >= CLAMP_HEAD_PX, 'bar rect above the shaft line: ' + r);
  }
});

test('multibar: the arrowhead is drawn with its apex at the plot edge', () => {
  const calls = draw(barPlot({ _clamped: clOf() }));
  const iMark = lastOp(calls, 'fill');
  assert.ok(iMark > lastOp(calls, 'fillRect'),
            'the arrowhead is drawn after shaft and hatch');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 150,0', 'lineTo 144,9', 'lineTo 156,9',
  ]);
});

test('multibar: with no record the arithmetic is exactly the old one', () => {
  const rec = recorder();
  plotData([0], [barPlot()], rctxFor(rec.c));
  assert.deepEqual(fillRects(rec.calls), [
    [0, 100, 100, -20],
    [0, 80, 100, -20],
    [100, 100, 100, -300],
    [100, -200, 100, -20],
  ]);
});

// ── highlight_multibar ──────────────────────────────────────────────────────

test('highlight_multibar frames the bar as DRAWN: the outline tops at the shaft line',
     () => {
  const plot = barPlot({ _clamped: clOf() });
  const { c, calls } = recorder();
  highlight(plot, 1, 'a', rctxCl(c), 'outline');
  // a is truncated: the shaft tops at y = 9 and runs to Y(0) = 100, so the
  // outline frames exactly the drawn rect, 1px outside it.
  assert.deepEqual(calls.filter(k => k.op === 'strokeRect').map(k => k.args),
                   [[99, 8, 102, 93]]);
});

test('highlight_multibar returns without framing a series the clamp erased', () => {
  const plot = barPlot({ _clamped: clOf() });
  const { calls } = recorder();
  // b's head is past the limit: room = 0 → no ink → no outline.
  highlight(plot, 1, 'b', rctxCl(recorder().c), 'outline');
  assert.deepEqual(calls, []);
});

// ── stackarea ───────────────────────────────────────────────────────────────

const areaPlot = extra => Object.assign({
  type: 'stackarea', interval: 100, interval_start: 0,
  data: { 0: { a: 20, b: 20 }, 1: { a: 300, b: 20 } },
}, extra);

test('stackarea: the edges are the TRUE cumulative totals — the crossing band '
     + 'leaves the plot box and carries the arrow', () => {
  const calls = draw(areaPlot({ _clamped: clOf() }));
  assert.deepEqual(path(calls), [
    'moveTo 0,60', 'lineTo 100,-500',              // a: 20, 300 (true, unclamped)
    'lineTo 100,100', 'lineTo 0,100',              // a base
    'moveTo 0,20', 'lineTo 100,-540',              // b: 40, 320 (on a's true top)
    'lineTo 100,-500', 'lineTo 0,60',              // b base = a's true top
    // the crossing band a's arrowhead, drawn last, apex at the edge
    'moveTo 100,0', 'lineTo 94,9', 'lineTo 106,9',
  ]);
  assert.equal(calls.filter(k => k.op === 'fill').length, 3,
               'two band fills + the crossing band\'s mark');
  assert.deepEqual(fillRects(calls), [], 'no hatch for the line/area family');
});

// ── multiline ───────────────────────────────────────────────────────────────

const linePlot = extra => Object.assign({
  type: 'multiline', interval: 100, interval_start: 0,
  data: { 0: { a: 20 }, 1: { a: 300 }, 2: { a: 20 } },
}, extra);

test('multiline: the line runs through the TRUE values, the clamped vertex '
     + 'carries the arrow', () => {
  const calls = draw(linePlot({ _clamped: lineCl() }));
  assert.deepEqual(path(calls), [
    'moveTo 0,60', 'lineTo 100,-500', 'lineTo 200,60',
    // the arrowhead at the vertex where the ink leaves the box
    'moveTo 100,0', 'lineTo 94,9', 'lineTo 106,9',
  ]);
  assert.ok(lastOp(calls, 'fill') > -1, 'the mark is drawn');
  assert.deepEqual(fillRects(calls), [], 'no hatch');
});

test('multiline fill: the top edge follows the TRUE vertices, closing edge unchanged',
     () => {
  const calls = draw(linePlot({ fill: true, _clamped: lineCl() }));
  assert.deepEqual(path(calls), [
    // The fill's top edge through the true (out-of-box) vertices…
    'moveTo 0,60', 'lineTo 100,-500', 'lineTo 200,60',
    // …its closing edge is untouched by the clamp…
    'lineTo 200,100', 'lineTo 0,100',
    // …and the stroke runs through the true values again; the clamp mark's
    // ops come last, on top of everything.
    'moveTo 0,60', 'lineTo 100,-500', 'lineTo 200,60',
    'moveTo 100,0', 'lineTo 94,9', 'lineTo 106,9',
  ]);
});

// ── multipoint ──────────────────────────────────────────────────────────────

test('multipoint: a clamped marker is the arrow shaft, just below the arrowhead', () => {
  const plot = {
    type: 'multipoint', interval: 100, interval_start: 0,
    data: { 0: { a: 20 }, 1: { a: 300 } },
    _clamped: lineCl(),
  };
  const calls = draw(plot);
  // r = POINT_RADIUS.multipoint = 2. Slot 0 draws at its true position; slot 1
  // sits CLAMP_HEAD + r px below the edge, and the arrowhead touches the edge.
  assert.deepEqual(fillRects(calls), [
    [-2, 58, 4, 4],
    [98, 9, 4, 4],
  ]);
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 100,0', 'lineTo 94,9', 'lineTo 106,9',
  ]);
});

// ── scatter ─────────────────────────────────────────────────────────────────

test('scatter: a clamped circle is the arrow shaft, apex at the edge', () => {
  const plot = {
    type: 'scatter', category: 'point',
    tmin: 0, tmax: 1100000,
    data: [{ t: 0, values: { a: 20 } }, { t: 50000, values: { a: 300 } }],
    _clamped: lineCl(),
  };
  const calls = draw(plot);
  const arcs = calls.filter(k => k.op === 'arc').map(k => k.args);
  assert.deepEqual(arcs, [
    [0, 60, 3, 0, Math.PI * 2],
    [50, 12, 3, 0, Math.PI * 2],
  ]);
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 50,0', 'lineTo 44,9', 'lineTo 56,9',
  ]);
});

// ── quantile-bands ──────────────────────────────────────────────────────────

const ladPlot = extra => Object.assign({
  type: 'quantile-bands', interval: 100, interval_start: 0,
  percentiles: [5, 50, 95],
  data: { 0: { a: [10, 20, 30] }, 1: { a: [10, 20, 900] } },
}, extra);

test('quantile-bands: bands and lines draw the TRUE entries — nothing is flattened',
     () => {
  const calls = draw(ladPlot({ _clamped: clOf() }));
  // Slot centres at x = 50 and 150. The outermost band's bottom edge and the
  // topmost percentile line run through the true 900 → far above the box.
  assert.deepEqual(path(calls), [
    // band j=0: 10…20 on both slots, unchanged
    'moveTo 50,80', 'lineTo 150,80', 'lineTo 150,60', 'lineTo 50,60',
    // band j=1: 20…30, then 20…900 (true, out of the box)
    'moveTo 50,60', 'lineTo 150,60', 'lineTo 150,-1700', 'lineTo 50,40',
    // the three percentile polylines, topmost through the true entry
    'moveTo 50,80', 'lineTo 150,80',
    'moveTo 50,60', 'lineTo 150,60',
    'moveTo 50,40', 'lineTo 150,-1700',
    // the mark at the bin centre, where the ink leaves the box
    'moveTo 150,0', 'lineTo 144,9', 'lineTo 156,9',
  ]);
  assert.deepEqual(fillRects(calls), [], 'no hatch');
  assert.equal(calls.filter(k => k.op === 'fill').length, 3,
               'the two band fills + the mark at the bin centre');
});

// ── quantile-steps ──────────────────────────────────────────────────────────

const stepPlot = extra => Object.assign({
  type: 'quantile-steps', interval: 100, interval_start: 0,
  percentiles: [5, 50, 95],
  data: { 0: { a: [10, 20, 30] }, 1: { a: [10, 20, 900] } },
}, extra);

test('quantile-steps: ribbons and step lines draw the TRUE entries', () => {
  const calls = draw(stepPlot({ _clamped: clOf() }));
  // Bins: 0…100 and 100…200. The ribbon's bottom edge and the topmost
  // percentile staircase rise straight past the box edge.
  assert.deepEqual(path(calls), [
    // ribbon j=0: 10…20 across both bins
    'moveTo 0,80', 'lineTo 0,80', 'lineTo 100,80',
    'lineTo 100,80', 'lineTo 200,80',
    'lineTo 200,60', 'lineTo 100,60',
    'lineTo 100,60', 'lineTo 0,60',
    // ribbon j=1: 20…30, then 20…900 (true, out of the box)
    'moveTo 0,60', 'lineTo 0,60', 'lineTo 100,60',
    'lineTo 100,60', 'lineTo 200,60',
    'lineTo 200,-1700', 'lineTo 100,-1700',
    'lineTo 100,40', 'lineTo 0,40',
    // percentile lines: j=0 and the median j=1 unchanged, j=2 true
    'moveTo 0,80', 'lineTo 100,80', 'lineTo 100,80', 'lineTo 200,80',
    'moveTo 0,60', 'lineTo 100,60', 'lineTo 100,60', 'lineTo 200,60',
    'moveTo 0,40', 'lineTo 100,40', 'lineTo 100,-1700', 'lineTo 200,-1700',
    // the mark at the clamped bin's riser (x0 = 100, connect defaults on)
    'moveTo 100,0', 'lineTo 94,9', 'lineTo 106,9',
  ]);
  assert.deepEqual(fillRects(calls), []);
  assert.equal(calls.filter(k => k.op === 'fill').length, 3,
               'the two ribbon fills + the mark at the riser');
});

// ── error-bars ──────────────────────────────────────────────────────────────

const ebPlot = extra => Object.assign({
  type: 'error-bars', interval: 100, interval_start: 0,
  percentiles: [5, 50, 95],
  data: { 0: { a: [10, 20, 30] }, 1: { a: [10, 20, 900] } },
}, extra);

test('error-bars: the whisker tops at the shaft line via clampY, arrow at the edge',
     () => {
  const calls = draw(ebPlot({ _clamped: clOf() }));
  // Single series → no dodge: cx = 150. Slot 0's whisker runs from Y(10) = 80
  // to Y(30) = 40, unchanged; slot 1 runs to the shaft line (y = 9). Caps on
  // the outermost pair at both ends.
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(0, iMark - 3)), [
    'moveTo 50,80', 'lineTo 50,40',             // slot 0: 10…30, unchanged
    'moveTo 44,80', 'lineTo 56,80',
    'moveTo 44,40', 'lineTo 56,40',
    'moveTo 150,80', 'lineTo 150,9',            // slot 1: whisker, clamped
    'moveTo 144,80', 'lineTo 156,80',
    'moveTo 144,9', 'lineTo 156,9',             // upper cap at the shaft line
  ]);
  // The centre marker of both slots, and nothing else.
  assert.deepEqual(fillRects(calls), [
    [47, 57, 6, 6],                             // slot 0
    [147, 57, 6, 6],                            // slot 1
  ]);
  assert.ok(iMark > -1, 'the clamped cap carries the arrow');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 150,0', 'lineTo 144,9', 'lineTo 156,9',
  ]);
});

// ── candlestick ─────────────────────────────────────────────────────────────

const candlePlot = extra => Object.assign({
  type: 'candlestick', interval: 100, interval_start: 0,
  percentiles: [5, 25, 50, 75, 95],   // wick 0…4, body 1…3, tick 2
  data: { 0: { a: [10, 15, 20, 25, 30] }, 1: { a: [10, 15, 20, 25, 900] } },
}, extra);

test('candlestick: the wick tops at the shaft line, body and tick unchanged', () => {
  const calls = draw(candlePlot({ _clamped: clOf() }));
  // Slot 0 at cx = 50, slot 1 at cx = 150; body width 0.7 × 100 = 70. Both
  // bodies are 15…25, below the limit, so they draw unchanged.
  assert.deepEqual(fillRects(calls), [
    [15, 50, 70, 20],
    [115, 50, 70, 20],
  ]);
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(0, iMark - 3)), [
    'moveTo 50,80', 'lineTo 50,40',             // slot 0: wick 10…30
    'moveTo 15,60', 'lineTo 85,60',             // median tick, unchanged
    'moveTo 150,80', 'lineTo 150,9',            // slot 1: wick 10…900→shaft line
    'moveTo 115,60', 'lineTo 185,60',           // median tick, unchanged
  ]);
  assert.ok(iMark > -1, 'the clamped wick top carries the arrow');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 150,0', 'lineTo 144,9', 'lineTo 156,9',
  ]);
});

// ── ohlc ────────────────────────────────────────────────────────────────────

const ohlcPlot = extra => Object.assign({
  type: 'ohlc', interval: 100, interval_start: 0,
  percentiles: ['o', 'h', 'l', 'c'],
  roles: { open: 0, high: 1, low: 2, close: 3 },
  data: { 0: { a: [10, 20, 5, 15] }, 1: { a: [10, 800, 5, 15] } },
}, extra);

test('ohlc: the wick tops at the shaft line, open/close ticks unchanged', () => {
  const plot = ohlcPlot({ _clamped: clOf() });
  const calls = draw(plot);
  // Slot 0 draws the whole bar unchanged; slot 1: the wick reads low 5 →
  // high 800→shaft line, open 10 left, close 15 right (unchanged).
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(0, iMark - 3)), [
    'moveTo 50,90', 'lineTo 50,60',             // slot 0: low 5 → high 20
    'moveTo 15,80', 'lineTo 50,80',             // open ticked left
    'moveTo 50,70', 'lineTo 85,70',             // close ticked right
    'moveTo 150,90', 'lineTo 150,9',            // slot 1: low 5 → high 800→9
    'moveTo 115,80', 'lineTo 150,80',           // open ticked left
    'moveTo 150,70', 'lineTo 185,70',           // close ticked right
  ]);
  assert.ok(iMark > -1, 'the clamped wick top carries the arrow');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 150,0', 'lineTo 144,9', 'lineTo 156,9',
  ]);
});

// ── Exclusions, at paint level ──────────────────────────────────────────────

test('waterfall ignores a clamp record: identical paint with and without it', () => {
  const clamped = {
    type: 'waterfall', interval: 100, interval_start: 0,
    data: { 0: { a: 10 }, 1: { a: 5 }, 2: { a: -8 }, 3: { a: 1000 } },
    _clamped: clOf(),
  };
  const plain = Object.assign({}, clamped);
  delete plain._clamped;
  assert.deepEqual(draw(clamped), draw(plain));
});

test('heatmap ignores a clamp record: identical paint with and without it', () => {
  const mk = stamp => {
    const data = {};
    for (let i = 0; i < 4; i++) data[i] = { a: 10, b: 900 };
    const plot = {
      type: 'heatmap', interval: 100, interval_start: 0,
      data, min: 0, max: 900,
    };
    layoutPlot(plot);
    if (stamp) plot._clamped = clOf();
    return plot;
  };
  assert.deepEqual(draw(mk(true)), draw(mk(false)));
});

// ── coalescing ──────────────────────────────────────────────────────────────

// The record prepare_grid stamps on the member whose detection fired: the
// merged stack totals are [30, 30, 30, 320, 30], so bulk = 30 and the axis
// edge — which is what the limit is re-stamped with — is 30 / 0.8.
const coalCl = () => ({ up: { bulk: 30, limit: 30 / 0.8 }, down: null });

test('a coalesced clamping group still draws the TRUE band edges and the mark', () => {
  // Two abutting fetch blocks of one signal; the outlier in the newer one, so
  // that is the member prepare_grid stamps. The merged block INHERITS that
  // record — it does not re-derive one — so the merged draw carries the same
  // arrowhead a hand-merged block would: the crossing band's mark at the
  // outlier's x, on ink that stays TRUE either way.
  const b1 = {
    type: 'stackarea', name: 's', interval: 100, interval_start: 0,
    data: { 0: { a: 10, b: 20 }, 1: { a: 10, b: 20 }, 2: { a: 10, b: 20 } },
    clampOutliers: true,
  };
  const b2 = {
    type: 'stackarea', name: 's', interval: 100, interval_start: 300,
    data: { 0: { a: 300, b: 20 }, 1: { a: 10, b: 20 } },
    clampOutliers: true, _clamped: coalCl(),
  };
  const { c, calls } = recorder();
  const rctx = rctxCl(c);
  rctx.clamp = { on: true, factor: 3, share: 0.05, bulkFrac: 0.8 };
  plotData([0, 1], [b1, b2], rctx);
  // Merged slot 3 (x = 300) carries the outlier: band a rises to its true
  // 300 (Y = -500), band b to 320 (Y = -540) — nothing is flattened, and the
  // merged draw is identical to the same blocks without any clamp state.
  assert.ok(path(calls).includes('lineTo 300,-500'),
            'the true band edge, unflattened');
  assert.ok(path(calls).includes('lineTo 300,-540'),
            "band b rides on a's true top");
  // Exactly one mark: band a crosses the limit (lower 20 ≤ 37.5), band b rides
  // fully above it (lower 300 > 37.5) and is not marked.
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 300,0', 'lineTo 294,9', 'lineTo 306,9',
  ]);
  assert.deepEqual(fillRects(calls), [], 'no hatch');
});

test('a coalesced group draws identically to the same block merged by hand', () => {
  const b1 = {
    type: 'stackarea', name: 's', interval: 100, interval_start: 0,
    data: { 0: { a: 10, b: 20 }, 1: { a: 10, b: 20 }, 2: { a: 10, b: 20 } },
    clampOutliers: true,
  };
  const b2 = {
    type: 'stackarea', name: 's', interval: 100, interval_start: 300,
    data: { 0: { a: 300, b: 20 }, 1: { a: 10, b: 20 } },
    clampOutliers: true, _clamped: coalCl(),
  };
  // The merged block, stamped by hand with the record the merge inherits. The
  // merged draw must be byte-identical to the coalesced group's — the mark the
  // record implies is not a coalescing artifact, and the member that carries
  // no record of its own is drawn under the very same limit.
  const merged = {
    type: 'stackarea', name: 's', interval: 100, interval_start: 0,
    data: { 0: { a: 10, b: 20 }, 1: { a: 10, b: 20 }, 2: { a: 10, b: 20 },
            3: { a: 300, b: 20 }, 4: { a: 10, b: 20 } },
    clampOutliers: true,
    _clamped: { up: { bulk: 30, limit: 30 / 0.8 }, down: null },
  };
  const draw1 = () => {
    const { c, calls } = recorder();
    const rctx = rctxCl(c);
    rctx.clamp = { on: true, factor: 3, share: 0.05, bulkFrac: 0.8 };
    plotData([0, 1], [b1, b2], rctx);
    return calls;
  };
  const draw2 = () => {
    const { c, calls } = recorder();
    const rctx = rctxCl(c);
    rctx.clamp = { on: true, factor: 3, share: 0.05, bulkFrac: 0.8 };
    plotData([0], [merged], rctx);
    return calls;
  };
  assert.deepEqual(draw1(), draw2());
});

// ── the line family's marks ─────────────────────────────────────────────────

test('the ink is byte-identical to the unclamped draw — the marks come on top',
     () => {
  // For every line/area renderer: with the record stamped, the ink path is the
  // unclamped draw's path and nothing else — the arrow ops only append, so the
  // slope stays true AND the record decides the marks, never the ink.
  const plain = path(draw(linePlot()));
  assert.deepEqual(path(draw(linePlot({ _clamped: lineCl() }))).slice(0, plain.length),
                   plain);
  const aPlain = path(draw(areaPlot()));
  assert.deepEqual(path(draw(areaPlot({ _clamped: clOf() }))).slice(0, aPlain.length),
                   aPlain);
  const lPlain = path(draw(ladPlot()));
  assert.deepEqual(path(draw(ladPlot({ _clamped: clOf() }))).slice(0, lPlain.length),
                   lPlain);
  const sPlain = path(draw(stepPlot()));
  assert.deepEqual(path(draw(stepPlot({ _clamped: clOf() }))).slice(0, sPlain.length),
                   sPlain);
});

test('a dense run of clamped values collapses to one mark at its entry', () => {
  // interval 1 s → vertices 1 px apart: every slot is clamped, MIN_GAP (14 px)
  // suppresses everything after the first mark.
  const plot = {
    type: 'multiline', interval: 1, interval_start: 0,
    data: { 0: { a: 300 }, 1: { a: 300 }, 2: { a: 300 }, 3: { a: 300 },
            4: { a: 300 }, 5: { a: 300 }, 6: { a: 300 }, 7: { a: 300 },
            8: { a: 300 }, 9: { a: 300 } },
    _clamped: lineCl(),
  };
  const calls = draw(plot);
  assert.equal(calls.filter(k => k.op === 'fill').length, 1, 'one mark only');
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 0,0', 'lineTo -6,9', 'lineTo 6,9',
  ]);
});

test('sparse clamped values each get their mark, on the MIN_GAP grid', () => {
  // interval 10 s → vertices 10 px apart: 10 < 14 suppresses the second mark,
  // 20 ≥ 14 draws the third — marks at x = 0, 20, 40.
  const plot = {
    type: 'multiline', interval: 10, interval_start: 0,
    data: { 0: { a: 300 }, 1: { a: 300 }, 2: { a: 300 }, 3: { a: 300 },
            4: { a: 300 } },
    _clamped: lineCl(),
  };
  const calls = draw(plot);
  assert.deepEqual(path(calls), [
    // the line ink through all five true vertices…
    'moveTo 0,-500', 'lineTo 10,-500', 'lineTo 20,-500', 'lineTo 30,-500',
    'lineTo 40,-500',
    // …and marks at x = 0, 20, 40 (10 px after 0 is under MIN_GAP).
    'moveTo 0,0', 'lineTo -6,9', 'lineTo 6,9',
    'moveTo 20,0', 'lineTo 14,9', 'lineTo 26,9',
    'moveTo 40,0', 'lineTo 34,9', 'lineTo 46,9',
  ]);
});

test('the direction mirrors: a down-clamped value marks the bottom edge', () => {
  const plot = {
    type: 'multiline', interval: 100, interval_start: 0,
    data: { 0: { a: -20 }, 1: { a: -300 } },
    _clamped: { up: null, down: { bulk: 20, limit: 25 } },
  };
  const calls = draw(plot);
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 100,100', 'lineTo 94,91', 'lineTo 106,91',
  ]);
  assert.equal(calls.filter(k => k.op === 'fill').length, 1);
  assert.ok(path(calls).includes('lineTo 100,700'), 'the true value, unflattened');
});

test("step 'before' marks the previous vertex — where the riser stands", () => {
  const plot = linePlot({ step: 'before', _clamped: lineCl() });
  const calls = draw(plot);
  // The value 300 sits at slot 1; under 'before' its riser is at slot 0's x.
  const iMark = lastOp(calls, 'fill');
  assert.deepEqual(path(calls.slice(iMark - 3, iMark + 1)), [
    'moveTo 0,0', 'lineTo -6,9', 'lineTo 6,9',
  ]);
  assert.ok(path(calls).includes('lineTo 0,-500'),
            "the riser into 300 stands at slot 0's x");
});

test('a partial quantile-steps bin tests its SCALED value', () => {
  const plot = {
    type: 'quantile-steps', interval: 100, interval_start: 0,
    percentiles: [5, 50, 95],
    data: { 0: { a: [10, 20, 30] }, 1: { a: [10, 20, 60] } },
    _partial: { slot: 1, frac: 0.5, scale: 0.5, skip: false },
    _clamped: clOf(),
  };
  const calls = draw(plot);
  // The raw rung 60 clears the limit 50, but the bin draws 60 × 0.5 = 30 —
  // what the bin draws is what gets tested, so no mark.
  assert.equal(calls.filter(k => k.op === 'fill').length, 2,
               'no mark beyond the two ribbon fills');
});

test('a record without cuts paints byte-identically to no record', () => {
  // All values inside the clamp: the paint must be the unrecorded draw — this
  // is the off invariant for the marks, per family.
  const inside = { 0: { a: 20 }, 1: { a: 20 }, 2: { a: 20 } };
  assert.deepEqual(draw(linePlot({ data: inside, _clamped: lineCl() })),
                   draw(linePlot({ data: inside })));
  const ldata = { 0: { a: [10, 20, 30] }, 1: { a: [10, 20, 30] } };
  assert.deepEqual(draw(ladPlot({ data: ldata, _clamped: clOf() })),
                   draw(ladPlot({ data: ldata })));
});

test('every draw here is deterministic: same input, same recorded calls', () => {
  const plots = [
    barPlot({ _clamped: clOf() }),
    areaPlot({ _clamped: clOf() }),
    linePlot({ _clamped: lineCl() }),
    stepPlot({ _clamped: clOf() }),
    ladPlot({ _clamped: clOf() }),
    candlePlot({ _clamped: clOf() }),
  ];
  for (const plot of plots) assert.deepEqual(draw(plot), draw(plot));
});

test('no draw here uses ctx.clip()', () => {
  const plots = [
    barPlot({ _clamped: clOf() }),
    areaPlot({ _clamped: clOf() }),
    linePlot({ _clamped: lineCl() }),
    linePlot({ fill: true, _clamped: lineCl() }),
    { type: 'multipoint', interval: 100, interval_start: 0,
      data: { 0: { a: 10 }, 1: { a: 300 } }, _clamped: lineCl() },
    { type: 'scatter', category: 'point', tmin: 0, tmax: 1100000,
      data: [{ t: 0, values: { a: 10 } }, { t: 50000, values: { a: 300 } }],
      _clamped: lineCl() },
    ladPlot({ _clamped: clOf() }),
    stepPlot({ _clamped: clOf() }),
    ebPlot({ _clamped: clOf() }),
    candlePlot({ _clamped: clOf() }),
    ohlcPlot({ _clamped: clOf() }),
    {
      type: 'waterfall', interval: 100, interval_start: 0,
      data: { 0: { a: 10 }, 1: { a: 5 }, 2: { a: -8 }, 3: { a: 1000 } },
    },
  ];
  for (const plot of plots) {
    const rec = recorder();
    draw(plot, rctxCl(rec.c));
    assert.ok(!rec.calls.some(k => k.op === 'clip'), plot.type + ' used ctx.clip()');
  }
});
