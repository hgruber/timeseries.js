//////////////////////////////////////////////////////
// timeseries.js                                    //
// yet another visualization library for timeseries //
// but this one is different, see the demo          //
//////////////////////////////////////////////////////
// settings                                         //
//////////////////////////////////////////////////////
// Only getWeek is used here; the interval-arithmetic helpers in intervals.js
// are a standalone utility module, imported by consumers directly.
import { getWeek } from './intervals.js';
import { plotData as _plotData, highlight as _highlight, registerRenderer, seriesColor,
         plotSeriesIds, resolveColor, POINT_RADIUS } from './renderers.js';
import { initSources, registerSource } from './sources.js';
import { layoutSpans } from './gantt.js';
import { lttb } from './lttb.js';
import { attachTooltip } from './tooltip.js';
import { VERSION } from './version.js';

// ── Viewport group registry ───────────────────────────────────────────────────
// Maps group name → Set of handles, one per instance.
// Each handle: { setViewport, getViewport, stopFollow, startFollowAsTick,
//               startFollowNoTick, getCanvasWidth }
var _groups = new Map();

// Per-group follow state: name → { active, fraction, leader }
var _groupFollowState = new Map();

function _groupJoin(name, handle) {
  if (!_groups.has(name)) _groups.set(name, new Set());
  _groups.get(name).add(handle);
}

function _groupLeave(name, handle) {
  var g = _groups.get(name);
  if (!g) return;
  g.delete(handle);
  if (g.size === 0) { _groups.delete(name); _groupFollowState.delete(name); }
}

function _groupBroadcast(name, t1, t2, sender) {
  var g = _groups.get(name);
  if (!g) return;
  for (var h of g) {
    if (h !== sender) h.setViewport(t1, t2);
  }
}

