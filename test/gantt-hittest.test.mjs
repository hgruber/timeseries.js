// Confirms gantt.js's barRect() (what gets drawn) agrees with timeseries.js's
// get_element() (what gets hit-tested on click/hover) — the two are hand-kept
// in sync rather than sharing code, so this is the most likely place for a
// real bug to hide. Runs against a real TimeSeries instance under a DOM
// stub, driving the actual canvas.onmousemove handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDOM, makeCanvas, setView, makeRctx } from './helpers/dom.mjs';

installDOM();

const { default: TimeSeries } = await import('../src/timeseries.js');
const { registerSource } = await import('../src/sources.js');
const { barRect, layoutSpans } = await import('../src/gantt.js');

const H = 3600000;
const T0 = Date.UTC(2026, 0, 5, 8);
const mk = (id, lane, h0, h1) => ({ id, lane, start: T0 + h0 * H, end: T0 + h1 * H, label: id });

let nextId = 0;

// Builds a real TimeSeries instance wired to a span plot, plus the stub
// canvas it attached to (so tests can dispatch synthetic mouse events).
function buildInstance(spanPlot) {
  const canvasId = 'gantt-test-' + (nextId++);
  const canvas = makeCanvas(canvasId);
  const sourceType = 'test-span-' + canvasId;
  registerSource({ type: sourceType, init(_s, cb) { cb.pushData(spanPlot); cb.requestRedraw(); } });
  const ts = new TimeSeries({
    canvas: canvasId,
    sources: [{ 'source-type': sourceType }],
    initialView: null,
  });
  return { ts, canvas };
}

function freshPlot() {
  const events = [
    mk('a1', 'A', 0, 4), mk('a2', 'A', 1, 5), mk('a3', 'A', 2, 6),
    mk('b1', 'B', 0, 2), mk('b2', 'B', 3, 5),
  ];
  return {
    type: 'gantt', category: 'span', layout: 'calendar',
    tmin: T0, tmax: T0 + 12 * H,
    lanes: [{ id: 'A', label: 'Lane A' }, { id: 'B', label: 'Lane B' }],
    data: events,
  };
}

test('prepare_grid assigns rows before draw is ever called', async () => {
  const plot = freshPlot();
  const { ts } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  assert.ok(plot.data.every(e => typeof e._row === 'number'));
});

test('the centre of every drawn bar hits that same event', async () => {
  const plot = freshPlot();
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);

  let hovered;   // reset per iteration below
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });

  const rctx = makeRctx(ts, plot.laneCount);
  for (const ev of plot.data) {
    const rect = barRect(plot, ev, rctx);
    assert.ok(rect, `barRect returned null for ${ev.id}`);
    hovered = null;
    canvas.onmousemove({ clientX: rect.x + rect.w / 2, clientY: rect.y + rect.h / 2 });
    assert.equal(hovered && hovered.id, ev.id, `centre of ${ev.id}'s bar should hit ${ev.id}`);
  }
});

test('bar width tracks duration, not a fixed slot width', async () => {
  const plot = freshPlot();
  const { ts } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  const rctx = makeRctx(ts, plot.laneCount);
  const a1 = plot.data.find(e => e.id === 'a1'); // 4-hour event
  const rect = barRect(plot, a1, rctx);
  const expected = 4 * H * (rctx.plotWidth / (T0 + 12 * H - T0));
  assert.ok(Math.abs(rect.w - expected) < 1);
});

test('bars in different rows never overlap vertically', async () => {
  const plot = freshPlot();
  const { ts } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  const rctx = makeRctx(ts, plot.laneCount);
  const rects = plot.data.map(e => ({ ev: e, rect: barRect(plot, e, rctx) }));
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      if (rects[i].ev._row === rects[j].ev._row) continue;
      const a = rects[i].rect, b = rects[j].rect;
      const overlap = a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `rows ${rects[i].ev._row} and ${rects[j].ev._row} overlap`);
    }
});

test('empty space past the last event hits nothing', async () => {
  const plot = freshPlot();
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  let hovered = 'unset';
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  const area = ts.getPlotArea();
  const rctx = makeRctx(ts, plot.laneCount);
  const r1 = barRect(plot, plot.data[0], rctx);
  canvas.onmousemove({ clientX: area.margin.left + area.plotWidth - 2, clientY: r1.y + r1.h / 2 });
  assert.equal(hovered, null);
});

