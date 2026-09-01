# Internals — the core

`src/timeseries.js`: the draw loop, the axes and everything the renderers are handed.
The public surface is documented in [API reference](../api.md) and
[Configuration](../configuration.md); this page is why the machinery underneath looks
like it does, and which parts must not be "simplified".

## Main constructor (`src/timeseries.js`)

The entire library is a single closure function `TimeSeries(options)`. All internal state is shared across functions via closure variables:

- `tmin`/`tmax`: visible time window (Unix ms)
- `ymin`/`ymax`: visible value range
- `data[]`: array of plot objects ready to render
- `ppms`/`mspp`, `ppv`/`vpp`: zoom scale factors
- `grid[]`/`ygrid[]`: computed axis tick positions
- `rctx`: render context object, rebuilt on every `plotAll()` call and passed to renderer plugins

The draw loop (`plotAll()`) runs on every interaction: builds `rctx`, calls `prepare_grid()`, then draws background → watermark → y-axis → data → version watermark → frame → time indicator. The image watermark goes behind the data, the optional version watermark over it — see [packaging.md](packaging.md#the-version-watermark).

**Time axis levels**: `label_level` (0 = month/day, 1 = year/month) controls which formats `grid_level_label` selects. Easter-based holidays computed from the `holidays` settings object.

**`data[]` slot lifecycle**: a plot id *is* its index in `data[]`, and sources keep that id
across calls (`replaceData`/`removeData`). The array is therefore **never compacted** —
that would silently repoint every id a source still holds. Instead, freed indices go on a
`freeSlots` list and are handed out again by the next `pushData`. Always release through
`releaseSlot(i)`, never by assigning `data[i] = null` directly, or the slot leaks.

This matters for polling sources: they push on every fetch, and `pushData` trims the
superseded block by deleting its slots. That used to leave an empty husk in `data[]`
forever — and worse, those husks stayed in `activePlot` and were re-rendered every frame
(1000 fetches → 1000 "active" blocks). A block trimmed down to `count === 0` is now
released. `test/memory.test.mjs` guards this.

The `hL` (holiday lookup) and `easterYears` caches are bounded by `HL_MAX`/`EASTER_MAX`
and dropped wholesale on overflow; they key on dates actually requested, so panning across
centuries would otherwise accumulate an entry per day and never release it.

## DOM overlays: the tooltip and legend are the shipped exceptions

The core is canvas-only and builds no DOM. `src/tooltip.js` and `src/legend.js` are the
two deliberate exceptions: the same hover box and the same swatch/label toggle list were
being re-implemented by every consumer, so they ship with the library. What keeps them
from eroding the rule (both helpers hold to all four):

- **Opt-in.** Nothing exists until `attachTooltip(ts)` / `attachLegend(ts)` is called —
  no element, no listener, no cost. The library's default behaviour is still DOM-free.
- **Public hooks only.** They reach the chart through `onHoverDataCallback` /
  `onSeriesChange`, `onColorsChange`, `getCanvas`/`getColors`, `getSeries`/`toggleSeries`
  and `getPlotArea`, never closure internals. Anything a third-party overlay could not do,
  they do not do either.
- **Default plus override.** Zero config gives the full default (tooltip: swatch, label,
  `(value · interval)`, timestamp; legend: swatch + label, click-to-toggle, draggable).
  `labelFor`/`colorFor`/… retarget one piece; `formatter(ctx)` replaces the body/row, with
  `ctx.defaultContent()` / `ctx.defaultRow()` available so an app extends rather than
  forks.
- **Palette-themed.** Colours come from the `tooltip*` / `legend*` keys in
  `settings.colors` — the only palette keys the canvas never reads. A consumer already
  calling `ts.setColors(themes.dark)` re-themes the overlays for free.

Primitives added to make this work on public API alone, and they matter to anything else
overlay-shaped:

- **`onHoverDataCallback` and `onSeriesChange` subscribe instead of replacing** and each
  return an unsubscribe. `onHoverData` used to be a single slot; `onSeriesChange` used to
  push with no way to detach — the legend needs to unsubscribe on `destroy()`.
- **`setColors` now fires `onColorsChange`.** Without it a theme switch repainted the
  canvas and left every DOM overlay on the old colours.
- **`getCanvas()`** exposes the element, since overlays track the pointer / anchor against
  it and only the core knows which element `settings.canvas` resolved to.

**Scope line for the legend — the abstraction is deliberately narrow.** `attachLegend` is
a *series-visibility* legend (toggle a series on/off), not an analytical panel. gstar's
own legend does viewport-windowed totals, avg/quantile-band aggregation, selection→filter,
butterfly split and CSV — all bound to gstar's data model — so it **stays in gstar** and
does *not* consume `attachLegend`. Do not try to absorb those app features into the library
helper; that was the explicit design decision (the generic 20% ships, the app-specific 80%
does not). Extend via `formatter`/`extra`/`onItemClick` if a consumer needs more.

## Resolution tiers and the cross-fade (any renderer)

Blocks of the **same `type` differing only in `interval`** are kept side by side by `pushData`
and treated by `prepare_grid` as resolution tiers of one signal. Per frame it picks the finest
tier whose bars are at least `fadeHi` (2px) wide; as that tier shrinks past the threshold the
coarser one takes over. Rather than a hard pop, both stay in `activePlot` across the
`fadeHi`→`fadeLo` (2px→1px) band and each is stamped with `plot._fade` (outgoing `1 → 0`,
incoming `0 → 1`, summing to 1).

Two things make that dissolve actually look right, and both are **generic — not Zabbix- or
renderer-specific**:

- **`plotData()` applies `_fade` via `c.globalAlpha`** around each `plugin.draw()` call
  (`src/renderers.js`), so every renderer — `multibar`, `multiline`, `quantile-bands`, and any
  third-party one — gets the dissolve without knowing `_fade` exists. Do **not** reintroduce a
  per-renderer `* fade` on colour alphas; it would double up with `globalAlpha`. Blocks are
  drawn faintest-first, so the nearly-invisible tier can never wash out the dominant one.
  `highlight()` is wrapped the same way. A renderer that sets `globalAlpha` itself must restore
  it to the value it found, not to `1`. The same holds for `lineWidth`: the chart chrome
  (`frame()`, the grid, the year/month/day separators) strokes at the ambient value and sets
  none of its own, so `highlight_multibar`'s outline branch — which draws at 2 — must wrap its
  stroke in `save()`/`restore()`. Leaving it set thickens all of that chrome from the next
  frame on.
- **`prepare_grid` interpolates the y-extent across the band.** The two tiers may sit on very
  different value scales (a `sum` rollup: hourly bars are 60× the minute bars). The
  ratio-weighted `ymax_array` blend would otherwise pick the taller tier outright the moment
  both cover the viewport, snapping the axis at the *start* of the dissolve and squashing the
  outgoing bars to a sliver. `blendExtents()` overwrites both tiers' extents with
  `fadeProg * E_incoming + (1 - fadeProg) * E_outgoing`, so the axis travels with the fade.

The hit test in `get_element` skips blocks at `_fade < 0.5`, so mid-dissolve the tooltip follows
the tier that is visually dominant rather than whichever landed first in `activePlot`.

**The band is a setting**, `fadeHi: 2` / `fadeLo: 1`, also movable after construction with
`setFadeBand(hi, lo)` (which rejects anything not `0 < lo < hi` rather than letting a NaN
`fadeProg` reach `globalAlpha`). This matters for a host that decides for *itself* which tier
to fetch: it has a switch threshold of its own, and unless the canvas switches on the same
number it renders one resolution while the host keeps a different one topped up — so panning
puts holes in whatever is visually dominant. Such a host should set `fadeHi` to its own
threshold and fetch the outgoing tier for as long as the band lasts (`relevantTiers()` in
`src/sources.js` is the in-tree example).

`setRenderInterval(iv)` pins one interval and disables the cross-fade entirely — the GUI then
owns the transition policy.

**Producing a second tier**: `TimeSeries.rollupBinned(plot, coarseInterval, { agg })`
(`src/rollup.js`) derives a coarser block from a fine one. Pure and non-mutating, like `lttb`.
`coarseInterval` must be an integer multiple of `plot.interval`; buckets are gridded on absolute
epoch time (not on the block's slot 0) so separately fetched blocks land on the same coarse
boundaries. `agg` is `'sum'` (default) | `'mean'` | `'max'` | `'min'` | `fn(values, seriesId, slot)`;
`'mean'` divides by the fine slots actually present, not by the bucket ratio. Binned scalar
blocks only — `category: 'point'`/`'span'` and array-valued (`quantile-bands`) blocks return
`null`. Note that `'sum'` is right for counts but changes the effective axis unit across the
dissolve ("per minute" → "per hour"); `'mean'` keeps both tiers on one scale, and so does the
rate axis below.

## The rate axis — `setRateUnit(seconds, opts)`

The cross-fade above dissolves the two tiers into each other, but it cannot make them the same
*size*. When a block's values are amounts accumulated over the bin — counts, `'sum'` rollups —
the coarse tier's bars are `interval ratio` times the fine tier's (60× on a 60s→3600s ladder).
`prepare_grid`'s `blendExtents()` then has to travel the axis across the band, so the bars
visibly breathe through what should be a plain resolution swap.

`ts.setRateUnit(seconds)` draws such blocks **per `seconds`** rather than per bin. Per second the
two tiers hold the same number, so they draw at the same height and the axis stands still; the
tier switch is left to change only what is *printed* on the axis. `null` (the default) is off, so
nothing changes for a consumer that does not ask.

- **Opt-in per block**, via `plot.extensive = true`. The host is the only one who knows whether a
  value is extensive (a count, a sum) or already intensive (an average, a percentile, a gauge) —
  scaling an average by the bin length would be simply wrong. Point/span blocks are never scaled.
  **`rollupBinned` deliberately does not carry `extensive` over** to the derived block, unlike
  `name`/`category`/`series_colors`/`series_directions`: whether the *result* is extensive
  depends on the `agg`, not on the input — a `'sum'` of counts still is, a `'mean'` of the same
  counts is not. The trap is that the two features are otherwise made for each other, so the
  obvious `rollupBinned(fine, 3600, {agg:'sum'})` + `setRateUnit()` pairing silently leaves the
  coarse tier unscaled (the axis then reads the hourly sum, ~60× too high) with no warning. The
  worked examples in `doc/tiers.md` and `doc/recipes.md` set the flag explicitly and say why.
- **Applied centrally**, exactly like `_fade`: `prepare_grid` stamps `plot._vscale` and measures
  the y-extent in drawn space; `plotData()` (`src/renderers.js`) hands each renderer a render
  context with `Y` and `ppv` scaled by it. Every renderer, including third-party ones, gets the
  rate axis without knowing it exists. Do **not** multiply `_vscale` into a renderer's own
  arithmetic — it would double up. Note both `Y` *and* `ppv` are scaled: a stacked bar is drawn
  from `Y(base)` with height `-ppv * v`, and scaling one without the other detaches the bar from
  its own baseline.
- **The hit test scales the stack but returns the raw value**, so a tooltip or drill-down still
  reports the amount in the bin rather than whatever unit the axis happens to show.
- **The unit swap dissolves.** `opts.label` sets the axis unit text in the same call (one call, so
  there is no ordering trap between the scale and its label), and `opts.transition` (ms) fades the
  old tick set out while the new one fades in. The outgoing numbers keep the pixels they were
  drawn at — `ymin`/`ymax` scale by exactly the ratio of the two units, so old tick value `v` is
  drawn at `Y(v * factor)`. Only defined between two rate units; switching the rate axis on or off
  rescales per block (each factor depends on that block's interval), so that always snaps.

## Partial bins — `plot.data_until` / `setPartialBins`

A block may only have data up to some point (an ETL high-water mark, a lagging feed). Drawn
at full width, the bin holding that point is **both too short and too long** at once: it
holds a fraction of a bin's worth of data, and it reaches into a span that holds none. Modes
are `'full'` (default, pre-0.9.1 behaviour), `'clip'` (right edge on `data_until`) and
`'scale'` (clip + height ÷ fill fraction, so the bar's *area* stays the value it holds).

- **The policy is resolved once, in `partialOf` (`src/timeseries.js`), and stamped as
  `plot._partial = {slot, frac, scale, skip}`.** Four consumers — the renderer,
  `highlight_multibar`, the y-extent scan and the hit test — then read two numbers and know
  nothing about modes. Stamping the raw `f` instead would have put the mode × `extensive` ×
  threshold decision in four places. The record is reset for *every* block each frame, or it
  would survive `setPartialBins('full')`.
- **The computing half lives in `timeseries.js`, the reading half in `renderers.js`** —
  exactly mirroring `vscaleOf`, which exists in both files for the same reason: the mode is
  instance state and must not leak into the module-global renderer file.
- **`scale` *is* the rate-correct factor, not a second effect on top of it.** A value
  accumulated over `interval*f` seconds is a rate of `value/(interval*f)` = `_vscale / f`,
  so the area-true factor and the rate factor coincide and `setRateUnit` needs no special
  case. They compose because `scale` lives in **value** space and `_vscale` in **axis**
  space; each is applied exactly once.
- **This is the one per-slot render factor, so unlike `_fade`/`_vscale` it is applied inside
  the renderer** rather than centrally. A `scaledCtx` per slot would be an allocation per
  slot per frame; since `Y(v)` is affine in `v`, `bar * k` is the identical arithmetic for
  free. That is not the double-application the block-wide factors warn about.
- **Only `extensive` blocks are scaled**; an average or a percentile falls back to `'clip'`,
  same judgement as the rate axis. `'clip'` therefore has to exist internally whether or not
  anyone selects it — which is why the option is a tri-state string and not a boolean.
- **Below `PARTIAL_MIN_FRAC` (0.1) the bin is dropped entirely** — not drawn, not measured,
  not hittable — because `1/f` explodes: 30 s into an hourly bin is a 120× extrapolation on
  a sub-pixel bar. A *fraction of the data* was chosen as the threshold rather than a pixel
  width, so the same bin behaves the same at every zoom. It does not pop vertically: a bin
  filling steadily arrives at roughly its neighbours' height, and grows in **width**.
- **A stale `data_until` is inert by construction**, not by bookkeeping: `partialOf` accepts
  it only when its slot is the block's last populated one. `pushData` therefore needed no
  change at all, even though it trims blocks in place — reading the truth each frame beats
  updating a cached horizon on every path that edits a block.
- **`rollupBinned` does not carry `data_until` over**, same reasoning as `extensive`.
- The y-extent's `banded` branch holds an **array** per series, so the factor goes on each
  entry — `array * number` would be `NaN`. Inert today (`quantile-bands` is never
  `extensive`), but the shape must not be allowed.

## Zero-size canvases (hidden containers)

A chart whose container is `display:none` — a tab panel, a collapsed section — measures
0×0. That case is guarded, and the guards are load-bearing: **do not "simplify" them.**

The failure they prevent: `readContainerPad()` still reports the container's real CSS
padding, and `margin.top` is always two label rows, so `canvas.width - margin.left -
margin.right` comes out **negative**, not zero. `ppms` then goes negative, `mspp = 1/ppms`
large-negative, and every `setTimeout` delay derived from it non-positive — which the
browser clamps to 0, so the self-rescheduling redraw timers spin at ~250 fps. Since
`plotAll()` broadcasts to the viewport-sync group, one hidden chart dragged every visible
peer into the same loop and their sources into an endless refetch.

- **`clampPlot(px)` floors `plotWidth`/`plotHeight` at 1** at *all six* assignment sites:
  two in the constructor, two in the ResizeObserver, and two inside `prepare_grid` (after
  the `margin.left` and `margin.bottom` animations). Miss one and the negative leaks back.
- **The ResizeObserver bails out on a zero-area canvas**, keeping the last good geometry
  rather than recomputing from nothing — it fires again with a real rect on unhide. This
  also keeps `getViewport().ppms` sane, so a hidden chart's sources stay on their
  resolution tier instead of dropping to the coarsest one and refetching on unhide.
- **`plotAll()` bails out on a zero-area canvas too, reading `canvas.clientWidth`, not
  `canvas.width`** — the observer deliberately leaves the bitmap at its last good size, so
  `canvas.width` is non-zero while hidden and would never trip the guard.
- **The group broadcast sits *above* that bail-out.** A follow *leader* that gets hidden
  keeps ticking (`follower_tick` re-arms itself before calling `plotAll`) and is the only
  thing driving time for the group, so swallowing its broadcast froze every visible peer
  until the user next interacted. Broadcasting from a hidden chart is safe because the
  storm is fixed at its source by the clamp, not by silence.
- **`activePlot` is initialised to `[]`.** It is only assigned in `prepare_grid`, which the
  bail-out can now skip entirely, and `getActiveData()`/`getSeries()` are public —
  `attachLegend()` calls `getSeries()` at attach time, so a legend on a chart built inside
  a hidden panel used to throw.
- **`getCanvasWidth()` reports 0 while hidden**, so a hidden instance loses the follow-leader
  election. Note the election only runs inside `start_follower()` and is never re-run, so
  this decides who leads at that moment; it does not re-elect when a leader is later hidden.

There is still **no `destroy()`** on an instance, and `canvas._tsInstance` is never
cleared, so a canvas can never be reused: a second `new TimeSeries` on it warns and
`return`s, which under `new` yields a half-built object with none of the methods attached.
A page that needs to rebuild (e.g. after new credentials) has to reload —
`demo/zabbix-live.html`'s and `demo/caldav-live.html`'s "Disconnect" both do exactly that,
deliberately. Their `window.demoTheme.onChange` subscriptions ride on the same fact: registered
inside `buildCharts()`/`buildChart()` and never unsubscribed, because the only way out of a
built chart is that reload.

`test/resize.test.mjs` covers all of the above; `test/helpers/dom.mjs` gained
`resizeObservers`, `resizeCanvas(canvas, w, h)`, a `_pad`-aware `getComputedStyle` and an
opt-in `parentElement` (via `makeCanvas`'s 4th argument) to make it drivable — the stub
`ResizeObserver` used to be inert, so resize was untestable.

## Keyboard, and the snap grid

`keyboard: true` (default) makes the canvas focusable (`tabindex=0`, `role=application`,
an `aria-label` unless the page set one) and binds all four arrows: ←/→ page
(`pan(∓1)`), ↑/↓ zoom (`zoomStep(±1)`), and Shift makes each the single-cell variant
(`{cells: 1}`). Handlers sit on the canvas, not the document, so a page with several charts
only moves the focused one. Set `keyboard: false` to opt out entirely. On the mouse side the
wheel zooms and **Shift+wheel pans**, both continuous.

Five letters enter follow mode: `f`/`F` anchor now at the right edge, `p`/`P` at the left,
`c` in the centre. All five land in the identical rolling state, and case picks only the
span left on screen — `f` slides the current width onto now, `F` pins the left edge and
stretches the right one out to it. `withinZoomLimits()` is what stops a window lying wholly
on the wrong side of now from producing an inverted target that `clampRange()` would flip;
it falls back to the sliding entry. The letters deliberately do **not** call `dropGrid()`:
a follow jump lands on a now-relative window, `ensureGridFor()` sees `snapState.lo/hi` no
longer match it and picks a fresh grid on the next arrow press by itself. Any modifier
returns early, so `Ctrl+F` and `Ctrl+P` stay with the browser.

Six more jump to a calendar unit: `t` to today, and `d`/`w`/`m`/`y` to the day, ISO week,
month or year that `midTime()` — the middle of `pendingView()`, not of the drawn frame —
falls in. They go through `zoomDayAt`/`zoomWeekAt`/`zoomMonthAt`/`zoomYearAt`, of which the
last two only delegate to the existing `zoomMonth`/`zoomYear`.

`zoomWeekAt()` deliberately does **not** route through `zoomWeek(year, week)`. `getWeek()`
returns the ISO week number without the ISO week-numbering *year*, and the two part company
around new year — 31 Dec 2025 is week 1 of 2026 while `getFullYear()` says 2025, so
`zoomWeek(2025, 1)` lands a year early. Walking back to the Monday never has to name a year.
Everything here resolves on local midnight via `dayStart()`, never by adding 86400000: a
23-hour DST day has to end where the axis says it does.

Two more are switches: `g` is `togglePanSnap()`, and `l` is `toggleLegend()`. The second is
the one place the core holds a reference to an overlay, in `_legend`, and it does so for
exactly one reason — the keyboard has no other route to a controller `attachLegend()` handed
back to the *host*. The coupling is kept as thin as it can be: the core only ever calls
`toggle()` on it, so any object carrying one qualifies, and the registration is defensive on
both sides (`legend.js` guards every `ts` call because it also runs against a host's own
object). `destroy()` clears the slot only if it is still the controller in it, so a second
legend outliving the first is not unregistered by it. `toggleLegend()` on an empty slot is
silent, not a warning: a page without a legend is not a misconfiguration.

**A viewport is a grid state `{unit, mult, k, lo}`, not a pair of timestamps.** That framing
is the whole feature and two earlier designs died without it:

- **The level carries the anchor, so it must not be read coarser than it is.** Treating a
  6 h window as `3 × 2h` parks its edges on *even* hours (04:00–10:00) instead of the nearer
  full hour (03:00–09:00). `labelledLevels()` therefore offers **one step per unit** — the
  step `time_part()` says is currently printed — never the whole `part24`/`part60` ladder.
- **Deriving the grid from the viewport on every call feeds back on itself.** Rounding changes
  the width and the width picks the level: 100 s → 105 s → 120 s, and a fixpoint iteration
  does *not* fix it (measured: 10 cases in 30 000 cycle, distortion accumulates to 60 %). So
  the state is **held** in `snapState` and only re-attached when there is none or when its
  level stopped being labelled. Rounding therefore happens once per attach, bounded by
  `GRID_TOLERANCE` (20 %), and every key press after that is exact arithmetic.
  Do not "simplify" `ensureGrid()` into a pure function of `tmin`/`tmax`.

The level is the **coarsest currently *labelled* x-axis level that fits the window** —
`labelledLevels()` (instance scope, next to `time_part`) builds the candidate list, and
`pickGridLevel()` (module scope, pure, hence testable without a canvas) picks from it. That
list is the only place the grid touches pixels, deliberately: you can only snap to a boundary
you can read, so when the hour labels stop fitting the grid moves up to day boundaries. It
must keep reading the same `dtl` the axis labels by, or grid and labelling drift apart.

The 20 % guard in `pickGridLevel` is not cosmetic — without it "coarsest wins" collapses a
10-day window onto one calendar week. Two more things that look redundant and are not:
`gridWindow()` re-floors the edge after every step (`panAdd` on a `mult > 1` hour grid can
land on an odd hour across spring-forward), and analogue gestures call `dropGrid()` — the
wheel, `onmousedown` and `ontouchstart` — so the hand is never fighting the grid.

`panSnap: 'off'` (or `{snap: false}` per call) skips all of it: `pan()` moves by the exact
width, `zoomStep()` by a factor of two. `snapView()` snaps without paging, `getSnapGrid()`
reports the state, `setPanSnap`/`getPanSnap` switch modes at runtime.

## Module-level exports

Besides the default export, `src/timeseries.js` exports the pure date/format helpers so
they can be tested and reused without constructing a chart: `Easter(year)`,
`isoWeekStart(year, week)`, `siFormat(v)`, the calendar-stepping set `panFloor(ms, unit)`,
`panAdd(ms, unit, n)`, `panDiff(lo, hi, unit)`, and the snap-grid set
`floorToGrid(ms, unit, mult)`, `addGrid(ms, unit, mult, n)`, `gridCell(ms, unit, mult)`,
`nearestGrid(ms, unit, mult)`, `pickGridLevel(levels, tmin, span[, tol])` with the
`GRID_TOLERANCE` constant (20%) — see *Keyboard, and the snap grid* above.

`panFloor`/`panAdd` work on local `Date` fields and are therefore DST-correct; `panDiff`
divides by fixed ms constants for day/week, which is off by up to an hour across a DST change
— `Math.round` absorbs it, and `test/pan.test.mjs` pins that. `floorToGrid` anchors a
sub-multiple *inside* its parent unit exactly the way the drawn axis anchors its lines
(`grid[1..3]` test `s % part`, `m % part`, `h % part`), so a snapped edge always lands on a
line that is actually drawn; `gridCell` measures on the calendar at that instant, because a
month cell is 28–31 days and a day cell 23–25 hours.

**`panSnapUnit`, `panSnapEdge` and `PAN_TOLERANCE` were removed** with the grid rewrite (0.10.0).
Do not reintroduce edge-wise snapping: snapping each edge independently and deriving the step
count from the result is what used to inflate a 6 h window to 7 h on the first key press.

The statics `TimeSeries.registerRenderer` / `registerSource` / `seriesColor` / `lttb` /
`rollupBinned` / `siFormat` / `themes` live at module scope, so the IIFE build can call them
**before** the first `new TimeSeries(...)`.

## Option merging

`colors` is merged key-by-key with the defaults, so a partial override keeps the rest of
the palette (an undefined colour would reach the canvas as an invalid `fillStyle`).
Everything else, **including `holidays`**, replaces the default wholesale — that is how a
caller swaps the German holiday set for another country's. `TimeSeries.themes.light` is
the same object as the built-in default palette, not a copy of it.

### Initial window vs. follow state

Two settings take part in what the user sees at startup, and they have to be applied at
different points — they look like they should be one thing but are deliberately not.

`initialView`, when it is a `[tmin, tmax]` array, is applied **synchronously**, before the
first `plotAll()`. The whole point is to avoid the flash of the default 24 h window: a host
that has computed its own start window (from data-source metadata, a URL parameter, etc.)
wants that window on screen the instant the constructor returns. The constructor tail's
`setTimeout(..., 0)` dispatch — preserved for named views — would miss this contract, so
the array form is consumed directly at the `tmin`/`tmax` initialisation site.

`follow`, by contrast, is applied **deferred**, in the same `setTimeout(..., 0)` and after
any named `initialView` dispatch. Two reasons. First, `onStop` / `onFollow` are not
registered until the caller has the instance back — firing them is half the point of the
option, so firing them synchronously from inside the constructor would always lose them.
Second, every named view except `last24()` / `next24()` begins with `doStop()`, so applying
`follow: true` before the named view would simply be undone. The one wrinkle is that a
named view animates over `zoomDuration`, so when `follow` is set together with a named
view it is delayed an additional `zoom_onclick_time` — the same dodge `last24()` uses for
its own deferred `start_follower()`. `follow: false` is the common case that motivated the
deferral: a host with a follow toggle wants the toggle's `onStop` callback to fire
straight after construction, so its button ends up in the right state without a manual
`ts.stop()`.

## Pointer coordinates

Mouse and touch events carry viewport-relative `clientX/clientY`.
`refreshOffset()` re-reads `canvas.getBoundingClientRect()` at the start of every pointer
handler, because the canvas can move (scrolling, layout shifts) without resizing, so the
ResizeObserver would not catch it. Do not reintroduce a cached offset — a stale one makes
every hit test silently miss (no tooltip, no cursor change, no click), worst on a scrolled
page. `test/offset.test.mjs` simulates the move by swapping `getBoundingClientRect`.

Tests pinning viewport windows must use **local** midnight (`new Date(y, m, d)`), not
`Date.UTC` — `panFloor`/`panAdd` work in local time, so a UTC-pinned window sits mid-day
in most zones and the first pan legitimately widens it to the surrounding boundaries.

## Deliberate oddities in the source

Two finished-but-unwired functions carry an explicit `eslint-disable-next-line` plus a
NOTE explaining the choice: `period()` (duration formatter) and `fog_of_future()` (which
is the only consumer of `settings.colors.future`, defined by every theme). Either wire
them up or delete them — don't let them rot silently.

Two more flagged-but-deliberately-unfixed oddities, both carrying a NOTE in the source:

- **`follow_view()`'s delay looks sign-inverted.** Under `if (now < rT(0))` it schedules
  `now - rT(0)`, which is negative; the intent reads as `rT(0) - now`. Left alone because
  flipping it is a behaviour change wanting its own commit and test, and the branch is all
  but unreachable — `follow_view` is only entered via `if (follow_timers < 0)` in
  `plotAll()`, which `timer()`'s `++`/`--` bookkeeping should make impossible. `tickDelay()`
  keeps it off the immediate-fire path either way.
- **`jpZabbix.api()` sets `req.timeout` but never wires `req.ontimeout`** (only `onload`
  and `onerror`). An XHR timeout therefore settles nothing and the promise hangs forever.
  Consumers that need a timeout must race it themselves — `demo/zabbix-live.html`'s connect
  probe does. Wiring `ontimeout` is the right fix but changes behaviour for every consumer.
