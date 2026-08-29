// Renderer plugin registry and built-in renderers for timeseries.js
//
// Each renderer plugin is:
//   { type: string, draw(plot, rctx), highlight?(plot, n, item, rctx),
//     coalesce?(plot) -> key, values?: 'scalar' | 'array', stacked?: boolean }
// rctx shape: { c, X, Y, ppms, ppv, margin, plotWidth, plotHeight }

const registry = new Map();

// Types whose per-slot, per-series value is an *array* (a percentile ladder)
// rather than a stackable scalar. The core has to know this: three places in
// timeseries.js branch on it (the pushData concat allow-list, the extent
// recompute there, and the y-extent scan in prepare_grid), and a type missing
// from all three fails *silently* — `array * number` is NaN, `NaN >= 0` is
// false, so the slot contributes nothing and the axis quietly falls back to
// plot.max. Declaring it once on the plugin is what keeps a fourth (or a
// third-party) ladder renderer from rediscovering that the hard way.
const bandedTypes = new Set();

// Types that *sum* their series per slot rather than drawing each independently.
// The y-extent scan in prepare_grid needs this: a stacked type's tallest point is
// the sum of a slot's series, an unstacked one's is its largest single series, and
// measuring a stack the unstacked way clips the top of every bar off the chart.
//
// This used to be the literal `plot.type === 'multibar'` in timeseries.js, which
// made "is this stacked" a fact only the core knew — so a second stacked renderer
// had to edit the core to be measured correctly. Declaring it on the plugin is the
// same move `values: 'array'` makes above, for the same reason.
const stackedTypes = new Set();

/**
 * Register a renderer plugin for a given plot type.
 * @param {{ type: string, draw: function, highlight?: function,
 *          coalesce?: function, values?: 'scalar'|'array',
 *          stacked?: boolean }} plugin
 */
export function registerRenderer(plugin) {
  registry.set(plugin.type, plugin);
  if (plugin.values === 'array') bandedTypes.add(plugin.type);
  else bandedTypes.delete(plugin.type);
  if (plugin.stacked) stackedTypes.add(plugin.type);
  else stackedTypes.delete(plugin.type);
}

/**
 * Does this plot type store an array of values per series per slot?
 * See `bandedTypes` above for why the core cares.
 */
export function isBandedType(type) {
  return bandedTypes.has(type);
}

/**
 * Does this plot type stack its series per slot? See `stackedTypes` above.
 */
export function isStackedType(type) {
  return stackedTypes.has(type);
}

/**
 * Merge several binned plot blocks that share the global slot grid into one
 * synthetic plot. Each block keys its slots relative to its own
 * `interval_start` (a multiple of `interval`); rebasing every slot onto the
 * group's earliest `interval_start` yields a single continuous `data` map so a
 * line/area renderer draws across fetch-block margins instead of leaving a
 * one-slot hole at each boundary. Color/label metadata is taken from the
 * blocks (series_colors merged, first non-empty name/percentiles win).
 *
 * `_partial` *is* carried, rebased onto this slot numbering along with the data
 * — quantile-steps is the case the note here used to only anticipate. Only one
 * record survives, the one at the highest rebased slot: `_partial` names a
 * single bin, and in practice only the newest block of a group carries a
 * `data_until` at all. `connect`, `step` and `fill` ride along for the same
 * reason as each other: every one of them changes what the merged block draws
 * *between* bins, so dropping them would make a coalesced block draw differently
 * from the blocks it was built out of.
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
  var partial = null;
  // Flags that change what is drawn between bins. First non-null wins, the same
  // rule `name` follows — they are block metadata, not per-slot data.
  var flags = { connect: base.connect, step: base.step, fill: base.fill };
  for (const i of group) {
    var blk = data[i];
    if (blk.percentiles && !merged.percentiles) merged.percentiles = blk.percentiles;
    if (blk.series_colors) colors = Object.assign(colors || {}, blk.series_colors);
    if (name == null) name = blk.name;
    for (var fk in flags) if (flags[fk] == null) flags[fk] = blk[fk];
    var shift = Math.round((blk.interval_start - baseStart) / interval);
    if (blk._partial && (!partial || blk._partial.slot + shift > partial.slot))
      partial = Object.assign({}, blk._partial, { slot: blk._partial.slot + shift });
    for (var s in blk.data) merged.data[+s + shift] = blk.data[s];
  }
  if (colors) merged.series_colors = colors;
  if (name != null) merged.name = name;
  for (var fk2 in flags) if (flags[fk2] != null) merged[fk2] = flags[fk2];
  if (partial) merged._partial = partial;
  return merged;
}

/**
 * Cross-fade factor a block is currently drawn at. prepare_grid stamps `_fade`
 * on both blocks involved in a resolution switch (outgoing 1 → 0, incoming
 * 0 → 1, summing to 1 across the band); everywhere else it is 1.
 */
function fadeOf(plot) {
  return (plot && plot._fade != null) ? plot._fade : 1;
}

