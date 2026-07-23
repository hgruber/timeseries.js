# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A vanilla JavaScript canvas-based time series visualization library. The live demo is at https://hgruber.github.io/timeseries.js/index.html.

## Development

```bash
npm install          # install esbuild (only dev dependency)
npm run build        # bundle src/ → dist/timeseries.js (IIFE)
npm run build:min    # minified build → dist/timeseries.min.js
npm run watch        # rebuild on file changes
npm run serve        # python3 static server on :8080
npm test             # run test/*.test.mjs with node's built-in test runner
npm run lint         # eslint; must stay at 0 errors
npm run lint:strict  # same, but warnings fail too (--max-warnings 0); currently green
```

### Linting

`eslint.config.mjs` is deliberately narrow: it catches real defects (implicit globals,
unused bindings, unreachable code) and leaves style alone. **`no-var` is not enabled** —
the source uses `var` throughout, and converting wholesale would be a 300-finding diff
with real risk (`var` is function-scoped, `let` is block-scoped) for no behavioural gain.

`npm run lint` is green at **0 errors and 0 warnings** — `npm run lint:strict`
(`--max-warnings 0`) also passes. The former backlog (~45 `eqeqeq`, ~31 `no-redeclare`,
~9 `no-shadow`) has been cleared, so *any* new warning now stands out immediately. Keep it
that way: prefer `===`/`!==` (use `== null` / `!= null` for the nullish check — `eqeqeq`
runs in `smart` mode and permits it), declare each `var` once per function (repeated
`var X` in sequential loops or mutually-exclusive branches was resolved by dropping the
redundant keyword, since `var` is function-scoped anyway), and don't shadow the outer
time-units object `f` or the `Y()`/`label()` helpers with a same-named local.

Two finished-but-unwired functions carry an explicit `eslint-disable-next-line` plus a
NOTE explaining the choice: `period()` (duration formatter) and `fog_of_future()` (which
is the only consumer of `settings.colors.future`, defined by every theme). Either wire
them up or delete them — don't let them rot silently.

**Dev without building**: `demo/caldav.html` uses `<script type="module">` and imports
directly from `src/`, so it needs no build step. `demo/index.html` does **not** — it loads
the IIFE bundle via `<script src="../dist/timeseries.js">`, so changes to `src/` only show
up there after `npm run build` (or with `npm run watch` running). `dist/` is gitignored;
the Pages deploy in `.github/workflows/deploy.yml` builds it in CI. Because `caldav.html`
imports `src/` directly even in production, that workflow also copies `src/` into the
deploy folder alongside `demo/` and `dist/` — otherwise the live `caldav.html` 404s on its
`../src/*.js` imports.

**Production**: `dist/timeseries.js` is an IIFE bundle; include it via `<script src="dist/timeseries.js">` and use `new TimeSeries(...)` globally.

### Testing (`test/`)

Plain `node:test` + `node:assert/strict`, no dependency. `test/helpers/dom.mjs` stubs
just enough DOM (`document.getElementById`, `canvas.getContext('2d')`,
`getBoundingClientRect`, `window.getComputedStyle`, `ResizeObserver`, `Image`) to
construct a real `TimeSeries` instance headlessly and dispatch synthetic mouse events at
its actual `canvas.onmousemove` handler — the hit-test tests exercise the real
`get_element()` path, not a reimplementation of it.

A constructed instance keeps a self-rescheduling `setTimeout` alive forever to advance
the "now" line (correct for a browser tab, which eventually closes). `installDOM()`
handles this by overriding the global `setTimeout` so every timer the library schedules
comes back `unref()`'d — it still fires, it just doesn't hold the process open. Test
helpers that need to reliably await a real delay (`sleep`, `setView`) use a
pre-captured, never-overridden reference instead, so `await setView(ts, tmin, tmax)`
still works. Do not `await sleep()`-style delays using the bare global `setTimeout` in
these tests — it will be unref'd and may not fire before the process exits.

**Environment note**: on at least one observed build (Fedora 44's `nodejs22` package,
v22.22.2), `node --test <directory>` fails immediately with `Cannot find module` —
directory-based test discovery does not work. `npm test` therefore expands a glob
(`test/*.test.mjs`) in the shell rather than passing a directory to `--test`. If test
discovery seems broken in a fresh environment, try the explicit glob before assuming
the test files themselves are at fault.

