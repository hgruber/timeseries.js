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

function color(i, t) {
  var r = (((i + 111) % 67) * 798) % 255;
  var g = (((i + 53) % 23) * 1131) % 255;
  var b = (((i + 79) % 19) * 979) % 255;
  return "rgb(" + r + "," + g + "," + b + ", " + t + ")";
}

function highlight_multibar(plot, n, item, rctx) {
  var { c, X, Y, ppms, ppv } = rctx;
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  var barWidth = ppms * step;
  var height = 0;
  var x = X(start + n * step);
  for (const [i, bar] of Object.entries(plot.data[n])) {
    if (i == item) {
      c.fillStyle = color(i, 0.8);
      c.fillRect(x, Y(height), barWidth, -ppv * bar);
      return;
    }
    height += bar;
  }
}

function multibar(plot, rctx) {
  var { c, X, Y, ppms, ppv, margin, plotWidth } = rctx;
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  var barWidth = ppms * step;
  for (const [t, bars] of Object.entries(plot.data)) {
    var height = 0;
    var x = X(start + t * step);
    if (x + barWidth >= margin.left && x <= margin.left + plotWidth)
      for (const [i, bar] of Object.entries(bars)) {
        c.fillStyle = color(i, 0.8);
        c.fillRect(x, Y(height), barWidth, -ppv * bar);
        height += bar;
      }
  }
}

function multipoint(plot, rctx) {
  var { c, X, Y, margin, plotWidth } = rctx;
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  for (const [t, value] of Object.entries(plot.data)) {
    var x = X(start + t * step);
    if (x >= margin.left && x <= margin.left + plotWidth) {
      for (const [i, v] of Object.entries(value)) {
        c.fillStyle = color(i, 0.8);
        c.fillRect(x - 2, Y(v) - 2, 4, 4);
        c.fill();
      }
    }
  }
}

function multiline(plot, rctx) {
  var { c, X, Y, margin, plotWidth } = rctx;
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  c.lineWidth = 1.5;
  for (const v of Object.entries(plot.data[0])) {
    var i = v[0];
    var x = X(start);
    var y = Y(plot.data[0][i]);
    c.beginPath();
    c.moveTo(x, y);
    for (const [t, value] of Object.entries(plot.data)) {
      x = X(start + t * step);
      if (
        x >= margin.left &&
        x <= margin.left + plotWidth &&
        value[i] != undefined
      ) {
        c.lineTo(x, Y(value[i]));
      }
    }
    c.strokeStyle = color(i, 0.8);
    c.stroke();
  }
  c.lineWidth = 1;
}

// Register built-in renderers
registerRenderer({ type: 'multibar',   draw: multibar,   highlight: highlight_multibar });
registerRenderer({ type: 'multiline',  draw: multiline });
registerRenderer({ type: 'multipoint', draw: multipoint });
