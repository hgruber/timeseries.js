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

**Dev without building**: `demo/caldav.html` and `demo/zabbix.html` use `<script type="module">`
and import directly from `src/`, so they need no build step. `demo/index.html` does **not** — it loads
the IIFE bundle via `<script src="../dist/timeseries.js">`, so changes to `src/` only show
up there after `npm run build` (or with `npm run watch` running). `dist/` is gitignored;
the Pages deploy in `.github/workflows/deploy.yml` builds it in CI. Because `caldav.html`
and `zabbix.html` import `src/` directly even in production, that workflow also copies `src/`
into the deploy folder alongside `demo/` and `dist/` — otherwise those pages 404 on their
`../src/*.js` imports.

**Shared demo chrome**: all three demo pages link `demo/demo.css` and load `demo/demo-nav.js`.
The stylesheet holds the page frame (header, cards, controls, buttons, footer) with the four
palettes declared as CSS custom properties on `body` — `light` is the bare default, the others
are `body.theme-dark` / `.theme-highContrast` / `.theme-warm`. Each page keeps only its own
rules in an inline `<style>`, which is loaded *after* the stylesheet and therefore wins on
equal specificity. `demo-nav.js` is a **classic** script on purpose (no `import`/`export`), so
the IIFE page and the two module pages can all load it; it builds the nav bar and the theme
picker into `<div id="demo-nav">`, owns the `<body>` theme class and persists the choice in
`localStorage`, and knows nothing about `TimeSeries`. Pages repaint their own canvases via
`window.demoTheme.onChange(fn)`, which fires immediately with the current theme so a module
script subscribing late still gets the stored palette. Load it right after `</header>`, not
deferred in `<head>`: the placeholder exists by then, the theme class lands before the page
below paints, and `window.demoTheme` is defined before any page script runs.

**Production**: `dist/timeseries.js` is an IIFE bundle; include it via `<script src="dist/timeseries.js">` and use `new TimeSeries(...)` globally.

### Testing (`test/`)

Plain `node:test` + `node:assert/strict`, no dependency. `test/helpers/dom.mjs` stubs
just enough DOM (`document.getElementById`, `canvas.getContext('2d')`,
`getBoundingClientRect`, `window.getComputedStyle`, `ResizeObserver`, `Image`) to
construct a real `TimeSeries` instance headlessly and dispatch synthetic mouse events at
its actual `canvas.onmousemove` handler — the hit-test tests exercise the real
`get_element()` path, not a reimplementation of it.