Coverage: `test/caldav.test.mjs` (iCalendar parsing, DST-aware TZID resolution),
`test/gantt.test.mjs` (row packing, `layoutSpans`), `test/gantt-hittest.test.mjs`
(confirms `barRect()` in `gantt.js` and `get_element()` in `timeseries.js` agree — the
two are hand-kept in sync rather than sharing code), `test/binned-regression.test.mjs`
(guards the pre-existing multibar path against the `category: 'span'` changes),
`test/dates.test.mjs` (`Easter` against published dates, `isoWeekStart`, and the
week/day presets for every weekday — Sunday being the case `(d.getDay() || 7)` exists
for), `test/pan.test.mjs` (pan snapping incl. DST transitions), `test/hover.test.mjs`
(the `onHoverData` contract the demo tooltip is built on), `test/options.test.mjs`
(option merging, statics, `zoom()` duration), `test/intervals.test.mjs` and
`test/lttb.test.mjs` (both previously untested pure modules), `test/memory.test.mjs`
(bounded growth of `data[]` under a polling source), `test/series.test.mjs`
(series enumeration, visibility, y-axis rescaling, point hit test),
`test/keyboard.test.mjs` (focusability, arrow-key paging), `test/offset.test.mjs`
(hit testing survives the canvas moving in the viewport — see below).

**Pointer coordinates**: mouse/touch events carry viewport-relative `clientX/clientY`.
`refreshOffset()` re-reads `canvas.getBoundingClientRect()` at the start of every pointer
handler, because the canvas can move (scrolling, layout shifts) without resizing, so the
ResizeObserver would not catch it. Do not reintroduce a cached offset — a stale one makes
every hit test silently miss (no tooltip, no cursor change, no click), worst on a scrolled
page. `test/offset.test.mjs` simulates the move by swapping `getBoundingClientRect`.

Tests pinning viewport windows must use **local** midnight (`new Date(y, m, d)`), not
`Date.UTC` — `panFloor`/`panAdd` work in local time, so a UTC-pinned window sits mid-day
in most zones and the first pan legitimately widens it to the surrounding boundaries.

**Time zones**: the DST cases in `test/pan.test.mjs` self-skip where the local zone has
no DST. Run both `TZ=Europe/Berlin npm test` and `TZ=UTC npm test` after touching date
arithmetic.

**Date-dependent tests**: the presets read "now" via `Date.now()`. `test/dates.test.mjs`
pins it around each call and restores it before awaiting — that also makes the pending
zoom animation's end time lie in the past, so the next frame snaps straight to the
target instead of needing the full `zoomDuration`.

## Versioning

The project is on a fixed `0.8.x` line; the patch number increments by exactly 1 on
**every** commit — it's a build counter, not a semver signal. `package.json`'s `version`
is the source of truth; `src/version.js` mirrors it (`export const VERSION`) and is
bundled as `TimeSeries.VERSION`, and the canvas itself draws a small `timeseries.js
0.8.N` tag in the bottom-left frame margin (`versionTag()` in `timeseries.js`, drawn
right after `frame()`) — low-alpha, 8px, unobtrusive by design. It's clickable: hovering
it swaps the cursor to `pointer` and a click opens the repo
(`https://github.com/hgruber/timeseries.js`) in a new tab. `versionTag()` measures its
own text and stores the box in `versionTagRect`; `hitVersionTag()` (used by both
`onmousemove` for the cursor and `onmouseup` for the click) reads that same rect rather
than re-deriving it, so hit area and drawn text can't drift apart.

The bump is automatic: `hooks/pre-commit` runs `node scripts/bump-version.mjs`, which
increments the patch component in `package.json` and rewrites `src/version.js` to
match, then stages both so the bump rides along with the commit that triggered it.
`scripts/install-hooks.sh` symlinks `hooks/*` into `.git/hooks/*` and runs
automatically via the npm `"prepare"` script, so a plain `npm install` wires the hook
up in a fresh checkout — no extra dependency (no husky). Do not hand-edit the patch
number in either file; if you need to jump the minor version (e.g. `0.8.x` → `0.9.0`),
edit `package.json` and `src/version.js` together in that commit and the hook will
continue incrementing patch from there. `git commit --no-verify` skips the bump like
any other hook.

## Architecture

### Source files (`src/`)

