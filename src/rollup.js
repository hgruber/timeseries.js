// Derive a coarser resolution tier from a binned plot block.
//
// The core already keeps blocks of differing `interval` side by side and
// cross-fades between them as the zoom crosses the ~2px bar-width threshold
// (see prepare_grid in timeseries.js). What it cannot do is *produce* the
// coarser tier — a source either delivers several resolutions or it does not.
// This is the missing half for the common case where a consumer holds one
// high-resolution block and wants the dissolve anyway.
//
// Pure and non-mutating, like lttb: it reads `plot` and returns a new block.
//
//   plot           a binned block: { interval, interval_start, data: {slot: {seriesId: value}}, … }
//                  category 'point'/'span' and array-valued blocks (quantile-bands)
//                  are out of scope and yield null
//   coarseInterval target bucket size in seconds; must be an integer multiple
//                  of plot.interval, else null
//   opts.agg       'sum' (default) | 'mean' | 'max' | 'min' | fn(values, seriesId, slot) → number
//
// A note on `agg`: 'sum' is the right semantics for counts, but it scales the
// coarse tier by the bucket ratio, so the axis unit effectively changes across
// the dissolve ("per minute" → "per hour"). prepare_grid interpolates the
// y-extent across the fade band so this travels smoothly rather than snapping,
// but for rates or gauges 'mean' is what you want.

var AGGS = {
  sum: function (vs) {
    var s = 0;
    for (var i = 0; i < vs.length; i++) s += vs[i];
    return s;
  },
  // Divides by the number of fine buckets actually present, not by the bucket
  // ratio — a sparse series must not be diluted by the slots it never had.
  mean: function (vs) {
    var s = 0;
    for (var i = 0; i < vs.length; i++) s += vs[i];
    return s / vs.length;
  },
  max: function (vs) {
    var m = vs[0];
    for (var i = 1; i < vs.length; i++) if (vs[i] > m) m = vs[i];
    return m;
  },
  min: function (vs) {
    var m = vs[0];
    for (var i = 1; i < vs.length; i++) if (vs[i] < m) m = vs[i];
    return m;
  },
};

export function rollupBinned(plot, coarseInterval, opts) {
  if (!plot || !plot.data) return null;
  if (plot.category === 'point' || plot.category === 'span') return null;
  if (!(plot.interval > 0) || !(coarseInterval > 0)) return null;
  // Whole fine buckets per coarse bucket, or the coarse grid would cut a fine
  // slot in half and the value would land in an arbitrary one of the two.
  var factor = coarseInterval / plot.interval;
  if (factor < 1 || Math.abs(factor - Math.round(factor)) > 1e-9) return null;

  var agg = (opts && opts.agg) || 'sum';
  var aggFn = (typeof agg === 'function') ? agg : AGGS[agg];
  if (!aggFn) return null;

  // Grid the coarse buckets on absolute epoch time, not on this block's slot 0:
  // two fetch blocks starting at different offsets must land on the same coarse
  // boundaries, or pushData's concat path stitches them together with gaps.
  var coarseStart = Math.floor(plot.interval_start / coarseInterval) * coarseInterval;

  // Collect the fine values per coarse slot per series before aggregating —
  // a custom agg gets to see the whole bucket, not a running accumulator.
  var buckets = {};
  var maxSlot = -1;
  for (var k in plot.data) {
    var fine = plot.data[k];
    var abs = plot.interval_start + +k * plot.interval;
    var cs = Math.floor((abs - coarseStart) / coarseInterval);
    if (cs > maxSlot) maxSlot = cs;
    var b = buckets[cs] || (buckets[cs] = {});
    for (var id in fine) {
      var v = fine[id];
      // Array values are quantile-bands and need percentile-aware folding,
      // which is a different problem than aggregating a scalar.
      if (Array.isArray(v)) return null;
      if (v == null) continue;
      (b[id] || (b[id] = [])).push(v);
    }
  }

  var out = {};
  var mn = Infinity, mx = -Infinity;
  for (var slot in buckets) {
    var src = buckets[slot];
    var row = {};
    for (var sid in src) {
      var val = aggFn(src[sid], sid, +slot);
      row[sid] = val;
      if (val < mn) mn = val;
      if (val > mx) mx = val;
    }
    out[slot] = row;
  }

  var result = {
    type: plot.type,
    interval: coarseInterval,
    interval_start: coarseStart,
    interval_end: coarseStart + coarseInterval * (maxSlot + 1),
    count: maxSlot + 1,
    min: mn === Infinity ? 0 : mn,
    max: mx === -Infinity ? 0 : mx,
    data: out,
  };
  // Carry the descriptive metadata; deliberately not `_fade`, `_laidOut` or
  // `intervals`, which are render state the core recomputes per frame.
  //
  // Nor `data_until`, for the same reason `extensive` is left behind: whether
  // the *result* has an incomplete bin is a property of the aggregation, not of
  // the input. Copying it would silently make the coarse tier partial too, at a
  // quite different fraction of its own longer interval, and so change the
  // cross-fade for callers who never asked for any of that. A host that wants
  // it there sets `coarse.data_until = fine.data_until` itself.
  if (plot.name != null) result.name = plot.name;
  if (plot.category != null) result.category = plot.category;
  if (plot.series_colors) result.series_colors = plot.series_colors;
  if (plot.series_directions) result.series_directions = plot.series_directions;
  return result;
}
