// ── Optional tooltip overlay ─────────────────────────────────────────────────
//
// The core draws to canvas and deliberately builds no DOM: getSeries() hands a
// caller the data for a legend and the caller renders it. This helper is the
// one *shipped* exception, so consumers stop re-implementing the same hover box
// — but it stays inert until attachTooltip() is called. No call means no
// element, no listener, no cost; the library's default is still DOM-free.
//
// It reaches the chart only through the public hooks (onHoverDataCallback,
// onColorsChange, getCanvas, getColors), never through closure internals — the
// same contract any third-party overlay would have to live with.
//
// Three levels of override, so the common case needs no configuration at all:
//   • nothing            → swatch + series label + (value · interval) + time
//   • labelFor / colorFor / valueFormat / timeFormat → retarget one piece
//   • formatter(ctx)     → take over the body completely; ctx.defaultContent()
//                          still returns the standard nodes to build on
//
// Theming follows the chart palette's tooltip* keys, so a page that already
// calls ts.setColors(TimeSeries.themes.dark) gets a matching tooltip for free,
// and onColorsChange keeps it in step on every later theme switch.

import { resolveColor } from './renderers.js';

// Applied once at construction. Everything colour-related is (re)applied by
// applyTheme() instead, so a theme switch never has to rebuild the element.
var BASE_STYLE = {
  position: 'fixed',
  zIndex: '2000',
  pointerEvents: 'none',        // must not steal the hover it reacts to
  display: 'none',
  borderRadius: '4px',
  borderWidth: '1px',
  borderStyle: 'solid',
  padding: '6px 10px',
  fontSize: '12px',
  lineHeight: '1.45',
  whiteSpace: 'nowrap',
  backdropFilter: 'blur(4px)',
};

// Used when the chart palette carries no tooltip* keys at all (a consumer on a
// hand-rolled `colors` object). Mirrors TimeSeries.themes.light.
var FALLBACK_COLORS = {
  tooltipBg:     'rgba(255,255,255,0.92)',
  tooltipBorder: '#ccc',
  tooltipShadow: 'rgba(0,0,0,0.15)',
  tooltipText:   '#222',
  tooltipTitle:  '#555',
  tooltipMuted:  '#888',
};

var COLOR_KEYS = Object.keys(FALLBACK_COLORS);

// "5min", "1h", "7d" — exact units only, so a 36h interval reads "36h" rather
// than the misleading "1.5d".
export function formatInterval(sec) {
  if (typeof sec !== 'number' || !(sec > 0)) return '';
  if (sec % 86400 === 0) return (sec / 86400) + 'd';
  if (sec % 3600 === 0)  return (sec / 3600) + 'h';
  if (sec % 60 === 0)    return (sec / 60) + 'min';
  return sec + 's';
}

// Counts want thousands separators; averages and quantiles want a fixed scale.
function defaultValueFormat(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
}

// Three plot shapes carry their time in three different places.
function hitTime(plot, n, value) {
  if (plot.category === 'span')
    return value && value.start != null ? new Date(value.start) : null;
  if (plot.category === 'point')
    return plot.data && plot.data[n] ? new Date(plot.data[n].t) : null;
  if (typeof plot.interval_start === 'number' && typeof plot.interval === 'number')
    return new Date((plot.interval_start + n * plot.interval) * 1000);
  return null;
}

// Same precedence getSeries() uses, but as a single cheap lookup: this runs on
// every mousemove, so it must not walk all slots of every active plot.
function seriesLabel(plot, key) {
  if (plot.series)
    for (const s of plot.series)
      if (String(s.id) === key) return s.name || s.label || key;
  return key;
}

/**
 * Attach a tooltip to a chart. Returns a controller, or null in a non-DOM
 * environment.
 *
 *   var tip = TimeSeries.attachTooltip(ts);
 *   var tip = TimeSeries.attachTooltip(ts, { labelFor: id => names[id] || id });
 *
 * Controller: { el, hide(), refresh(), setOptions(o), destroy() }
 */