| File | Purpose |
|---|---|
| `timeseries.js` | Main constructor. Canvas lifecycle, time axis, grid generation, coordinate math, event handlers, animation, navigation API |
| `intervals.js` | Six standalone interval-arithmetic utility functions (no global side effects) |
| `renderers.js` | Renderer plugin registry + built-in renderers: `multibar`, `multiline`, `multipoint` |
| `gantt.js` | `gantt` renderer + `layoutSpans()` row packing for `category: 'span'` plots |
| `sources.js` | Data source plugin registry + built-in adapters: `zabbix`, `artificial`, `caldav` |
| `jpZabbix.js` | Standalone Zabbix JSON-RPC client (Promise-based, reusable independently) |
| `caldav.js` | Standalone CalDAV client + iCalendar parser (Promise-based, reusable independently) |

`demo/artificial.js` — demo data generator (Gaussian-shaped multibar dataset), not part of the library.

### Main constructor (`src/timeseries.js`)

The entire library is a single closure function `TimeSeries(options)`. All internal state is shared across functions via closure variables:

- `tmin`/`tmax`: visible time window (Unix ms)
- `ymin`/`ymax`: visible value range
- `data[]`: array of plot objects ready to render
- `ppms`/`mspp`, `ppv`/`vpp`: zoom scale factors
- `grid[]`/`ygrid[]`: computed axis tick positions
- `rctx`: render context object, rebuilt on every `plotAll()` call and passed to renderer plugins

The draw loop (`plotAll()`) runs on every interaction: builds `rctx`, calls `prepare_grid()`, then draws background → watermark → y-axis → data → frame → time indicator.

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

### Plugin interfaces

**Renderer plugin** (`src/renderers.js`):
```js
TimeSeries.registerRenderer({
  type: 'my-type',
  draw(plot, rctx) { /* rctx: { c, X, Y, ppms, ppv, margin, plotWidth, plotHeight } */ },
  highlight(plot, n, item, rctx) { /* optional */ }
});
```

**Source plugin** (`src/sources.js`):
```js
TimeSeries.registerSource({
  type: 'my-source',
  init(source, callbacks) {
    /* callbacks: { pushData(plotObj), requestRedraw(), getViewport() → {tmin,tmax} } */
  }
});
```

Both `registerRenderer` and `registerSource` are available on the built IIFE as `TimeSeries.registerRenderer` / `TimeSeries.registerSource`, and as named ES module exports for use in `src/`.

### Plot object shape

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

### Span plots (`category: 'span'`) and the gantt renderer

Spans are for data with arbitrary start/end pairs — calendar events, jobs, outages — where bar
width means duration rather than a slot on a shared grid:
```js
{
  type: 'gantt', category: 'span',
  tmin, tmax,                        // ms epoch — window this block covers
  layout: 'calendar' | 'packed',     // one row-block per lane, or greedy-packed into one band
  lanes: [{ id, label, color }],     // 'calendar' layout
  data: [{ id, lane, start, end, label, color }],   // start/end in ms epoch
}
```
`layoutSpans(plot)` (`src/gantt.js`) assigns `_row` to each event and derives `laneCount`,
`yticks` (lane names for the y-axis) and `laneBounds`. It's idempotent and stamped via
`plot._laidOut`; `prepare_grid` calls it before computing the y-extent, so **mutating `data` in
place requires clearing `plot._laidOut`**. Rows occupy the value space `0…laneCount`, which is
what lets the existing `Y()`/`ppv` transforms and axis animation carry them unchanged.

Core support for `'span'` lives in four guarded spots in `src/timeseries.js`: extent in `pushData`
and `prepare_grid`, the y-extent shortcut, and the hit test in `get_element` (which mirrors
`barRect()` in `gantt.js` — keep the two in step).

### CalDAV source

```js
{ 'source-type': 'caldav',
  url, username, password, 'auth-token', proxy,   // see src/caldav.js
  calendars: [href | {href,label,color}],         // omit → discover()
  layout: 'calendar' | 'packed',
  padding: 0.5 }                                  // extra window fetched either side
```
Fetches VEVENTs overlapping the padded viewport and refetches via `onViewportChange` only when
panning leaves the fetched window; stale responses are dropped by sequence number. Recurrence is
expanded **server-side** via `<C:expand>` — `caldav.js` deliberately does not implement RRULE.
After init, `source.client` is the CalDAV client and `source.setLayout(l)` re-packs without a
refetch.

