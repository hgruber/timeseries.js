# Internals — renderers

Why the renderer layer is shaped the way it is. The *how to use it* side lives in
[Data formats](../data-formats.md) and [Plugins](../plugins.md); this page is the
reasoning behind those, and the record of what breaks when a rule is dropped.

Source: `src/renderers.js`, `src/gantt.js`.

## Plugin interfaces

**Renderer plugin** (`src/renderers.js`):
```js
TimeSeries.registerRenderer({
  type: 'my-type',
  draw(plot, rctx) { /* rctx: { c, X, Y, ppms, ppv, margin, plotWidth, plotHeight } */ },
  highlight(plot, n, item, rctx) { /* optional */ },
  coalesce(plot) { /* optional — key; blocks sharing it are merged before draw */ },
  values: 'array', /* optional — declares a ladder renderer, see below */
  stacked: true,   /* optional — declares that series sum per slot, see below */
  cumulative: true,/* optional — values are deltas; see `waterfall` below */
  lanes: true,     /* optional — categorical y-axis; see The lane axis below */
  layout(plot) { /* required with `lanes` — stamps laneCount/yticks; idempotent */ },
});
```

**`values: 'array'` is load-bearing, not decoration.** The core branches on "does this
type store an array per slot" at three sites in `src/timeseries.js` (the `pushData`
concat allow-list, the extent recompute beside it, and the y-extent scan in
`prepare_grid`). Those used to test the literal string `'quantile-bands'`; they now call
`isBandedType()` from `src/renderers.js`, which `registerRenderer` populates from this
field. A type that fails to declare it does **not** error — `array * number` is `NaN`,
`NaN >= 0` is false, so the extent scan contributes nothing and the axis silently falls
back to `plot.max`. That silence is the whole reason the flag exists.

**`stacked: true` is the same move for the y-extent.** A stacked type's tallest point in
a slot is the *sum* of that slot's series; an unstacked one's is its largest single
series, and `prepare_grid` has no other way to tell them apart. This was the literal
`plot.type === 'multibar'` until `stackarea` needed the same treatment, i.e. it was a fact
only the core knew and a second stacked renderer could not declare. It now reads
`isStackedType()`, populated by `registerRenderer` from this field, and the same flag also
puts the type on the `pushData` concat allow-list (which likewise tested `'multibar'`).
Omitting it fails as quietly as the banded case, mirror-imaged: the axis is measured from
the tallest single series and the top of every stack is clipped off.

## Plot object shape

Renderers receive a `plot` object with:
```js
{
  type: 'multibar' | 'multiline' | 'multipoint',
  interval_start: number,  // Unix seconds
  interval_end: number,    // Unix seconds
  interval: number,        // seconds per slot
  count: number,
  min: number, max: number,
  data: { [slotIndex]: { [seriesId]: value } }
}
```

`plot.category` selects between three shapes: the binned default (above), `'point'`
(`data` is an array of `{t, values}`, extent from `plot.tmin`/`tmax`), and `'span'`.
Orthogonally to `category`, a binned block's slot values may be **arrays** rather than
numbers — see *Ladder renderers* below.

An optional `extensive: true` marks the values as amounts accumulated over the bin (counts,
sums) rather than already per-unit (averages, percentiles, gauges) — see
[the rate axis](core.md#the-rate-axis--setrateunitseconds-opts).
It is inert unless `setRateUnit()` is in use.

## Span plots (`category: 'span'`) and the gantt renderer

Spans are for data with arbitrary start/end pairs — calendar events, jobs, outages — where bar
width means duration rather than a slot on a shared grid:
```js
{
  type: 'gantt', category: 'span',
  tmin, tmax,                        // ms epoch — window this block covers
  layout: 'calendar' | 'packed',     // one row-block per lane, or greedy-packed into one band
  lanes: [{ id, label, color }],     // 'calendar' layout
  data: [{ id, lane, start, end, label, color, group }],   // start/end in ms epoch
}
```
`layoutSpans(plot)` (`src/gantt.js`) assigns `_row` to each event and derives `laneCount`,
`yticks` (lane names for the y-axis) and `laneBounds`. It's idempotent and stamped via
`plot._laidOut`; `prepare_grid` calls it before computing the y-extent, so **mutating `data` in
place requires clearing `plot._laidOut`**. Rows occupy the value space `0…laneCount`, which is
what lets the existing `Y()`/`ppv` transforms and axis animation carry them unchanged.

`group` is optional and only affects row *packing*, not drawing: within one lane, `pack()`
prefers to reuse the same row for every event sharing a `group` value, as long as that row is
still free at the event's start (falling back to ordinary first-fit otherwise, so it can never
cause an incorrect overlap). Without it, several short, non-overlapping events that a consumer
considers "the same thing" — e.g. one flapping trigger firing many brief times — can land in
different rows purely because unrelated events on the same lane happened to occupy whichever
row was free at each particular moment. Leave it unset for independent events (the CalDAV source
does; each event is its own thing, nothing to keep together).