/**
 * Value multiplier a block is currently drawn at. prepare_grid stamps `_vscale`
 * on every block from the rate unit set with setRateUnit() (1 everywhere else).
 */
function vscaleOf(plot) {
  return (plot && plot._vscale != null) ? plot._vscale : 1;
}

/**
 * Geometry override for the bin holding a block's `data_until`, stamped as
 * `plot._partial` by prepare_grid — null on every other slot, and null
 * everywhere while `partialBins` is 'full'. See partialOf() in timeseries.js.
 *
 * Unlike `_fade` and `_vscale`, this is NOT applied centrally in plotData().
 * Those are properties of a whole block and so ride on globalAlpha and on a
 * scaled render context; this one touches a single slot out of thousands, and a
 * per-slot context would mean an allocation per slot per frame. Since `Y(v)` is
 * affine in `v`, multiplying the value is the very same arithmetic at no cost.
 * It is not the double-application the block-wide factors warn about, because
 * `scale` lives in value space and `_vscale` in axis space.
 */
function partialAt(plot, n) {
  var p = plot && plot._partial;
  return (p && p.slot === n) ? p : null;
}

/**
 * Render context with the value axis rescaled by `s`. Both the value→pixel map
 * and the pixels-per-value factor have to move together: a renderer draws a
 * stacked bar as a rect from `Y(base)` of height `-ppv * v`, and scaling only
 * one of the two would detach the bar from its own baseline.
 */
function scaledCtx(rctx, s) {
  if (s === 1) return rctx;
  var Y0 = rctx.Y;
  return Object.assign({}, rctx, {
    Y: function (v) { return Y0(v * s); },
    ppv: rctx.ppv * s,
  });
}

/**
 * Draw all active plots using their registered renderers. A renderer may set
 * `coalesce(plot) -> key`; active blocks of the same type sharing that key are
 * merged (see coalesceBlocks) and drawn once, so connected renderers stay
 * continuous across the separate fetch blocks stored in `data`.
 *
 * The cross-fade is applied here rather than inside each renderer: `globalAlpha`
 * multiplies the source alpha of every drawing op, which is exactly what a
 * renderer would otherwise do by hand to each of its own colours — so every
 * renderer, including third-party ones, gets the resolution dissolve for free
 * and none of them has to know `_fade` exists.
 */
export function plotData(activePlot, data, rctx) {
  var c = rctx.c;
  var done = null;
  // Faintest first: a block at _fade 0.1 painted *over* its 0.9 counterpart
  // would wash the dominant one out. Without an explicit order this would be
  // decided by push order, i.e. by which fetch happened to land first.
  var order = activePlot.slice().sort(function (a, b) {
    return fadeOf(data[a]) - fadeOf(data[b]);
  });
  for (const i of order) {
    if (done && done.has(i)) continue;
    const plugin = registry.get(data[i].type);
    if (!plugin) { console.warn('TimeSeries: unknown plot type', data[i].type); continue; }
    var fade = fadeOf(data[i]);
    if (fade <= 0) continue;
    if (fade < 1) c.globalAlpha = fade;
    // The rate scale rides on the render context for the same reason the fade
    // rides on globalAlpha: it is a property of the block, not of the renderer,
    // and every renderer would otherwise have to multiply it into each of its
    // own value→pixel calls by hand. Blocks that coalesce share an interval
    // (the coalesce key carries it), so they share a scale too.
    var vctx = scaledCtx(rctx, vscaleOf(data[i]));
    if (plugin.coalesce) {
      var key = plugin.coalesce(data[i]);
      var group = [];
      for (const j of order)
        if (data[j].type === data[i].type && plugin.coalesce(data[j]) === key) {
          group.push(j);
          (done || (done = new Set())).add(j);
        }
      plugin.draw(coalesceBlocks(group, data), vctx);
    } else {
      plugin.draw(data[i], vctx);
    }
    if (fade < 1) c.globalAlpha = 1;
  }
}

/**
 * Highlight a specific data point using the registered renderer's highlight handler.
 * Faded the same way plotData fades the block itself, so a highlight mid-dissolve
 * does not sit at full opacity on top of a half-faded bar.
 */
export function highlight(plot, n, item, rctx) {
  const plugin = registry.get(plot.type);
  if (!plugin || !plugin.highlight) return;
  var fade = fadeOf(plot);
  if (fade <= 0) return;
  if (fade < 1) rctx.c.globalAlpha = fade;
  plugin.highlight(plot, n, item, scaledCtx(rctx, vscaleOf(plot)));
  if (fade < 1) rctx.c.globalAlpha = 1;
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
  // The same geometry the draw pass used for this slot. A highlight at full
  // width over a clipped bar is exactly the mismatch this second copy of the
  // arithmetic exists to get wrong, so it has to be carried here too.
  var part = partialAt(plot, +n);
  if (part && part.skip) return;
  var barWidth = ppms * step * (part ? part.frac : 1);
  var k = part ? part.scale : 1;
  var dirs = plot.series_directions;
  var heightUp = 0;
  var heightDown = 0;
  var x = X(start + n * step);
  for (const [i, bar] of Object.entries(plot.data[n])) {
    var down = dirs && dirs[i] === 'down';
    var v = bar * k;
    if (i === item) {
      c.fillStyle = resolveColor(plot, i, 0.8);
      if (down) c.fillRect(x, Y(-heightDown), barWidth, ppv * v);
      else      c.fillRect(x, Y(heightUp),    barWidth, -ppv * v);
      return;
    }
    if (down) heightDown += v;
    else      heightUp   += v;
  }
}

