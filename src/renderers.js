// Renderer plugin registry and built-in renderers for timeseries.js
//
// Each renderer plugin is: { type: string, draw(plot, rctx), highlight?(plot, n, item, rctx) }
// rctx shape: { c, X, Y, ppms, ppv, margin, plotWidth, plotHeight }

const registry = new Map();

/**
 * Register a renderer plugin for a given plot type.
 * @param {{ type: string, draw: function, highlight?: function }} plugin
 */
export function registerRenderer(plugin) {
  registry.set(plugin.type, plugin);
}

/**
 * Merge several binned plot blocks that share the global slot grid into one
 * synthetic plot. Each block keys its slots relative to its own
 * `interval_start` (a multiple of `interval`); rebasing every slot onto the
 * group's earliest `interval_start` yields a single continuous `data` map so a
 * line/area renderer draws across fetch-block margins instead of leaving a
 * one-slot hole at each boundary. Color/label metadata is taken from the
 * blocks (series_colors merged, first non-empty name/percentiles win).
 */
function coalesceBlocks(group, data) {
  if (group.length === 1) return data[group[0]];
  var base = data[group[0]];
  var interval = base.interval;
  var baseStart = Infinity;
  for (const i of group) if (data[i].interval_start < baseStart) baseStart = data[i].interval_start;
  var merged = {
    type: base.type,
    category: base.category,
    interval: interval,
    interval_start: baseStart,
    percentiles: base.percentiles,
    data: {},
  };
  var colors = null;
  var name = base.name;
  for (const i of group) {
    var blk = data[i];
    if (blk.percentiles && !merged.percentiles) merged.percentiles = blk.percentiles;
    if (blk.series_colors) colors = Object.assign(colors || {}, blk.series_colors);
    if (name == null) name = blk.name;
    var shift = Math.round((blk.interval_start - baseStart) / interval);
    for (var s in blk.data) merged.data[+s + shift] = blk.data[s];
  }
  if (colors) merged.series_colors = colors;
  if (name != null) merged.name = name;
  return merged;
}

/**
 * Draw all active plots using their registered renderers. A renderer may set
 * `coalesce(plot) -> key`; active blocks of the same type sharing that key are
 * merged (see coalesceBlocks) and drawn once, so connected renderers stay
 * continuous across the separate fetch blocks stored in `data`.
 */
export function plotData(activePlot, data, rctx) {
  var done = null;
  for (const i of activePlot) {
    if (done && done.has(i)) continue;
    const plugin = registry.get(data[i].type);
    if (!plugin) { console.warn('TimeSeries: unknown plot type', data[i].type); continue; }
    if (plugin.coalesce) {
      var key = plugin.coalesce(data[i]);
      var group = [];
      for (const j of activePlot)
        if (data[j].type === data[i].type && plugin.coalesce(data[j]) === key) {
          group.push(j);
          (done || (done = new Set())).add(j);
        }
      plugin.draw(coalesceBlocks(group, data), rctx);
    } else {
      plugin.draw(data[i], rctx);
    }
  }
}

/**
 * Highlight a specific data point using the registered renderer's highlight handler.
 */
export function highlight(plot, n, item, rctx) {
  const plugin = registry.get(plot.type);
  if (plugin && plugin.highlight) plugin.highlight(plot, n, item, rctx);
}

export function seriesColor(i, t) {
  // Strip the '_' prefix that the backend adds to integer-like series keys
  // so JS preserves insertion order. The prefix must not affect color.
  var raw = (i[0] === '_') ? i.slice(1) : i;
  // Convert series key to a numeric seed. Numeric strings use their value;
  // non-numeric strings get a deterministic hash.
  var key = Number(raw);
  if (isNaN(key)) {
    key = 0;
    for (var j = 0; j < raw.length; j++)
      key = ((key << 5) - key + raw.charCodeAt(j)) | 0;
    key = Math.abs(key);
  }
  // Golden-angle hue rotation (~137.5°) gives maximally spaced hues
  // for any consecutive series keys. Fixed saturation/lightness keeps
  // colors vivid and readable on both light and dark backgrounds.
  var hue = (key * 137.508) % 360;
  return 'hsla(' + hue.toFixed(1) + ',65%,50%,' + t + ')';
}