test('a zero-length event still gets a minimum-width, hoverable bar', async () => {
  const plot = freshPlot();
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  const zero = mk('z1', 'B', 8, 8);
  plot.data.push(zero);
  plot._laidOut = null;
  layoutSpans(plot);
  ts.redraw();

  const rctx = makeRctx(ts, plot.laneCount);
  const rect = barRect(plot, zero, rctx);
  assert.equal(rect.w, 2);

  let hovered = null;
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  canvas.onmousemove({ clientX: rect.x + 1, clientY: rect.y + rect.h / 2 });
  assert.equal(hovered && hovered.id, 'z1');
});

test('an event entirely outside the viewport yields no rect', async () => {
  const plot = freshPlot();
  const { ts } = buildInstance(plot);
  await setView(ts, T0 + 20 * H, T0 + 30 * H);
  const rctx = makeRctx(ts, plot.laneCount);
  const a1 = plot.data.find(e => e.id === 'a1');
  assert.equal(barRect(plot, a1, rctx), null);
});

test('an event clipped by the left edge still renders its visible part', async () => {
  const plot = freshPlot();
  const { ts } = buildInstance(plot);
  await setView(ts, T0 + 2 * H, T0 + 8 * H); // a1 (0-4h) starts before this window
  const rctx = makeRctx(ts, plot.laneCount);
  const a1 = plot.data.find(e => e.id === 'a1');
  const rect = barRect(plot, a1, rctx);
  assert.ok(rect.w > 0);
  assert.ok(rect.x >= rctx.margin.left);
  assert.equal(rect.clipped, true);
});

// ── `yPos` + appearance: pinned events and line glyphs ───────────────────────

const pmk = (id, lane, h0, h1, yPos) => Object.assign(mk(id, lane, h0, h1), { yPos });

test('the centre of a pinned bar hits its own event', async () => {
  const plot = freshPlot();
  plot.data.push(pmk('pin1', 'A', 5, 7, 0.5), pmk('pin2', 'B', 0, 2, 0.8));
  plot._laidOut = null;
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  let hovered;
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  const rctx = makeRctx(ts, plot.laneCount);
  for (const ev of plot.data.filter(e => e.yPos != null)) {
    const rect = barRect(plot, ev, rctx);
    assert.ok(rect, `barRect returned null for ${ev.id}`);
    hovered = null;
    canvas.onmousemove({ clientX: rect.x + rect.w / 2, clientY: rect.y + rect.h / 2 });
    assert.equal(hovered && hovered.id, ev.id, `centre of ${ev.id}'s pinned bar should hit ${ev.id}`);
  }
});

test('two overlapping pinned events: the later data index wins', async () => {
  const plot = freshPlot();
  plot.data.push(pmk('p1', 'A', 0, 6, 0.5), pmk('p2', 'A', 2, 8, 0.5));
  plot._laidOut = null;
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  let hovered;
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  const rctx = makeRctx(ts, plot.laneCount);
  const r = barRect(plot, plot.data.find(e => e.id === 'p2'), rctx);
  // p1 and p2 overlap in time and height; the later data index (p2) wins,
  // matching the draw order.
  canvas.onmousemove({ clientX: r.x + r.w / 2, clientY: r.y + r.h / 2 });
  assert.equal(hovered && hovered.id, 'p2');
});

test('a clamped pinned event is hit inside the plot and missed outside it', async () => {
  const plot = freshPlot();
  plot.data.push(pmk('p1', 'A', 5, 7, 1.2));   // clamped into the plot top
  plot._laidOut = null;
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  let hovered;
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  const rctx = makeRctx(ts, plot.laneCount);
  const ev = plot.data[plot.data.length - 1];
  const rect = barRect(plot, ev, rctx);
  const area = ts.getPlotArea();
  canvas.onmousemove({ clientX: rect.x + rect.w / 2, clientY: rect.y + rect.h / 2 });
  assert.equal(hovered && hovered.id, 'p1', 'clamped bar centre should hit');
  // Above the plot top nothing is hittable, not even for a pinned event.
  canvas.onmousemove({ clientX: rect.x + rect.w / 2, clientY: area.margin.top - 1 });
  assert.equal(hovered, null);
});

