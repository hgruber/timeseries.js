// ── Optional legend overlay ──────────────────────────────────────────────────
//
// Sibling to src/tooltip.js and held to the same contract: the core draws to
// canvas and builds no DOM, getSeries() hands a caller the data, and this
// *shipped* helper renders the common floating panel so consumers stop
// re-implementing it — but it stays inert until attachLegend() is called. No
// call means no element, no listener, no cost; the DOM-free default is intact.
//
// It reaches the chart only through the public hooks (getSeries, onSeriesChange,
// toggleSeries, onColorsChange, getColors, getCanvas, getPlotArea), never
// through closure internals — the same contract any third-party legend would
// have to live with.
//
// Three levels of override, so the common case needs no configuration at all:
//   • nothing            → swatch + label; click toggles the series, dimmed when
//                          hidden
//   • labelFor / colorFor / extra → retarget one piece of a row
//   • formatter(ctx)     → take over a row's content; ctx.defaultRow() still
//                          returns the standard nodes to build on. Returning
//                          null/false drops that series from the list.
//
// Theming follows the chart palette's legend* keys, so a page that already calls
// ts.setColors(TimeSeries.themes.dark) gets a matching legend for free, and
// onColorsChange keeps it in step on every later theme switch.

// Applied once at construction; everything colour-related is (re)applied by
// applyTheme() so a theme switch restyles in place rather than rebuilding.
var BASE_STYLE = {
  position: 'fixed',
  zIndex: '1000',
  display: 'none',
  boxSizing: 'border-box',
  borderRadius: '6px',
  borderWidth: '1px',
  borderStyle: 'solid',
  padding: '8px 12px',
  fontSize: '12px',
  lineHeight: '1.5',
  overflowY: 'auto',
  userSelect: 'none',
  cursor: 'grab',
};

// Used when the chart palette carries no legend* keys (a consumer on a
// hand-rolled `colors` object). Mirrors TimeSeries.themes.light.
var FALLBACK_COLORS = {
  legendBg:     'rgba(255,255,255,0.92)',
  legendBorder: '#ccc',
  legendShadow: 'rgba(0,0,0,0.15)',
  legendText:   '#222',
  legendTitle:  '#555',
  legendMuted:  '#888',
  legendHover:  'rgba(128,128,128,0.15)',
};

var COLOR_KEYS = Object.keys(FALLBACK_COLORS);

/**
 * Attach a series legend to a chart. Returns a controller, or null in a
 * non-DOM environment.
 *
 *   var lg = TimeSeries.attachLegend(ts);
 *   var lg = TimeSeries.attachLegend(ts, { title: 'Series', labelFor: id => names[id] || id });
 *
 * getSeries() only reports series once data has been pushed, and onSeriesChange
 * does NOT fire for newly arrived series — call refresh() after a load, exactly
 * as you would re-poll getSeries().
 *
 * Controller: { el, refresh(), setOptions(o), show(), hide(), toggle(), destroy() }
 */
