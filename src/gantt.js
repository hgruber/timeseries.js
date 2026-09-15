//////////////////////////////////////////////////////
// gantt.js                                         //
// span renderer: events as bars across real time   //
//////////////////////////////////////////////////////
//
// Unlike the binned renderers, a gantt plot draws each datum from its own
// start/end pair, so bar width tracks duration rather than a slot grid. Plots
// carry `category: 'span'`:
//
//   {
//     type: 'gantt', category: 'span',
//     tmin, tmax,                      // ms epoch — the window this block covers
//     layout: 'calendar' | 'packed',
//     appearance: 'bar',               // default glyph; 'bar' | 'arrow' | 'bracket' | 'line'
//     lanes: [{ id, label, color }],   // 'calendar' layout only
//     data: [{ id, lane, start, end, label, color, allDay, group, appearance, yPos }],
//   }
//
// `group` is optional: events sharing the same `group` value within one lane
// prefer to reuse the same packed row once one of them has claimed it (see
// pack() below), instead of falling wherever chronological first-fit happens
// to land. Without it, several short-lived events of what a consumer thinks
// of as "the same thing" (e.g. one flapping trigger firing many brief times)
// can end up scattered across rows purely because unrelated events on the
// same lane happened to occupy whichever row was free at each moment.
//
// `appearance` picks the glyph a span is drawn as: a solid 'bar' (default), a
// thin 'line' capped by vertical end ticks, an 'arrow' with heads on both
// ends, or a 'bracket' (arrows plus end ticks). It lives on the plot block
// and can be overridden per event.
//
// `yPos` pins an event *absolutely* inside the plot: 0 is the plot floor, 1
// the ceiling, regardless of any lane — and regardless of what any other
// block does to the shared value axis, which is the whole point of pinning
// (see `pinnedCenterY` for why that needs saying). Pinned events take no part
// in the row packing (nor in lane discovery — `lane` may be omitted entirely)
// and are stamped `_row = FLOAT_ROW` instead of a packed row; the user accepts
// that pinned events may overlap each other. Omitted `yPos` keeps the packing
// behaviour unchanged. Pinned events' vertical extent is shared with the hit
// test through `spanHitBand()`, so it cannot drift between draw and hover.
//
// layoutSpans() fills in `_row` (packed row, or FLOAT_ROW for pinned events)
// per event plus `laneCount` / `yticks`, which the y-axis and hit-testing in
// timeseries.js read.

import { registerRenderer, seriesColor } from './renderers.js';

// Fraction of a row's height left empty, split above and below the bar.
var ROW_GAP = 0.18;

// `_row` sentinel for events pinned with `yPos`: they hold no packed row, so
// the hit test routes them through spanHitBand() instead of the row band.
var FLOAT_ROW = -1;
export { FLOAT_ROW };

// Appearance glyphs. 'bar' keeps the drawn-so-far solid rounded bar; the
// other three draw a thin horizontal line at the row centre (or the pinned
// yPos), with the end decoration named by the value.
var APPEARANCES = ['bar', 'arrow', 'bracket', 'line'];

// Stroke width of a line-style span; matches the highlight stroke the bar
// path uses, so a line highlight does not read thicker than its idle ink.
var LINE_WIDTH = 1.5;

// Thin ink reads fainter than a bar at the bar's 0.8 alpha; a hairline at 0.8
// would all but disappear against the grid.
var LINE_ALPHA = 0.9;

// Arrowhead/tick sizing: fractions of one row's pixel height (ppv), with min
// and max caps so degenerate rows stay drawable. tickH is additionally capped
// at the bar thickness (ppv·(1−ROW_GAP)) so a bracket never outgrows a bar in
// the same lane.
//
// A *pinned* event sits in no lane, so neither base applies to it: its
// metrics come from `plotHeight` and the lane cap is dropped (see
// `pinnedCenterY`). With the same fractions and caps this lands on the MAX
// for any usable plot height, which is exactly the point — a pinned glyph
// keeps one size no matter what the value axis is doing.
var HEAD_LEN_FRAC = 0.22, HEAD_LEN_MIN = 4, HEAD_LEN_MAX = 10;
var HEAD_HALF_FRAC = 0.20, HEAD_HALF_MIN = 3, HEAD_HALF_MAX = 7;
var TICK_FRAC = 0.34, TICK_MIN = 6, TICK_MAX = 14;