/**
 * Half-size in pixels of the marker each point renderer draws. Shared with the
 * hit test in `get_element` (src/timeseries.js) so that what you can hover is
 * what you can see — the gantt renderer keeps `barRect()` in step the same way.
 *
 * multiline draws no marker at all; its entry is the tolerance for grabbing a
 * vertex of the line. Anything not listed falls back to `default`.
 *
 * Only valid while no renderer downsamples internally: the hit test walks
 * plot.data directly, so drawn points must equal stored points. (A source may
 * apply TimeSeries.lttb before pushing — that is fine, the reduced array is
 * then what both draw and hit-test see.)
 */
export const POINT_RADIUS = {
  multipoint: 2,
  scatter: 3,
  multiline: 4,
  default: 3,
};

/**
 * Series ids present in a plot, in a stable order.
 *
 * Every renderer used to work this out for itself, three different ways — and
 * the point renderers disagreed with the binned ones about what a series is
 * even keyed by. One implementation, so the legend, the hit test and the
 * renderers cannot drift apart.
 *
 * - point:  plot.series metadata if present, else the union of `values` keys
 *           across the whole array (later points may introduce a series).
 * - binned: the union of keys across all slots (sparse slots omit series).
 * - span:   lanes, which is what a span plot's "series" means.
 */
export function plotSeriesIds(plot) {
  if (!plot || !plot.data) return [];
  var ids = [];
  var seen = Object.create(null);
  var add = k => { if (!seen[k]) { seen[k] = 1; ids.push(k); } };

  if (plot.category === 'span') {
    for (const lane of plot.lanes || []) add(String(lane.id));
    return ids;
  }
  if (plot.category === 'point') {
    if (plot.series) for (const s of plot.series) add(String(s.id));
    else for (const pt of plot.data) for (const k in pt.values) add(k);
    return ids;
  }
  for (const s in plot.data) for (const k in plot.data[s]) add(k);
  return ids;
}

// Per-plot color override: a `plot.series_colors` map ({ [seriesKey]: cssColor })
// wins over the auto-hashed color. Hex values get an alpha byte appended so
// stacked bars match the auto-color translucency; named/hsla/rgba colors pass
// through untouched.
//
// Exported because the legend has to reproduce exactly what was painted.
export function resolveColor(plot, i, t) {
  var override = plot.series_colors && plot.series_colors[i];
  if (!override) return seriesColor(i, t);
  if (override[0] === '#' && override.length === 7) {
    var a = Math.round(t * 255).toString(16);
    if (a.length < 2) a = '0' + a;
    return override + a;
  }
  return override;
}

function highlight_multibar(plot, n, item, rctx) {
  var { c, X, Y, ppms, ppv } = rctx;
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  var barWidth = ppms * step;
  var dirs = plot.series_directions;
  var heightUp = 0;
  var heightDown = 0;
  var x = X(start + n * step);
  for (const [i, bar] of Object.entries(plot.data[n])) {
    var down = dirs && dirs[i] === 'down';
    if (i == item) {
      c.fillStyle = resolveColor(plot, i, 0.8);
      if (down) c.fillRect(x, Y(-heightDown), barWidth, ppv * bar);
      else      c.fillRect(x, Y(heightUp),    barWidth, -ppv * bar);
      return;
    }
    if (down) heightDown += bar;
    else      heightUp   += bar;
  }
}