export function attachLegend(ts, options) {
  if (!ts || typeof document === 'undefined') return null;

  var opts = Object.assign({}, options);
  var theme = Object.assign({}, FALLBACK_COLORS);
  var wantVisible = opts.hidden ? false : true;   // panel-toggle intent
  var dragged = false;                            // user moved it → stop auto-anchoring
  var drag = null;

  var el = document.createElement('div');
  el.className = 'ts-legend' + (opts.className ? ' ' + opts.className : '');
  Object.assign(el.style, BASE_STYLE);
  (opts.container || document.body).appendChild(el);

  var header = document.createElement('div');
  header.className = 'ts-legend-title';
  Object.assign(header.style, {
    fontWeight: '600', fontSize: '11px', marginBottom: '6px', display: 'none',
  });
  el.appendChild(header);

  var itemsEl = document.createElement('div');
  itemsEl.className = 'ts-legend-items';
  Object.assign(itemsEl.style, { display: 'flex', flexDirection: 'column', gap: '2px' });
  el.appendChild(itemsEl);

  // ── element helpers ─────────────────────────────────────────────────────────
  // textContent, never innerHTML: series ids and labels come from the data
  // source and are not ours to trust.
  function span(text, cls) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    return s;
  }
  function swatch(color, hidden) {
    var s = span('', 'ts-legend-swatch');
    Object.assign(s.style, {
      width: '14px', height: '10px', borderRadius: '2px', flexShrink: '0',
      border: '1px solid ' + color,
      background: hidden ? 'transparent' : color,
    });
    return s;
  }

  // ── theming ───────────────────────────────────────────────────────────────
  function applyTheme() {
    var pal = (typeof ts.getColors === 'function' ? ts.getColors() : null) || {};
    var next = Object.assign({}, FALLBACK_COLORS);
    for (const k of COLOR_KEYS) if (pal[k]) next[k] = pal[k];
    theme = Object.assign(next, opts.colors);
    el.style.background  = theme.legendBg;
    el.style.borderColor = theme.legendBorder;
    el.style.boxShadow   = '0 2px 8px ' + theme.legendShadow;
    el.style.color       = theme.legendText;
    header.style.color   = theme.legendTitle;
  }

  // ── content ───────────────────────────────────────────────────────────────
  function labelOf(s) {
    return opts.labelFor ? String(opts.labelFor(s.id, s)) : String(s.label);
  }
  function colorOf(s) {
    return opts.colorFor ? opts.colorFor(s.id, s) : s.color;
  }

  // The standard row body: swatch, label, and an optional trailing extra
  // (opts.extra → a total, a count, …). Returned as an array so a formatter can
  // splice into it.
  function defaultRow(ctx) {
    var nodes = [swatch(ctx.color, ctx.hidden), span(ctx.label, 'ts-legend-name')];
    if (opts.extra) {
      var ex = opts.extra(ctx.series, ctx);
      if (ex != null) {
        var e = typeof ex === 'object' && ex.nodeType ? ex : span(String(ex), 'ts-legend-extra');
        Object.assign(e.style, { marginLeft: 'auto', paddingLeft: '8px',
          color: theme.legendMuted, fontSize: '11px' });
        nodes.push(e);
      }
    }
    return nodes;
  }

  function buildCtx(s) {
    var ctx = {
      ts: ts, series: s, id: s.id, label: labelOf(s), color: colorOf(s),
      hidden: !!s.hidden, colors: theme,
    };
    ctx.defaultRow = function () { return defaultRow(ctx); };
    return ctx;
  }

  // A formatter may return a Node, an array of Nodes, a plain string (text — the
  // safe default) or { html }. Returning null/false drops the series from the
  // list. undefined falls through to the default row.
  function fillRow(btn, content) {
    if (typeof content === 'string') { btn.textContent = content; return; }
    if (content && typeof content.html === 'string') { btn.innerHTML = content.html; return; }
    for (const node of (Array.isArray(content) ? content : [content]))
      if (node) btn.appendChild(node);
  }

  function buildRow(s) {
    var ctx = buildCtx(s);
    var content = opts.formatter ? opts.formatter(ctx) : undefined;
    if (content === null || content === false) return null;   // omit this series
    if (content === undefined) content = defaultRow(ctx);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ts-legend-item';
    // aria-pressed is the single source of truth for the hidden state.
    btn.setAttribute('aria-pressed', String(!s.hidden));
    btn.setAttribute('title', (s.hidden ? 'Show ' : 'Hide ') + ctx.label);
    Object.assign(btn.style, {
      display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap',
      width: '100%', textAlign: 'left', border: 'none', background: 'none',
      font: 'inherit', color: 'inherit', cursor: 'pointer',
      padding: '1px 3px', borderRadius: '3px',
      opacity: s.hidden ? '0.45' : '1',
    });
    fillRow(btn, content);

    // Hover feedback without a global stylesheet: the palette's legendHover is
    // theme-dependent, so an injected :hover rule would need patching on every
    // theme switch. Inline enter/leave keeps the helper self-contained.
    btn.addEventListener('mouseenter', function () { btn.style.background = theme.legendHover; });
    btn.addEventListener('mouseleave', function () { btn.style.background = 'none'; });
    btn.onclick = function (ev) {
      if (opts.onItemClick) opts.onItemClick(s.id, s, ev);
      else ts.toggleSeries(s.id);       // fires onSeriesChange → refresh()
    };
    return btn;
  }

  // ── placement ─────────────────────────────────────────────────────────────
  // Anchored to the top-right corner of the chart's plot area with a small
  // margin, matching where a painted legend would sit. Skipped once the user
  // drags the panel, and re-measured on every refresh otherwise (the canvas may
  // have resized). maxHeight tracks the canvas so a long list scrolls rather
  // than overflowing the chart.
  function anchor() {
    var canvas = typeof ts.getCanvas === 'function' ? ts.getCanvas() : null;
    if (!canvas || !canvas.getBoundingClientRect) return;
    var rect = canvas.getBoundingClientRect();
    el.style.maxHeight = Math.round(rect.height * 0.8) + 'px';
    if (dragged) return;
    var off = opts.offset == null ? 8 : opts.offset;
    var area = typeof ts.getPlotArea === 'function' ? ts.getPlotArea() : null;
    var scaleX = rect.width / (canvas.width || rect.width || 1);
    var scaleY = rect.height / (canvas.height || rect.height || 1);
    var m = area ? area.margin : { top: 0, right: 0 };
    var rightOffset = (m.right * scaleX) + off;
    var topOffset = (m.top * scaleY) + off;
    var vw = (typeof window !== 'undefined' && window.innerWidth) || rect.right;
    el.style.right = (vw - rect.right + rightOffset) + 'px';
    el.style.top   = (rect.top + topOffset) + 'px';
    el.style.left  = 'auto';
  }

  // ── drag ────────────────────────────────────────────────────────────────────
  function isInteractive(node) {
    while (node && node !== el) {
      if (node.tagName === 'BUTTON') return true;
      node = node.parentNode;
    }
    return false;
  }
  function onDown(e) {
    if (isInteractive(e.target)) return;    // a click on a row is a toggle, not a drag
    drag = { x: e.clientX - el.offsetLeft, y: e.clientY - el.offsetTop };
    dragged = true;
    el.classList.add('ts-legend-dragging');
    el.style.cursor = 'grabbing';
    if (e.preventDefault) e.preventDefault();
  }
  function onMove(e) {
    if (!drag) return;
    el.style.left  = (e.clientX - drag.x) + 'px';
    el.style.top   = (e.clientY - drag.y) + 'px';
    el.style.right = 'auto';
  }
  function onUp() {
    if (!drag) return;
    drag = null;
    el.classList.remove('ts-legend-dragging');
    el.style.cursor = 'grab';
  }

  // ── render ──────────────────────────────────────────────────────────────────
  function applyVisibility(count) {
    el.style.display = (wantVisible && count > 0) ? 'block' : 'none';
  }

  function refresh() {
    var series = typeof ts.getSeries === 'function' ? ts.getSeries() : [];
    itemsEl.replaceChildren();
    var shown = 0;
    for (const s of series) {
      var row = buildRow(s);
      if (row) { itemsEl.appendChild(row); shown++; }
    }
    if (opts.title) { header.textContent = opts.title; header.style.display = 'block'; }
    else header.style.display = 'none';
    applyVisibility(shown);
    anchor();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  el.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  var offSeries = ts.onSeriesChange(refresh);
  var offColors = typeof ts.onColorsChange === 'function'
    ? ts.onColorsChange(function () { applyTheme(); refresh(); })
    : null;

  applyTheme();
  refresh();

  return {
    el: el,
    // Rebuild from the current getSeries() — after a data load, after changing
    // options, or when the app's own label/colour lookups have new data.
    refresh: function () { refresh(); return this; },
    setOptions: function (next) {
      Object.assign(opts, next);
      applyTheme();
      refresh();
      return this;
    },
    show:   function () { wantVisible = true;  refresh(); return this; },
    hide:   function () { wantVisible = false; applyVisibility(0); return this; },
    toggle: function () { wantVisible = !wantVisible; refresh(); return this; },
    destroy: function () {
      if (typeof offSeries === 'function') offSeries();
      if (typeof offColors === 'function') offColors();
      el.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