// Greedy interval packing: walk events by start time and drop each into the
// first row whose last event has already ended. O(n·rows), and rows stays
// small for realistic calendars.
//
// `ev.group`, if set, keeps every event sharing that value in one row for the
// whole pack() call (one lane). A row a group has claimed is reserved for
// that group until its LAST event's end — its whole "season" — not just its
// most recent one, and a same-group event always reuses its row without a
// free-row check (occurrences of one group are assumed never to overlap each
// other, true for e.g. one Zabbix trigger, which can't be open twice at
// once). That season-long reservation is what makes this safe against
// interleaving: an early version of this only remembered each group's most
// recently used row and re-checked it was free, which meant a different,
// unrelated event landing between two occurrences of the same group could
// grab that row while it looked idle, permanently splitting the group across
// two rows from then on. Reserving the whole season up front means a
// foreign event can never wedge itself into a gap the group will need again.
function pack(events, baseRow) {
  var groupSeasonEnd = new Map();
  for (var ev of events) {
    if (ev.group == null) continue;
    var end = Math.max(ev.end, ev.start);
    var prev = groupSeasonEnd.get(ev.group);
    if (prev === undefined || end > prev) groupSeasonEnd.set(ev.group, end);
  }
  var rowBusyUntil = [];
  var groupRow = new Map();
  for (var e2 of events) {
    var row = -1;
    var key = e2.group;
    if (key != null && groupRow.has(key)) {
      row = groupRow.get(key);
    } else {
      for (var r = 0; r < rowBusyUntil.length; r++)
        if (rowBusyUntil[r] <= e2.start) { row = r; break; }
      if (row < 0) { row = rowBusyUntil.length; rowBusyUntil.push(0); }
    }
    // A zero-length event still occupies its row against the next one.
    rowBusyUntil[row] = key != null ? groupSeasonEnd.get(key) : Math.max(e2.end, e2.start);
    e2._row = baseRow + row;
    if (key != null) groupRow.set(key, row);
  }
  return rowBusyUntil.length;
}

/**
 * Assign rows to a span plot's events and derive its vertical extent.
 * Idempotent: re-running on an already-laid-out plot is a no-op, so both the
 * renderer and prepare_grid can call it freely. Sources that mutate `data` in
 * place should clear `plot._laidOut` to force a recompute.
 *
 * @param {object} plot a `category: 'span'` plot
 * @returns {object} the same plot, with `_row` / `laneCount` / `yticks` set
 */