For the overlays it also stubs `document.createElement`/`document.body` via
`makeElement()` (className/style, append/remove/replaceChildren, a *recursive*
`textContent` so a test can assert on rendered text, and a fixed
`ELEMENT_WIDTH`/`ELEMENT_HEIGHT` box so the edge-flip arithmetic is deterministic),
plus `window.innerWidth/innerHeight` and `addEventListener`/`removeEventListener`/
`emit` on the canvas — the library only assigns the `on*` properties, but overlays
track the pointer with `addEventListener`. The legend needs a *clickable/draggable*
surface the pointer-inert tooltip never did, so `makeElement()` also carries
`classList`, `dataset`, `setAttribute`, `getBoundingClientRect`, `offsetLeft/Top`,
`querySelectorAll` and a `click`-aware `emit`, and `installDOM()` gives `document`
itself `addEventListener`/`emit` (the drag listens on the document for move/up).

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
(the `onHoverData` contract the tooltip overlay is built on),
`test/tooltip.test.mjs` (the shipped overlay: inert until attached, default body,
each override level, palette re-theming, edge flip, `destroy()`, and that an app's
own hover handler survives alongside it), `test/legend.test.mjs` (the shipped legend:
inert until attached, one clickable row per series, click-to-toggle dimming, each
override level incl. `formatter`/`extra`/`onItemClick`, palette re-theming, anchoring,
drag-and-pin, and `destroy()` unsubscribe), `test/options.test.mjs`
(option merging, statics, `zoom()` duration), `test/intervals.test.mjs` and
`test/lttb.test.mjs` (both previously untested pure modules), `test/memory.test.mjs`
(bounded growth of `data[]` under a polling source), `test/series.test.mjs`
(series enumeration, visibility, y-axis rescaling, point hit test),
`test/keyboard.test.mjs` (focusability, arrow-key paging), `test/offset.test.mjs`
(hit testing survives the canvas moving in the viewport — see below),
`test/zabbix.test.mjs` (the zoom-adaptive Zabbix source: the pure ring helpers
`zabbixFold`/`zabbixEvict`/`zabbixPlot`/`zabbixWindow`/`zabbixPrimaryTier`, the
`prepare_grid` history↔trends cross-fade `_fade`, and the source end-to-end over a stubbed
`XMLHttpRequest` — trends→band, ±50% prefetch skip, and the out-of-order sequence guard),
`test/rollup.test.mjs` (`rollupBinned`: every `agg`, epoch-gridded buckets, sparse means,
non-mutation, and the shapes it refuses), and `test/crossfade.test.mjs` (the generic tier
dissolve: `plotData` applying `_fade` through `globalAlpha` for `multibar`/`multiline`/
`multipoint`/`quantile-bands`, faintest-first draw order, the interpolated y-extent across
the band, and the hit test following the dominant tier). The renderer-level assertions there
use a **recording 2D context** defined in the test file — the Proxy context in
`test/helpers/dom.mjs` is a pure no-op and cannot report the alpha a draw call ran at.

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
0.8.N` tag in a rounded pill in the bottom margin, just inside the plot's right edge
(`versionTag()` in `timeseries.js`) — 8px, low-alpha, unobtrusive by design. The pill's
fill is a translucent white wash (reads as "slightly lighter" over whatever `frameBg`
the theme paints) with a faint `colors.text` outline, so it re-themes for free.
`versionTag()` is called from *within* `frame()`, after the `frameBg` it sits on but
**before** frame()'s vertical time labels, so those overprint the pill rather than being
hidden by its background — keep it in that spot if you touch `frame()`. It's clickable:
hovering it swaps the cursor to `pointer` and a click opens the repo
(`https://github.com/hgruber/timeseries.js`) in a new tab. `versionTag()` measures its
own text and stores the pill box in `versionTagRect`; `hitVersionTag()` (used by both
`onmousemove` for the cursor and `onmouseup` for the click) reads that same rect rather
than re-deriving it, so hit area and drawn box can't drift apart.

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
| `tooltip.js` | `attachTooltip()` — shipped opt-in hover overlay (see below) |
| `legend.js` | `attachLegend()` — shipped opt-in series-visibility legend overlay (see below) |
| `intervals.js` | Six standalone interval-arithmetic utility functions (no global side effects) |
| `rollup.js` | `rollupBinned()` — pure helper deriving a coarser resolution tier from a binned block |
| `renderers.js` | Renderer plugin registry + built-in renderers: `multibar`, `multiline`, `multipoint` |
| `gantt.js` | `gantt` renderer + `layoutSpans()` row packing for `category: 'span'` plots |
| `sources.js` | Data source plugin registry + built-in adapters: `zabbix`, `artificial`, `caldav` |
| `jpZabbix.js` | Standalone Zabbix JSON-RPC client (Promise-based, reusable independently) |
| `caldav.js` | Standalone CalDAV client + iCalendar parser (Promise-based, reusable independently) |

`demo/artificial.js` — demo data generator (Gaussian-shaped multibar dataset), not part of the
library. It also derives an hourly tier from the minute data via `TimeSeries.rollupBinned`, so
`demo/index.html`'s main chart shows the resolution cross-fade below.

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

### Resolution tiers and the cross-fade (any renderer)

Blocks of the **same `type` differing only in `interval`** are kept side by side by `pushData`
and treated by `prepare_grid` as resolution tiers of one signal. Per frame it picks the finest
tier whose bars are at least `FADE_HI` (2px) wide; as that tier shrinks past the threshold the
coarser one takes over. Rather than a hard pop, both stay in `activePlot` across a 2px→1px band
and each is stamped with `plot._fade` (outgoing `1 → 0`, incoming `0 → 1`, summing to 1).

Two things make that dissolve actually look right, and both are **generic — not Zabbix- or
renderer-specific**:

- **`plotData()` applies `_fade` via `c.globalAlpha`** around each `plugin.draw()` call
  (`src/renderers.js`), so every renderer — `multibar`, `multiline`, `quantile-bands`, and any
  third-party one — gets the dissolve without knowing `_fade` exists. Do **not** reintroduce a
  per-renderer `* fade` on colour alphas; it would double up with `globalAlpha`. Blocks are
  drawn faintest-first, so the nearly-invisible tier can never wash out the dominant one.
  `highlight()` is wrapped the same way. A renderer that sets `globalAlpha` itself must restore
  it to the value it found, not to `1`.
- **`prepare_grid` interpolates the y-extent across the band.** The two tiers may sit on very
  different value scales (a `sum` rollup: hourly bars are 60× the minute bars). The
  ratio-weighted `ymax_array` blend would otherwise pick the taller tier outright the moment
  both cover the viewport, snapping the axis at the *start* of the dissolve and squashing the
  outgoing bars to a sliver. `blendExtents()` overwrites both tiers' extents with
  `fadeProg * E_incoming + (1 - fadeProg) * E_outgoing`, so the axis travels with the fade.