Core support for `'span'` lives in four guarded spots in `src/timeseries.js`: extent in `pushData`
and `prepare_grid`, the y-extent shortcut, and the hit test in `get_element` (which mirrors
`barRect()` in `gantt.js` — keep the two in step).

## The area family — `multiline`'s `step`/`fill`, and `stackarea`

`multiline` takes two per-block options (`step: 'after'|'before'`, `fill: true`), and
`stackarea` is the stacked renderer beside it. Both shapes — binned and point — support
all of it. Things worth knowing before touching this family:

- **`lineRuns(plot, sid, rctx)` is the single reading of "where does this series' line
  go".** It replaced two near-identical branches in `multiline` that had already begun to
  drift: the binned one broke a run only on `undefined`, so an explicit `null` was drawn at
  `Y(0)` — a spike to the axis indistinguishable from data. It returns `{runs, binW}`;
  `binW` exists because a `step: 'after'` staircase has to carry its last value *across*
  the bin that value belongs to, which a list of bin-start x-coordinates cannot express.
- **A line bridges a gap in the slot numbering; a filled form breaks on it.** That split is
  deliberate and it is the rule for the whole file: `multiline` and `quantile-bands`
  interpolate by definition, while `stackarea` and `quantile-steps` shade a region, and
  shading across unmeasured time asserts far more than a line through it does. What breaks
  a line is a missing *value* in a slot that exists. Note this page's predecessor in
  `CLAUDE.md`, and the source, both used to claim `multiline` broke on a missing slot; it
  never did.
- **`stackarea` is a type, not a `stack: true` flag on `multiline`** — because
  `prepare_grid` decides how to measure the y-extent from the *type* (`isStackedType`), so
  a per-plot flag would put that decision somewhere the registry cannot see it.
- **`traceRun` traces into the current path; `edgePoints` returns a list.** They look
  redundant and are not: a stacked band is closed by walking its *lower* edge backwards,
  and a path-tracing helper cannot be run in reverse.
- **`coalesceBlocks` carries `step` and `fill` alongside `connect`.** All three change what
  a block draws *between* bins, so a merged block that dropped them would draw differently
  from the blocks it was built out of. `stackarea` registers `coalesce` for the same reason
  `quantile-steps` does — a stack drawn block by block notches at every fetch margin.
- **`fill` clamps its closing edge to the plot box.** The zero line can sit far outside the
  viewport, and an unclamped fill paints over the axis and the margins on its way there.
  The data vertices themselves are *not* clamped, matching every other renderer.

## The lane axis — a renderer property, not a data shape

A **categorical y-axis**: each series or lane owns a horizontal band, the axis prints names
instead of numbers, and the plot occupies the fixed value space `0…laneCount` whatever its
values are. `gantt`, `heatmap` and `horizon` all use it.

This used to be welded to `category === 'span'` — `prepare_grid` called `layoutSpans()` by
name and keyed the extent shortcut off the category — which is why `gantt` was the only
renderer that could ever have a lane axis. The two concerns are now separate:

- **`lanes: true`** declares the axis; `isLanedType()` reports it. It sits beside
  `values: 'array'`, `stacked` and `cumulative` as the fourth thing a renderer tells the
  core that the core cannot infer.
- **`layout(plot)`** is the hook that stamps `laneCount` and `yticks` before draw time.
  `gantt` hangs its existing `layoutSpans` on it; `heatmap`/`horizon` share `laneLayout`,
  which just gives each series a lane. `layoutPlot(plot)` in `renderers.js` dispatches it
  and is called for *every* block each frame, so implementations must be idempotent.
- **The category still decides the *time* extents** (`ptmin`/`ptmax` from `tmin`/`tmax` for
  span and point, from `interval_start` for binned). Only the *y* axis moved. Keeping those
  two apart is the whole point — `gantt` is a span renderer and `heatmap` a binned one.
- **A span block keeps its lane axis whether or not its renderer declares one.** That
  back-compat path is not decoration: a third-party span renderer written before `lanes`
  existed declares neither `lanes` nor `layout`, and without it falls through to the *binned*
  extent scan — which reads `plot.data` as a slot map, while a span block's `data` is an
  array. So `prepare_grid` still calls `layoutSpans` for an unpacked span block and still
  ORs `category === 'span'` into the laned test. `test/laned-types.test.mjs` registers a
  bare span renderer to pin it (verified to fail without the fallback).
