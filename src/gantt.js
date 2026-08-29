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
//     lanes: [{ id, label, color }],   // 'calendar' layout only
//     data: [{ id, lane, start, end, label, color, allDay, group }],
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
// layoutSpans() fills in `_row` per event plus `laneCount` / `yticks`, which
// the y-axis and hit-testing in timeseries.js read.

import { registerRenderer, seriesColor } from './renderers.js';

// Fraction of a row's height left empty, split above and below the bar.
var ROW_GAP = 0.18;

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
  // stay stable for hit-testing and highlight().
  var byStart = events.slice().sort(function (a, b) { return a.start - b.start; });
  var rows = 0;
  var ticks = [];
  var bounds = [];

  if (layout === 'packed') {
    rows = pack(byStart, 0);
  } else {
    // One contiguous block of rows per lane, in the declared lane order;
    // lanes referenced by events but absent from `lanes` are appended so no
    // event is silently dropped.
    var lanes = (plot.lanes || []).slice();
    var known = {};
    for (var l of lanes) known[l.id] = true;
    for (var e of events)
      if (!known[e.lane]) { known[e.lane] = true; lanes.push({ id: e.lane, label: String(e.lane) }); }

    for (var lane of lanes) {
      var mine = byStart.filter(function (ev) { return ev.lane === lane.id; });
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

/**
 * Pixel rect for one event. Returns null when the bar is entirely off-screen.
 * Shared by draw() and highlight() so both stay in lockstep, and mirrored by
 * the hit test in `get_element` (src/timeseries.js) — exported so that
 * correspondence can be asserted rather than assumed. The hit test works in
 * value space and ignores the ROW_GAP gutter, so it is deliberately the more
 * forgiving of the two.
 */
export function barRect(plot, ev, rctx) {
  var { X, Y, ppv, margin, plotWidth } = rctx;
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
  var top = Y(plot.laneCount - ev._row);
  var h = ppv;
  var gap = h * ROW_GAP / 2;
  return { x: cx0, y: top + gap, w: w, h: Math.max(h - 2 * gap, 1), clipped: x0 < left };
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

// Reads the same base size the month/weekday axis labels use — xFont() in
// timeseries.js derives it from the canvas's own computed font-size; that
// function is a private closure, so this reads the computed style itself
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
    c.fillStyle = eventColor(plot, ev, 0.8);
    roundRect(c, rect.x, rect.y, rect.w, rect.h, 2);
    c.fill();
    drawLabel(c, ev, rect);
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
  c.fillStyle = eventColor(plot, ev, 1);
  roundRect(c, rect.x, rect.y, rect.w, rect.h, 2);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.9)';
  c.lineWidth = 1.5;
  c.stroke();
  drawLabel(c, ev, rect);
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