function multibar(plot, rctx) {
  var { c, X, Y, ppms, ppv, margin, plotWidth, hidden } = rctx;
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  var barWidth = ppms * step;
  var dirs = plot.series_directions;
  for (const [t, bars] of Object.entries(plot.data)) {
    var heightUp = 0;
    var heightDown = 0;
    var x = X(start + t * step);
    if (x + barWidth >= margin.left && x <= margin.left + plotWidth)
      for (const [i, bar] of Object.entries(bars)) {
        // Skipped entirely, not drawn transparent: a hidden series must not
        // occupy stack height either, or the visible bars float off the axis.
        if (hidden && hidden.has(i)) continue;
        c.fillStyle = resolveColor(plot, i, 0.8);
        if (dirs && dirs[i] === 'down') {
          c.fillRect(x, Y(-heightDown), barWidth, ppv * bar);
          heightDown += bar;
        } else {
          c.fillRect(x, Y(heightUp), barWidth, -ppv * bar);
          heightUp += bar;
        }
      }
  }
}

function multipoint(plot, rctx) {
  var { c, X, Y, margin, plotWidth, hidden } = rctx;
  var r = POINT_RADIUS.multipoint;
  if (plot.category === 'point') {
    for (const pt of plot.data) {
      var x = X(pt.t);
      if (x >= margin.left && x <= margin.left + plotWidth) {
        for (const [i, v] of Object.entries(pt.values)) {
          if (v == null || (hidden && hidden.has(i))) continue;
          c.fillStyle = resolveColor(plot, i, 0.8);
          c.fillRect(x - r, Y(v) - r, 2 * r, 2 * r);
        }
      }
    }
  } else {
    var start = plot.interval_start * 1000;
    var step = plot.interval * 1000;
    for (const [t, value] of Object.entries(plot.data)) {
      var x = X(start + t * step);
      if (x >= margin.left && x <= margin.left + plotWidth) {
        for (const [i, v] of Object.entries(value)) {
          if (hidden && hidden.has(i)) continue;
          c.fillStyle = resolveColor(plot, i, 0.8);
          c.fillRect(x - r, Y(v) - r, 2 * r, 2 * r);
        }
      }
    }
  }
}

function multiline(plot, rctx) {
  var { c, X, Y, hidden } = rctx;
  c.lineWidth = 1.5;
  if (plot.category === 'point') {
    for (const sid of plotSeriesIds(plot)) {
      if (hidden && hidden.has(sid)) continue;
      var started = false;
      c.beginPath();
      for (const pt of plot.data) {
        var v = pt.values[sid];
        if (v == null) { started = false; continue; }
        var x = X(pt.t);
        if (!started) { c.moveTo(x, Y(v)); started = true; }
        else c.lineTo(x, Y(v));
      }
      c.strokeStyle = resolveColor(plot, sid, 0.8);
      c.stroke();
    }
  } else {
    var start = plot.interval_start * 1000;
    var step = plot.interval * 1000;
    // Slots in chronological order — do not assume slot 0 exists (it may be
    // empty for an arbitrary time window).
    var slots = Object.keys(plot.data).map(Number).sort((a, b) => a - b);
    // Series ids = union across all slots (sparse slots may omit some series).
    for (const i of plotSeriesIds(plot)) {
      if (hidden && hidden.has(i)) continue;
      var started = false;
      c.beginPath();
      for (const t of slots) {
        var val = plot.data[t][i];
        if (val === undefined) { started = false; continue; }
        var x = X(start + t * step);
        if (!started) { c.moveTo(x, Y(val)); started = true; }
        else c.lineTo(x, Y(val));
      }
      c.strokeStyle = resolveColor(plot, i, 0.8);
      c.stroke();
    }
  }
  c.lineWidth = 1;
}

// scatter — PointSeries only: draws a filled circle per data point per series
function scatter(plot, rctx) {
  var { c, X, Y, margin, plotWidth, hidden } = rctx;
  var r = POINT_RADIUS.scatter;
  for (const sid of plotSeriesIds(plot)) {
    if (hidden && hidden.has(sid)) continue;
    c.fillStyle = resolveColor(plot, sid, 0.75);
    for (const pt of plot.data) {
      var v = pt.values[sid];
      if (v == null) continue;
      var x = X(pt.t);
      if (x < margin.left || x > margin.left + plotWidth) continue;
      c.beginPath();
      c.arc(x, Y(v), r, 0, 2 * Math.PI);
      c.fill();
    }
  }
}

