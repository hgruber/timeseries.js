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
 * Draw all active plots using their registered renderers.
 */
export function plotData(activePlot, data, rctx) {
  for (const i of activePlot) {
    const plugin = registry.get(data[i].type);
    if (plugin) plugin.draw(data[i], rctx);
    else console.warn('TimeSeries: unknown plot type', data[i].type);
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
  var { c, X, Y, margin, plotWidth } = rctx;
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

// Register built-in renderers
registerRenderer({ type: 'multibar',   draw: multibar,   highlight: highlight_multibar });
registerRenderer({ type: 'multiline',  draw: multiline });
registerRenderer({ type: 'multipoint', draw: multipoint });
registerRenderer({ type: 'scatter',    draw: scatter });