- Lane *k* owns `[laneCount-k-1, laneCount-k)`, and the hit test finds a cell from the row
  and the slot alone — structurally the span branch, not the value branches.
- **A hidden lane is blanked, not closed up.** Removing the row would relabel every lane
  below it, so the axis would shift under the user's pointer.

`test/gantt.test.mjs` and `test/gantt-hittest.test.mjs` passing *unchanged* is the
regression proof for this rework; `test/laned-types.test.mjs` asserts `isLanedType('gantt')`
for the same reason.

## `heatmap` and `horizon`

Both binned, both laned, both sharing `laneLayout` and `laneRange`.

- **The colour/fill range is measured over the whole block, not the viewport** — same call
  as the waterfall total accumulating from the first slot. A scale that rescaled itself on
  every pan would make one value read as two colours a second apart. `vmin`/`vmax` pin it.
- **`heatmap`'s default colour is the *series* colour at a value-dependent alpha**, not a
  sequential palette of the library's own. That re-themes for free across all four themes,
  costs no palette to maintain, and keeps two lanes apart at a glance — which one shared
  ramp does not. `plot.colorScale` (hex stops, interpolated) is the explicit opt-in; non-hex
  stops snap to the nearest rather than blending, since an invalid `fillStyle` would
  silently keep the previous colour for the rest of the frame.
- **`horizon` puts its alpha ramp on the colour, never on `globalAlpha`** — that belongs to
  the tier cross-fade, and writing it inside a renderer cancels the dissolve. `withAlpha()`
  was split out of `resolveColor` precisely so the negative-direction colour, which is not a
  series colour, can take the same ramp.
- **`coalesceBlocks` carries `lanes`/`colorScale`/`vmin`/`vmax`/`horizonBands`.** Two fetch
  blocks that each derived their own lane order or colour range would draw the same series
  in a different row and a different colour on either side of the block margin.
  Note the y-extent is still computed per block, *before* the merge — so blocks whose series
  sets differ can still disagree on `laneCount`. Pass `plot.lanes` explicitly if a source
  pushes blocks that do not all carry every series.

## `waterfall` — the one cumulative type

A binned block of **deltas**: each bar is drawn between the running total before its value
and after it. `plot.totals` (slot numbers) marks bars that restate the sum from zero,
`plot.waterfallColors = {up, down, total}` colours the three roles, `connect: false` drops
the leader lines.

- **`waterfallLevels(plot)` is the one place the levels are derived**, and the renderer,
  the y-extent scan in `prepare_grid` and the hit test in `get_element` all call it. Three
  consumers agreeing on where a bar is, by construction — the same arrangement `barRect()`
  in `gantt.js` has to maintain by hand.
- **It is recomputed every frame, deliberately not cached** the way `layoutSpans` stamps
  `_laidOut`. A cache would need invalidating on every path that edits a block, and
  `pushData` edits blocks in place when a polling source supersedes slots. This is the same
  call `partialOf` makes for `data_until`: reading the truth each frame beats maintaining a
  horizon.
- **The total accumulates from the block's first slot, never from the viewport edge.** A
  zero point that moved as you panned would make every bar jump on every drag.
  `test/waterfall.test.mjs` pins this by panning and re-reading the extent.
- **`cumulative: true` is why the y-extent is right.** Measuring a waterfall like an
  ordinary binned block gives the largest single step, which is almost never the height of
  the chart. Third of the same family as `values: 'array'` and `stacked: true`.
- **It has no `coalesce`**, unlike the other bin-local renderers: the running total is
  accumulated from the block's own first slot, so merging two fetch blocks would restart it
  somewhere else and move every bar.
- **`binGeom`'s `k` (the partial bin's area-true factor) is deliberately not applied**, in
  the renderer *and* in the extent scan. That factor means "this amount was accumulated
  over part of a bin", and a waterfall bar's value is a difference between two levels, not
  an amount with an area. Only `skip` and the narrowing apply. The two must skip it
  together or the paint and the axis disagree.

## Ladder renderers — one block, five ways to draw it

Five renderers share one shape: a **binned** block whose every slot holds, per series, an
*array* aligned to `plot.percentiles`. They all declare `values: 'array'`.

| Type | Draws | Interpolates? |
|---|---|---|
| `quantile-bands` | lines through slot **centres**, shaded between | yes |
| `quantile-steps` | a flat segment across each **bin**, shaded between | no |
| `error-bars` | marker on the centre rung, whiskers over the pairs | no |
| `ohlc` | high–low line, open ticked left, close ticked right | no |
| `candlestick` | wick / body / median tick, or true OHLC via `plot.roles` | no |