// quantile-bands — binned only. Each slot holds, per series, an array of
// percentile values aligned to plot.percentiles (ascending). Lines connect
// slot centers; the area between adjacent percentiles is filled in the series
// color at a fixed per-band alpha (most opaque around the median, fainter in
// the tails). Single series (key '(all)') or multiple binned series.

// Fixed alpha tiers by band position: segments adjacent to the median get the
// highest alpha, halving outward. medianIdx is in percentile-index space.
function bandAlpha(j, npct) {
  var medianIdx = (npct - 1) / 2;
  var dist = Math.abs((j + 0.5) - medianIdx);   // 0.5 for innermost segments
  var tier = Math.round(dist - 0.5);            // 0, 1, 2, ... outward
  return Math.max(0.06, 0.25 * Math.pow(0.5, tier));
}

function quantilebands(plot, rctx) {
  var { c, X, Y, hidden } = rctx;
  var pct = plot.percentiles || [];
  var npct = pct.length;
  if (npct < 2) return;
  if (plot.category === 'point') return;        // binned series only
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  var half = step / 2;
  var slots = Object.keys(plot.data).map(Number).sort(function (a, b) { return a - b; });
  var medianIdx = Math.floor((npct - 1) / 2);   // which line to draw bold

  for (const id of plotSeriesIds(plot)) {
    if (hidden && hidden.has(id)) continue;
    // Fills: one polygon per band segment, broken on slot gaps so disjoint
    // runs don't bridge across missing data.
    for (var j = 0; j < npct - 1; j++) {
      c.fillStyle = resolveColor(plot, id, bandAlpha(j, npct));
      var run = [];
      for (var si = 0; si <= slots.length; si++) {
        var v = si < slots.length ? plot.data[slots[si]][id] : undefined;
        if (v === undefined) {
          if (run.length >= 2) {
            c.beginPath();
            for (var r = 0; r < run.length; r++)
              (r === 0 ? c.moveTo : c.lineTo).call(c, run[r].x, Y(run[r].v[j]));
            for (var r2 = run.length - 1; r2 >= 0; r2--)
              c.lineTo(run[r2].x, Y(run[r2].v[j + 1]));
            c.closePath();
            c.fill();
          }
          run = [];
          continue;
        }
        run.push({ x: X(start + slots[si] * step + half), v: v });
      }
    }
    // Lines: one polyline per percentile, gap-aware. Median bold and opaque.
    for (var jl = 0; jl < npct; jl++) {
      c.lineWidth = (jl === medianIdx) ? 2 : 1;
      c.strokeStyle = resolveColor(plot, id, (jl === medianIdx) ? 0.9 : 0.55);
      var started = false;
      c.beginPath();
      for (var sl = 0; sl < slots.length; sl++) {
        var vv = plot.data[slots[sl]][id];
        if (vv === undefined) { started = false; continue; }
        var x = X(start + slots[sl] * step + half);
        if (!started) { c.moveTo(x, Y(vv[jl])); started = true; }
        else c.lineTo(x, Y(vv[jl]));
      }
      c.stroke();
    }
  }
  c.lineWidth = 1;
}

// Register built-in renderers
registerRenderer({ type: 'multibar',   draw: multibar,   highlight: highlight_multibar });
registerRenderer({ type: 'multiline',  draw: multiline });
registerRenderer({ type: 'multipoint', draw: multipoint });
registerRenderer({ type: 'scatter',    draw: scatter });
// Coalesce abutting quantile-bands fetch blocks (same source + interval) so the
// fan lines and shaded bands run continuously across block margins.
registerRenderer({
  type: 'quantile-bands',
  draw: quantilebands,
  coalesce: function (plot) { return (plot.name || '') + '|' + plot.interval; },
});