export function layoutSpans(plot) {
  var layout = plot.layout === 'packed' ? 'packed' : 'calendar';
  if (plot._laidOut === layout) return plot;

  var events = plot.data || [];
  // Pack in chronological order; `data` order itself is left alone so indices
  // stay stable for hit-testing and highlight(). Events pinned with `yPos`
  // sit absolutely in the plot and hold no row, so they are kept out of the
  // packing — and out of lane discovery: `lane` may be omitted entirely.
  var byStart = events.slice().sort(function (a, b) { return a.start - b.start; });
  var rows = 0;
  var ticks = [];
  var bounds = [];

  // Stamp every event in this run up front: pack() only touches the events it
  // is handed, so a pinned event left unstamped here would carry a stale
  // packed row from a previous layout and be hit-tested as packed.
  for (var f of events) f._row = isFloat(f) ? FLOAT_ROW : undefined;

  if (layout === 'packed') {
    rows = pack(byStart.filter(function (ev) { return !isFloat(ev); }), 0);
  } else {
    // One contiguous block of rows per lane, in the declared lane order;
    // lanes referenced by events but absent from `lanes` are appended so no
    // event is silently dropped. Pinned events are skipped here: they sit
    // absolutely in the plot and need no lane.
    var lanes = (plot.lanes || []).slice();
    var known = {};
    for (var l of lanes) known[l.id] = true;
    for (var e of events)
      if (!isFloat(e) && !known[e.lane]) { known[e.lane] = true; lanes.push({ id: e.lane, label: String(e.lane) }); }

    for (var lane of lanes) {
      var mine = byStart.filter(function (ev) { return ev.lane === lane.id && !isFloat(ev); });
      var used = Math.max(1, pack(mine, rows));
      // Tick sits at the vertical centre of the lane's block, recorded as a
      // row offset and converted to a value once the total is known.
      ticks.push({ offset: rows + used / 2, label: lane.label != null ? lane.label : String(lane.id) });
      rows += used;
      bounds.push(rows);
    }
    plot.lanes = lanes;
  }

  plot.laneCount = Math.max(1, rows);
  plot.yticks = ticks.map(function (t) {
    return { y: plot.laneCount - t.offset, label: t.label };
  });
  // Row index of each lane boundary; the last entry is the plot edge, which
  // the frame already draws.
  plot.laneBounds = bounds.slice(0, -1);
  plot._laidOut = layout;
  return plot;
}

// Whether an event is pinned absolutely with `yPos`: only a finite number
// counts — a numeric string would silently mean something else.
function isFloat(ev) {
  return typeof ev.yPos === 'number' && isFinite(ev.yPos);
}

// Normalises `ev.appearance || plot.appearance` to one of APPEARANCES, so a
// typo'd value falls back to the bar glyph instead of a broken draw path.
function spanStyle(plot, ev) {
  var s = ev.appearance || plot.appearance;
  return APPEARANCES.indexOf(s) < 0 ? 'bar' : s;
}

// Centre line (canvas pixels) of an event pinned with `yPos`, clamped so a
// glyph of half-height `halfPx` stays inside the plot box.
//
// Measured against the plot's **pixel** box rather than through Y(), which is
// what makes `yPos` mean what its documentation says. Y() and ppv belong to
// the *shared* value axis, and that axis's ymax is a weighted blend over the
// active blocks (see the ymax_array merge in timeseries.js): a span block
// contributes its laneCount, a bar block its data maximum. Pinning through
// Y() therefore moved the event whenever a *neighbouring* plot's extent
// changed — zooming a chart that draws bars underneath a pinned bracket made
// the bracket wander and, through ppv, resize with it.
//
// Where the span block owns the axis alone (ymax = laneCount, ymin = 0) this
// is arithmetically the same expression as before:
//   Y(yPos·laneCount) = margin.top + (1 − yPos)·plotHeight
// so nothing about a span-only chart changes.
function pinnedCenterY(ev, margin, plotHeight, halfPx) {
  var cy = margin.top + (1 - ev.yPos) * plotHeight;
  return Math.min(Math.max(cy, margin.top + halfPx),
                  margin.top + plotHeight - halfPx);
}

// Glyph metrics for a line-style span. `base` is one row's height (ppv) for a
// packed event and the plot height for a pinned one; `lane` is false for
// pinned events, which have no lane thickness to be capped against.
function lineMetrics(base, w, lane) {
  var headLen = Math.min(Math.max(base * HEAD_LEN_FRAC, HEAD_LEN_MIN), HEAD_LEN_MAX);
  headLen = Math.min(headLen, Math.max(1, (w - 2) / 2));
  var headHalf = Math.min(Math.max(base * HEAD_HALF_FRAC, HEAD_HALF_MIN), HEAD_HALF_MAX);
  var tickH = Math.min(Math.max(base * TICK_FRAC, TICK_MIN), TICK_MAX);
  if (lane) tickH = Math.min(tickH, base * (1 - ROW_GAP));
  return { headLen: headLen, headHalf: headHalf, tickH: tickH };
}