The hit test in `get_element` skips blocks at `_fade < 0.5`, so mid-dissolve the tooltip follows
the tier that is visually dominant rather than whichever landed first in `activePlot`.

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
dissolve ("per minute" → "per hour"); `'mean'` keeps both tiers on one scale.

### Zabbix source — zoom-adaptive history/trends

```js
{ 'source-type': 'zabbix',
  url, username, password, 'auth-token',           // see src/jpZabbix.js (token skips login)
  itemids: [itemid, …],                            // each item is one band series
  'value-type': 0,                                 // history.get value type (0 float, 3 unsigned)
  'history-interval': 60,                          // fine tier bucket seconds
  tiers: [{interval, kind:'history'|'trends'}],    // optional; default 60s history + 3600s trends
  padding: 0.5,                                    // prefetch fraction fetched either side
  series_colors: { [itemid]: cssColor }, name }
```

Two (or more) **resolution tiers coexist as `quantile-bands` plots that differ only in
`interval`**. Both `history` (raw, binned to min/avg/max per bucket) and `trends` (Zabbix's
hourly `value_min/avg/max`) map to the **same `[min, avg, max]` band shape**, so history draws
as a single line (min=avg=max at ~1 sample/bucket) and trends as a filled band — via the one
`quantile-bands` renderer. The core's `prepare_grid` picks the finest tier whose buckets are
≥ 2px per zoom (the same rule the source uses to decide what to fetch, `zabbixPrimaryTier`),
so no extra switch logic is needed. `jpZabbix.api()` is generic, so `trends.get` needs no
client change.

Each tier is a **self-managed ring cache** (mirrors the CalDAV pattern): one `replaceData`
block, prefetching ±`padding` around the viewport, refetched via `onViewportChange` only when
the *viewport* nears the fetched edge, stale responses dropped by sequence number. The ring
(`Map<slot, {[itemid]:{mn,av,mx,n}}>`) retains **multiple visited windows** so panning back is
instant, and is bounded by `ZBX_MAX_SLOTS`, evicting the slots farthest from the viewport
centre. The pure ring helpers (`zabbixPrimaryTier`, `zabbixWindow`, `zabbixClearRange`,
`zabbixFold`, `zabbixEvict`, `zabbixPlot`) are **exported from `src/sources.js`** for testing.

**Cross-fade at the switch** is the generic tier mechanism described above — the Zabbix source
adds nothing to it beyond making sure the data is there: prefetch means the incoming tier is
already cached, so the dissolve never waits on the network.

Demo: `demo/zabbix.html`. With no server configured it installs a synthetic
`api_jsonrpc.php` (a fake `XMLHttpRequest` answering `history.get`/`trends.get` with a generated
signal), so the **real** `zabbix` source — login flow, tiering, prefetch, ring, cross-fade —
runs unchanged with no infrastructure.

### Public API (TimeSeries instance)

`ts.today()`, `ts.yesterday()`, `ts.tomorrow()`, `ts.last24()`, `ts.next24()`, `ts.lastWeek()`, `ts.thisWeek()`, `ts.nextWeek()`, `ts.zoom(tmin, tmax, animationMs)`, `ts.pan(dir)`, `ts.setWatermark(src)`, `ts.redraw()`, `ts.setColors(obj)` / `ts.getColors()`, `ts.getHolidays()`, `ts.getSeries()`, `ts.setSeriesHidden(id, bool)`, `ts.toggleSeries(id)`, `ts.showAllSeries()`, `ts.onSeriesChange(fn)`, `ts.onColorsChange(fn)`, `ts.getCanvas()`,
`ts.getViewport()` / `ts.getValueRange()` (the horizontal and vertical range currently drawn —
`getValueRange` reflects hidden series and any tier cross-fade)

Statics: `TimeSeries.attachTooltip(ts, opts)`, `TimeSeries.attachLegend(ts, opts)`,
`TimeSeries.resolveColor(plot, id, alpha)`,
`TimeSeries.rollupBinned(plot, coarseInterval, opts)`.

### DOM overlays: the tooltip and legend are the shipped exceptions

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

### Series visibility and legends

The core provides the *data* for a legend and never builds DOM for it (the opt-in
`attachLegend` helper above does): `ts.getSeries()` returns `[{ id, label, color, hidden }]`
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
`rollupBinned` / `siFormat` / `themes` live at module scope, so the IIFE build can call them
**before** the first `new TimeSeries(...)`.

### Option merging

`colors` is merged key-by-key with the defaults, so a partial override keeps the rest of
the palette (an undefined colour would reach the canvas as an invalid `fillStyle`).
Everything else, **including `holidays`**, replaces the default wholesale — that is how a
caller swaps the German holiday set for another country's. `TimeSeries.themes.light` is
the same object as the built-in default palette, not a copy of it.
