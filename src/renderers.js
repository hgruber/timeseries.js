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

// Per-plot color override: a `plot.series_colors` map ({ [seriesKey]: cssColor })
// wins over the auto-hashed color. Hex values get an alpha byte appended so
// stacked bars match the auto-color translucency; named/hsla/rgba colors pass
// through untouched.
function resolveColor(plot, i, t) {
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
  var { c, X, Y, ppms, ppv, margin, plotWidth } = rctx;
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
  var { c, X, Y, margin, plotWidth } = rctx;
  if (plot.category === 'point') {
    for (const pt of plot.data) {
      var x = X(pt.t);
      if (x >= margin.left && x <= margin.left + plotWidth) {
        for (const [i, v] of Object.entries(pt.values)) {
          c.fillStyle = seriesColor(i, 0.8);
          c.fillRect(x - 2, Y(v) - 2, 4, 4);
          c.fill();
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
          c.fillStyle = seriesColor(i, 0.8);
          c.fillRect(x - 2, Y(v) - 2, 4, 4);
          c.fill();
        }
      }
    }
  }
}

function multiline(plot, rctx) {
  var { c, X, Y } = rctx;
  c.lineWidth = 1.5;
  if (plot.category === 'point') {
    var seriesIds = plot.series ? plot.series.map(s => s.id) : Object.keys(plot.data[0].values);
    var si = 0;
    for (const sid of seriesIds) {
      var started = false;
      c.beginPath();
      for (const pt of plot.data) {
        var v = pt.values[sid];
        if (v == null) { started = false; continue; }
        var x = X(pt.t);
        if (!started) { c.moveTo(x, Y(v)); started = true; }
        else c.lineTo(x, Y(v));
      }
      c.strokeStyle = seriesColor(si, 0.8);
      c.stroke();
      si++;
    }
  } else {
    var start = plot.interval_start * 1000;
    var step = plot.interval * 1000;
    // Slots in chronological order — do not assume slot 0 exists (it may be
    // empty for an arbitrary time window).
    var slots = Object.keys(plot.data).map(Number).sort((a, b) => a - b);
    // Series ids = union across all slots (sparse slots may omit some series).
    var ids = {};
    for (const s of slots) for (const k in plot.data[s]) ids[k] = 1;
    for (const i in ids) {
      var started = false;
      c.beginPath();
      for (const t of slots) {
        var val = plot.data[t][i];
        if (val === undefined) { started = false; continue; }
        var x = X(start + t * step);
        if (!started) { c.moveTo(x, Y(val)); started = true; }
        else c.lineTo(x, Y(val));
      }
      c.strokeStyle = seriesColor(i, 0.8);
      c.stroke();
    }
  }
  c.lineWidth = 1;
}

// scatter — PointSeries only: draws a filled circle per data point per series
function scatter(plot, rctx) {
  var { c, X, Y, margin, plotWidth } = rctx;
  var seriesIds = plot.series ? plot.series.map(s => s.id) : Object.keys(plot.data[0].values);
  var si = 0;
  for (const sid of seriesIds) {
    c.fillStyle = seriesColor(si, 0.75);
    for (const pt of plot.data) {
      var v = pt.values[sid];
      if (v == null) continue;
      var x = X(pt.t);
      if (x < margin.left || x > margin.left + plotWidth) continue;
      c.beginPath();
      c.arc(x, Y(v), 3, 0, 2 * Math.PI);
      c.fill();
    }
    si++;
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
  var { c, X, Y } = rctx;
  var pct = plot.percentiles || [];
  var npct = pct.length;
  if (npct < 2) return;
  if (plot.category === 'point') return;        // binned series only
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  var half = step / 2;
  var slots = Object.keys(plot.data).map(Number).sort(function (a, b) { return a - b; });
  // Series ids = union across all slots (sparse slots may omit some series).
  var ids = {};
  for (var s = 0; s < slots.length; s++)
    for (var k in plot.data[slots[s]]) ids[k] = 1;
  var medianIdx = Math.floor((npct - 1) / 2);   // which line to draw bold

  for (var id in ids) {
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