/**
 * Pixel rect / glyph box for one event. Returns null when the event is
 * entirely off-screen. Shared by draw() and highlight() so both stay in
 * lockstep, and mirrored by the hit test in `get_element` (src/timeseries.js)
 * — exported so that correspondence can be asserted rather than assumed.
 * The hit test works in value space and, for packed events, ignores the
 * ROW_GAP gutter (whole row band), so it is deliberately the more forgiving
 * of the two; pinned (yPos) events are hit-tested through spanHitBand(),
 * which mirrors this rect's vertical extent exactly.
 */
export function barRect(plot, ev, rctx) {
  var { X, Y, ppv, margin, plotWidth, plotHeight } = rctx;
  var left = margin.left;
  var right = margin.left + plotWidth;
  var x0 = X(ev.start);
  var x1 = X(ev.end);
  if (x1 < left || x0 > right) return null;
  // Clamp so a multi-day event crossing the viewport still paints its visible
  // part, then enforce a minimum width so zero-length events stay clickable.
  var cx0 = Math.max(x0, left);
  var cx1 = Math.min(x1, right);
  var w = Math.max(cx1 - cx0, 2);
  if (cx0 + w > right) cx0 = Math.max(left, right - w);
  var style = spanStyle(plot, ev);
  var laneCount = plot.laneCount || 1;
  if (style === 'bar' && ev._row !== FLOAT_ROW) {
    var top = Y(laneCount - ev._row);
    var h = ppv;
    var gap = h * ROW_GAP / 2;
    return { x: cx0, y: top + gap, w: w, h: Math.max(h - 2 * gap, 1), clipped: x0 < left, style: 'bar' };
  }
  // Pinned bar: same thickness as a packed bar, but placed against the plot
  // box rather than the value axis — see pinnedCenterY.
  var pinned = ev._row === FLOAT_ROW;
  if (style === 'bar') {
    var barH = Math.max(ppv * (1 - ROW_GAP), 1);
    var cyb = pinnedCenterY(ev, margin, plotHeight, barH / 2);
    return { x: cx0, y: cyb - barH / 2, w: w, h: barH, clipped: x0 < left, style: 'bar' };
  }

  // Line glyphs (arrow / bracket / line): the rect is the glyph's bounding
  // box — highlight() redraws from the rect alone, so the metrics ride along.
  var m = lineMetrics(pinned ? plotHeight : ppv, w, !pinned);
  var ext = Math.max(m.headHalf, style === 'arrow' ? 0 : m.tickH / 2);
  var cy;
  if (pinned) {
    cy = pinnedCenterY(ev, margin, plotHeight, ext);
  } else {
    var yv = laneCount - ev._row - 0.5;
    var extV = ext / ppv;
    yv = Math.min(Math.max(yv, extV), laneCount - extV);
    cy = Y(yv);
  }
  return {
    x: cx0, y: cy - ext, w: w, h: 2 * ext, clipped: x0 < left,
    style: style, lineY: cy, headLen: m.headLen, headHalf: m.headHalf, tickH: m.tickH,
  };
}

function eventColor(plot, ev, alpha) {
  var color = ev.color;
  if (!color && plot.lanes)
    for (var l of plot.lanes) if (l.id === ev.lane && l.color) { color = l.color; break; }
  if (!color) return seriesColor(String(ev.lane == null ? 0 : ev.lane), alpha);
  if (color[0] === '#' && color.length === 7) {
    var a = Math.round(alpha * 255).toString(16);
    return color + (a.length < 2 ? '0' + a : a);
  }
  return color;
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y,     x + w, y + h, r);
  c.arcTo(x + w, y + h, x,     y + h, r);
  c.arcTo(x,     y + h, x,     y,     r);
  c.arcTo(x,     y,     x + w, y,     r);
  c.closePath();
}

// Labels are only worth drawing once the bar is wide enough to show more than
// an ellipsis, and tall enough for the glyphs to read.
var MIN_LABEL_WIDTH = 30;
var MIN_LABEL_HEIGHT = 9;