`quantile-steps`, `error-bars` and `candlestick` exist because the bands draw a value for
every instant between two measurements, and nothing was measured there. They are a
presentation choice, not a data one — the same block feeds all four.

Things worth knowing before touching this family:

- **`ladderPairs(npct)` (`src/renderers.js`, exported) is the single reading of
  `plot.percentiles`.** It returns `{ centre, pairs }`, pairs outermost-first. Three
  renderers need the same decomposition and each deriving it by hand is how they would
  drift. An **even** ladder has `centre: null` and therefore no marker and no median tick —
  rounding to a neighbour would label a value the data never claimed. Note
  `quantile-bands` predates it and keeps its own `Math.floor((npct-1)/2)`; that is
  deliberate, its bold-median index must not move.
- **`binGeom(plot, slot, rctx)`** is the left-edge/width/partial-scale arithmetic the three
  bin-local renderers share; `multibar` predates it and keeps an inlined copy.
- **`dodgeBin()` is only for the glyph renderers.** `error-bars` and `candlestick` draw at a
  single x, so two series would land exactly on top of each other and the upper one would
  erase the lower. Bands and steps must *not* dodge — their translucent fills overlay
  correctly, and the dodge index counts only *visible* series so hiding one closes the row
  up rather than leaving a hole.
- **`coalesceBlocks` now carries a rebased `_partial`.** `quantile-steps` registers
  `coalesce` (to keep risers running across fetch-block margins) *and* reads `_partial`,
  which is exactly the collision the function's docstring used to only anticipate. Only one
  record survives, the one at the highest rebased slot.
- **The hit test is its own branch** in `get_element`, above the multibar loop: a ladder has
  no stack to walk, so the bin is the target and the whole array comes back as `value`,
  raw and unscaled. It grabs within 4px of the ladder's range (the `POINT_RADIUS.multiline`
  idea, in value space) so a min=avg=max hairline stays hittable, picks the ladder whose
  middle is nearest when several overlap, and — unlike the multibar branch, which still
  does not — honours `hiddenSeries`.
- **All tiers of one signal must use the same ladder type**: `_fade` groups by `plot.type`,
  so two types pop rather than dissolve. The `zabbix` source's `render` option therefore
  applies to every tier at once.

## Series visibility and legends

The core provides the *data* for a legend and never builds DOM for it (the opt-in
[`attachLegend` helper](core.md#dom-overlays-the-tooltip-and-legend-are-the-shipped-exceptions)
does): `ts.getSeries()` returns `[{ id, label, color, hidden }]`
for the series across all active plots, `color` being exactly what was painted (including
any `plot.series_colors` override).

Hiding is instance-wide by series id, not per plot: an id names the same measurement in
every block a source pushes, and hiding it in one block only would flicker as blocks
scroll past. The hidden set reaches renderers through `rctx.hidden` (a `Set`), and
`prepare_grid` excludes hidden series from the y-extent — otherwise hiding the tallest
series would leave the rest squashed against the axis.

`plotSeriesIds(plot)` in `src/renderers.js` is the one place that knows how to enumerate
a plot's series (point / binned / span). Renderers, `getSeries()` and the hit test all
call it rather than re-deriving it.

**Series colours are keyed by series id everywhere.** `multiline`(point) and `scatter`
used to colour by ordinal index instead, which meant hiding one series recoloured all the
ones after it. If you add a renderer, use `resolveColor(plot, seriesId, alpha)`.

## Point hit testing

`POINT_RADIUS` in `src/renderers.js` is the marker half-size per renderer type, shared
between drawing and the hit test in `get_element` — the same "keep these in step"
arrangement as `barRect()` in `gantt.js`. Point plots are hit-tested in *pixel* space
(nearest marker within its radius), unlike bars, which tile the plot area and can be
found arithmetically. Valid only while no renderer downsamples internally; a source
applying `lttb` before pushing is fine, since both draw and hit test then see the
reduced array.

The one bar that does **not** tile its bin is the partial one (see
[Partial bins](core.md#partial-bins--plotdata_until--setpartialbins)):
right of `data_until` nothing is drawn, so `get_element` has to stop there explicitly
instead of inferring the bar from its slot index alone. That is the whole reason the
feature needed a hit-test change, and why a third consumer of the bar geometry had to be
kept in step with the other two.

`ts.zoom()`'s third argument overrides the animation duration for that one transition;
`0` jumps without animating. Omit it for the configured `zoomDuration`.