function multibar(plot, rctx) {
  var { c, X, Y, ppms, ppv, margin, plotWidth, hidden } = rctx;
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  var fullWidth = ppms * step;
  var dirs = plot.series_directions;
  for (const [t, bars] of Object.entries(plot.data)) {
    var heightUp = 0;
    var heightDown = 0;
    // Object.entries hands back string keys; the stamped slot is a number.
    var part = partialAt(plot, +t);
    if (part && part.skip) continue;
    // A bin only partly covered by data is drawn `frac` as wide, so its right
    // edge sits on data_until rather than reaching into a future that holds no
    // data, and `1/frac` as tall, so the area it covers is still the value it
    // holds — same ink and same visual density as the full bin beside it,
    // instead of a full-width bar that is both too low and too long.
    var barWidth = part ? fullWidth * part.frac : fullWidth;
    var k = part ? part.scale : 1;
    var x = X(start + t * step);
    if (x + barWidth >= margin.left && x <= margin.left + plotWidth)
      for (const [i, bar] of Object.entries(bars)) {
        // Skipped entirely, not drawn transparent: a hidden series must not
        // occupy stack height either, or the visible bars float off the axis.
        if (hidden && hidden.has(i)) continue;
        var v = bar * k;
        c.fillStyle = resolveColor(plot, i, 0.8);
        if (dirs && dirs[i] === 'down') {
          c.fillRect(x, Y(-heightDown), barWidth, ppv * v);
          heightDown += v;
        } else {
          c.fillRect(x, Y(heightUp), barWidth, -ppv * v);
          heightUp += v;
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
      x = X(start + t * step);
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

/**
 * Runs of drawable points for one series, chronologically — one run per unbroken
 * stretch of data, so a caller can stroke or fill each without bridging a gap.
 * The point shape ({t, values}) and the binned shape (a slot grid) reduce to the
 * same {x, v} list here.
 *
 * This is the single reading of "where does this series' line go". multiline,
 * its fill, and stackarea all need it, and each deriving it by hand is how they
 * would drift apart on the gap rule — which is exactly what the two near-identical
 * branches this replaces had already started to do (the binned one broke only on
 * `undefined`, so an explicit `null` was drawn as a dive to zero).
 *
 * What breaks a run is a missing *value* in a slot that exists. An absent slot
 * is bridged, which is deliberate and unchanged: multiline is the interpolating
 * renderer, and quantile-bands reads its slots the same way. The filled forms
 * break on an absent slot instead (stackarea below, quantile-steps already) —
 * shading across unmeasured time asserts much more than a line through it does.
 *
 * `binW` is the pixel width of one bin, 0 for a point plot: a step line has to
 * carry its last value across the bin that value belongs to, and a list of
 * bin-start x-coordinates alone cannot express that.
 */
function lineRuns(plot, sid, rctx) {
  var X = rctx.X;
  var runs = [];
  var run = null;
  var push = function (x, v) {
    if (!run) { run = []; runs.push(run); }
    run.push({ x: x, v: v });
  };
  if (plot.category === 'point') {
    for (const pt of plot.data) {
      var pv = pt.values[sid];
      if (pv == null) { run = null; continue; }
      push(X(pt.t), pv);
    }
    return { runs: runs, binW: 0 };
  }
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  // Slots in chronological order — do not assume slot 0 exists (a block covers
  // an arbitrary window).
  for (const s of sortedSlots(plot)) {
    var v = plot.data[s][sid];
    if (v == null) { run = null; continue; }
    push(X(start + s * step), v);
  }
  return { runs: runs, binW: rctx.ppms * step };
}

/**
 * Trace one run into the current path — a plain polyline, or a staircase when
 * `step` is set: 'after' holds each value until the next point (which is what a
 * binned slot *means*, since the bin covers the whole interval), 'before' holds
 * it from the previous one.
 *
 * Returns the x the run ends at. Under 'after' that is past the last point: the
 * final value still owns its own bin, so the staircase has to cross it rather
 * than stopping on the bin's left edge. The caller needs that x to close a fill.
 */
function traceRun(c, Y, run, step, binW) {
  c.moveTo(run[0].x, Y(run[0].v));
  for (var i = 1; i < run.length; i++) {
    var p = run[i], q = run[i - 1];
    if (step === 'after') c.lineTo(p.x, Y(q.v));
    else if (step === 'before') c.lineTo(q.x, Y(p.v));
    c.lineTo(p.x, Y(p.v));
  }
  var last = run[run.length - 1];
  var endX = last.x;
  if (step === 'after' && binW) {
    endX += binW;
    c.lineTo(endX, Y(last.v));
  }
  return endX;
}

// multiline — one gap-aware polyline per series. `plot.step` ('after'|'before')
// draws it as a staircase instead of interpolating, and `plot.fill` shades the
// area down to the zero line. Both apply to binned and point blocks.
function multiline(plot, rctx) {
  var { c, Y, margin, plotHeight, hidden } = rctx;
  var step = (plot.step === 'after' || plot.step === 'before') ? plot.step : null;
  c.lineWidth = 1.5;
  for (const sid of plotSeriesIds(plot)) {
    if (hidden && hidden.has(sid)) continue;
    var lr = lineRuns(plot, sid, rctx);
    if (plot.fill) {
      // Clamped to the plot box: the zero line can sit far outside the viewport
      // (a series that never approaches zero), and an unclamped fill would paint
      // over the axis and the margins on its way there.
      var y0 = Math.max(margin.top, Math.min(margin.top + plotHeight, Y(0)));
      c.fillStyle = resolveColor(plot, sid, 0.18);
      for (const frun of lr.runs) {
        c.beginPath();
        var endX = traceRun(c, Y, frun, step, lr.binW);
        c.lineTo(endX, y0);
        c.lineTo(frun[0].x, y0);
        c.closePath();
        c.fill();
      }
    }
    // Stroked after the fill and in one path over all runs: the area is context,
    // the line is the datum, so the line stays the crisper of the two.
    c.strokeStyle = resolveColor(plot, sid, 0.8);
    c.beginPath();
    for (const run of lr.runs) traceRun(c, Y, run, step, lr.binW);
    c.stroke();
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

/**
 * The polyline of one stacked edge, already expanded into its staircase corners
 * when `step` is set.
 *
 * Returned as a list rather than traced straight into the path (the way
 * traceRun does it) because a band is closed by walking its *lower* edge
 * backwards, and a path-tracing helper cannot be run in reverse.
 */
function edgePoints(run, cols, vals, step, binW) {
  var pts = [];
  for (var i = 0; i < run.length; i++) {
    var ci = run[i];
    if (i > 0) {
      if (step === 'after') pts.push({ x: cols[ci].x, v: vals[run[i - 1]] });
      else if (step === 'before') pts.push({ x: cols[run[i - 1]].x, v: vals[ci] });
    }
    pts.push({ x: cols[ci].x, v: vals[ci] });
  }
  if (step === 'after' && binW) {
    var last = run[run.length - 1];
    pts.push({ x: cols[last].x + binW, v: vals[last] });
  }
  return pts;
}

// stackarea — series summed per slot and drawn as bands stacked on one another,
// so the outline is the total and each band's thickness is its own contribution.
//
// A separate type rather than a `stack: true` flag on multiline: prepare_grid
// decides how to measure the y-extent from the *type* (see isStackedType), and a
// per-plot flag would leave that decision somewhere the registry cannot see.
function stackarea(plot, rctx) {
  var { c, X, Y, hidden } = rctx;
  var step = (plot.step === 'after' || plot.step === 'before') ? plot.step : null;
  // Hidden series are dropped from the stack entirely, not drawn transparent —
  // exactly as multibar does it. Leaving a gap in the stack would float every
  // band above it off its own baseline.
  var ids = visibleIds(plot, hidden);
  if (!ids.length) return;

  // One column per position, carrying its slot number so a gap in the slot
  // numbering can break the run. A point block has no slot grid and so no gaps.
  var cols = [];
  var binW = 0;
  if (plot.category === 'point') {
    for (const pt of plot.data) cols.push({ x: X(pt.t), v: pt.values, slot: null });
  } else {
    var start = plot.interval_start * 1000;
    var istep = plot.interval * 1000;
    binW = rctx.ppms * istep;
    for (const s of sortedSlots(plot))
      cols.push({ x: X(start + s * istep), v: plot.data[s], slot: s });
  }
  if (!cols.length) return;

  // Run boundaries are a property of the columns, not of any one series, so they
  // are found once and shared by every band — that is also what keeps the bands
  // stacked on each other rather than each breaking at a different place.
  var runs = [];
  var cur = null;
  for (var i = 0; i < cols.length; i++) {
    if (cur && cols[i].slot != null && cols[i].slot !== cols[i - 1].slot + 1) cur = null;
    if (!cur) { cur = []; runs.push(cur); }
    cur.push(i);
  }

  var lower = new Array(cols.length).fill(0);
  for (const id of ids) {
    var upper = new Array(cols.length);
    for (var k = 0; k < cols.length; k++) {
      // A series absent from one column contributes nothing there, but must not
      // tear the stack: the columns around it still stack, so the band pinches
      // to zero height instead of starting a new run.
      var raw = cols[k].v ? cols[k].v[id] : undefined;
      upper[k] = lower[k] + (raw == null ? 0 : raw);
    }
    c.fillStyle = resolveColor(plot, id, 0.75);
    for (const run of runs) {
      var top = edgePoints(run, cols, upper, step, binW);
      var bot = edgePoints(run, cols, lower, step, binW);
      c.beginPath();
      c.moveTo(top[0].x, Y(top[0].v));
      for (var t = 1; t < top.length; t++) c.lineTo(top[t].x, Y(top[t].v));
      for (var b = bot.length - 1; b >= 0; b--) c.lineTo(bot[b].x, Y(bot[b].v));
      c.closePath();
      c.fill();
    }
    lower = upper;
  }
}

// ── Ladder renderers ─────────────────────────────────────────────────────────
//
// Four renderers share one data shape: a binned block whose every slot holds,
// per series, an *array* of values aligned to `plot.percentiles`. They differ
// only in how they draw it.
//
//   quantile-bands   lines through the slot *centres*, shaded between
//   quantile-steps   a horizontal segment across each *bin*, shaded between
//   error-bars       a marker on the ladder's centre, whiskers over its pairs
//   candlestick      wick / body / median tick, or true OHLC via plot.roles
//
// quantile-bands interpolates between measurements; the other three are
// bin-local and claim nothing between bins. All four declare `values: 'array'`
// so the core's three banded branches pick them up (see `bandedTypes`).

/**
 * Symmetric decomposition of a percentile ladder into a centre and nested
 * low/high pairs, outermost first. Three renderers need the same reading of
 * `plot.percentiles`, and each working it out by hand is how they would drift.
 *
 *   [min, avg, max]          -> { centre: 1,    pairs: [[0,2]] }
 *   [p5,p25,p50,p75,p95]     -> { centre: 2,    pairs: [[0,4],[1,3]] }
 *   [p25, p75]               -> { centre: null, pairs: [[0,1]] }
 *
 * An even-length ladder has no centre entry, so error-bars draws no marker and
 * candlestick no median tick. Inventing one (rounding to a neighbour) would
 * label a value the data never claimed.
 */
export function ladderPairs(npct) {
  var pairs = [];
  for (var lo = 0, hi = npct - 1; lo < hi; lo++, hi--) pairs.push([lo, hi]);
  return { centre: (npct % 2) ? (npct - 1) / 2 : null, pairs: pairs };
}

/**
 * Pixel geometry of one bin: left edge, width, and the value-space factor of a
 * partial bin. Returns null for a bin that is not drawn at all. This is the
 * left/right-edge arithmetic every bin-local renderer needs, in one place —
 * multibar predates it and keeps its own inlined copy.
 */
function binGeom(plot, slot, rctx) {
  var step = plot.interval * 1000;
  var full = rctx.ppms * step;
  var part = partialAt(plot, slot);
  if (part && part.skip) return null;
  return {
    x0: rctx.X(plot.interval_start * 1000 + slot * step),
    w: part ? full * part.frac : full,
    k: part ? part.scale : 1,
  };
}

/**
 * Sub-slot within a bin for the k-th of `nVisible` series. Whiskers and candles
 * are drawn at a single x, so two series would otherwise land exactly on top of
 * one another and the upper one would simply erase the lower. Bands and steps
 * do not use this: their translucent fills overlay correctly.
 */
function dodgeBin(x0, width, nVisible, k) {
  if (nVisible <= 1) return { cx: x0 + width / 2, w: width };
  var w = width / nVisible;
  return { cx: x0 + w * (k + 0.5), w: w };
}

// Series ids actually drawn. The dodge index has to count only these, or
// hiding a series would leave a gap in the row instead of closing it up.
function visibleIds(plot, hidden) {
  var ids = plotSeriesIds(plot);
  if (!hidden || !hidden.size) return ids;
  return ids.filter(function (id) { return !hidden.has(id); });
}

// Slot numbers of a binned block in chronological order. Do not assume slot 0
// exists — a block covers an arbitrary window.
function sortedSlots(plot) {
  return Object.keys(plot.data).map(Number).sort(function (a, b) { return a - b; });
}

// Half-size in px of the marker error-bars draws on the ladder's centre.
// Deliberately not in POINT_RADIUS: that table is tied to the *point* hit test,
// and a ladder block is hit-tested by its bin, not by marker proximity.
const ERRORBAR_MARKER = 3;

// Fixed alpha tiers by band position: segments adjacent to the median get the
// highest alpha, halving outward. medianIdx is in percentile-index space.
function bandAlpha(j, npct) {
  var medianIdx = (npct - 1) / 2;
  var dist = Math.abs((j + 0.5) - medianIdx);   // 0.5 for innermost segments
  var tier = Math.round(dist - 0.5);            // 0, 1, 2, ... outward
  return Math.max(0.06, 0.25 * Math.pow(0.5, tier));
}

// quantile-bands — lines connect slot centres, the area between adjacent
// percentiles is filled in the series colour at a fixed per-band alpha (most
// opaque around the median, fainter in the tails).
function quantilebands(plot, rctx) {
  var { c, X, Y, hidden } = rctx;
  var pct = plot.percentiles || [];
  var npct = pct.length;
  if (npct < 2) return;
  if (plot.category === 'point') return;        // binned series only
  // The resolution cross-fade (history vs. trends) is applied by plotData via
  // globalAlpha — nothing to do here beyond drawing at the normal alphas.
  var start = plot.interval_start * 1000;
  var step = plot.interval * 1000;
  var half = step / 2;
  var slots = sortedSlots(plot);
  // A bin below PARTIAL_MIN_FRAC is neither measured for the y-extent nor
  // hittable, so it must not be drawn either. The other two partial effects
  // (narrowing, area-true scaling) are bar geometry and mean nothing to a line
  // through a slot centre, so only `skip` applies here.
  var skipPart = plot._partial;
  if (skipPart && skipPart.skip)
    slots = slots.filter(function (s) { return s !== skipPart.slot; });
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

// quantile-steps — the same ladder as quantile-bands, drawn bin-locally. Each
// percentile is a horizontal segment spanning its own interval and the shaded
// area between two of them is a staircase ribbon, so nothing is claimed about
// the time between two measurements. `plot.connect === false` drops the
// vertical risers, leaving the segments free-standing.
function quantilesteps(plot, rctx) {
  var { c, Y } = rctx;
  var pct = plot.percentiles || [];
  var npct = pct.length;
  if (npct < 2) return;
  if (plot.category === 'point') return;        // binned series only
  var connect = plot.connect !== false;
  var medianIdx = Math.floor((npct - 1) / 2);   // which line to draw bold

  // Geometry once per slot: the fills and every percentile line read it, and a
  // partial bin has to narrow all of them by the very same amount.
  var bins = [];
  for (const s of sortedSlots(plot)) {
    var g = binGeom(plot, s, rctx);
    if (g) bins.push({ slot: s, x0: g.x0, x1: g.x0 + g.w, k: g.k, v: plot.data[s] });
  }
  if (!bins.length) return;

  for (const id of visibleIds(plot, rctx.hidden)) {
    // Fills: one closed staircase per run of consecutive bins holding a value.
    // Merging a run into a single path rather than filling bin by bin keeps
    // antialiasing from leaving hairline seams between abutting rectangles.
    for (var j = 0; j < npct - 1; j++) {
      c.fillStyle = resolveColor(plot, id, bandAlpha(j, npct));
      var run = [];
      for (var si = 0; si <= bins.length; si++) {
        var b = si < bins.length ? bins[si] : null;
        var v = b ? b.v[id] : undefined;
        // A gap in the slot numbering is a gap in the data: unlike the bands,
        // steps never bridge one — there is no bin there to draw.
        var breaks = v === undefined || (run.length && b.slot !== run[run.length - 1].slot + 1);
        if (breaks) {
          fillRibbon(c, Y, run, j, id);
          run = [];
          if (v === undefined) continue;
        }
        if (b) run.push(b);
      }
    }
    // Lines: one path per percentile over all runs. The riser is simply the
    // lineTo that starts the next bin — it is vertical because an unbroken run
    // has bins sharing an edge (only the last bin of a block can be narrowed).
    for (var jl = 0; jl < npct; jl++) {
      c.lineWidth = (jl === medianIdx) ? 2 : 1;
      c.strokeStyle = resolveColor(plot, id, (jl === medianIdx) ? 0.9 : 0.55);
      c.beginPath();
      var prev = null;
      for (const bin of bins) {
        var vv = bin.v[id];
        if (vv === undefined) { prev = null; continue; }
        var y = Y(vv[jl] * bin.k);
        if (connect && prev && bin.slot === prev.slot + 1) c.lineTo(bin.x0, y);
        else c.moveTo(bin.x0, y);
        c.lineTo(bin.x1, y);
        prev = bin;
      }
      c.stroke();
    }
  }
  c.lineWidth = 1;
}

// One band segment across a run of consecutive bins: right along the top edge
// as a staircase, then back left along the bottom edge. Takes the series id
// rather than a pre-sliced array so a run costs no allocation per frame.
function fillRibbon(c, Y, run, j, id) {
  if (!run.length) return;
  c.beginPath();
  c.moveTo(run[0].x0, Y(run[0].v[id][j] * run[0].k));
  for (var r = 0; r < run.length; r++) {
    var yTop = Y(run[r].v[id][j] * run[r].k);
    c.lineTo(run[r].x0, yTop);
    c.lineTo(run[r].x1, yTop);
  }
  for (var q = run.length - 1; q >= 0; q--) {
    var yBot = Y(run[q].v[id][j + 1] * run[q].k);
    c.lineTo(run[q].x1, yBot);
    c.lineTo(run[q].x0, yBot);
  }
  c.closePath();
  c.fill();
}

// error-bars — a marker on the ladder's centre with a whisker over each of its
// symmetric pairs, drawn at the bin's centre. Nothing connects two bins, so the
// chart makes no claim at all about the time between them.
function errorbars(plot, rctx) {
  var { c, Y, margin, plotWidth } = rctx;
  var pct = plot.percentiles || [];
  var npct = pct.length;
  if (npct < 2) return;
  if (plot.category === 'point') return;        // binned series only
  var lad = ladderPairs(npct);
  var ids = visibleIds(plot, rctx.hidden);
  if (!ids.length) return;

  for (const s of sortedSlots(plot)) {
    var g = binGeom(plot, s, rctx);
    if (!g) continue;
    if (g.x0 + g.w < margin.left || g.x0 > margin.left + plotWidth) continue;
    var slot = plot.data[s];
    for (var ki = 0; ki < ids.length; ki++) {
      var v = slot[ids[ki]];
      if (v === undefined) continue;
      var d = dodgeBin(g.x0, g.w, ids.length, ki);
      // Innermost pair bold and opaque, outward thinner and fainter — the same
      // staffing quantile-bands applies to its fills, on stroke instead.
      for (var p = 0; p < lad.pairs.length; p++) {
        var inner = (p === lad.pairs.length - 1);
        c.lineWidth = 1 + p;
        c.strokeStyle = resolveColor(plot, ids[ki], inner ? 0.9 : 0.55);
        var yLo = Y(v[lad.pairs[p][0]] * g.k);
        var yHi = Y(v[lad.pairs[p][1]] * g.k);
        c.beginPath();
        c.moveTo(d.cx, yLo);
        c.lineTo(d.cx, yHi);
        // Caps on the outermost pair only; on every pair they read as noise.
        if (p === 0) {
          var cap = Math.max(2, Math.min(d.w * 0.4, 12)) / 2;
          c.moveTo(d.cx - cap, yLo); c.lineTo(d.cx + cap, yLo);
          c.moveTo(d.cx - cap, yHi); c.lineTo(d.cx + cap, yHi);
        }
        c.stroke();
      }
      if (lad.centre != null) {
        c.fillStyle = resolveColor(plot, ids[ki], 0.9);
        var yc = Y(v[lad.centre] * g.k);
        c.fillRect(d.cx - ERRORBAR_MARKER, yc - ERRORBAR_MARKER,
                   2 * ERRORBAR_MARKER, 2 * ERRORBAR_MARKER);
      }
    }
  }
  c.lineWidth = 1;
}

/**
 * Which ladder entries are the wick, the body and the median tick.
 *
 * `plot.roles = { open, high, low, close }` (indices into the value array) is
 * the true OHLC case and also the only one with a direction, hence the only one
 * that can colour rising against falling. Without it the roles come out of the
 * ladder itself: the outermost pair is the wick and the next one in the body.
 * A ladder with only one pair ([min,avg,max], [p25,p75]) becomes a plain filled
 * box over that pair instead of a hairline candle with no body at all.
 */
function candleRoles(plot, npct) {
  var r = plot.roles;
  if (r) {
    var ok = ['open', 'high', 'low', 'close'].every(function (k) {
      return typeof r[k] === 'number' && r[k] >= 0 && r[k] < npct;
    });
    // A malformed mapping falls back rather than drawing from undefined values.
    if (ok) return { wick: [r.low, r.high], body: [r.open, r.close], tick: null, ohlc: r };
  }
  var lad = ladderPairs(npct);
  if (lad.pairs.length >= 2)
    return { wick: lad.pairs[0], body: lad.pairs[1], tick: lad.centre, ohlc: null };
  return { wick: null, body: lad.pairs[0], tick: lad.centre, ohlc: null };
}

// candlestick — wick, body and median tick per bin. See candleRoles for how the
// three are read out of the ladder, and for the OHLC opt-in.
function candlestick(plot, rctx) {
  var { c, Y, margin, plotWidth } = rctx;
  var pct = plot.percentiles || [];
  var npct = pct.length;
  if (npct < 2) return;
  if (plot.category === 'point') return;        // binned series only
  var role = candleRoles(plot, npct);
  var cc = plot.candleColors;
  var ids = visibleIds(plot, rctx.hidden);
  if (!ids.length) return;

  for (const s of sortedSlots(plot)) {
    var g = binGeom(plot, s, rctx);
    if (!g) continue;
    if (g.x0 + g.w < margin.left || g.x0 > margin.left + plotWidth) continue;
    var slot = plot.data[s];
    for (var ki = 0; ki < ids.length; ki++) {
      var v = slot[ids[ki]];
      if (v === undefined) continue;
      var d = dodgeBin(g.x0, g.w, ids.length, ki);
      var bw = Math.max(d.w * 0.7, 1);
      var bx = d.cx - bw / 2;
      c.lineWidth = 1;
      if (role.wick) {
        c.strokeStyle = resolveColor(plot, ids[ki], 0.8);
        c.beginPath();
        c.moveTo(d.cx, Y(v[role.wick[0]] * g.k));
        c.lineTo(d.cx, Y(v[role.wick[1]] * g.k));
        c.stroke();
      }
      var y0 = Y(v[role.body[0]] * g.k);
      var y1 = Y(v[role.body[1]] * g.k);
      var top = Math.min(y0, y1);
      // A doji — open equal to close — still has to be visible as a line.
      var h = Math.max(Math.abs(y1 - y0), 1);
      var up = role.ohlc ? v[role.ohlc.close] >= v[role.ohlc.open] : true;
      var override = cc && (up ? cc.up : cc.down);
      if (override) {
        c.fillStyle = override;
        c.fillRect(bx, top, bw, h);
      } else if (role.ohlc && up) {
        // Hollow rising, filled falling: the classic convention, and the one
        // that needs no second colour — so it re-themes with the series and
        // keeps renderers out of settings.colors.
        c.strokeStyle = resolveColor(plot, ids[ki], 0.9);
        c.strokeRect(bx, top, bw, h);
      } else {
        c.fillStyle = resolveColor(plot, ids[ki], 0.8);
        c.fillRect(bx, top, bw, h);
      }
      if (role.tick != null) {
        c.strokeStyle = resolveColor(plot, ids[ki], 0.9);
        c.lineWidth = 2;
        var yt = Y(v[role.tick] * g.k);
        c.beginPath();
        c.moveTo(bx, yt);
        c.lineTo(bx + bw, yt);
        c.stroke();
        c.lineWidth = 1;
      }
    }
  }
}

// ohlc — the bar form of a candle: a high-low line with the open ticked off to
// the left and the close to the right. Reads exactly the same block and the same
// roles as candlestick (see candleRoles); it draws thinner, which is what keeps
// it readable at bin widths where a filled body turns into a blob.
function ohlc(plot, rctx) {
  var { c, Y, margin, plotWidth } = rctx;
  var pct = plot.percentiles || [];
  var npct = pct.length;
  if (npct < 2) return;
  if (plot.category === 'point') return;        // binned series only
  var role = candleRoles(plot, npct);
  var cc = plot.candleColors;
  var ids = visibleIds(plot, rctx.hidden);
  if (!ids.length) return;

  for (const s of sortedSlots(plot)) {
    var g = binGeom(plot, s, rctx);
    if (!g) continue;
    if (g.x0 + g.w < margin.left || g.x0 > margin.left + plotWidth) continue;
    var slot = plot.data[s];
    for (var ki = 0; ki < ids.length; ki++) {
      var v = slot[ids[ki]];
      if (v === undefined) continue;
      var d = dodgeBin(g.x0, g.w, ids.length, ki);
      var tw = Math.max(d.w * 0.35, 1);
      var up = role.ohlc ? v[role.ohlc.close] >= v[role.ohlc.open] : true;
      var override = cc && (up ? cc.up : cc.down);
      // No hollow/filled convention here — an OHLC bar is all strokes, so the
      // direction shows only where candleColors gives it a second colour.
      c.strokeStyle = override || resolveColor(plot, ids[ki], 0.85);
      c.lineWidth = 1;
      c.beginPath();
      if (role.wick) {
        c.moveTo(d.cx, Y(v[role.wick[0]] * g.k));
        c.lineTo(d.cx, Y(v[role.wick[1]] * g.k));
      }
      // Open left, close right. These ticks are the whole difference between an
      // OHLC bar and a plain whisker, so they are drawn even when the ladder
      // yielded no separate wick pair to hang them on.
      var yOpen = Y(v[role.body[0]] * g.k);
      var yClose = Y(v[role.body[1]] * g.k);
      c.moveTo(d.cx - tw, yOpen);
      c.lineTo(d.cx, yOpen);
      c.moveTo(d.cx, yClose);
      c.lineTo(d.cx + tw, yClose);
      c.stroke();
    }
  }
  c.lineWidth = 1;
}

// Register built-in renderers
registerRenderer({ type: 'multibar',   draw: multibar,   highlight: highlight_multibar,
                   stacked: true });
registerRenderer({ type: 'multiline',  draw: multiline });
registerRenderer({ type: 'multipoint', draw: multipoint });
registerRenderer({ type: 'scatter',    draw: scatter });
// Areas join across abutting fetch blocks for the same reason the ladder types
// do: a stack drawn block by block leaves a one-slot notch at every margin.
var areaCoalesce = function (plot) { return (plot.name || '') + '|' + plot.interval; };
registerRenderer({
  type: 'stackarea',
  draw: stackarea,
  stacked: true,
  coalesce: areaCoalesce,
});
// Coalesce abutting fetch blocks (same source + interval) so the fan lines,
// shaded bands and step risers run continuously across block margins.
var ladderCoalesce = function (plot) { return (plot.name || '') + '|' + plot.interval; };
registerRenderer({
  type: 'quantile-bands',
  draw: quantilebands,
  values: 'array',
  coalesce: ladderCoalesce,
});
registerRenderer({
  type: 'quantile-steps',
  draw: quantilesteps,
  values: 'array',
  coalesce: ladderCoalesce,
});
// error-bars and candlestick draw nothing between two bins, so they have no
// block margin to bridge and need no coalesce.
registerRenderer({ type: 'error-bars',  draw: errorbars,   values: 'array' });
registerRenderer({ type: 'candlestick', draw: candlestick, values: 'array' });
registerRenderer({ type: 'ohlc',        draw: ohlc,        values: 'array' });
