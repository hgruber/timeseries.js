# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Versioning.** The project is pre-1.0 and follows the usual 0.x convention: a
**minor** bump (`0.9.0` → `0.10.0`) may break the public API, a **patch** bump
(`0.9.0` → `0.9.1`) never does. Pin a minor range (`^0.9.0`, or `@0.9` on a CDN
URL) to get fixes without breakage. See [Versioning](doc/getting-started.md#versioning).

Each release section is used verbatim as the body of the matching
[GitHub release](https://github.com/hgruber/timeseries.js/releases), so write it
for a reader who has not seen the commits.

## [Unreleased]

### Changed

- The version tag on the canvas is now **opt-in and off by default**. Every chart used to
  draw `timeseries.js <version>` in a small clickable pill in the bottom margin, whether
  its host wanted it or not. That pill is gone — along with its hover cursor and the click
  that opened the repository — and an embedded chart now draws nothing about itself unless
  asked.

### Added

- `versionMark: true` draws the library name and the build it was cut from bottom-right
  inside the plot area, in two colours: `timeseries` in `colors.text`, `.js` and the
  version in the new `colors.versionMark` palette key (defined in all four themes). It is
  low-alpha, scales with the plot, and skips itself entirely on a chart too small to carry
  it. Unrelated to the image `watermark` option — both can be on at once. All demo pages
  turn it on. See [Version watermark](doc/configuration.md#version-watermark).

## [0.10.2] - 2026-08-30

### Added

- **Two opt-in data-source adapters: WebSocket and DuckDB-WASM.** Both live in
  `src/adapters/` and register a `source-type` on import, so a page that does not
  use them does not pay for the registration. **WebSocket** keeps a rolling
  `multiline` `PointSeries` of the most recent `windowMs` (default 1 h) of
  messages received from a caller-supplied feed; the wire format is yours, and a
  caller-supplied `transform(msg) → { t, values }` maps it onto the plot shape.
  **DuckDB-WASM** re-runs a SQL query against an in-browser DuckDB on every
  viewport change. The SQL is a template with `:tmin` / `:tmax` / `:mspp`
  placeholders, and the page supplies the `AsyncDuckDB` instance via `db` or a
  `dbFactory`. Connection failures and SQL errors are reported via
  `console.warn` and the previous block is kept on screen.
  See [Data sources → WebSocket](doc/sources.md#websocket-adapter) and
  [Data sources → DuckDB-WASM](doc/sources.md#duckdb-wasm-adapter). New demo
  pages: `demo/websocket.html` and `demo/duckdb-wasm.html`.
- **`initialView` now accepts a `[tmin, tmax]` window** in addition to a named navigation
  method. The window is applied synchronously, before the first paint, so a host that has
  computed its own start window (from data-source metadata or URL parameters) no longer
  sees the default 24 h frame flash before the real window animates in. `Date` objects
  are accepted alongside ms timestamps. Malformed input (wrong length, `NaN`, `tmax <=
  tmin`) falls back to the 24 h default with a `console.warn`.
- **`follow` constructor option** for the explicit rolling start state, independent of
  the start window. `true` rolls while keeping "now" where it sits in the start window
  (so an explicit `initialView: [tmin, tmax]` is preserved instead of snapping back onto
  now); `false` stops; a number `0`–`100` sets the fraction directly. Applied after
  `initialView`, so the `onStop` / `onFollow` callbacks fire for the start state — a
  follow toggle can be wired straight to those and stay in sync without a manual
  `ts.stop()` after construction. `autoFollow` is unchanged: it still means "start
  rolling once the right edge reaches the present", not "start rolling now". The
  direction semantics of `ts.follow(fraction)` and `previewNow` / `followNow` were also
  corrected in the API reference, where the previous description had 0 and 100 swapped.

### Changed

- **`doc/sources.md` is now in step with the code.** The top-of-page summary lists the six
  built-in sources plus the two opt-in adapters (previously the adapters were missing and
  Prometheus / Home Assistant / InfluxDB still appeared under "What is not built in yet").
  Each adapter has a dedicated section with options, behaviour notes and a
  copy-pasteable example.

## [0.10.1] - 2026-08-30

### Added

- **Two new plot types, and two options that turn `multiline` into an area chart.**
  The area family was the largest remaining gap in the built-in set: `multiline`
  could draw a line but not shade under it, and a stacked composition over time —
  arguably the most common time-series chart there is — could not be drawn at all.
  **`stackarea`** sums the visible series per slot and draws each as a band on top
  of the running total, so the outline is the total and each band's thickness is
  that series' share of it. Hiding a series closes the stack up rather than
  leaving a hole, and the y-axis is measured from the stacked total.
  **`ohlc`** is the bar form of `candlestick`: a high–low line with the open
  ticked off to the left and the close to the right. It reads exactly the same
  block and the same `roles` mapping, and draws thinner — which is what keeps it
  readable at bin widths where a filled body turns into a blob.
- **`plot.step` and `plot.fill` on `multiline`** (both also honoured by
  `stackarea`, and both applying to binned and point blocks). `step: 'after'`
  holds each value across its own bin instead of sloping to the next one, which is
  what a binned slot actually claims — nothing was measured part-way through it;
  `'before'` raises the value at the previous point. `fill: true` shades each
  series down to the zero line, under the stroke, clamped to the plot box so a
  far-off zero line cannot paint over the axis. Series are filled independently
  and therefore overlap; use `stackarea` to stack them.
- **`heatmap` and `horizon`, and a lane axis that is no longer gantt's alone.**
  A *categorical* y-axis — each series owning a horizontal band, the axis
  labelled with names rather than numbers — already existed, but it was welded to
  `category: 'span'`, so `gantt` was the only renderer that could ever have one.
  It is now a property of the **renderer** (`lanes: true` plus a `layout` hook
  that stamps `laneCount`/`yticks`), which is what lets a *binned* block have one.
  **`heatmap`** draws one coloured cell per slot per lane. Its default colour is
  each series' own colour at an intensity that follows the value, so it re-themes
  with everything else and two lanes stay distinguishable; `plot.colorScale` takes
  an explicit sequential palette of hex stops instead.
  **`horizon`** folds each series into a short band — the value cut into
  `horizonBands` slices drawn on top of one another with rising intensity, so a
  band a third the height reads as well as the full line would. Negatives mirror
  from the band's top edge, optionally in `horizonNegative`.
  Both take `plot.lanes` to fix the row order and labels, and `vmin`/`vmax` to pin
  the range their colours are scaled against — which is measured over the whole
  block, never the viewport, so panning cannot recolour a cell.
- **`waterfall`** — cumulative bars, where each starts where the previous one
  ended, so the chart reads as a running total broken into its contributions.
  `plot.totals` names the slots that restate the sum from zero (the subtotal and
  total bars), `plot.waterfallColors` colours rising, falling and total apart,
  and `connect: false` drops the leader lines. Two things follow from the total
  being cumulative and both are load-bearing: it accumulates from the block's
  first slot rather than from the left edge of the viewport, so panning cannot
  make every bar jump; and the y-axis follows the running total rather than the
  largest single step, so twelve steps of +10 are drawn on an axis reaching 120.
- **`cumulative: true` in the renderer contract**, with
  `TimeSeries.isCumulativeType(type)` and `TimeSeries.waterfallLevels(plot)`.
  The renderer, the y-extent scan and the hit test all read the same levels from
  that one function, which is the only way three consumers can agree on where a
  floating bar actually is.
- **`stacked: true` in the renderer contract**, with `TimeSeries.isStackedType(type)`
  to read it back. Whether a type sums its series per slot decides how the y-extent
  is measured, and the core previously knew it only as a literal comparison against
  `'multibar'` — so a second stacked renderer had no way to be measured correctly
  without editing the core. This is the same declaration `values: 'array'` already
  makes, and it fails the same way when omitted: the axis is measured from the
  tallest single series and the top of every stack is quietly clipped.

### Fixed

- **`multiline` no longer draws an explicit `null` as a dive to zero.** The binned
  branch broke the line only on `undefined`, so a slot carrying `null` was drawn at
  `Y(0)` — a spike to the axis indistinguishable from real data. Both shapes now
  break on either, which is what the point branch always did. A gap in the *slot
  numbering* is still bridged, unchanged and deliberate: `multiline` is the
  interpolating renderer.
- **A coalesced block no longer loses its draw-affecting metadata.** Blocks merged
  across fetch margins carried `connect` but nothing else, so a coalesced block
  drew differently from the blocks it was built from. `step`, `fill`, `lanes`,
  `colorScale`, `vmin`/`vmax`, `horizonBands`, `totals`, `waterfallColors`,
  `roles` and `candleColors` now ride along too — for the laned types that matters
  most, since two blocks each deriving their own lane order would put the same
  series in a different row on either side of the margin.

## [0.10.0] - 2026-08-28

### Added

- **Three new plot types that draw a distribution without interpolating it.**
  `quantile-bands` connects the percentile values of neighbouring bins with straight
  lines through their centres. That reads as a trend, but it also draws a value for
  every instant between two measurements — instants in which nothing was measured.
  The three new renderers read the very same block and stay inside the bin the
  values belong to.
  **`quantile-steps`** is the direct swap: same ladder, same shading, same bold
  median, except each percentile is a horizontal segment spanning its own interval,
  joined to its neighbour by a vertical riser. `plot.connect = false` drops the
  risers too, leaving the segments free-standing.
  **`error-bars`** draws a marker on the ladder's centre rung with a whisker over
  each symmetric percentile pair — innermost bold, outermost thin and capped.
  **`candlestick`** draws a wick from the outermost pair, a body from the next pair
  in and a median tick: the box plot a percentile ladder actually supports. With
  `plot.roles = { open, high, low, close }` (indices into the value array) it
  instead draws true OHLC candles, rising ones hollow and falling ones filled — the
  classic convention, which needs no second colour and so re-themes with the series.
  `plot.candleColors = { up, down }` overrides that.
  Several series in one bin are dodged apart rather than drawn on top of each other,
  and the row closes up when one is hidden.
- **Ladder blocks are hoverable and clickable**, `quantile-bands` included. A bin is
  the hit target and the whole percentile array arrives as the callback's `value`.
  The shipped tooltip renders one labelled row per rung, highest first (`p95`, `p75`,
  …), retargetable with the new `percentileLabel` option. Hidden series are not
  hittable — unlike the stacked-bar hit test, which still is.
- **`values: 'array'` in the renderer plugin contract**, reported back by
  `TimeSeries.isBandedType(type)`. The core branches on whether a plot type stores an
  array per slot in three places, and a type missing from all three used to fail
  silently: `array * number` is `NaN`, `NaN >= 0` is false, so the y-extent scan
  measured nothing and the axis quietly fell back to the block's declared `max`.
  Declaring it once on the plugin now covers all three. `TimeSeries.ladderPairs(n)`
  is exported alongside it, so a third-party ladder renderer reads `plot.percentiles`
  the way the built-in four do.
- **`render` option on the `zabbix` source** — its `[min, avg, max]` cells suit any of
  the four ladder renderers. It applies to every tier at once, since the resolution
  cross-fade groups blocks by `plot.type`.
- **`↑`/`↓` zoom from the keyboard**, halving and doubling the window on the grid,
  and **`Shift`+arrow** as the single-cell variant of each direction (`←`/`→` step
  one cell instead of a page, `↑`/`↓` change the cell count by one). The chart was
  previously not zoomable without a mouse.
- **`Shift`+mouse wheel pans** horizontally, continuously.
- `panSnap: 'grid' | 'off'` option plus `ts.setPanSnap()` / `ts.getPanSnap()` —
  `'off'` moves by the exact current width and never rounds.
- `ts.zoomStep(dir, opts)`, `ts.snapView()` and `ts.getSnapGrid()`.
- `ts.pan(dir, opts)` takes `{ cells: n }` and `{ snap: false }`.

### Changed

- **Keyboard navigation now snaps to the labelled axis grid at every zoom level.**
  Arrow keys move the viewport in whole cells of the coarsest x-axis level that is
  currently labelled and fits the window, so they land on boundaries you can read:
  a window of 18:55–20:04 pages to 20:00–21:00, a six-hour window pages six full
  hours on *without changing width*, a window over a day lands on midnight and one
  over a month on the first. Previously each edge was snapped independently and the
  step count derived from the result, which drifted (18:55–20:04 → 20:04–21:13),
  grew the window (6 h → 7 h on the first press), never used a finer unit than the
  second (a 40 ms window paged a full second), and ignored steps like 5 or 15
  minutes entirely.
  Attaching the grid rounds the window once, by at most 20 % of its width; from
  then on it is held, so repeated paging is exact and the width never drifts.
  Wheel, drag and pinch are never snapped and release the grid.

- **`quantile-bands` now drops a bin the partial-bin policy dropped.** A block whose
  `data_until` leaves under 10 % of its last bin covered had that bin excluded from
  the y-extent and from hit testing, but still drawn. All four ladder renderers now
  agree.

### Removed

- The module-level exports `panSnapUnit`, `panSnapEdge` and `PAN_TOLERANCE`, which
  implemented the old edge-wise snapping. `panFloor`, `panAdd` and `panDiff` remain;
  the new grid helpers `floorToGrid`, `addGrid`, `gridCell`, `nearestGrid`,
  `pickGridLevel` and `GRID_TOLERANCE` are exported alongside them.

## [0.9.1] - 2026-08-25

### Added

- **Partial bins.** A block can now declare `data_until` — the point past which
  it simply has no data yet, such as an ETL high-water mark. The bin holding
  that point is only partly covered, and drawn at full width it is both too
  short (it holds a fraction of a bin's worth) and too long (it reaches into a
  span that holds nothing). `ts.setPartialBins('clip')` puts the bar's right
  edge on the mark; `'scale'` additionally divides its height by the filled
  fraction, so the bar's *area* still equals the value it holds and its density
  matches the full bins beside it. That factor is also the rate-correct one, so
  it composes cleanly with `setRateUnit`.

  Only blocks marked `extensive` are ever scaled — an average or a percentile is
  already per-unit and falls back to clipping. A bin filled to less than 10 % is
  left out of the drawing, of the y-axis extent and of hit-testing alike, since
  below that the extrapolation is noise rather than data. Tooltips and
  drill-down keep reporting the raw value in the bin.

  The default is `'full'`: without opting in, not a pixel changes.

## [0.9.0] - 2026-07-30

First published release. The library has been developed and deployed from `main`
for some time; what changes here is that a **specific, immutable version can now
be installed and pinned** instead of only the always-latest build on GitHub
Pages.

### Added

- **npm package** — `npm i @hgruber/timeseries.js`, which also makes pinned CDN
  URLs available via jsDelivr and unpkg
  (`…/npm/@hgruber/timeseries.js@0.9.0/dist/timeseries.min.js`). The package is
  scoped because the unscoped name collides with the existing `timeseries-js`,
  which npm's name-similarity check rejects. Both the ES modules under `src/` and
  the IIFE bundles under `dist/` ship in the tarball; `exports` resolves `import`
  to the former and everything else to the latter.
- **GitHub releases** carrying `timeseries.js` and `timeseries.min.js` as
  attachments, for hosting a fixed build yourself.
- `TimeSeries.BUILD` alongside `TimeSeries.VERSION`, identifying the exact build
  when it is not a release (a Pages deploy reports the commit it was built from).

### Changed

- **The version number is now a semver signal, not a build counter.** It
  previously incremented by one on every commit and deliberately carried no
  compatibility meaning, which is incompatible with pinning. It now changes only
  at a release, and the increment reflects what changed. Build identity moved to
  `BUILD` (see above), so the on-canvas version pill still names the exact build.

### Feature set at this release

For anyone arriving at the project with this release, the library covers:

- Fluid navigation (drag to pan, wheel to zoom, animated transitions), a
  calendar-aware time axis with ISO week numbers and holidays, and correct
  daylight-saving handling in the browser's local time zone.
- Rolling "follow" mode, viewport sync across instances, keyboard paging, touch
  gestures, and LTTB downsampling.
- Renderers: stacked bars, lines, points, scatter, percentile bands, and
  calendar/Gantt spans.
- Data sources: Zabbix JSON-RPC (zoom-adaptive, cross-faded history/trends band),
  CalDAV calendars, and static/generated data — plus a plugin interface for both
  renderers and sources.
- Resolution tiers that cross-fade into each other, with an optional rate axis so
  the two tiers of an accumulated signal draw at the same height.
- Opt-in tooltip and series-visibility legend overlays that follow the palette.
- Four built-in themes and a fully overridable colour palette.

[Unreleased]: https://github.com/hgruber/timeseries.js/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/hgruber/timeseries.js/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/hgruber/timeseries.js/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/hgruber/timeseries.js/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/hgruber/timeseries.js/releases/tag/v0.9.0