function drawLabel(c, ev, rect) {
  if (rect.w < MIN_LABEL_WIDTH || rect.h < MIN_LABEL_HEIGHT) return;
  var text = ev.label || '';
  if (!text) return;
  c.save();
  roundRect(c, rect.x, rect.y, rect.w, rect.h, 2);
  c.clip();
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(text, rect.x + 4, rect.y + rect.h / 2);
  c.restore();
}

// Draws one span glyph. 'bar' is the solid rounded bar; the line glyphs
// (arrow / bracket / line) draw a thin shaft with the end decoration named by
// the style, from the metrics barRect() carries on the rect. draw() and
// highlight() both come through here; `halo` is the highlight-only white
// under-pass that lets a hairline separate from the ink underneath it.
function drawSpan(c, plot, ev, rect, alpha, halo) {
  var col = halo ? 'rgba(255,255,255,0.9)' : eventColor(plot, ev, alpha);
  if (rect.style === 'bar') {
    if (halo) return;
    c.fillStyle = col;
    roundRect(c, rect.x, rect.y, rect.w, rect.h, 2);
    c.fill();
    return;
  }
  // Line glyphs. Shaft: arrows stop short of their heads; bracket/line shafts
  // run under the end ticks so no gap shows.
  var lineY = rect.lineY;
  var xR = rect.x + rect.w;
  var shaft0 = rect.style === 'arrow' ? rect.x + rect.headLen : rect.x;
  var shaft1 = rect.style === 'arrow' ? xR - rect.headLen : xR;
  if (halo) {
    c.strokeStyle = col;
    c.lineWidth = LINE_WIDTH + 2;
  } else {
    c.strokeStyle = col;
    c.lineWidth = LINE_WIDTH;
  }
  c.lineCap = 'butt';
  if (shaft1 > shaft0) {
    c.beginPath();
    c.moveTo(shaft0, lineY);
    c.lineTo(shaft1, lineY);
    c.stroke();
  }
  // Arrowheads ('arrow' and 'bracket'): filled triangles, apex outward.
  if (rect.style !== 'line' && !halo) {
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(rect.x, lineY);
    c.lineTo(rect.x + rect.headLen, lineY - rect.headHalf);
    c.lineTo(rect.x + rect.headLen, lineY + rect.headHalf);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(xR, lineY);
    c.lineTo(xR - rect.headLen, lineY - rect.headHalf);
    c.lineTo(xR - rect.headLen, lineY + rect.headHalf);
    c.closePath();
    c.fill();
  }
  // End ticks ('bracket' and 'line'), just inside the glyph box edges so the
  // clamped x range still contains the ink.
  if (rect.style !== 'arrow') {
    c.strokeStyle = col;
    c.beginPath();
    c.moveTo(rect.x + 0.5, lineY - rect.tickH / 2);
    c.lineTo(rect.x + 0.5, lineY + rect.tickH / 2);
    c.moveTo(xR - 0.5, lineY - rect.tickH / 2);
    c.lineTo(xR - 0.5, lineY + rect.tickH / 2);
    c.stroke();
  }
}

/**
 * Vertical hit band, in **canvas pixels**, for one span event. Returns null
 * for packed events, which keep the forgiving whole-row band derived from
 * `_row` in get_element; pinned (yPos) events get their band from here so it
 * mirrors barRect()'s vertical extent exactly. The yPos clamp is the one
 * piece of the geometry that is easy to get subtly wrong twice, so
 * get_element imports this instead of re-deriving it.
 *
 * Pixels, not lane values, because that is the space barRect() places a
 * pinned event in (see pinnedCenterY) — expressing the band in lane values
 * would mean converting back through the very axis the pinning escapes.
 * `geom` carries `{ margin, plotHeight, ppv }`.
 */
