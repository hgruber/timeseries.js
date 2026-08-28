# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Versioning.** The project is pre-1.0 and follows the usual 0.x convention: a
**minor** bump (`0.9.0` → `0.10.0`) may break the public API, a **patch** bump
(`0.9.0` → `0.9.1`) never does. Pin a minor range (`^0.9.0`, or `@0.9` on a CDN
URL) to get fixes without breakage. See [Versioning](README.md#versioning).

Each release section is used verbatim as the body of the matching
[GitHub release](https://github.com/hgruber/timeseries.js/releases), so write it
for a reader who has not seen the commits.

## [Unreleased]

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

[Unreleased]: https://github.com/hgruber/timeseries.js/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/hgruber/timeseries.js/releases/tag/v0.9.0