test('line glyphs on packed events: thin box, row band still forgiving', async () => {
  const plot = freshPlot();
  plot.data.push(
    Object.assign(mk('arw', 'B', 6, 8), { appearance: 'arrow' }),
    Object.assign(mk('brk', 'B', 6, 8), { appearance: 'bracket' }),
    Object.assign(mk('lin', 'B', 6, 8), { appearance: 'line' }),
  );
  plot._laidOut = null;
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  let hovered;
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  const rctx = makeRctx(ts, plot.laneCount);
  for (const ev of plot.data.filter(e => e.appearance)) {
    const r = barRect(plot, ev, rctx);
    assert.ok(r, `barRect returns null for ${ev.id}`);
    assert.ok(r.h < 0.5 * rctx.ppv, 'glyph box should be thin');
    hovered = null;
    canvas.onmousemove({ clientX: r.x + r.w / 2, clientY: r.lineY });
    assert.equal(hovered && hovered.id, ev.id, `row centre of ${ev.id} should hit ${ev.id}`);
    hovered = null;
    // A packed event is hittable anywhere in its whole row band, even where
    // only the forgiving hit band — not the thin glyph — covers the pointer.
    canvas.onmousemove({ clientX: r.x + r.w / 2, clientY: r.lineY + 0.45 * rctx.ppv });
    assert.equal(hovered && hovered.id, ev.id, 'whole-row band stays forgiving');
  }
});

test('a pinned line glyph is hit through its tolerance band, not the whole lane', async () => {
  const plot = freshPlot();
  plot.data.push(Object.assign(mk('dep', 'B', 8, 10), { yPos: 0.35, appearance: 'arrow' }));
  plot._laidOut = null;
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  let hovered;
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  const rctx = makeRctx(ts, plot.laneCount);
  const ev = plot.data[plot.data.length - 1];
  const r = barRect(plot, ev, rctx);
  canvas.onmousemove({ clientX: r.x + r.w / 2, clientY: r.lineY });
  assert.equal(hovered && hovered.id, 'dep', 'the line itself should hit');
  // Half a row away is outside the tolerance band (≤12px) at this ppv.
  canvas.onmousemove({ clientX: r.x + r.w / 2, clientY: r.lineY + 0.5 * rctx.ppv });
  assert.equal(hovered, null);
});

test('a pinned bar is not hittable outside its own band (no whole-lane forgiveness)', async () => {
  const plot = freshPlot();
  plot.data.push(pmk('p1', 'A', 5, 7, 0.85));
  plot._laidOut = null;
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  let hovered;
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  const rctx = makeRctx(ts, plot.laneCount);
  const ev = plot.data[plot.data.length - 1];
  const r = barRect(plot, ev, rctx);
  // Inside the drawn rect: hit. Just above it (same lane): miss — pinned
  // events do not inherit the packed path's whole-row-band forgiveness.
  canvas.onmousemove({ clientX: r.x + r.w / 2, clientY: r.y + r.h / 2 });
  assert.equal(hovered && hovered.id, 'p1', 'drawn centre should hit');
  canvas.onmousemove({ clientX: r.x + r.w / 2, clientY: r.y - 3 });
  assert.equal(hovered, null, 'pinned events must not be hittable outside their drawn rect');
});

// The regression this whole pinning rework exists for. `yPos` promises a place
// that does not move; before pinnedCenterY() it was resolved through Y(), and
// Y() belongs to the axis every *other* block votes on too. A gap bracket
// drawn over a bar chart therefore wandered and resized whenever the bars'
// maximum changed — which is on every zoom. Same plot, same viewport here;
// only the axis differs between the two rctx.
test('a pinned glyph keeps its place and size when a neighbour moves the axis', async () => {
  const plot = freshPlot();
  plot.data.push(Object.assign(mk('gap', 'B', 3, 6), { yPos: 0.382, appearance: 'bracket' }));
  plot._laidOut = null;
  const { ts, canvas } = buildInstance(plot);
  await setView(ts, T0, T0 + 12 * H);
  const ev = plot.data[plot.data.length - 1];

  const lane = makeRctx(ts, plot.laneCount);   // span block owns the axis
  const tall = makeRctx(ts, 1271);             // a bar block's data maximum wins
  const a = barRect(plot, ev, lane);
  const b = barRect(plot, ev, tall);

  assert.equal(b.lineY, a.lineY, 'pinned centre must not move with the axis');
  assert.equal(b.h, a.h, 'glyph box must not resize with the axis');
  assert.equal(b.headLen, a.headLen);
  assert.equal(b.headHalf, a.headHalf);
  assert.equal(b.tickH, a.tickH);

  // And it lands where the pin says: 0.382 of the plot height up from the floor.
  const area = ts.getPlotArea();
  const want = area.margin.top + (1 - 0.382) * area.plotHeight;
  assert.ok(Math.abs(a.lineY - want) < 0.5, `pinned at ${a.lineY}, expected ${want}`);

  // Draw and hit test share pinnedCenterY, so the hover still finds it.
  let hovered = null;
  ts.onHoverDataCallback((_p, _n, _key, value) => { hovered = value; });
  canvas.onmousemove({ clientX: b.x + b.w / 2, clientY: b.lineY });
  assert.equal(hovered && hovered.id, 'gap', 'pinned bracket must stay hoverable');
});