export function attachTooltip(ts, options) {
  if (!ts || typeof document === 'undefined') return null;

  var opts = Object.assign({}, options);
  var theme = Object.assign({}, FALLBACK_COLORS);
  var last = null;                    // last accepted hit, for re-render
  var lastX = 0, lastY = 0;

  var el = document.createElement('div');
  el.className = 'ts-tooltip' + (opts.className ? ' ' + opts.className : '');
  Object.assign(el.style, BASE_STYLE);
  (opts.container || document.body).appendChild(el);

  // ── element helpers ───────────────────────────────────────────────────────
  function div(cls) {
    var d = document.createElement('div');
    d.className = cls;
    return d;
  }
  // textContent, never innerHTML: series ids and labels come from the data
  // source and are not ours to trust.
  function span(text, cls) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    return s;
  }
  function swatch(color) {
    var s = span('', 'ts-tooltip-swatch');
    Object.assign(s.style, {
      width: '10px', height: '10px', borderRadius: '2px',
      flexShrink: '0', background: color,
    });
    return s;
  }

  // ── theming ───────────────────────────────────────────────────────────────
  function applyTheme() {
    var pal = (typeof ts.getColors === 'function' ? ts.getColors() : null) || {};
    var next = Object.assign({}, FALLBACK_COLORS);
    for (const k of COLOR_KEYS) if (pal[k]) next[k] = pal[k];
    theme = Object.assign(next, opts.colors);
    el.style.background  = theme.tooltipBg;
    el.style.borderColor = theme.tooltipBorder;
    el.style.boxShadow   = '0 2px 8px ' + theme.tooltipShadow;
    el.style.color       = theme.tooltipText;
  }

  // ── content ───────────────────────────────────────────────────────────────
  function valueFormat(v) {
    return (opts.valueFormat || defaultValueFormat)(v);
  }

  function timeText(ctx) {
    if (opts.timeFormat) return opts.timeFormat(ctx.time, ctx);
    if (ctx.plot.category === 'span' && ctx.value && ctx.value.start != null) {
      var from = new Date(ctx.value.start).toLocaleString();
      return ctx.value.end != null
        ? from + ' → ' + new Date(ctx.value.end).toLocaleString()
        : from;
    }
    return ctx.time ? ctx.time.toLocaleString() : '';
  }

  // "(1,234 · 5min)" — omitted entirely for span plots, whose value is the
  // event object rather than a number.
  function metaText(ctx) {
    var parts = [];
    if (typeof ctx.value === 'number') parts.push(valueFormat(ctx.value));
    var iv = formatInterval(ctx.interval);
    if (iv) parts.push(iv);
    return parts.length ? '(' + parts.join(' · ') + ')' : '';
  }

  function defaultContent(ctx) {
    var nodes = [];

    var title = div('ts-tooltip-title');
    Object.assign(title.style, {
      display: 'flex', alignItems: 'center', gap: '5px',
      fontWeight: '600', color: theme.tooltipTitle,
    });
    if (ctx.color) title.appendChild(swatch(ctx.color));
    title.appendChild(span(ctx.label));

    var meta = metaText(ctx);
    if (meta) {
      var m = span(meta, 'ts-tooltip-value');
      m.style.color = theme.tooltipText;
      m.style.fontWeight = '400';
      title.appendChild(m);
    }
    nodes.push(title);

    var when = timeText(ctx);
    if (when) {
      var t = div('ts-tooltip-time');
      t.style.color = theme.tooltipMuted;
      t.style.fontSize = '11px';
      t.textContent = when;
      nodes.push(t);
    }
    return nodes;
  }

  function buildCtx(plot, n, key, value) {
    var rawKey = String(key);
    var label = opts.labelFor
      ? opts.labelFor(rawKey, plot, value)
      : (plot.category === 'span' && value && value.label
        ? String(value.label)
        : seriesLabel(plot, rawKey));
    // resolveColor is what the renderer painted, plot.series_colors included.
    var color = opts.colorFor
      ? opts.colorFor(rawKey, plot, value)
      : resolveColor(plot, rawKey, 0.9);
    var interval = (plot.category !== 'point' && plot.category !== 'span'
      && typeof plot.interval === 'number') ? plot.interval : null;

    var ctx = {
      ts: ts, plot: plot, n: n, key: rawKey, value: value,
      label: label, color: color, time: hitTime(plot, n, value),
      interval: interval, colors: theme,
    };
    ctx.defaultContent = function () { return defaultContent(ctx); };
    return ctx;
  }

  // A formatter may return a Node, an array of Nodes, a plain string (inserted
  // as text — the safe default), or { html } to opt explicitly into markup.
  // Returning null/false hides the tooltip for this hit.
  function fill(content) {
    el.replaceChildren();
    if (typeof content === 'string') { el.textContent = content; return; }
    if (content && typeof content.html === 'string') { el.innerHTML = content.html; return; }
    for (const node of (Array.isArray(content) ? content : [content]))
      if (node) el.appendChild(node);
  }

  // ── placement ─────────────────────────────────────────────────────────────
  // Right of the cursor and vertically centred, flipping to the left near the
  // right edge and clamped into the viewport. Measured after the content is in
  // place, so the flip uses the real box.
  function place() {
    el.style.display = 'block';
    var off = opts.offset == null ? 14 : opts.offset;
    var tw = el.offsetWidth || 0;
    var th = el.offsetHeight || 0;
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 0;

    var left = lastX + off;
    if (vw && left + tw > vw - 8) left = lastX - tw - off;
    if (left < 4) left = 4;

    var top = lastY - Math.round(th / 2);
    if (vh && top + th > vh - 4) top = vh - 4 - th;
    if (top < 4) top = 4;

    el.style.left = left + 'px';
    el.style.top  = top + 'px';
  }

  function accepts(plot) {
    var want = opts.plotTypes;
    if (!want) return true;
    if (typeof want === 'function') return !!want(plot);
    return want.indexOf(plot.type) !== -1;
  }

  function hide() {
    last = null;
    el.style.display = 'none';
  }

  function render() {
    if (!last) return;
    var ctx = buildCtx(last.plot, last.n, last.key, last.value);
    var content = opts.formatter ? opts.formatter(ctx) : undefined;
    if (content === undefined) content = defaultContent(ctx);
    if (content === null || content === false) { hide(); return; }
    fill(content);
    place();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  // The all-null call is the core's "nothing hit" signal.
  function onHover(plot, n, key, value) {
    if (plot == null || key == null || !accepts(plot)) { hide(); return; }
    last = { plot: plot, n: n, key: key, value: value };
    render();
  }

  function trackMouse(e) {
    lastX = e.clientX;
    lastY = e.clientY;
  }

  var canvas = typeof ts.getCanvas === 'function' ? ts.getCanvas() : null;
  if (canvas && canvas.addEventListener) canvas.addEventListener('mousemove', trackMouse);

  var offHover  = ts.onHoverDataCallback(onHover);
  var offColors = typeof ts.onColorsChange === 'function'
    ? ts.onColorsChange(function () { applyTheme(); render(); })
    : null;

  applyTheme();

  return {
    el: el,
    hide: hide,
    // Re-render the current hit — after changing options, or when the app's own
    // label/colour lookups have new data.
    refresh: function () { render(); return this; },
    setOptions: function (next) {
      Object.assign(opts, next);
      applyTheme();
      render();
      return this;
    },
    destroy: function () {
      if (typeof offHover === 'function') offHover();
      if (typeof offColors === 'function') offColors();
      if (canvas && canvas.removeEventListener) canvas.removeEventListener('mousemove', trackMouse);
      if (el.parentNode) el.parentNode.removeChild(el);
      last = null;
    },
  };
}
