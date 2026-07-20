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
```

**Dev without building**: Open `demo/index.html` via the static server. It uses `<script type="module">` and imports directly from `src/` — no build step needed for development.

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
(guards the pre-existing multibar path against the `category: 'span'` changes).

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

`ts.today()`, `ts.yesterday()`, `ts.tomorrow()`, `ts.last24()`, `ts.next24()`, `ts.lastWeek()`, `ts.thisWeek()`, `ts.nextWeek()`, `ts.zoom(tmin, tmax, animationMs)`, `ts.pan(dir)`, `ts.setWatermark(src)`, `ts.redraw()`