Demo: `demo/caldav.html`. With no server configured it parses the static fixtures in
`demo/fixtures/` (shifted onto the current week), so the renderer and parser are testable with no
infrastructure.

### Public API (TimeSeries instance)

`ts.today()`, `ts.yesterday()`, `ts.tomorrow()`, `ts.last24()`, `ts.next24()`, `ts.lastWeek()`, `ts.thisWeek()`, `ts.nextWeek()`, `ts.zoom(tmin, tmax, animationMs)`, `ts.pan(dir)`, `ts.setWatermark(src)`, `ts.redraw()`, `ts.setColors(obj)` / `ts.getColors()`, `ts.getHolidays()`, `ts.getSeries()`, `ts.setSeriesHidden(id, bool)`, `ts.toggleSeries(id)`, `ts.showAllSeries()`, `ts.onSeriesChange(fn)`

### Series visibility and legends

The library provides the *data* for a legend and never builds DOM for it:
`ts.getSeries()` returns `[{ id, label, color, hidden }]` for the series across all
active plots, `color` being exactly what was painted (including any
`plot.series_colors` override). The caller renders it — `demo/index.html` builds a
positioned `<div>` overlay; see `renderLegend()` there.

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

### Keyboard

`keyboard: true` (default) makes the canvas focusable (`tabindex=0`, `role=application`,
an `aria-label` unless the page set one) and binds left/right arrows to `pan(∓1)` — one
screenful, snapped to the calendar unit that fits the current zoom. Handlers sit on the
canvas, not the document, so a page with several charts only moves the focused one. Set
`keyboard: false` to opt out entirely.

### Point hit testing

`POINT_RADIUS` in `src/renderers.js` is the marker half-size per renderer type, shared
between drawing and the hit test in `get_element` — the same "keep these in step"
arrangement as `barRect()` in `gantt.js`. Point plots are hit-tested in *pixel* space
(nearest marker within its radius), unlike bars, which tile the plot area and can be
found arithmetically. Valid only while no renderer downsamples internally; a source
applying `lttb` before pushing is fine, since both draw and hit test then see the
reduced array.

`ts.zoom()`'s third argument overrides the animation duration for that one transition;
`0` jumps without animating. Omit it for the configured `zoomDuration`.

### Module-level exports

Besides the default export, `src/timeseries.js` exports the pure date/format helpers so
they can be tested and reused without constructing a chart: `Easter(year)`,
`isoWeekStart(year, week)`, `siFormat(v)`, and the pan-snapping set `panSnapUnit(tmin, tmax)`,
`panFloor(ms, unit)`, `panAdd(ms, unit, n)`, `panDiff(lo, hi, unit)`,
`panSnapEdge(ms, unit, roundUpIfAmbiguous)`, and the `PAN_TOLERANCE` constant (5%) they
share. `panSnapUnit` is calendar-aware for month/year (a plain ms threshold can't tell a
30-day April from a 30-day non-month span, since real month/year lengths vary); `panSnapEdge`
applies that same tolerance when rounding `pan()`'s viewport edges to the unit's boundaries,
so a viewport that's close to but not exactly one calendar month/year still snaps cleanly
instead of inflating to the next full unit. It's also calendar-aware at the hour/day
boundary: a viewport already sitting on local-midnight at both edges is treated as `'day'`
grain even when its real length is 23h/25h (a DST transition day), because `'day'`
steps via `Date#setDate` (DST-safe) where `'hour'` steps via `Date#setHours` field
arithmetic — which only rolls to the next day when the added hour count overflows past
23, so a 23-hour DST day (which doesn't) used to leave `pan()`'s boundary stuck 1h off
midnight. A non-midnight-aligned rolling window (e.g. `last24()`) still uses `'hour'`.

The statics `TimeSeries.registerRenderer` / `registerSource` / `seriesColor` / `lttb` /
`siFormat` / `themes` live at module scope, so the IIFE build can call them **before**
the first `new TimeSeries(...)`.

### Option merging

`colors` is merged key-by-key with the defaults, so a partial override keeps the rest of
the palette (an undefined colour would reach the canvas as an invalid `fillStyle`).
Everything else, **including `holidays`**, replaces the default wholesale — that is how a
caller swaps the German holiday set for another country's. `TimeSeries.themes.light` is
the same object as the built-in default palette, not a copy of it.