function _groupStopFollow(name, sender) {
  var fs = _groupFollowState.get(name);
  if (fs) { fs.active = false; fs.leader = null; }
  var g = _groups.get(name);
  if (!g) return;
  for (var h of g) {
    if (h !== sender) h.stopFollow();
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Pure date helpers ─────────────────────────────────────────────────────────
// Neither touches instance state, so they live at module scope (one copy for all
// instances) and are exported to be testable on their own.

// Gauss's Easter algorithm. Returns Easter Sunday as "D.M" (1-based month),
// which is the key format isHoliday() compares against.
export function Easter(Y) {
  var C = Math.floor(Y / 100);
  var N = Y - 19 * Math.floor(Y / 19);
  var K = Math.floor((C - 17) / 25);
  var I = C - Math.floor(C / 4) - Math.floor((C - K) / 3) + 19 * N + 15;
  I = I - 30 * Math.floor(I / 30);
  I =
    I -
    Math.floor(I / 28) *
      (1 -
        Math.floor(I / 28) *
          Math.floor(29 / (I + 1)) *
          Math.floor((21 - N) / 11));
  var J = Y + Math.floor(Y / 4) + I + 2 - C + Math.floor(C / 4);
  J = J - 7 * Math.floor(J / 7);
  var L = I - J;
  var M = 3 + Math.floor((L + 40) / 44);
  var D = L + 28 - 31 * Math.floor(M / 4);
  return D + "." + M;
}

// Local-time Date for the Monday of ISO week `week` in `year`.
export function isoWeekStart(year, week) {
  var jan4 = new Date(year, 0, 4);
  var dayOfWeek = (jan4.getDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(year, 0, 4 - dayOfWeek + (week - 1) * 7);
}

// ── Default palette ───────────────────────────────────────────────────────────
// Single source of truth: the constructor's `settings.colors` starts as a copy
// of this, and TimeSeries.themes.light *is* this object. Editing either used to
// mean editing both by hand.
var DEFAULT_COLORS = {
  frameBg:     '#f0f6ff',                    // margin / axis area background
  text:        '#1a2e45',                    // all text and plot border
  plotBg:      '#ffffff',                    // plot area background
  gridLine:    'rgba(100,100,100,0.35)',      // vertical time grid lines
  gridLineY:   'rgba(150,150,150,0.55)',      // horizontal y-axis lines
  weekNumber:  '#999999',                    // week-number label
  nowLine:     'rgba(210,0,0,0.65)',          // the now indicator line
  future:      'rgba(150,150,150,0.28)',      // fog-of-future overlay
  stripMs:     ['rgba(235,235,235,0.55)', 'rgba(190,190,190,0.55)'],
  stripSecond: ['rgba(255,255,215,0.55)', 'rgba(255,255,165,0.55)'],
  stripMinute: ['rgba(215,255,215,0.55)', 'rgba(165,240,165,0.55)'],
  stripHour:   ['rgba(215,215,255,0.55)', 'rgba(165,165,240,0.55)'],
  dayDefault:  'rgba(190,190,190,0.45)',      // regular weekday stripe
  dayWeekend:  'rgba(255,155,155,0.50)',      // weekend / holiday stripe
  dayOdd:      'rgba(215,215,215,0.42)',      // alternate weekday stripe
  yearOdd:     'rgba(255,255,255,0.40)',      // alternating year stripes
  yearEven:    'rgba(232,232,232,0.40)',
  monthOdd:    'rgba(85,148,200,0.48)',       // alternating month stripes
  monthEven:   'rgba(232,232,232,0.42)',
  // Consumed only by the optional tooltip overlay (src/tooltip.js), not by the
  // canvas. Kept in the palette so a theme switch restyles chart and overlay
  // through the one existing ts.setColors() call.
  tooltipBg:     'rgba(255,255,255,0.92)',
  tooltipBorder: '#ccc',
  tooltipShadow: 'rgba(0,0,0,0.15)',
  tooltipText:   '#222',
  tooltipTitle:  '#555',
  tooltipMuted:  '#888',
};

// Default y-axis formatter: SI prefixes (k/M/G/T).
export function siFormat(v) {
  if (v === 0) return "0";
  var abs = Math.abs(v);
  if (abs >= 1e12)  return (v / 1e12).toFixed(1).replace(/\.0$/, '')  + 'T';
  if (abs >= 1e9)   return (v / 1e9).toFixed(1).replace(/\.0$/, '')   + 'G';
  if (abs >= 1e6)   return (v / 1e6).toFixed(1).replace(/\.0$/, '')   + 'M';
  if (abs >= 1e3)   return (v / 1e3).toFixed(1).replace(/\.0$/, '')   + 'k';
  return String(v);
}

// ── Pan snapping ──────────────────────────────────────────────────────────────
// Used by ts.pan(): both viewport edges snap to the nearest local-time calendar
// boundary for the most meaningful unit at the current zoom level.
// panFloor/panAdd use local Date methods and are therefore DST-correct. panDiff
// counts day/week steps from a fixed-ms division, which is off by up to an hour
// across a DST change — Math.round absorbs that, so the step count still comes
// out right (see test/pan.test.mjs).

// Shared by panSnapUnit's calendar-boundary detection and panSnapEdge's
// boundary rounding: how close (as a fraction of the unit's actual length)
// a viewport edge must be to a calendar boundary to snap to it.
export var PAN_TOLERANCE = 0.05;

export function panSnapUnit(tmin, tmax) {
  var span = tmax - tmin;
  var s = 1000, m = 60000, h = 3600000, d = 86400000;
  var YEAR_AVG = 365.25 * d, MONTH_AVG = YEAR_AVG / 12;

  // Months/years have variable real length (28-31d, 365-366d), so a fixed-ms
  // threshold alone can never tell "this 30-day span is April" from "this
  // 30-day span is just a long week-ish view" — only checking against the
  // actual calendar anchored at tmin can. Checked largest-first so an exact
  // multi-year span wins over an incidental multi-month match.
  if (calendarUnitMatches(tmin, span, 'year', YEAR_AVG))   return 'year';
  if (calendarUnitMatches(tmin, span, 'month', MONTH_AVG)) return 'month';

  if (span <  90 * s) return 'second';
  if (span <  90 * m) return 'minute';
  if (span <  36 * h) {
    // A viewport already sitting on local-midnight boundaries at both edges
    // is a calendar-day view (or a short run of them) even when its real
    // duration isn't exactly 24h — the day either side of a DST transition
    // is 23h or 25h. 'hour' would then step it via panAdd's Date#setHours
    // field arithmetic, which only rolls to the next day when the hour
    // count overflows past 23; a DST day's real hour count (23) doesn't,
    // so the boundary silently sticks 1h off local midnight. 'day' steps
    // via Date#setDate instead, which is calendar-safe (see panAdd tests).
    // A non-midnight-aligned rolling window (e.g. last24()) still falls
    // through to 'hour' below, unaffected.
    if (panFloor(tmin, 'day') === tmin && panFloor(tmax, 'day') === tmax) return 'day';
    return 'hour';
  }
  if (span <  14 * d) return 'day';
  if (span <  60 * d) return 'week';
  return 'month';  // multi-month span that isn't calendar-aligned within tolerance
}

// n is estimated from the average unit length rather than panDiff(unit),
// because panDiff('year'/'month') is a raw calendar-field difference
// (getFullYear()/getMonth() only) — it doesn't know whether an anniversary
// has actually elapsed, so it's inconsistent with panAdd for an arbitrary
// (non-boundary-aligned) tmin. Rounding by average length and then verifying
// the *actual* panAdd-derived span avoids that mismatch.
function calendarUnitMatches(tmin, span, unit, avgLen) {
  var n = Math.round(span / avgLen);
  if (n < 1) return false;
  var unitSpan = panAdd(tmin, unit, n) - tmin;
  return Math.abs(span - unitSpan) <= PAN_TOLERANCE * unitSpan;
}

export function panFloor(ms, unit) {
  var d = new Date(ms);
  if      (unit === 'year')   { d.setMonth(0, 1);  d.setHours(0, 0, 0, 0); }
  else if (unit === 'month')  { d.setDate(1);       d.setHours(0, 0, 0, 0); }
  else if (unit === 'week')   { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); }
  else if (unit === 'day')    { d.setHours(0, 0, 0, 0); }
  else if (unit === 'hour')   { d.setMinutes(0, 0, 0); }
  else if (unit === 'minute') { d.setSeconds(0, 0); }
  else                        { d.setMilliseconds(0); }  // second
  return d.getTime();
}

export function panAdd(ms, unit, n) {
  var d = new Date(ms);
  if      (unit === 'year')   d.setFullYear(d.getFullYear() + n);
  else if (unit === 'month')  d.setMonth(d.getMonth() + n);
  else if (unit === 'week')   d.setDate(d.getDate() + n * 7);
  else if (unit === 'day')    d.setDate(d.getDate() + n);
  else if (unit === 'hour')   d.setHours(d.getHours() + n);
  else if (unit === 'minute') d.setMinutes(d.getMinutes() + n);
  else                        d.setSeconds(d.getSeconds() + n);
  return d.getTime();
}

export function panDiff(lo, hi, unit) {
  if (unit === 'second') return Math.round((hi - lo) / 1000);
  if (unit === 'minute') return Math.round((hi - lo) / 60000);
  if (unit === 'hour')   return Math.round((hi - lo) / 3600000);
  if (unit === 'day')    return Math.round((hi - lo) / 86400000);
  if (unit === 'week')   return Math.round((hi - lo) / 604800000);
  var a = new Date(lo), b = new Date(hi);
  if (unit === 'month')
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  return b.getFullYear() - a.getFullYear();
}

// Rounds one viewport edge to the nearest boundary of `unit` if it's within
// PAN_TOLERANCE of one, otherwise falls back to the historical behaviour
// (floor when roundUpIfAmbiguous is false, ceil when true) — so this only
// changes anything for edges that sit close to, but not exactly on, a
// calendar boundary; an already-aligned edge is untouched.
export function panSnapEdge(ms, unit, roundUpIfAmbiguous) {
  var lo = panFloor(ms, unit);
  if (lo === ms) return lo;
  var hi = panAdd(lo, unit, 1);
  var unitLen = hi - lo;
  if ((ms - lo) <= PAN_TOLERANCE * unitLen) return lo;
  if ((hi - ms) <= PAN_TOLERANCE * unitLen) return hi;
  return roundUpIfAmbiguous ? hi : lo;
}

export default function TimeSeries(options) {
  var settings = {
    canvas: "timeseries",
    sources: [], // array of data sources
    initialView: 'last24', // method to call on startup, or null
    zoomDuration: 500,     // animation duration in ms for zoom transitions
    zoomFactor: 0.1,       // wheel-zoom sensitivity (smaller = smoother)
    autoFollow: false,     // automatically enter follow mode when now reaches right edge
    keyboard: true,        // arrow-key navigation; also makes the canvas focusable
    yAxisFormat: null,     // (value) → string; defaults to SI-prefixed (k/M/G/T)
    yAxisLabel: '',        // unit text shown above y-axis, e.g. "txn/s"
    // Copied so that a per-instance override never writes through to the shared
    // DEFAULT_COLORS object.
    colors: Object.assign({}, DEFAULT_COLORS),
    // Keys are strings, always quoted. Two forms:
    //   "D.M"  — fixed date, 1-based month, no leading zeros ("3.10" = 3 October)
    //   "+N"/"-N" — N days relative to Easter Sunday ("-2" = Good Friday)
    // Quoting matters: an unquoted 1.10 is the *number* 1.1 and would silently
    // become New Year's Day. Replace this object wholesale to use another
    // country's holidays — unlike `colors`, it is not merged with the defaults.
    holidays: {
      "1.1":  "Neujahr",
      "1.5":  "Maifeiertag",
      "-2":   "Karfreitag",
      "+0":   "Ostersonntag",
      "+1":   "Ostermontag",
      "+39":  "Himmelfahrt",
      "+49":  "Pfingstsonntag",
      "+50":  "Pfingstmontag",
      "+60":  "Fronleichnam",
      "3.10": "Tag der Einheit",
      "24.12": "Heilig Abend",
      "25.12": "1. Weihnachtstag",
      "26.12": "2. Weihnachtstag",
      "31.12": "Silvester",
    },
    watermark: null,          // URL string or HTMLImageElement drawn behind all chart content
    watermarkWidth: 0.63,    // fraction of plot width
    watermarkAlpha: 0.2,     // opacity (0 = invisible, 1 = opaque)
  };
  if (options) {
    for (const [key, value] of Object.entries(options)) {
      // `colors` is a palette where every key must stay defined — a partial
      // override would leave the rest undefined and reach the canvas as an
      // invalid fillStyle, so merge it key-by-key (same as setColors() does).
      // `holidays` is deliberately NOT merged: it is a list, and replacing it
      // wholesale is how a caller swaps the German defaults for another set.
      if (key === 'colors' && value && typeof value === 'object')
        Object.assign(settings.colors, value);
      else
        settings[key] = value;
    }
  }
  var canvas = document.getElementById(settings.canvas);
  if (canvas._tsInstance) {
    console.warn('TimeSeries: canvas "' + settings.canvas + '" already has an instance');
    return;
  }
  canvas._tsInstance = this;
  var c = canvas.getContext("2d");
  var holidays = settings.holidays;

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  // clientX/clientY are viewport-relative, so mapping them to canvas
  // coordinates needs the canvas's *current* position. Scrolling moves the
  // canvas without resizing it, so the ResizeObserver never fires — refresh
  // this at the start of every pointer handler instead of trusting a cache.
  var offset = { x: 0, y: 0 };
  function refreshOffset() {
    var r = canvas.getBoundingClientRect();
    offset.x = r.left;
    offset.y = r.top;
  }
  refreshOffset();
  var style = window.getComputedStyle(canvas);
  var _baseFontSize = parseFloat(style.fontSize) || 13;
  var _fontL = style.font;
  var _fontM = style.font.replace(/[\d.]+px/, Math.round(_baseFontSize * 0.80) + 'px');
  var _fontS = style.font.replace(/[\d.]+px/, Math.round(_baseFontSize * 0.65) + 'px');
  // x-axis font driven by canvas height; y-axis font driven by canvas width
  function xFont() { return canvas.height >= 300 ? _fontL : canvas.height >= 150 ? _fontM : _fontS; }
  function yFont() { return canvas.width  >= 600 ? _fontL : canvas.width  >= 300 ? _fontM : _fontS; }
  c.font = xFont();
  var fm = c.measureText("22:22");
  var font_height = 1.4 * fm.actualBoundingBoxAscent + 4;
  var font_width  = fm.width;
  // The rotated time labels are drawn 4px *below* the plot edge (see drawAxis) and run
  // downwards from there, so margin.bottom must reserve font_width plus that offset —
  // keep this in sync with the literal 4 in drawAxis; the extra 2px is breathing room.
  var LABEL_GAP = 6;

  // Read the canvas container's CSS padding to use as the outer whitespace.
  // Set padding on .canvas-wrap in CSS to control the space around the chart.
  function readContainerPad() {
    var cs = window.getComputedStyle(canvas.parentElement || canvas);
    return {
      top:    parseFloat(cs.paddingTop)    || 0,
      right:  parseFloat(cs.paddingRight)  || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left:   parseFloat(cs.paddingLeft)   || 0,
    };
  }
  var basePad = readContainerPad();

  var margin = {
    top:    2 * font_height + basePad.top,    // 2 label rows + css padding
    right:  basePad.right,                    // css padding only
    bottom: font_width + LABEL_GAP + basePad.bottom,  // time labels + css padding (animated)
    left:   basePad.left,                    // y-axis + css padding (set by prepare_grid)
  };

  var startDragX = 0,
    startTmin,
    startTmax,
    pendingClickItem = null;
  var nls = "default";
  var plotWidth = canvas.width - margin.left - margin.right;
  var plotHeight = canvas.height - margin.top - margin.bottom;
  var now = Date.now();
  var follow_timers = 0;
  var follow_stopped = false;
  var follow_fraction = 1.0;   // 0 = now at left edge, 1 = now at right edge
  var follow_stop_cb = null;
  var follow_start_cb = null;
  var nowline_timer = null;    // periodic redraw to keep now-line moving when not following
  var tmax = now;
  var tmin = tmax - 86400000;
  var ymin = 0;
  var ymax = 1;
  var zf = settings.zoomFactor;
  var ppms = plotWidth / (tmax - tmin); // pixels per millisecond
  var mspp = 1 / ppms; // milliseconds per pixels
  var ppv = plotHeight / (ymax - ymin); // pixels per value
  var vpp = 1 / ppv; // values per pixel
  var data = [];
  var viewportChangeHandlers = [];
  var viewportChangePending = null;
  var activePlot;
  // Series ids the user has switched off, e.g. via a legend. Instance-wide
  // rather than per-plot: an id identifies the same measurement in every block
  // a source pushes, and hiding it in one block but not the next would flicker
  // as blocks scroll in and out. Handed to renderers through rctx.hidden and
  // honoured by the y-axis extent, so hiding a tall series rescales the axis.
  var hiddenSeries = new Set();
  var seriesChangeHandlers = [];
  function notifySeriesChange() {
    for (const f of seriesChangeHandlers) f();
  }
  var colorsChangeHandlers = [];
  function notifyColorsChange() {
    for (const f of colorsChangeHandlers) f();
  }
  // Indices in data[] whose plot has been dropped and can be handed out again.
  // Plot ids are array indices and sources hold on to them (replaceData/
  // removeData), so slots are recycled, never compacted — compacting would
  // silently repoint every id a source still holds.
  var freeSlots = [];
  function releaseSlot(i) {
    if (!data[i]) return;          // already free — don't list it twice
    data[i] = null;
    freeSlots.push(i);
  }
  var rctx = null; // render context, updated on each plotAll() call
  var renderInterval = null; // when set via setRenderInterval(), prepare_grid renders only blocks at this interval
  var _currentGroup = null;  // name of the viewport-sync group this instance belongs to
  var _syncing = false;      // true while applying a viewport broadcast from a peer
  var _suppressTick = false; // true when this instance is a non-leader in a group follow session
  var _handle = null;        // handle object registered in _groups
  var _watermarkImg = null;  // preloaded HTMLImageElement for watermark drawing

  var f = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    mon: 2678400000,
  };

  // grid holds all information about the timeaxis
  // 0 - milliseconds, 1 -
  var grid = [];
  var ygrid = [];

  var dvtl = 10; // the minimal pixel distance for vertical time lines
  var dtl = 3 * font_height; // the minimal pixel distance for time labels

  var part1000 = [1, 5, 10, 50, 100, 500];
  var part60 = [1, 5, 15, 30];
  var part24 = [1, 2, 4, 12];

  var animation = {};

  //
  // create possible labels to create array with maximum length
  // stored in labels.day_pixels
  // this can vary with font-size as well as with language settings
  //
  var labels = {};

  // month in top row, day in second row: 0
  // year in top row, month in second row: 1
  // decade in top row, year in second row: 2 (not used..)
  // century in top row, decade in second row: 3 (not used..)
  var label_level = 0;
  var label_level_prev = 0;
  var label_level_alpha = 1.0;   // 0 = showing prev, 1 = fully at label_level
  var label_anim_startT = 0;
  var label_anim_dur = 280;      // ms for horizontal-label crossfade
  var ygrid_alpha = 1.0;         // opacity for y-axis lines + labels
  var ygrid_anim_startT = 0;
  var ygrid_had_data = false;
  var ygrid_initialized = false;
  var margin_left_anim   = { from: basePad.left,           to: basePad.left,           startT: 0, dur: 300 };
  var margin_bottom_anim = { from: font_width + basePad.bottom, to: font_width + basePad.bottom, startT: 0, dur: 250 };
  var margin_left_initialized   = false;
  var margin_bottom_initialized = false;
  var axis_anim_pending = false;
  var grid_level_label = [
    [5, 6, 7],
    [4, 5, 6],
  ];
  var zoom_onclick_time = settings.zoomDuration;

  labels.day = [
    {
      weekday: "long",
      day: "numeric",
      month: "numeric",
    },
    {
      weekday: "short",
      day: "numeric",
    },
    {
      day: "numeric",
    },
  ];

  labels.month = [
    {
      month: "long",
      year: "numeric",
    },
    {
      month: "long",
      year: "2-digit",
    },
    {
      month: "long",
    },
    {
      month: "short",
    },
    {
      month: "narrow",
    },
  ];

  labels.year = [
    {
      year: "numeric",
    },
    {
      year: "2-digit",
    },
  ];

  var onClickData = function (plot, n, item) {
    _highlight(plot, n, item, rctx);
  };
  // Multi-subscriber, like seriesChangeHandlers: the shipped tooltip overlay
  // registers here, and an app that also wants its own hover logic must not
  // have to choose between the two. onHoverDataCallback returns an unsubscribe.
  var hoverDataHandlers = [];
  function notifyHoverData(plot, n, key, value) {
    for (const h of hoverDataHandlers) h(plot, n, key, value);
  }

  ////////////////////////////////////
  // helper functions and variables //
  ////////////////////////////////////

  // SI prefix formatter: 1500 → "1.5k", 1200000 → "1.2M", 0.5 → "0.5"
  var _yFmt = settings.yAxisFormat || siFormat;
  var _yLabel = settings.yAxisLabel || '';

  // calculate the width of labels — wrapped in recomputeFonts() so resize can update them
  var holiday_pixels = {};

  function recomputeFonts() {
    c.font = xFont();
    var _fm = c.measureText("22:22");
    font_height = 1.4 * _fm.actualBoundingBoxAscent + 4;
    font_width  = _fm.width;
    dtl = 3 * font_height;

    for (const holiday of Object.values(holidays)) {
      holiday_pixels[holiday] = c.measureText(holiday).width;
    }

    labels.day_pixels = new Array(labels.day.length).fill(0);
    for (var i = 0; i < 7; i++) {
      labels.day.forEach((format, j) => {
        var l = c.measureText(
          new Date((i + 355) * f.d).toLocaleString(nls, format),
        ).width;
        if (l > labels.day_pixels[j]) labels.day_pixels[j] = l;
      });
    }

    labels.month_pixels = new Array(labels.month.length).fill(0);
    for (i = 0; i < 12; i++) {
      labels.month.forEach((format, j) => {
        var l = c.measureText(
          new Date((i * 30 + 5) * f.d).toLocaleString(nls, format),
        ).width;
        if (l > labels.month_pixels[j]) labels.month_pixels[j] = l;
      });
    }

    labels.year_pixels = [c.measureText("2000").width, c.measureText("20").width];
  }

  recomputeFonts();

  // Memoised Easter dates ("D.M" per year) and holiday lookups
  // ("D.M.YYYY" → name | false, negative hits included).
  //
  // Both are bounded. They key on the dates actually asked for, so panning
  // across centuries at day resolution would otherwise accumulate an entry per
  // day for the whole journey and never release any. The visible window is at
  // most a few hundred days, so dropping the whole cache on overflow costs one
  // frame's worth of recomputation — far cheaper than tracking LRU order.
  var HL_MAX = 4000;          // ≫ any single viewport
  var EASTER_MAX = 500;
  var easterYears = {};
  var easterCount = 0;
  var hL = {};
  var hLCount = 0;

  function cacheHoliday(key, value) {
    if (hLCount >= HL_MAX) { hL = {}; hLCount = 0; }
    hL[key] = value;
    hLCount++;
    return value;
  }

  function isHoliday(date) {
    var year = date.getFullYear();
    var d = date.getDate() + "." + (date.getMonth() + 1);
    var di = d + "." + year;
    if (Object.prototype.hasOwnProperty.call(hL, di)) return hL[di];
    if (!Object.prototype.hasOwnProperty.call(easterYears, year.toString())) {
      if (easterCount >= EASTER_MAX) { easterYears = {}; easterCount = 0; }
      easterYears[year] = Easter(year);
      easterCount++;
    }
    var a = easterYears[year].split(".");
    for (var day in holidays) {
      if (d === day) {
        return cacheHoliday(di, holidays[day]);
      } else if (day[0] === "-" || day[0] === "+") {
        var checkDay = new Date(year, a[1] - 1, a[0]);
        checkDay.setDate(checkDay.getDate() + Number(day));
        checkDay = checkDay.getDate() + "." + (checkDay.getMonth() + 1);
        if (d === checkDay) {
          return cacheHoliday(di, holidays[day]);
        }
      }
    }
    return cacheHoliday(di, false);
  }

  // NOTE: currently unused. Formats a duration as "2d 3h" / "5m 30s"; kept
  // because it is finished and useful (e.g. for a span tooltip), but nothing
  // calls it today. Delete it or wire it up.
  // eslint-disable-next-line no-unused-vars
  function period(delta) {
    var days = Math.floor(delta / 86400000);
    delta -= days * 86400000;
    var hours = Math.floor(delta / 3600000) % 24;
    if (days) return days.toString() + "d " + hours.toString() + "h";
    delta -= hours * 3600000;
    var minutes = Math.floor(delta / 60000) % 60;
    if (hours) return hours.toString() + "h " + minutes.toString() + "m";
    delta -= minutes * 60000;
    var seconds = Math.floor(delta / 1000);
    if (minutes) return minutes.toString() + "m " + seconds.toString() + "s";
    delta -= seconds * 1000;
    var ms = Math.floor(delta);
    if (seconds) return seconds.toString() + "s " + ms.toString() + "ms";
    delta -= ms;
    var us = Math.floor(delta * 1000);
    if (us) return ms.toString() + "ms " + us.toString() + "µs";
    return us.toString() + "µs";
  }

  //////////////////////////
  // data retrieval stuff //
  //////////////////////////

  function scheduleViewportChange() {
    // Throttle, not debounce: fire once per 300 ms with the latest
    // tmin/tmax/ppms.  A pure trailing-edge debounce would starve under fast
    // tick rates — follower_tick at high zoom fires every mspp ms (could be
    // <300 ms), and resetting the timer on each call means it never elapses.
    if (viewportChangePending !== null) return;
    viewportChangePending = setTimeout(function () {
      viewportChangePending = null;
      for (var fn of viewportChangeHandlers) fn(tmin, tmax, ppms);
    }, 300);
  }

  initSources(settings.sources, {
    pushData(plot) {
      var newStart, newEnd;
      if (plot.category === 'point' || plot.category === 'span') {
        newStart = plot.tmin;
        newEnd = plot.tmax;
      } else {
        newStart = plot.interval_start * 1000;
        // Prefer the server-provided interval_end so an empty or sparse
        // plot correctly covers the full requested window — otherwise
        // empty results (e.g. a brand-new filter that excludes everything)
        // would only trim one interval of stale data and leave the rest
        // visible. Fall back to the slot-derived extent when interval_end
        // is missing.
        if (typeof plot.interval_end === 'number') {
          newEnd = plot.interval_end * 1000;
        } else {
          var ms = 0;
          for (var k in plot.data) { var n = +k; if (n > ms) ms = n; }
          newEnd = (plot.interval_start + plot.interval * (ms + 1)) * 1000;
        }
      }
      // Store new data first so there's never a gap between old and new.
      // Reuse a freed slot rather than always appending: a polling source
      // pushes on every fetch and the superseded blocks are nulled out, so
      // appending unconditionally would grow data[] — and the per-frame scan
      // over it in prepare_grid — without bound across a long session.
      var id = freeSlots.length ? freeSlots.pop() : data.length;
      data[id] = plot;
      // Then trim or remove old overlapping blocks. Scans every slot, not just
      // those below `id`, because a recycled id is not the highest index.
      for (var i = 0; i < data.length; i++) {
        if (i === id || !data[i] || data[i].type !== plot.type) continue;
        // Different interval: keep both — rendering selects the best
        // interval for the current zoom level in prepare_grid.
        if (data[i].interval !== undefined && plot.interval !== undefined
            && data[i].interval !== plot.interval) {
          continue;
        }
        var es, ee;
        if (data[i].category === 'point' || data[i].category === 'span') {
          es = data[i].tmin;
          ee = data[i].tmax;
        } else {
          var dms = 0;
          for (k in data[i].data) { n = +k; if (n > dms) dms = n; }
          es = data[i].interval_start * 1000;
          ee = (data[i].interval_start + data[i].interval * (dms + 1)) * 1000;
        }
        if (newStart < ee && newEnd > es) {
          var concatable = (data[i].type === 'multibar'
                            || data[i].type === 'quantile-bands');
          if (concatable && data[i].interval === plot.interval
              && data[i].category !== 'point' && plot.category !== 'point') {
            // Concatenate: trim old block's slots inside the new block's
            // range only. Slots past newEnd belong to a different plot
            // (e.g. a back-extended live block that overlaps the new
            // plot's left edge but extends well past its right edge) —
            // deleting them wipes data the new plot doesn't replace.
            for (var s in data[i].data) {
              var slotTime = data[i].interval_start + +s * data[i].interval;
              var slotMs = slotTime * 1000;
              if (slotMs >= newStart && slotMs < newEnd) delete data[i].data[s];
            }
            // Recalculate old block's metadata. quantile-bands store an array
            // of percentile values per series (extent = min/max array entry);
            // multibar stacks series (extent = per-slot stacked total).
            data[i].count = Object.keys(data[i].data).length;
            if (data[i].count === 0) {
              // Every slot this block held was inside the new block's range,
              // so it is now an empty husk. Release it instead of leaving it
              // in data[] forever — this is the case a polling source hits on
              // every single fetch.
              releaseSlot(i);
              continue;
            } else {
              var mn = Infinity, mx = -Infinity;
              var banded = data[i].type === 'quantile-bands';
              for (s in data[i].data) {
                if (banded) {
                  for (var series in data[i].data[s]) {
                    var arr = data[i].data[s][series];
                    for (var qi = 0; qi < arr.length; qi++) {
                      if (arr[qi] < mn) mn = arr[qi];
                      if (arr[qi] > mx) mx = arr[qi];
                    }
                  }
                } else {
                  var total = 0;
                  for (series in data[i].data[s]) total += data[i].data[s][series];
                  if (total < mn) mn = total;
                  if (total > mx) mx = total;
                }
              }
              data[i].min = mn; data[i].max = mx;
            }
          } else {
            releaseSlot(i);
          }
        }
      }
      return id;
    },
    replaceData(id, plot) { data[id] = plot; },
    removeData(id) { releaseSlot(id); },
    requestRedraw() { plotAll(); },
    getViewport() { return { tmin, tmax, ppms }; },
    onViewportChange(fn) { viewportChangeHandlers.push(fn); },
  });

  // Clamp t1/tt2 so t1 < t2; swap if inverted, add 1h if equal.
  function clampRange(t1, t2) {
    if (t1 > t2) return [t2, t1];
    if (t1 === t2) return [t1, t1 + 3600000];
    return [t1, t2];
  }

  // Receive a viewport update from a group peer — apply silently (no re-broadcast).
  function setViewport(t1, t2) {
    var r = clampRange(t1, t2);
    _syncing = true;
    tmin = r[0];
    tmax = r[1];
    plotAll();
    _syncing = false;
  }

  // Called by a group peer to stop follow mode on this instance.
  function stopFollowFromPeer() {
    _syncing = true;
    doStop();
    _syncing = false;
  }

  // Called when this instance is elected follow leader: start ticking.
  function startFollowAsTick(fraction) {
    _syncing = true;
    _suppressTick = false;
    doFollow(fraction);
    start_follower();
    _syncing = false;
  }

  // Called when this instance is a non-leader: visual follow state, no tick.
  function startFollowNoTick(fraction) {
    _syncing = true;
    _suppressTick = true;
    doFollow(fraction);
    _syncing = false;
  }

  _handle = {
    setViewport:      setViewport,
    getViewport:      function () { return { tmin: tmin, tmax: tmax }; },
    stopFollow:       stopFollowFromPeer,
    startFollowAsTick: startFollowAsTick,
    startFollowNoTick: startFollowNoTick,
    getCanvasWidth:   function () { return canvas.width; },
  };

  this.joinGroup = function (name) {
    if (_currentGroup) _groupLeave(_currentGroup, _handle);
    _currentGroup = name;
    _groupJoin(name, _handle);
    // Adopt viewport from an existing peer so this instance snaps to the
    // group's current view — peers must not jump to our stale position.
    var g = _groups.get(name);
    for (var h of g) {
      if (h !== _handle) { var vp = h.getViewport(); setViewport(vp.tmin, vp.tmax); break; }
    }
  };

  this.leaveGroup = function () {
    if (!_currentGroup) return;
    var name = _currentGroup;
    var fs = _groupFollowState.get(name);
    var wasLeader = fs && fs.active && fs.leader === _handle;

    _groupLeave(name, _handle);
    _currentGroup = null;
    _suppressTick = false;

    if (wasLeader) {
      // Elect the next-largest remaining member as the new follow leader.
      var g = _groups.get(name);
      if (g && g.size > 0) {
        var newLeader = null;
        var maxW = -1;
        for (var h of g) { var w = h.getCanvasWidth(); if (w > maxW) { maxW = w; newLeader = h; } }
        if (newLeader) {
          fs.leader = newLeader;
          newLeader.startFollowAsTick(fs.fraction);
          for (h of g) { if (h !== newLeader) h.startFollowNoTick(fs.fraction); }
        }
      }
    }
  };

  if (settings.group) {
    _currentGroup = settings.group;
    _groupJoin(_currentGroup, _handle);
  }

  //////////////////////////
  // timeseries functions //
  //////////////////////////

  function timer(fn, t) {
    follow_timers++;
    setTimeout(fn, t);
    //console.log('Timer ' + follow_timers + ' set for ' + t + ' milliseconds');
  }

  function follow_view() {
    follow_timers--;
    if (follow_stopped) return;
    now = Date.now();
    if (tmax - mspp < now && now < tmax + 10 * mspp) {
      tmin = tmin + now - tmax;
      tmax = now;
    } else if (now > tmax) return;
    if (now < rT(0)) {
      timer(follow_view, now - rT(0));
      return;
    } else {
      var t = mspp;
      if (mspp > 5000) t = 5000;
      timer(follow_view, t);
    }
    scheduleViewportChange();
    plotAll();
  }

  // Single persistent tick; reads follow_fraction so the slider can update it live.
  function follower_tick() {
    follow_timers--;
    if (follow_stopped) return;
    if (_suppressTick) return; // non-leader in a group: do not drive time
    now = Date.now();
    var range = tmax - tmin;
    tmin = now - follow_fraction * range;
    tmax = tmin + range;
    var t = mspp;
    if (mspp > 5000) t = 5000;
    timer(follower_tick, t);
    scheduleViewportChange();
    plotAll();
  }

  function start_follower() {
    if (!_currentGroup) {
      if (follow_timers === 0) timer(follower_tick, 0);
      return;
    }
    // Group follow: elect the largest canvas as leader.
    var g = _groups.get(_currentGroup);
    if (!g) { if (follow_timers === 0) timer(follower_tick, 0); return; }

    var leaderHandle = _handle;
    for (var h of g) {
      if (h.getCanvasWidth() > leaderHandle.getCanvasWidth()) leaderHandle = h;
    }

    _groupFollowState.set(_currentGroup, { active: true, fraction: follow_fraction * 100, leader: leaderHandle });

    // Tell all non-leaders (other than this instance) to follow without ticking.
    // Tell the leader (if it is not this instance) to start its tick.
    for (h of g) {
      if (h === _handle) continue;
      if (h === leaderHandle) h.startFollowAsTick(follow_fraction * 100);
      else h.startFollowNoTick(follow_fraction * 100);
    }

    // This instance: leader starts the tick, non-leader suppresses it.
    if (leaderHandle === _handle) {
      _suppressTick = false;
      if (follow_timers === 0) timer(follower_tick, 0);
    } else {
      _suppressTick = true;
    }
  }

  // Keeps the now-line moving when not in follow mode.
  // Same interval as follower_tick: one redraw per pixel of now-line travel.
  function scheduleNowLine() {
    if (nowline_timer !== null) return;
    var t = mspp > 5000 ? 5000 : mspp;
    nowline_timer = setTimeout(function () {
      nowline_timer = null;
      if (settings.autoFollow && Date.now() >= tmax) {
        doFollow(100);
        start_follower();
      } else {
        plotAll();
      }
    }, t);
  }

  // navigate view to specific day, month or year (center current or go to left or right)
  function navigate(item, level, direction) {
    if (level === 4) {
      if (direction === "center")
        zoom(
          +item.tm,
          +new Date(new Date(+item.tm + f.d + 2 * f.h).toDateString()),
        );
      else if (direction === "left")
        zoom(+new Date(new Date(+item.tm - 2 * f.h).toDateString()), +item.tm);
      else
        zoom(
          +new Date(new Date(+item.tm + f.d + 2 * f.h).toDateString()),
          +new Date(new Date(+item.tm + 2 * f.d + 2 * f.h).toDateString()),
        );
      return;
    }
    if (level === 4.5) {
      zoom(
        +item.tm,
        +new Date(new Date(+item.tm + f.d * 7 + 2 * f.h).toDateString()),
      );
      return;
    }
    if (level === 5) {
      if (direction === "center") {
        var dm = new Date(+item.tm + f.mon + 2 * f.d);
        zoom(
          +item.tm,
          +new Date(
            Date.parse(
              dm.getFullYear() + "-" + (dm.getMonth() + 1) + "-1 00:00",
            ),
          ),
        );
      } else if (direction === "left") {
        dm = new Date(+item.tm + -2 * f.d);
        zoom(
          +new Date(
            Date.parse(
              dm.getFullYear() + "-" + (dm.getMonth() + 1) + "-1 00:00",
            ),
          ),
          +item.tm,
        );
      } else {
        dm = new Date(+item.tm + f.mon + 2 * f.d);
        var dm2 = new Date(+dm + f.mon + 2 * f.d);
        zoom(
          +new Date(
            Date.parse(
              dm.getFullYear() + "-" + (dm.getMonth() + 1) + "-1 00:00",
            ),
          ),
          +new Date(
            Date.parse(
              dm2.getFullYear() + "-" + (dm2.getMonth() + 1) + "-1 00:00",
            ),
          ),
        );
      }
      return;
    }
    if (level === 6) {
      if (direction === "center") {
        zoom(
          +item.tm,
          +new Date(Date.parse(item.tm.getFullYear() + 1 + "-1-1 00:00")),
        );
      } else if (direction === "left") {
        zoom(
          +new Date(Date.parse(item.tm.getFullYear() - 1 + "-1-1 00:00")),
          +item.tm,
        );
      } else {
        zoom(
          +new Date(Date.parse(item.tm.getFullYear() + 1 + "-1-1 00:00")),
          +new Date(Date.parse(item.tm.getFullYear() + 2 + "-1-1 00:00")),
        );
      }
      return;
    }
  }

  // `time` overrides the animation duration in ms for this one transition;
  // omit it for the configured zoomDuration, pass 0 to jump without animating.
  function zoom(target_tmin, target_tmax, time) {
    var r = clampRange(target_tmin, target_tmax);
    if (tmin === r[0] && tmax === r[1]) return;
    var dur = typeof time === 'number' && time >= 0 ? time : zoom_onclick_time;
    animation.startT = +Date.now() - 20;
    animation.endT = animation.startT + dur;
    animation.start = {
      tmin: tmin,
      tmax: tmax,
    };
    animation.end = {
      tmin: r[0],
      tmax: r[1],
    };
    animate();
  }

  // today midnight
  function last_midnight() {
    var today = new Date(Date.now());
    return new Date(today.toDateString());
  }
  this.zoom = zoom;
  this.today = function () {
    doStop();
    var today = last_midnight();
    var tomorrow = new Date(today);
    tomorrow = new Date(tomorrow.setDate(tomorrow.getDate() + 1));
    zoom(today, tomorrow);
  };
  this.yesterday = function () {
    doStop();
    var today = last_midnight();
    var yesterday = new Date(today);
    yesterday = new Date(yesterday.setDate(yesterday.getDate() - 1));
    zoom(yesterday, today);
  };
  this.tomorrow = function () {
    doStop();
    var tomorrow = new Date(last_midnight());
    tomorrow = new Date(tomorrow.setDate(tomorrow.getDate() + 1));
    var dayafter = new Date(tomorrow);
    dayafter = new Date(dayafter.setDate(dayafter.getDate() + 1));
    zoom(tomorrow, dayafter);
  };
  this.last24 = function () {
    doFollow(100);
    zoom(Date.now() - 86400000, Date.now());
    setTimeout(start_follower, zoom_onclick_time);
  };
  this.next24 = function () {
    doFollow(0);
    zoom(Date.now(), Date.now() + 86400000);
    setTimeout(start_follower, zoom_onclick_time);
  };
  this.lastWeek = function () {
    doStop();
    var lastweek = new Date(last_midnight());
    lastweek = new Date(
      lastweek.setDate(lastweek.getDate() - 6 - (lastweek.getDay() || 7)),
    );
    var thisweek = new Date(lastweek);
    thisweek = new Date(thisweek.setDate(thisweek.getDate() + 7));
    zoom(lastweek, thisweek);
  };
  this.thisWeek = function () {
    doStop();
    var thisweek = new Date(last_midnight());
    thisweek = new Date(
      thisweek.setDate(thisweek.getDate() + 1 - (thisweek.getDay() || 7)),
    );
    var nextweek = new Date(thisweek);
    nextweek = new Date(nextweek.setDate(nextweek.getDate() + 7));
    zoom(thisweek, nextweek);
  };
  this.nextWeek = function () {
    doStop();
    var nextweek = new Date(last_midnight());
    nextweek = new Date(
      nextweek.setDate(nextweek.getDate() + 8 - (nextweek.getDay() || 7)),
    );
    var weekafter = new Date(nextweek);
    weekafter = new Date(weekafter.setDate(weekafter.getDate() + 7));
    zoom(nextweek, weekafter);
  };

  // ── Month navigation ──────────────────────────────────────────────────────
  this.thisMonth = function () {
    doStop();
    var d = new Date();
    zoom(new Date(d.getFullYear(), d.getMonth(), 1),
         new Date(d.getFullYear(), d.getMonth() + 1, 1));
  };
  this.lastMonth = function () {
    doStop();
    var d = new Date();
    zoom(new Date(d.getFullYear(), d.getMonth() - 1, 1),
         new Date(d.getFullYear(), d.getMonth(), 1));
  };
  this.nextMonth = function () {
    doStop();
    var d = new Date();
    zoom(new Date(d.getFullYear(), d.getMonth() + 1, 1),
         new Date(d.getFullYear(), d.getMonth() + 2, 1));
  };
  this.zoomMonth = function (year, month) {
    doStop();
    zoom(new Date(year, month, 1), new Date(year, month + 1, 1));
  };

  // ── Year navigation ───────────────────────────────────────────────────────
  this.thisYear = function () {
    doStop();
    var y = new Date().getFullYear();
    zoom(new Date(y, 0, 1), new Date(y + 1, 0, 1));
  };
  this.lastYear = function () {
    doStop();
    var y = new Date().getFullYear() - 1;
    zoom(new Date(y, 0, 1), new Date(y + 1, 0, 1));
  };
  this.nextYear = function () {
    doStop();
    var y = new Date().getFullYear() + 1;
    zoom(new Date(y, 0, 1), new Date(y + 1, 0, 1));
  };
  this.zoomYear = function (year) {
    doStop();
    zoom(new Date(year, 0, 1), new Date(year + 1, 0, 1));
  };

  // ── Calendar-week navigation (ISO 8601, Monday start) ────────────────────
  // isoWeekStart() lives at module scope — see top of file.
  this.zoomWeek = function (year, week) {
    doStop();
    var start = isoWeekStart(year, week);
    var end = new Date(start);
    end.setDate(start.getDate() + 7);
    zoom(start, end);
  };

  // ── Viewport pan: one "screen" left (dir=-1) or right (dir=+1) ───────────
  // panSnapUnit/panFloor/panAdd/panDiff live at module scope — see top of file.
  this.pan = function (dir) {
    doStop();
    var inFlight = animation.endT && Date.now() < animation.endT;
    var srcMin = inFlight ? animation.end.tmin : tmin;
    var srcMax = inFlight ? animation.end.tmax : tmax;
    var unit = panSnapUnit(srcMin, srcMax);
    var lo   = panSnapEdge(srcMin, unit, false);
    var hi   = panSnapEdge(srcMax, unit, true);
    var n    = Math.max(1, panDiff(lo, hi, unit));
    zoom(panAdd(lo, unit, dir * n), panAdd(hi, unit, dir * n));
  };

  function easeInOutExpo(x) {
    return x === 0
      ? 0
      : x === 1
        ? 1
        : x < 0.5
          ? Math.pow(2, 20 * x - 10) / 2
          : (2 - Math.pow(2, -20 * x + 10)) / 2;
  }

  function scheduleAxisTransition() {
    if (axis_anim_pending) return;
    axis_anim_pending = true;
    setTimeout(function () { axis_anim_pending = false; plotAll(); }, 12);
  }

  function animate() {
    now = Date.now();
    var done = false;
    if (now >= animation.endT) {
      now = animation.endT;
      done = true;
    }
    // `var` matters: without it this is an implicit global, which is silently
    // tolerated in the IIFE bundle but throws in strict mode — i.e. whenever
    // the library is loaded as an ES module, as the demos do.
    // A zero-length animation (zoom(…, 0)) would divide by zero here and put
    // NaN into tmin/tmax — treat it as already finished.
    var span = animation.endT - animation.startT;
    var t = span > 0
      ? easeInOutExpo((now - animation.startT) / span)
      : 1;
    tmin = animation.start.tmin * (1 - t) + animation.end.tmin * t;
    tmax = animation.start.tmax * (1 - t) + animation.end.tmax * t;
    if (!done) setTimeout(animate, 10);
    plotAll();
    if (done) scheduleViewportChange();
  }

  function watermark() {
    if (!_watermarkImg) return;
    var w = plotWidth * settings.watermarkWidth;
    var h = w * _watermarkImg.naturalHeight / _watermarkImg.naturalWidth;
    c.save();
    c.globalAlpha = settings.watermarkAlpha;
    c.drawImage(_watermarkImg, margin.left, margin.top, w, h);
    c.restore();
  }

  function plotAll() {
    now = Date.now();
    c.clearRect(0, 0, canvas.width, canvas.height);
    prepare_grid(); // must run before rctx is built: recalculates ppms, ppv, ppv, mspp
    rctx = { c, X, Y, ppms, ppv, margin, plotWidth, plotHeight, hidden: hiddenSeries };
    background();
    watermark();
    yAxis();
    _plotData(activePlot, data, rctx);
    frame();
    versionTag();
    redLine();
    // console.log('plot finished: ' + follow_timers);
    // console.log(grid);
    if (follow_timers < 0) timer(follow_view, 1000);
    if (follow_stopped || follow_timers === 0) scheduleNowLine();
    if (!_syncing && !_suppressTick && _currentGroup) _groupBroadcast(_currentGroup, tmin, tmax, _handle);
  }

  var _resizeObserver = new ResizeObserver(function () {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    basePad = readContainerPad();
    recomputeFonts();
    margin.top   = 2 * font_height + basePad.top;
    margin.right = basePad.right;
    plotWidth  = canvas.width  - margin.left - margin.right;
    plotHeight = canvas.height - margin.top  - margin.bottom;
    refreshOffset();
    plotAll();
    // Notify viewport-change listeners — plotWidth changed so ppms changed
    // even though tmin/tmax did not. Throttled at 300 ms inside scheduleViewportChange.
    scheduleViewportChange();
  });
  _resizeObserver.observe(canvas.parentElement || canvas);

  canvas.onmousedown = function (e) {
    refreshOffset();
    doStop();
    var item = mouse_position(e);
    if (item.level) {
      var dir = "center";
      if (item.browse) {
        if (e.clientX - offset.x - margin.left < font_height) dir = "left";
        if (e.clientX - offset.x > plotWidth + margin.left - font_height)
          dir = "right";
      }
      navigate(item, item.level, dir);
    }
    pendingClickItem = item.key ? item : null;
    startDragX = e.clientX;
    startTmin = tmin;
    startTmax = tmax;
  };

  canvas.onmousemove = function (e) {
    refreshOffset();
    if (startDragX !== 0) {
      canvas.style.cursor = 'grabbing';
      var move = ((startDragX - e.clientX) / plotWidth) * (tmax - tmin);
      tmin = startTmin + move;
      tmax = startTmax + move;
      plotAll();
      scheduleViewportChange();
      return;
    }
    if (hitVersionTag(e)) {
      canvas.style.cursor = 'pointer';
      notifyHoverData(null, null, null, null);
      return;
    }
    var item = mouse_position(e);
    canvas.style.cursor =
      item && item !== 'frame' && (item.level || item.key) ? 'pointer' :
      item && item !== 'frame' ? 'grab' :
      'default';
    if (item && item !== 'frame' && item.key != null)
      notifyHoverData(data[item.plot], item.n, item.key, item.value);
    else
      notifyHoverData(null, null, null, null);
  };

  canvas.onmouseleave = function () {
    notifyHoverData(null, null, null, null);
  };

  canvas.onmouseup = function (e) {
    if (startDragX !== 0) scheduleViewportChange();
    var wasClick = Math.abs(e.clientX - startDragX) < 4;
    if (pendingClickItem && wasClick) {
      onClickData(data[pendingClickItem.plot], pendingClickItem.n, pendingClickItem.key, pendingClickItem.value);
    } else if (wasClick && hitVersionTag(e)) {
      window.open(VERSION_TAG_URL, '_blank', 'noopener,noreferrer');
    }
    pendingClickItem = null;
    startDragX = 0;
  };

  canvas.onmouseout = function (e) {
    if (startDragX !== 0) scheduleViewportChange();
    startDragX = 0;
    canvas.style.cursor = 'default';
  };

  var touchState = null;

  canvas.ontouchstart = function (e) {
    e.preventDefault();
    refreshOffset();
    if (e.touches.length === 1) {
      if (follow_timers > 0 && !follow_stopped) return; // pan not allowed while following
      doStop();
      touchState = {
        type: 'pan',
        x0: e.touches[0].clientX,
        tmin0: tmin,
        tmax0: tmax,
      };
    } else if (e.touches.length === 2) {
      var cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      var following = follow_timers > 0 && !follow_stopped;
      if (following) {
        now = Date.now();
        var range0 = tmax - tmin;
        tmin = now - follow_fraction * range0;
        tmax = tmin + range0;
      }
      touchState = {
        type: 'pinch',
        dist0: Math.abs(e.touches[1].clientX - e.touches[0].clientX),
        midTime: following ? now : rT(cx - offset.x),
        midFrac: following ? follow_fraction : (cx - offset.x - margin.left) / plotWidth,
        tmin0: tmin,
        tmax0: tmax,
      };
    }
  };

  canvas.ontouchmove = function (e) {
    e.preventDefault();
    refreshOffset();
    if (!touchState) return;
    if (e.touches.length === 1 && touchState.type === 'pan') {
      var move = ((touchState.x0 - e.touches[0].clientX) / plotWidth) * (touchState.tmax0 - touchState.tmin0);
      tmin = touchState.tmin0 + move;
      tmax = touchState.tmax0 + move;
      plotAll();
      scheduleViewportChange();
    } else if (e.touches.length === 2 && touchState.type === 'pinch') {
      var dist = Math.abs(e.touches[1].clientX - e.touches[0].clientX);
      if (dist === 0) return;
      var scale = touchState.dist0 / dist;
      var newRange = (touchState.tmax0 - touchState.tmin0) * scale;
      tmin = touchState.midTime - touchState.midFrac * newRange;
      tmax = tmin + newRange;
      plotAll();
      scheduleViewportChange();
    }
  };

  canvas.ontouchend = function (e) {
    e.preventDefault();
    if (touchState) scheduleViewportChange();
    touchState = null;
  };

  // ── Keyboard navigation ───────────────────────────────────────────────────
  // A <canvas> is not focusable by default, so opt it into the tab order and
  // describe it — without this the chart is unusable without a mouse. Handlers
  // hang off the canvas rather than the document so that a page with several
  // charts (the demo has seven) only moves the focused one.
  if (settings.keyboard) {
    if (!canvas.hasAttribute || !canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    if (canvas.setAttribute && !canvas.getAttribute('role')) {
      canvas.setAttribute('role', 'application');
      if (!canvas.getAttribute('aria-label'))
        canvas.setAttribute('aria-label',
          'Time series chart. Use left and right arrow keys to page through time.');
    }

    canvas.onkeydown = function (e) {
      // Left/right page by one screenful, snapped to whichever calendar unit
      // fits the current zoom (see panSnapUnit) — same behaviour as ts.pan(),
      // so a keyboard user lands on the same boundaries as a clicking one.
      if (e.key === 'ArrowLeft')       self.pan(-1);
      else if (e.key === 'ArrowRight') self.pan(1);
      else return;                     // leave every other key to the browser
      e.preventDefault();              // ... but don't let the page scroll
    };
  }

  canvas.onwheel = function (e) {
    e.preventDefault();
    refreshOffset();
    if (ppms > 25 && e.deltaY < 0) return;
    if (ppms < 6e-9 && e.deltaY > 0) return;
    // When following, reposition to the actual current now before zooming.
    // Without this the pivot maps to the now from the last tick, and the next
    // tick repositioning to real Date.now() causes a visible jump.
    if (follow_timers > 0 && !follow_stopped) {
      now = Date.now();
      var range0 = tmax - tmin;
      tmin = now - follow_fraction * range0;
      tmax = tmin + range0;
    }
    var r = tmax - tmin;
    var lr = (follow_timers > 0 && !follow_stopped)
      ? follow_fraction
      : (e.clientX - offset.x - margin.left) / plotWidth;
    var rr = 1 - lr;
    if (e.deltaY > 0) {
      tmin -= zf * lr * r;
      tmax += zf * rr * r;
    } else {
      tmin += zf * lr * r;
      tmax -= zf * rr * r;
    }
    plotAll();
    scheduleViewportChange();
  };

  // how many tic to use for a given interval
  // p is defined array part10, part24 or part60
  // t is timeinterval in ms
  // d is minimum pixel distance allowed between tics
  function time_part(p, t, d) {
    for (var pp in p) if (ppms * t * p[pp] > d) return p[pp];
  }

  function mouse_position(e) {
    var x = e.clientX - offset.x;
    var y = e.clientY - offset.y;
    if (margin.left < x && x < plotWidth + margin.left) {
      if (margin.top < y && y < plotHeight + margin.top) {
        var weekitems = grid[4].filter((item) => item.tm.getDay() === 1);
        for (var wi of weekitems) {
          if (
            x > wi.x &&
            x < wi.x + c.measureText(wi.cw).width &&
            y > plotHeight + margin.top - font_height &&
            y < plotHeight + margin.top
          ) {
            var item = wi;
            return { cw: item.cw, level: 4.5, tm: item.tm };
          }
        }
        // plot area
        return get_element(x, y);
      } else if (
        margin.top - 2 * font_height < y &&
        y < margin.top - font_height
      ) {
        // first label row
        item = get_grid(x, grid_level_label[0][label_level]);
        item.y = margin.top - font_height;
        return item;
      }
      if (margin.top - font_height < y && y < margin.top) {
        // second label row
        item = get_grid(x, grid_level_label[1][label_level]);
        item.y = margin.top;
        return item;
      }
    }
    // frame
    return "frame";
  }

  // return grid element of given canvas coordinates
  function get_grid(x, grid_level) {
    for (var j = 0; j < grid[grid_level].length; j++) {
      var item = grid[grid_level][j];
      if (item.x < x && x < item.x + item.len) {
        item.level = grid_level;
        return item;
      }
    }
  }

  // return data element of given canvas coordinates
  function get_element(x, y) {
    var t = new Date(rT(x));
    var py = rY(y);
    // span identification — mirrors barRect() in gantt.js: row r covers the
    // value band [laneCount - r - 1, laneCount - r). Later events win, matching
    // the draw order (last painted is on top).
    for (const i of activePlot) {
      if (!data[i] || data[i].category !== 'span') continue;
      var sp = data[i];
      if (!sp.data || !sp.laneCount) continue;
      var row = Math.floor(sp.laneCount - py);
      if (row < 0 || row >= sp.laneCount) continue;
      for (var e = sp.data.length - 1; e >= 0; e--) {
        var ev = sp.data[e];
        if (ev._row !== row) continue;
        // Widen zero-length events to the 2px minimum the renderer draws.
        var evEnd = Math.max(ev.end, ev.start + 2 * mspp);
        if (ev.start <= +t && +t <= evEnd)
          // key must be non-null for the hover/click path to fire; events
          // without an explicit id fall back to their index.
          return { plot: i, n: e, key: ev.id != null ? ev.id : String(e), value: ev };
      }
    }
    // multibar identification
    for (const i of activePlot) {
      if (!data[i] || data[i].category === 'point' || data[i].category === 'span') continue;
      // quantile-bands store an array per series, not a stackable scalar;
      // they have no per-bar hit target, so skip hit-testing them.
      if (data[i].type === 'quantile-bands') continue;
      if (
        data[i].interval_start * 1000 <= t &&
        t <= data[i].interval_end * 1000
      ) {
        var n = Math.floor(
          (+t / 1000 - data[i].interval_start) / data[i].interval,
        );
        var slot = data[i].data[n];
        if (!slot) continue;
        var dirs = data[i].series_directions;
        var hUp = 0, hDown = 0;
        for (const [k, v] of Object.entries(slot)) {
          if (dirs && dirs[k] === 'down') {
            if (py < -hDown && py >= -(hDown + v)) {
              return { plot: i, n: n, key: k, value: v };
            }
            hDown += v;
          } else {
            if (py >= hUp && py < hUp + v) {
              return { plot: i, n: n, key: k, value: v };
            }
            hUp += v;
          }
        }
      }
    }
    // point identification — unlike bars, which tile the plot area and can be
    // hit by arithmetic alone, point markers are sparse, so this works in
    // pixel space and picks the nearest one within the marker's own radius.
    // POINT_RADIUS is the same table the renderers draw from (renderers.js),
    // so what is hoverable is what is visible.
    for (const i of activePlot) {
      if (!data[i] || data[i].category !== 'point' || !data[i].data) continue;
      var pplot = data[i];
      var pr = POINT_RADIUS[pplot.type] || POINT_RADIUS.default;
      var grab = pr + 2;               // a little forgiveness for the mouse
      var bestD2 = grab * grab, best = null;
      for (var pi = 0; pi < pplot.data.length; pi++) {
        var ppt = pplot.data[pi];
        var dx = X(ppt.t) - x;
        if (dx * dx > bestD2) continue;
        for (var psid in ppt.values) {
          if (hiddenSeries.has(psid)) continue;   // hidden means unhittable
          var pval = ppt.values[psid];
          if (pval == null) continue;
          var dy = Y(pval) - y;
          var d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) {
            bestD2 = d2;
            best = { plot: i, n: pi, key: psid, value: pval };
          }
        }
      }
      if (best) return best;
    }
    return { t: t, y: py };
  }

  function plotpercentage(min, max) {
    if (min > tmax) min = tmax;
    if (min < tmin) min = tmin;
    if (max > tmax) max = tmax;
    if (max < tmin) max = tmin;
    return (max - min) / (tmax - tmin);
  }

  // create grid array containing all time labels
  function prepare_grid() {
    ppms = plotWidth / (tmax - tmin);
    mspp = 1 / ppms;
    var dtm = new Date(tmax);

    // find data that can be displayed and assign it to activePlot
    activePlot = [];
    var ymax_array = [];
    var ymin_array = [];
    if (data.length)
      data.forEach((plot, i) => {
        if (!plot) return;
        var ptmin, ptmax;
        if (plot.category === 'span') {
          // Rows and the vertical extent come from the packing, which the
          // renderer would otherwise not compute until draw time — the y-axis
          // needs it now.
          layoutSpans(plot);
          ptmin = plot.tmin;
          ptmax = plot.tmax;
        } else if (plot.category === 'point') {
          ptmin = plot.tmin;
          ptmax = plot.tmax;
        } else {
          var maxSlot = 0;
          for (var k in plot.data) { var n = +k; if (n > maxSlot) maxSlot = n; }
          plot.intervals = maxSlot + 1;
          plot.interval_end =
            plot.interval_start + plot.interval * plot.intervals;
          ptmin = plot.interval_start * 1000;
          ptmax = plot.interval_end * 1000;
        }
        var pp = plotpercentage(ptmin, ptmax);
        if (pp > 0) {
          activePlot.push(i);
          if (plot.category === 'span') {
            // Span plots occupy a fixed row space of 0…laneCount regardless of
            // what is on screen, so the viewport scan below does not apply.
            ymax_array.push([i, plot.laneCount, pp]);
            ymin_array.push([i, 0, pp]);
            return;
          }
          // Compute ymax from slots visible in the current viewport,
          // not from the data block's precomputed max (which covers
          // the entire block including off-screen bars).
          // When plot.series_directions marks some keys as 'down', sum
          // those into vpDownMax separately so the y-axis can extend
          // below zero for butterfly plots.
          var vpUpMax = 0, vpDownMax = 0;
          var dirs = plot.series_directions;
          // Stacked plots (multibar) sum series per slot for the y-extent;
          // un-stacked plots (multiline, multipoint) plot each series
          // independently, so each slot contributes its largest single series
          // value (and most-negative) instead. quantile-bands store an array
          // of percentile values per series; the extent is the largest /
          // most-negative array entry across the slot's series.
          var stacked = plot.type === 'multibar';
          var banded  = plot.type === 'quantile-bands';
          if (plot.category === 'point') {
            // Point series carry {t, values} and no slot grid, so the binned
            // scan below cannot address them (it would compute NaN slot times
            // from an undefined interval_start and silently fall through to
            // plot.max). Scan the points in the viewport directly — which also
            // lets a hidden series drop out of the extent.
            for (const pt of plot.data) {
              if (pt.t < tmin || pt.t > tmax) continue;
              for (var pk in pt.values) {
                if (hiddenSeries.has(pk)) continue;
                var pv = pt.values[pk];
                if (pv == null) continue;
                if (pv >= 0) { if (pv > vpUpMax) vpUpMax = pv; }
                else if (-pv > vpDownMax) vpDownMax = -pv;
              }
            }
          } else if (plot.data) {
            for (var sk in plot.data) {
              var slotTime = (plot.interval_start + +sk * plot.interval) * 1000;
              if (slotTime + plot.interval * 1000 > tmin && slotTime < tmax) {
                var upSum = 0, downSum = 0;
                var slot = plot.data[sk];
                for (var key in slot) {
                  // A hidden series is not drawn, so it must not stretch the
                  // axis either — otherwise hiding the tallest series leaves
                  // the rest squashed against the bottom.
                  if (hiddenSeries.has(key)) continue;
                  var val = slot[key];
                  if (banded) {
                    for (var qi = 0; qi < val.length; qi++) {
                      var qv = val[qi];
                      if (qv >= 0) { if (qv > upSum) upSum = qv; }
                      else if (-qv > downSum) downSum = -qv;
                    }
                  } else if (stacked) {
                    if (dirs && dirs[key] === 'down') downSum += val;
                    else                              upSum   += val;
                  } else if (val >= 0) {
                    if (val > upSum)   upSum   = val;
                  } else if (-val > downSum) downSum = -val;
                }
                if (upSum   > vpUpMax)   vpUpMax   = upSum;
                if (downSum > vpDownMax) vpDownMax = downSum;
              }
            }
          }
          ymax_array.push([i, vpUpMax || plot.max, pp]);
          ymin_array.push([i, vpDownMax, pp]);
        }
      });
    // For each plot type, keep only blocks at the best interval for the
    // current zoom. This prevents rendering bars at wildly different widths
    // simultaneously (e.g. 60s bars on top of 3600s bars).
    (function() {
      var byType = {};
      for (var j = 0; j < activePlot.length; j++) {
        var p = data[activePlot[j]];
        if (!p || p.category === 'point' || p.interval === undefined) continue;
        var t = p.type;
        if (!byType[t]) byType[t] = {};
        if (!byType[t][p.interval]) byType[t][p.interval] = [];
        byType[t][p.interval].push(j);
      }
      for (t in byType) {
        var ivs = byType[t];
        var keys = Object.keys(ivs);
        if (keys.length <= 1) continue;
        var best = null;
        // If the caller has set an explicit render interval and we have
        // blocks at that interval, use it — the GUI owns the transition
        // policy via setRenderInterval().
        if (renderInterval !== null && ivs[renderInterval]) {
          best = +renderInterval;
        } else {
          // Fallback: finest interval whose bar width is at least 2px;
          // if none qualify, the coarsest available — better wide-but-
          // readable bars than invisible sub-pixel ones.
          var coarsest = null;
          for (var k = 0; k < keys.length; k++) {
            var iv = +keys[k];
            var w = iv * 1000 * ppms;
            if (coarsest === null || iv > coarsest) coarsest = iv;
            if (w >= 2 && (best === null || iv < best)) best = iv;
          }
          if (best === null) best = coarsest;
        }
        for (k = 0; k < keys.length; k++) {
          if (+keys[k] !== best) {
            for (var m = 0; m < ivs[keys[k]].length; m++)
              activePlot[ivs[keys[k]][m]] = -1;
          }
        }
      }
      if (activePlot.indexOf(-1) !== -1) {
        var kept = [];
        for (j = 0; j < activePlot.length; j++)
          if (activePlot[j] !== -1) kept.push(activePlot[j]);
        activePlot = kept;
        ymax_array = ymax_array.filter(function(a) { return activePlot.indexOf(a[0]) !== -1; });
        ymin_array = ymin_array.filter(function(a) { return activePlot.indexOf(a[0]) !== -1; });
      }
    })();
    ymax_array.sort(function (first, second) {
      return second[1] - first[1];
    });
    if (ymax_array.length > 1) {
      var s = easeInOutExpo((ymax_array[0][2] / ymax_array[1][2]) * 4);
      ymax = s * ymax_array[0][1] + (1 - s) * ymax_array[1][1];
    } else if (ymax_array.length === 1) ymax = ymax_array[0][1];
    else ymax = 0;
    // Mirror the ymax blend for downward-stack magnitudes; ymin = -blend.
    ymin_array.sort(function (first, second) {
      return second[1] - first[1];
    });
    var _downMax = 0;
    if (ymin_array.length > 1) {
      var sd = easeInOutExpo((ymin_array[0][2] / ymin_array[1][2]) * 4);
      _downMax = sd * ymin_array[0][1] + (1 - sd) * ymin_array[1][1];
    } else if (ymin_array.length === 1) _downMax = ymin_array[0][1];
    ymin = -_downMax;

    ygrid = [];
    // A span plot labels its axis with lane names at row centres, not numeric
    // ticks — row indices carry no quantity worth printing. Only honoured when
    // it is the sole active plot, since the shared axis cannot mean two things
    // at once.
    var _spanTicks = null;
    if (activePlot.length === 1 && data[activePlot[0]]
        && data[activePlot[0]].category === 'span')
      _spanTicks = data[activePlot[0]].yticks || [];

    if (ymax > ymin) {
      ppv = plotHeight / (ymax - ymin);
      vpp = 1 / ppv;
      if (_spanTicks) {
        // Lane blocks vary in height, so thin the labels by actual pixel
        // spacing rather than by index; the lane separators drawn by the
        // renderer still delimit the ones left unlabelled.
        var _lastY = -Infinity;
        for (var ti = 0; ti < _spanTicks.length; ti++) {
          var _ty = Y(_spanTicks[ti].y);
          var _fits = _ty - _lastY >= font_height;
          if (_fits) _lastY = _ty;
          ygrid.push({
            label: _fits ? _spanTicks[ti].label : "",
            y: _spanTicks[ti].y,
            noline: true,
          });
        }
      } else {
        s = vpp * font_height;
        var step = Math.pow(10, Math.ceil(Math.log10(s)));
        //if (s / step <= 0.2) step = 0.2 * step;
        if (s / step <= 0.5) step = 0.5 * step;
        // Iterate by integer count, not `i += step`, to avoid accumulated FP
        // error producing labels like "0.15000000000000002" for step=0.05.
        // parseFloat(toFixed(d)) trims any single-multiplication residue too.
        var decimals = Math.max(0, -Math.floor(Math.log10(step)));
        var labelEvery = step > vpp * 2 * font_height ? 1 : 2;
        var n = Math.round(ymax / step);
        for (var k = 0; k <= n; k++) {
          var v = parseFloat((k * step).toFixed(decimals));
          ygrid.push({
            label: k % labelEvery === 0 ? _yFmt(v) : "",
            y: v,
          });
        }
        // Negative ticks for butterfly plots; ymin < 0 only when at least
        // one active plot has down-stacked series.
        if (ymin < 0) {
          var nmin = Math.round(-ymin / step);
          for (k = 1; k <= nmin; k++) {
            v = parseFloat((-k * step).toFixed(decimals));
            ygrid.push({
              label: k % labelEvery === 0 ? _yFmt(v) : "",
              y: v,
            });
          }
        }
      }
    }

    // Animate margin.left — width from actual ygrid label text so longest label touches canvas left
    var _yLabelW = 0;
    if (ygrid.length > 0) {
      c.font = yFont();
      ygrid.forEach(function (item) {
        var w = c.measureText(String(item.label)).width;
        if (w > _yLabelW) _yLabelW = w;
      });
    }
    // If a yAxisLabel is set, it sits above the top grid line; include its width
    if (_yLabel) {
      c.font = yFont();
      var _yw = c.measureText(_yLabel).width;
      if (_yw > _yLabelW) _yLabelW = _yw;
    }
    // +4 preserves the existing 4px gap between label right-edge and axis line
    var margin_left_new = ygrid.length > 0 ? Math.ceil(_yLabelW) + 4 + basePad.left : basePad.left;
    if (!margin_left_initialized) {
      margin.left = margin_left_new;
      margin_left_anim = { from: margin_left_new, to: margin_left_new, startT: 0, dur: 0 };
      margin_left_initialized = true;
    } else if (margin_left_new !== margin_left_anim.to) {
      margin_left_anim = { from: margin.left, to: margin_left_new, startT: Date.now(), dur: 300 };
    }
    var mlt = margin_left_anim.dur > 0
      ? Math.min(1, (Date.now() - margin_left_anim.startT) / margin_left_anim.dur)
      : 1;
    margin.left = Math.round(margin_left_anim.from + (margin_left_anim.to - margin_left_anim.from) * easeInOutExpo(mlt));
    if (mlt < 1) scheduleAxisTransition();
    plotWidth = canvas.width - margin.left - margin.right;

    // Fade in y-axis labels / lines when data enters the viewport
    var has_ygrid = ygrid.length > 0;
    if (!ygrid_initialized) {
      ygrid_alpha = has_ygrid ? 1.0 : 0.0;
      ygrid_had_data = has_ygrid;
      ygrid_initialized = true;
    } else if (has_ygrid !== ygrid_had_data) {
      ygrid_had_data = has_ygrid;
      if (has_ygrid) { ygrid_alpha = 0; ygrid_anim_startT = Date.now(); }
    }
    if (has_ygrid && ygrid_alpha < 1) {
      ygrid_alpha = Math.min(1, (Date.now() - ygrid_anim_startT) / 300);
      if (ygrid_alpha < 1) scheduleAxisTransition();
    }

    // milliseconds
    var part = time_part(part1000, 1, dvtl);
    var partl = time_part(part1000, 1, dtl);
    grid[0] = [];
    if (part)
      for (var t = Math.floor(tmin); t <= Math.ceil(tmax); t++) {
        if (t % part === 0) {
          var d = new Date(t);
          grid[0].push({
            tm: d,
            label:
              t % partl === 0 && t % 1000 > 0
                ? ":" +
                  String(d.getSeconds()).padStart(2, "0") +
                  "." +
                  String(d.getMilliseconds()).padStart(3, "0")
                : false,
            x: X(t),
            len: part * ppms,
            fill:
              part === 1
                ? t % 2
                  ? settings.colors.stripMs[0]
                  : settings.colors.stripMs[1]
                : false,
          });
        }
      }

    // seconds
    part = time_part(part60, f.s, dvtl);
    partl = time_part(part60, f.s, dtl);
    grid[1] = [];
    if (part)
      for (t = Math.floor(tmin / f.s) * f.s; t <= tmax; t += f.s) {
        d = new Date(t);
        s = d / 1000;
        if (s % part === 0)
          grid[1].push({
            tm: d,
            label: s % partl === 0,
            x: X(t),
            len: part * ppms * f.s,
            fill:
              part === 1
                ? s % 2
                  ? settings.colors.stripSecond[0]
                  : settings.colors.stripSecond[1]
                : false,
          });
      }

    // minutes
    part = time_part(part60, f.m, dvtl);
    partl = time_part(part60, f.m, dtl);
    grid[2] = [];
    if (part)
      for (t = Math.floor(tmin / f.m) * f.m; t <= tmax; t += f.m) {
        d = new Date(t);
        var m = d.getMinutes();
        if (m % part === 0)
          grid[2].push({
            tm: d,
            label: m % partl === 0,
            x: X(t),
            len: part * ppms * f.m,
            fill:
              part === 1
                ? m % 2
                  ? settings.colors.stripMinute[0]
                  : settings.colors.stripMinute[1]
                : false,
          });
      }

    // hours
    grid[3] = [];
    part = time_part(part24, f.h, dvtl);
    partl = time_part(part24, f.h, dtl);
    if (part)
      for (t = Math.floor(tmin / f.h) * f.h; t <= tmax; t += f.h) {
        d = new Date(t);
        var h = d.getHours();
        if (h % part === 0)
          grid[3].push({
            tm: d,
            label: h % partl === 0,
            x: X(t),
            len: part * ppms * f.h,
            fill:
              part === 1
                ? h % 2
                  ? settings.colors.stripHour[0]
                  : settings.colors.stripHour[1]
                : false,
          });
      }

    // days
    grid[4] = [];
    var space = ppms * f.d;
    if (space > dvtl)
      for (
        t = new Date(new Date(tmax).toDateString());
        t >= tmin - f.d;
        t = new Date(new Date(t - 12 * f.h).toDateString())
      ) {
        var x;
        if (t < tmin) x = margin.left;
        else x = X(t);
        var l = grid[4].length;
        var len;
        if (l) len = grid[4][l - 1].x - x;
        else len = canvas.width - margin.right - x;
        h = isHoliday(t);
        var bh = h !== false;
        if (h) {
          if (holiday_pixels[h] > len) h = label(t, "day", len);
          else
            h = (label(t, "day", len - holiday_pixels[h] - 5) + " " + h).trim();
        }
        var wd = t.getDay();
        var fill = settings.colors.dayDefault;
        if (wd === 0 || wd === 6 || bh) fill = settings.colors.dayWeekend;
        else if (wd % 2) fill = settings.colors.dayOdd;
        grid[4].push({
          tm: t,
          label: h ? h : label(t, "day", len),
          x: x,
          len: len,
          fill: fill,
          cw: wd === 1 ? getWeek(t) : "",
          browse: t <= tmin && len + x >= canvas.width - margin.right,
        });
      }

    // months
    grid[5] = [];
    space = ppms * f.d * 31;
    var dm = dtm;
    if (space > dvtl) {
      while (true) {
        t = new Date(
          Date.parse(dm.getFullYear() + "-" + (dm.getMonth() + 1) + "-1 00:00"),
        );
        if (t < tmin) x = margin.left;
        else x = X(t);
        l = grid[5].length;
        if (l) len = grid[5][l - 1].x - x;
        else len = canvas.width - margin.right - x;
        grid[5].push({
          tm: t,
          label: label(t, "month", len),
          x: x,
          len: len,
          fill:
            t.getMonth() % 2 ? settings.colors.monthOdd : settings.colors.monthEven,
          browse: t <= tmin && len + x >= canvas.width - margin.right,
        });
        dm = new Date(t - 1);
        if (dm < tmin) break;
      }
    }

    // years
    dm = dtm;
    grid[6] = [];
    space = ppms * f.d * 365;
    if (space > dvtl) {
      for (
        t = new Date(Date.parse(dm.getFullYear() + "-1-1 00:00"));
        t >= tmin - 366 * f.d;
        t = new Date(
          Date.parse(new Date(t - 70 * f.d).getFullYear() + "-1-1 00:00"),
        )
      ) {
        if (t < tmin) x = margin.left;
        else x = X(t);
        l = grid[6].length;
        if (l) len = grid[6][l - 1].x - x;
        else len = canvas.width - margin.right - x;
        grid[6].push({
          tm: t,
          label: label(t, "year", len),
          x: x,
          len: len,
          fill:
            t.getFullYear() % 2 ? settings.colors.yearOdd : settings.colors.yearEven,
          browse: t <= tmin && len + x >= canvas.width - margin.right,
        });
      }
    }

    var new_level = labels.day_pixels[labels.day_pixels.length - 1] > ppms * f.d ? 1 : 0;
    if (new_level !== label_level) {
      label_level_prev = label_level;
      label_level = new_level;
      label_level_alpha = 0;
      label_anim_startT = Date.now();
    }
    if (label_level_alpha < 1) {
      label_level_alpha = Math.min(1, (Date.now() - label_anim_startT) / label_anim_dur);
      if (label_level_alpha < 1) scheduleAxisTransition();
    }

    // Animate margin.bottom when vertical time labels (10:00, 11:00 …) appear / disappear
    var has_time_labels = false;
    for (var tli = 0; tli < 4 && !has_time_labels; tli++)
      if (grid[tli]) for (var tlj = 0; tlj < grid[tli].length && !has_time_labels; tlj++)
        if (grid[tli][tlj].label) has_time_labels = true;
    var margin_bottom_new = (has_time_labels ? font_width + LABEL_GAP : 0) + basePad.bottom;
    if (!margin_bottom_initialized) {
      margin.bottom = margin_bottom_new;
      margin_bottom_anim = { from: margin_bottom_new, to: margin_bottom_new, startT: 0, dur: 0 };
      margin_bottom_initialized = true;
    } else if (margin_bottom_new !== margin_bottom_anim.to) {
      margin_bottom_anim = { from: margin.bottom, to: margin_bottom_new, startT: Date.now(), dur: 250 };
    }
    var mbt = margin_bottom_anim.dur > 0
      ? Math.min(1, (Date.now() - margin_bottom_anim.startT) / margin_bottom_anim.dur)
      : 1;
    margin.bottom = Math.round(margin_bottom_anim.from + (margin_bottom_anim.to - margin_bottom_anim.from) * easeInOutExpo(mbt));
    if (mbt < 1) scheduleAxisTransition();
    plotHeight = canvas.height - margin.top - margin.bottom;
  }

  function X(t) {
    return ((t - tmin) / (tmax - tmin)) * plotWidth + margin.left;
  }

  function rT(x) {
    return ((x - margin.left) / plotWidth) * (tmax - tmin) + tmin;
  }

  function Y(y) {
    return ((ymax - y) / (ymax - ymin)) * plotHeight + margin.top;
  }

  function rY(py) {
    return ymax - ((py - margin.top) / plotHeight) * (ymax - ymin);
  }

  function rotateText(text, x, y) {
    c.save();
    c.translate(x, y);
    c.rotate(-Math.PI / 2);
    c.fillText(text, 0, 0);
    c.restore();
  }

  function label(date, format, size) {
    for (var i = 0; i < labels[format].length; i++)
      if (size > labels[format + "_pixels"][i])
        return date.toLocaleString(nls, labels[format][i]);
    return "";
  }

  function vertical_label(t, x, y) {
    var text = String(t.getHours()) + ":" + String(t.getMinutes()).padStart(2, "0");
    if (t % f.m > 0) text = ":" + String(t.getSeconds()).padStart(2, "0");
    if (t % 1000 > 0)
      text += "." + String(t.getMilliseconds()).padStart(3, "0");
    if (x >= margin.left) rotateText(text, x, y);
  }

  function horizontal_label(item, position) {
    c.textAlign = "center";
    c.textBaseline = "bottom";
    c.fillStyle = item.fill;
    c.fillRect(item.x, position - font_height, item.len, font_height);
    c.fillStyle = settings.colors.text;
    c.fillText(item.label, item.x + item.len / 2, position - 1);
    if (item.browse) {
      c.textAlign = "left";
      c.fillText("«", margin.left + 4, position - 1);
      c.textAlign = "right";
      c.fillText("»", canvas.width - margin.right - 4, position - 1);
    }
    c.beginPath();
    c.moveTo(item.x, position);
    c.lineTo(item.x, position - font_height);
    c.lineTo(item.x + item.len, position - font_height);
    c.stroke();
  }

  function vertical_line(t, color) {
    var x = X(+t);
    c.strokeStyle = color;
    c.beginPath();
    c.moveTo(x, margin.top);
    c.lineTo(x, margin.top + plotHeight);
    c.stroke();
  }

  function background() {
    c.fillStyle = settings.colors.plotBg;
    c.fillRect(margin.left, margin.top, plotWidth, plotHeight);
    Object.keys(grid)
      .reverse()
      .forEach(function (layer) {
        grid[layer].forEach(function (item) {
          if (item.fill) {
            c.fillStyle = item.fill;
            c.fillRect(item.x, margin.top, item.len, plotHeight);
          }
          vertical_line(item.tm, settings.colors.gridLine);
          if (item.cw) {
            c.font = xFont();
            c.textAlign = "left";
            var x = X(item.tm);
            if (x < margin.left) x = margin.left;
            c.fillStyle = settings.colors.weekNumber;
            c.textAlign = "left";
            c.textBaseline = "bottom";
            c.fillText(item.cw, x + 1, canvas.height - margin.bottom);
          }
        });
      });
  }

  // Draw horizontal axis label rows for a given label_level at the given alpha.
  function drawAxisLabels(lvl, alpha) {
    if (alpha <= 0) return;
    c.globalAlpha = alpha;
    if (lvl === 0) grid[4].forEach(function (item) { horizontal_label(item, margin.top); });
    grid[5].forEach(function (item) { horizontal_label(item, margin.top - (1 - lvl) * font_height); });
    if (lvl > 0) grid[6].forEach(function (item) { horizontal_label(item, margin.top - font_height); });
    c.globalAlpha = 1;
  }

  function frame() {
    c.fillStyle = settings.colors.frameBg;
    c.fillRect(0, 0, canvas.width, margin.top);
    c.fillRect(0, margin.top, margin.left, canvas.height - margin.top);
    c.fillRect(
      margin.left,
      canvas.height - margin.bottom,
      canvas.width - margin.left,
      margin.bottom,
    );
    c.fillRect(
      canvas.width - margin.right,
      margin.top,
      margin.right,
      plotHeight,
    );
    c.beginPath();
    c.moveTo(margin.left, margin.top);
    c.lineTo(canvas.width - margin.right, margin.top);
    c.lineTo(canvas.width - margin.right, canvas.height - margin.bottom);
    c.lineTo(margin.left, canvas.height - margin.bottom);
    c.lineTo(margin.left, margin.top);
    c.moveTo(canvas.width - margin.right, margin.top);
    c.lineTo(canvas.width - margin.right, margin.top - 2 * font_height);
    c.strokeStyle = settings.colors.text;
    c.stroke();
    c.fillStyle = settings.colors.text;
    c.font = xFont();
    c.textAlign = "right";
    c.textBaseline = "middle";
    for (var level = 0; level < 4; level++)
      grid[level].forEach((item, i) => {
        if (item.label)
          vertical_label(
            item.tm,
            X(item.tm),
            canvas.height - margin.bottom + 4,   // offset accounted for by LABEL_GAP
          );
      });
    if (label_level_alpha < 1) drawAxisLabels(label_level_prev, 1 - label_level_alpha);
    drawAxisLabels(label_level, label_level_alpha);
    if (ygrid.length > 0 && ygrid_alpha > 0) {
      c.globalAlpha = ygrid_alpha;
      c.fillStyle = settings.colors.text;
      c.font = yFont();
      c.textAlign = "right";
      c.textBaseline = "middle";
      ygrid.forEach(function (item) {
        // Skip labels whose tick value falls outside the visible y-range
        // (e.g. the topmost tick rounded up past ymax).
        if (item.y < ymin || item.y > ymax) return;
        c.fillText(String(item.label), margin.left - 4, Y(item.y));
      });
      if (_yLabel) {
        // Sit a full font_height above the top grid line so the topmost
        // (center-aligned) tick label has clearance below the y-axis label.
        c.textBaseline = "bottom";
        c.fillText(_yLabel, margin.left - 4, margin.top - font_height);
      }
      c.globalAlpha = 1;
    }
  }

  function yAxis() {
    if (!ygrid.length || ygrid_alpha <= 0) return;
    c.globalAlpha = ygrid_alpha;
    c.strokeStyle = settings.colors.gridLineY;
    ygrid.forEach(function (item) {
      // Span ticks sit at lane centres, where a grid line would cut straight
      // through the bars it labels.
      if (item.noline) return;
      var y = Y(item.y);
      c.beginPath();
      c.moveTo(margin.left, y);
      c.lineTo(margin.left + plotWidth, y);
      c.stroke();
    });
    c.globalAlpha = 1;
  }

  var VERSION_TAG_URL = 'https://github.com/hgruber/timeseries.js';
  // Clickable area of the version tag, in canvas-local pixels — set by
  // versionTag() on every draw, read by hitVersionTag() for cursor/click
  // handling. The two stay in step because the rect is measured off the
  // same font/text versionTag() draws with, not duplicated by hand.
  var versionTagRect = null;

  // Small, unobtrusive build tag in the bottom-left margin corner — sits on
  // the frameBg painted by frame(), so draw it after frame() has run.
  function versionTag() {
    var tag = 'timeseries.js ' + VERSION;
    c.save();
    c.font = '8px sans-serif';
    var w = c.measureText(tag).width;
    var y1 = canvas.height - 3;
    versionTagRect = { x0: 3, y0: y1 - 8, x1: 3 + w, y1: y1 };
    c.globalAlpha = 0.35;
    c.fillStyle = settings.colors.text;
    c.textAlign = 'left';
    c.textBaseline = 'bottom';
    c.fillText(tag, versionTagRect.x0, y1);
    c.restore();
  }

  // A little forgiveness around the measured text box, same rationale as
  // POINT_RADIUS's mouse "grab" padding elsewhere in this file.
  function hitVersionTag(e) {
    if (!versionTagRect) return false;
    var x = e.clientX - offset.x, y = e.clientY - offset.y;
    return x >= versionTagRect.x0 - 2 && x <= versionTagRect.x1 + 2 &&
           y >= versionTagRect.y0 - 2 && y <= versionTagRect.y1 + 2;
  }

  function redLine() {
    var x = X(now);
    c.beginPath();
    c.moveTo(x, margin.top);
    c.lineTo(x, margin.top + plotHeight);
    c.strokeStyle = settings.colors.nowLine;
    c.stroke();
    c.font = xFont();
    c.fillStyle = settings.colors.text;
  }

  // NOTE: currently unused — and the sole consumer of settings.colors.future,
  // which every theme still defines. The "fog of future" overlay is therefore
  // dead: either call this from plotAll() or drop both it and the colour.
  // eslint-disable-next-line no-unused-vars
  function fog_of_future() {
    if (now >= tmax) return;
    var x;
    if (now < tmin) x = margin.left;
    else x = X(now);
    c.fillStyle = settings.colors.future;
    c.fillRect(x, margin.top, plotWidth, plotHeight);
  }

  function doStop() {
    follow_stopped = true;
    _suppressTick = false;
    if (follow_stop_cb) follow_stop_cb();
    scheduleNowLine();
    if (!_syncing && _currentGroup) _groupStopFollow(_currentGroup, _handle);
  }

  function doFollow(p) {
    if (nowline_timer !== null) { clearTimeout(nowline_timer); nowline_timer = null; }
    follow_stopped = false;
    follow_fraction = Math.max(0, Math.min(100, p)) / 100;
    if (follow_start_cb) follow_start_cb(Math.round(follow_fraction * 100));
  }

  // Animated entry: zoom to position then start/continue rolling.
  function follow_animated(p) {
    doFollow(p);
    var range = tmax - tmin;
    zoom(Date.now() - follow_fraction * range, Date.now() + (1 - follow_fraction) * range);
    setTimeout(start_follower, zoom_onclick_time);
  }

  // Immediate snap: update fraction, reposition view at once, start/continue rolling.
  this.follow = function (p) {
    doFollow(p);
    now = Date.now();
    var range = tmax - tmin;
    tmin = now - follow_fraction * range;
    tmax = tmin + range;
    start_follower();
    plotAll();
  };
  this.followNow  = function () { follow_animated(100); };
  this.previewNow = function () { follow_animated(0); };
  this.stop     = function () { doStop(); };
  this.clearAll = function () { data = []; freeSlots = []; plotAll(); };
  // Force a repaint. The same thing sources get as requestRedraw(), exposed
  // for hosts that mutate a plot object they pushed (e.g. re-packing a span
  // plot after a layout change).
  this.redraw = function () { plotAll(); };
  // Remove every plot block for which pred(plot) is true, then redraw.
  // Lets a host app that shows one logical series at a time evict stale
  // blocks of a different type/measure that pushData intentionally keeps
  // (pushData only trims overlapping blocks of the *same* type, so it can
  // overlay e.g. bars + lines).
  this.dropData = function (pred) {
    var changed = false;
    for (var i = 0; i < data.length; i++)
      if (data[i] && pred(data[i])) { releaseSlot(i); changed = true; }
    if (changed) plotAll();
  };
  this.getData = function () { return data; };
  this.getActiveData = function () { return activePlot.map(i => data[i]).filter(Boolean); };
  this.getRenderBounds = function () {
    return { tmin: rT(margin.left), tmax: rT(margin.left + plotWidth) };
  };
  this.getViewport = function () { return { tmin: tmin, tmax: tmax, ppms: ppms }; };
  this.getPlotArea = function () { return { margin: margin, plotWidth: plotWidth, plotHeight: plotHeight }; };
  // Overlays need the element to track the pointer against; the core resolves
  // it from settings.canvas and is the only one that knows which it got.
  this.getCanvas = function () { return canvas; };
  this.onStop   = function (fn) { follow_stop_cb = fn; };
  this.onFollow = function (fn) { follow_start_cb = fn; };

  function onClickDataCallback(fn) {
    onClickData = fn;
  }

  // Subscribes (does not replace) and hands back an unsubscribe, so an overlay
  // can detach cleanly. Callback args: (plot, n, key, value), with all four
  // null meaning "nothing hit" — that is the signal to hide.
  function onHoverDataCallback(fn) {
    hoverDataHandlers.push(fn);
    return function () {
      var i = hoverDataHandlers.indexOf(fn);
      if (i !== -1) hoverDataHandlers.splice(i, 1);
    };
  }

  this.setColors = function (obj) {
    Object.assign(settings.colors, obj);
    plotAll();
    notifyColorsChange();
  };

  // Fires after the palette changes. DOM overlays (the tooltip) restyle from
  // here — without it a theme switch would repaint the canvas and leave every
  // overlay on the old colours.
  this.onColorsChange = function (fn) {
    colorsChangeHandlers.push(fn);
    return function () {
      var i = colorsChangeHandlers.indexOf(fn);
      if (i !== -1) colorsChangeHandlers.splice(i, 1);
    };
  };

  // Copies, so callers cannot mutate the live settings behind the chart's back.
  this.getColors = function () { return Object.assign({}, settings.colors); };
  this.getHolidays = function () { return Object.assign({}, settings.holidays); };

  // ── Series visibility ─────────────────────────────────────────────────────
  // Enough for a caller to build a legend: the series currently on screen,
  // each with the colour it was actually painted in and whether it is hidden.
  // The library deliberately does not build any DOM itself.
  //
  // Ids are collected across all active plots, so two blocks sharing a series
  // yield one entry. `label` prefers point-series metadata (plot.series[].name)
  // and falls back to the raw id.
  this.getSeries = function () {
    var out = [];
    var seen = Object.create(null);
    for (const plot of this.getActiveData()) {
      var names = Object.create(null);
      if (plot.series)
        for (const s of plot.series) names[String(s.id)] = s.name || s.label;
      for (const id of plotSeriesIds(plot)) {
        if (seen[id]) continue;
        seen[id] = 1;
        out.push({
          id: id,
          label: names[id] || id,
          color: resolveColor(plot, id, 1),
          hidden: hiddenSeries.has(id),
        });
      }
    }
    return out;
  };

  this.setSeriesHidden = function (id, hide) {
    var key = String(id);
    var was = hiddenSeries.has(key);
    if (hide) hiddenSeries.add(key); else hiddenSeries.delete(key);
    if (was !== hiddenSeries.has(key)) { plotAll(); notifySeriesChange(); }
  };

  this.toggleSeries = function (id) {
    this.setSeriesHidden(id, !hiddenSeries.has(String(id)));
  };

  this.showAllSeries = function () {
    if (!hiddenSeries.size) return;
    hiddenSeries.clear();
    plotAll();
    notifySeriesChange();
  };

  // Fires after the hidden set changes. Note it does NOT fire when new data
  // arrives with previously unseen series — poll getSeries() after pushing, or
  // call it from your own source's callback.
  this.onSeriesChange = function (fn) { seriesChangeHandlers.push(fn); };

  this.setRenderInterval = function (iv) {
    renderInterval = (iv == null) ? null : +iv;
    plotAll();
  };

  this.setYAxisLabel = function (lbl) {
    _yLabel = lbl || '';
    plotAll();
  };

  this.setWatermark = function (src) {
    if (!src) { _watermarkImg = null; plotAll(); return; }
    if (typeof src === 'string') {
      var img = new Image();
      img.onload = function () { _watermarkImg = img; plotAll(); };
      img.onerror = function () { console.warn('TimeSeries: watermark failed to load', src); };
      img.src = src;
    } else {
      _watermarkImg = src;
      plotAll();
    }
  };

  this.onClickDataCallback = onClickDataCallback;
  this.onHoverDataCallback = onHoverDataCallback;

  if (settings.watermark) this.setWatermark(settings.watermark);
  plotAll();
  var self = this;
  if (settings.initialView) setTimeout(function () { self[settings.initialView](); }, 0);
}

// ── Statics ───────────────────────────────────────────────────────────────────
// Module scope, not inside the constructor: consumers of the IIFE build call
// TimeSeries.registerSource(...) *before* creating their first chart, and these
// used to only exist once an instance had been constructed.
TimeSeries.registerRenderer = registerRenderer;
TimeSeries.registerSource = registerSource;
TimeSeries.seriesColor = seriesColor;
// Exposed so an overlay can reproduce exactly what a renderer painted for a
// series, plot.series_colors overrides included.
TimeSeries.resolveColor = resolveColor;
TimeSeries.attachTooltip = attachTooltip;
TimeSeries.lttb = lttb;
TimeSeries.siFormat = siFormat;
TimeSeries.VERSION = VERSION;

// ── Named colour themes ───────────────────────────────────────────────────────
// Each theme is a complete colors object suitable for new TimeSeries({ colors: … })
// or ts.setColors(TimeSeries.themes.dark).

TimeSeries.themes = {

  // ── Default (light blue) ─────────────────────────────────────────────────
  // Not a copy of the built-in defaults — literally the same object.
  light: DEFAULT_COLORS,

  // ── Dark ─────────────────────────────────────────────────────────────────
  dark: {
    frameBg:     '#1a1f2e',
    text:        '#c8d8e8',
    plotBg:      '#0f1420',
    gridLine:    'rgba(150,165,190,0.22)',
    gridLineY:   'rgba(150,165,190,0.32)',
    weekNumber:  '#4a5a6a',
    nowLine:     'rgba(255,90,90,0.75)',
    future:      'rgba(0,0,0,0.38)',
    stripMs:     ['rgba(35,42,60,0.60)', 'rgba(50,62,88,0.60)'],
    stripSecond: ['rgba(60,58,25,0.55)', 'rgba(82,78,20,0.55)'],
    stripMinute: ['rgba(22,52,28,0.55)', 'rgba(22,72,32,0.55)'],
    stripHour:   ['rgba(24,28,62,0.55)', 'rgba(24,28,85,0.55)'],
    dayDefault:  'rgba(55,68,92,0.42)',
    dayWeekend:  'rgba(120,38,38,0.48)',
    dayOdd:      'rgba(45,52,70,0.35)',
    yearOdd:     'rgba(255,255,255,0.04)',
    yearEven:    'rgba(90,115,150,0.09)',
    monthOdd:    'rgba(42,88,145,0.48)',
    monthEven:   'rgba(55,68,92,0.38)',
    tooltipBg:     'rgba(30,30,30,0.92)',
    tooltipBorder: '#555',
    tooltipShadow: 'rgba(0,0,0,0.4)',
    tooltipText:   '#ddd',
    tooltipTitle:  '#ccc',
    tooltipMuted:  '#888',
  },

  // ── High contrast (WCAG-friendly) ────────────────────────────────────────
  highContrast: {
    frameBg:     '#ffffff',
    text:        '#000000',
    plotBg:      '#ffffff',
    gridLine:    'rgba(0,0,0,0.50)',
    gridLineY:   'rgba(0,0,0,0.62)',
    weekNumber:  '#333333',
    nowLine:     'rgba(200,0,0,0.92)',
    future:      'rgba(80,80,80,0.28)',
    stripMs:     ['rgba(215,215,215,0.75)', 'rgba(160,160,160,0.75)'],
    stripSecond: ['rgba(255,255,170,0.85)', 'rgba(255,240,100,0.85)'],
    stripMinute: ['rgba(170,255,170,0.85)', 'rgba(90,230,90,0.85)'],
    stripHour:   ['rgba(170,170,255,0.85)', 'rgba(90,90,230,0.85)'],
    dayDefault:  'rgba(140,140,140,0.52)',
    dayWeekend:  'rgba(255,80,80,0.55)',
    dayOdd:      'rgba(180,180,180,0.45)',
    yearOdd:     'rgba(255,255,255,0.55)',
    yearEven:    'rgba(195,195,195,0.55)',
    monthOdd:    'rgba(0,80,200,0.65)',
    monthEven:   'rgba(195,195,195,0.55)',
    tooltipBg:     '#ffffff',
    tooltipBorder: '#000000',
    tooltipShadow: 'rgba(0,0,0,0.45)',
    tooltipText:   '#000000',
    tooltipTitle:  '#000000',
    tooltipMuted:  '#333333',
  },

  // ── Warm (amber / sepia) ─────────────────────────────────────────────────
  warm: {
    frameBg:     '#fdf6ec',
    text:        '#3d2200',
    plotBg:      '#fffef8',
    gridLine:    'rgba(140,90,30,0.28)',
    gridLineY:   'rgba(140,90,30,0.42)',
    weekNumber:  '#b08040',
    nowLine:     'rgba(200,50,0,0.72)',
    future:      'rgba(180,140,90,0.25)',
    stripMs:     ['rgba(255,242,215,0.58)', 'rgba(242,215,168,0.58)'],
    stripSecond: ['rgba(255,255,195,0.58)', 'rgba(255,242,140,0.58)'],
    stripMinute: ['rgba(215,252,205,0.58)', 'rgba(185,238,168,0.58)'],
    stripHour:   ['rgba(215,210,255,0.58)', 'rgba(188,180,242,0.58)'],
    dayDefault:  'rgba(195,162,118,0.42)',
    dayWeekend:  'rgba(255,148,105,0.52)',
    dayOdd:      'rgba(222,192,148,0.38)',
    yearOdd:     'rgba(255,248,232,0.52)',
    yearEven:    'rgba(238,220,192,0.52)',
    monthOdd:    'rgba(175,105,32,0.48)',
    monthEven:   'rgba(238,218,185,0.48)',
    tooltipBg:     'rgba(253,246,236,0.94)',
    tooltipBorder: '#d8bc93',
    tooltipShadow: 'rgba(120,80,30,0.22)',
    tooltipText:   '#3d2200',
    tooltipTitle:  '#7a4b12',
    tooltipMuted:  '#b08040',
  },
};