export function spanHitBand(plot, ev, geom) {
  if (ev._row !== FLOAT_ROW) return null;
  var half;
  if (spanStyle(plot, ev) === 'bar') {
    half = Math.max(geom.ppv * (1 - ROW_GAP), 1) / 2;
  } else {
    // Line glyphs are hairlines; give them a small tolerance band so they
    // stay hoverable, clamped inside the plot band.
    var m = lineMetrics(geom.plotHeight, Infinity, false);
    half = Math.min(Math.max(4, 2 * m.headHalf), 12);
  }
  var cy = pinnedCenterY(ev, geom.margin, geom.plotHeight, half);
  return { lo: cy - half, hi: cy + half };
}

// Reads the same base size the month/weekday axis labels use — xFont() in
// timeseries.js derives it from the canvas's own computed font-size; that
// function is marked a private closure, so this reads the computed style itself
// (the same "kept in step by hand" arrangement as barRect()/get_element()).
// Unlike xFont(), this does NOT scale down with the *canvas's* height: a
// Gantt row's own height is what actually bounds how big its label can be
// without overflowing, and that is usually unrelated to the canvas's overall
// height. Scaling with canvas height too (mirroring xFont() exactly) landed
// at essentially the same size bar labels already had, because typical
// Gantt heights and typical row heights both happen to move together —
// clamping to the row height directly is what makes labels reliably as
// large as the axis text instead of quietly staying small.
function labelFont(rctx) {
  var canvas = rctx.c && rctx.c.canvas;
  var base = 13;
  var family = 'sans-serif';
  if (canvas && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    var style = window.getComputedStyle(canvas);
    base = parseFloat(style.fontSize) || base;
    family = style.fontFamily || family;
  }
  var size = Math.min(base, Math.max(9, rctx.ppv - 4));
  return Math.round(size) + 'px ' + family;
}

function gantt(plot, rctx) {
  if (!plot.data || !plot.data.length) return;
  layoutSpans(plot);
  var { c, Y, margin, plotWidth } = rctx;
  c.save();
  c.font = labelFont(rctx);

  // Lane separators give the eye a baseline to track a row across the width;
  // in packed layout the rows carry no identity, so they are left out.
  if (plot._laidOut === 'calendar' && plot.laneBounds) {
    c.strokeStyle = 'rgba(128,128,128,0.25)';
    c.lineWidth = 1;
    for (var b of plot.laneBounds) {
      var y = Math.round(Y(plot.laneCount - b)) + 0.5;
      c.beginPath();
      c.moveTo(margin.left, y);
      c.lineTo(margin.left + plotWidth, y);
      c.stroke();
    }
  }

  for (var ev of plot.data) {
    var rect = barRect(plot, ev, rctx);
    if (!rect) continue;
    drawSpan(c, plot, ev, rect, rect.style === 'bar' ? 0.8 : LINE_ALPHA);
    if (rect.style === 'bar') drawLabel(c, ev, rect);
  }
  c.restore();
}

function highlight_gantt(plot, n, item, rctx) {
  var ev = plot.data && plot.data[n];
  if (!ev) return;
  var rect = barRect(plot, ev, rctx);
  if (!rect) return;
  var c = rctx.c;
  c.save();
  c.font = labelFont(rctx);
  if (rect.style === 'bar') {
    c.fillStyle = eventColor(plot, ev, 1);
    roundRect(c, rect.x, rect.y, rect.w, rect.h, 2);
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 1.5;
    c.stroke();
    drawLabel(c, ev, rect);
  } else {
    // Line glyphs: white halo pass, then the colour pass at full alpha; no
    // rounded-rect stroke — stroking a 2px-tall box reads as a smudge.
    drawSpan(c, plot, ev, rect, 1, true);
    drawSpan(c, plot, ev, rect, 1, false);
  }
  c.restore();
}

// `lanes` puts this type on the categorical y-axis (rows, labelled by name), and
// `layout` is how the axis gets `laneCount`/`yticks` before draw time.
// prepare_grid used to call layoutSpans directly off `category === 'span'`;
// declaring it here is what lets a *binned* renderer have a lane axis too.
registerRenderer({
  type: 'gantt',
  draw: gantt,
  highlight: highlight_gantt,
  lanes: true,
  layout: layoutSpans,
});

export default gantt;