# Development

Working on the library itself: building, the demo pages, testing, and cutting a release.

## Commands

```bash
npm install          # installs esbuild + eslint (the only dev dependencies)
npm run build        # bundle src/ → dist/timeseries.js (IIFE)
npm run build:min    # minified → dist/timeseries.min.js
npm run watch        # rebuild on file changes
npm run serve        # static server on :8080
npm run serve:proxy  # same, but node — adds the /dav-proxy route (see below)
npm test             # test/*.test.mjs with node's built-in runner
npm run lint         # eslint; must stay at 0 errors
npm run lint:strict  # warnings fail too (--max-warnings 0); currently green
npm run bench         # performance comparison: micro (CPU) + browser (TTFR + heap)
npm run bench:micro   # CPU time per plotAll in the DOM stub, ~10 s, no browser
npm run bench:browser # TTFR + heap vs uPlot / Chart.js in headless Chromium, ~1 min
npm run release -- X.Y.Z   # cut a release — see below
```

`dist/` is gitignored; the Pages deploy builds it in CI.

## The demo pages

```bash
npm run build && npm run serve
# → http://localhost:8080/demo/index.html
```

| Page | Needs a server? | Notes |
|---|---|---|
| `demo/index.html` | no | Loads the **IIFE bundle**, so it needs `npm run build` first |
| `demo/caldav.html` | no | Parses the static fixtures in `demo/fixtures/` |
| `demo/zabbix.html` | no | Installs a synthetic `api_jsonrpc.php`; the real source runs unchanged |
| `demo/caldav-live.html` | yes | Connect form: URL, user, password, optional proxy prefix |
| `demo/zabbix-live.html` | yes | Connect form: API URL and token |

The four non-index pages use `<script type="module">` and import directly from `src/`, so
they need **no build step** — edits show up on reload. `demo/index.html` does not: it loads
`dist/timeseries.js`, so run `npm run watch` while working on it.

Because those four pages import `src/` directly **even in production**,
`.github/workflows/deploy.yml` copies `src/` into the deploy folder alongside `demo/` and
`dist/` — otherwise they 404 on their `../src/*.js` imports.

Read the banner on either live page before pointing it at anything you care about. Served
from `localhost`, both are cross-origin to whatever server you point them at — see
[Cross-origin](sources.md#cross-origin-cors), including the `/dav-proxy` route that
`npm run serve:proxy` adds for the CalDAV page.

### Shared demo chrome

All five demo pages link `demo/demo.css` and load `demo/demo-nav.js`.
The stylesheet holds the page frame (header, cards, controls, buttons, footer) with the four
palettes declared as CSS custom properties on `body` — `light` is the bare default, the others
are `body.theme-dark` / `.theme-highContrast` / `.theme-warm`. Each page keeps only its own
rules in an inline `<style>`, which is loaded *after* the stylesheet and therefore wins on
equal specificity. `demo-nav.js` is a **classic** script on purpose (no `import`/`export`), so
the IIFE page and the four module pages can all load it; it builds the nav bar and the theme
picker into `<div id="demo-nav">`, owns the `<body>` theme class and persists the choice in
`localStorage`, and knows nothing about `TimeSeries`. Pages repaint their own canvases via
`window.demoTheme.onChange(fn)`, which fires immediately with the current theme so a module
script subscribing late still gets the stored palette. Load it right after `</header>`, not
deferred in `<head>`: the placeholder exists by then, the theme class lands before the page
below paints, and `window.demoTheme` is defined before any page script runs.

That "fires immediately" is what lets a page whose charts do not exist at load time still get
the stored palette: `zabbix-live.html` subscribes inside `buildCharts()` and `caldav-live.html`
inside `buildChart()`, i.e. only after a successful connect, and the callback runs right there
with the theme read from `localStorage` — so the canvases come up already themed instead of
waiting for the next picker click.

One rule in `demo.css` exists purely for these two: **`button[hidden] { display: none }`**.
The `button` rule sets `display: inline-flex`, and the UA rule implementing the `hidden`
attribute sits at the lowest possible priority, so any author `display` beats it — without that
line, both pages' `#reconnect` button (hidden in the markup, unhidden from an error handler)
showed from the start.

**The nav list**: adding a page means one entry in `PAGES` at the top of `demo-nav.js`; nothing
else knows the list. An entry comes in two forms — `{href, label}` for a plain pill, or
`{group, pages: [{href, label, title}]}` for a labelled pill-box holding several. The group form
is for pages on the **same topic at a different fidelity**, and the two Zabbix pages are the case
it exists for: as two flat pills ("Zabbix", "Zabbix live") the bar repeats the topic, is wider
for it, and still never says which one needs a server. Grouped, the topic is named once and the
labels are only the qualifier (`demo` / `live`). The two CalDAV pages are grouped under
"Calendar" for the same reason.

Three things about that group are deliberate:

- **`.nav-group` reuses the `--group-*` custom properties** every palette already declares for
  `.control-group`, so it re-themes without a colour of its own. It is styled as a filled pill
  box with borderless children because `.theme-picker` beside it in the header already is one —
  that is the header's existing idiom, not a new one. It is *not* `.control-group` itself: that
  class gets `flex: 1 1 100%` under 640px, tuned for the `.controls` bars, which would blow the
  nav apart.
- **The children's border loses its colour, not its width** (`border-color: transparent`, guarded
  by `:not([aria-current="page"])` so it can't blank the current page's border), so nothing
  shifts when a hover or the current page fills one in.
- **`navLink()` sets `aria-label` inside a group.** The visible text is only `demo`/`live`, which
  says nothing in a screen reader's list of links, so the full "Zabbix demo" goes on the label —
  and the visible group label is `aria-hidden`, since `role="group"`'s own `aria-label` already
  announces it.

## Testing

Plain `node:test` + `node:assert/strict`, no dependency.

```bash
npm test
TZ=Europe/Berlin npm test    # run both after touching date arithmetic
TZ=UTC npm test
```

`test/helpers/dom.mjs` stubs just enough DOM (`document.getElementById`,
`canvas.getContext('2d')`, `getBoundingClientRect`, `window.getComputedStyle`,
`ResizeObserver`, `Image`) to construct a real `TimeSeries` headlessly and dispatch
synthetic mouse events at its actual `canvas.onmousemove` handler — the hit-test tests
exercise the real `get_element()` path, not a reimplementation of it.

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

`test/resize.test.mjs` needed more still: `resizeObservers`, `resizeCanvas(canvas, w, h)`,
a `_pad`-aware `getComputedStyle` and an opt-in `parentElement` (via `makeCanvas`'s 4th
argument). The stub `ResizeObserver` used to be inert, so resize was untestable.

Some renderer-level assertions define a **recording 2D context** in the test file rather
than using the helper's: the Proxy context in `test/helpers/dom.mjs` is a pure no-op and
cannot report the alpha a draw call ran at. `test/rate.test.mjs` goes one step further and
swaps `canvas.getContext` for a recording one *before* constructing, since the tick-set
dissolve is only observable in what was drawn.

Two things to know when writing tests:

- **Timers.** A constructed instance keeps a self-rescheduling `setTimeout` alive forever to
  advance the "now" line — correct for a browser tab, which eventually closes. `installDOM()`
  overrides the global `setTimeout` so every library timer comes back `unref()`'d: it still
  fires, it just does not hold the process open. The helpers that must await a real delay
  (`sleep`, `setView`) keep a pre-captured, never-overridden reference, which is why
  `await setView(ts, tmin, tmax)` still works. Do **not** `await` a delay using the bare
  global `setTimeout` — it may not fire before the process exits.
- **Viewport windows must use local midnight** (`new Date(y, m, d)`), not `Date.UTC` — pan
  snapping works in local time, so a UTC-pinned window sits mid-day in most zones and the
  first pan legitimately widens it.

The DST cases self-skip where the local zone has no DST.

**Date-dependent tests**: the presets read "now" via `Date.now()`. `test/dates.test.mjs`
pins it around each call and restores it before awaiting — that also makes the pending
zoom animation's end time lie in the past, so the next frame snaps straight to the
target instead of needing the full `zoomDuration`.

> **Environment note:** on at least one build (Fedora's `nodejs22`, v22.22.2)
> `node --test <directory>` fails with `Cannot find module` — directory-based discovery does
> not work. `npm test` therefore expands a glob in the shell. If discovery seems broken in a
> fresh environment, try the explicit glob before suspecting the test files.

### What each test file covers

One line of intent per file, so a new test lands beside the ones that already
own its subject rather than duplicating them.

`test/caldav.test.mjs` (iCalendar parsing, DST-aware TZID resolution),
`test/gantt.test.mjs` (row packing, `layoutSpans`, and the `group` reservation —
including the interleaving case a foreign event used to split a group on),
`test/gantt-hittest.test.mjs`
(confirms `barRect()` in `gantt.js` and `get_element()` in `timeseries.js` agree — the
two are hand-kept in sync rather than sharing code), `test/binned-regression.test.mjs`
(guards the pre-existing multibar path against the `category: 'span'` changes),
`test/dates.test.mjs` (`Easter` against published dates, `isoWeekStart`, and the
week/day presets for every weekday — Sunday being the case `(d.getDay() || 7)` exists
for), `test/pan.test.mjs` (the snap-grid arithmetic and the calendar helpers under it, incl.
DST transitions), `test/snapgrid.test.mjs` (the invariants that make the grid *consistent*
rather than usually-right: paging never changes level/width/alignment, out-and-back is
lossless, attaching rounds once within tolerance, the level follows what is labelled, and an
analogue gesture releases the grid), `test/hover.test.mjs`
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
`test/keyboard.test.mjs` (focusability, all four arrows and their shift variants, the
five follow keys and the modifier escape hatch),
`test/offset.test.mjs`
(hit testing survives the canvas moving in the viewport — see below),
`test/zabbix.test.mjs` (the zoom-adaptive Zabbix source: the pure ring helpers
`zabbixFold`/`zabbixEvict`/`zabbixPlot`/`zabbixWindow`/`zabbixPrimaryTier`, the
`prepare_grid` history↔trends cross-fade `_fade`, and the source end-to-end over a stubbed
`XMLHttpRequest` — trends→band, ±50% prefetch skip, and the out-of-order sequence guard),
`test/rollup.test.mjs` (`rollupBinned`: every `agg`, epoch-gridded buckets, sparse means,
non-mutation, and the shapes it refuses), `test/ladder-types.test.mjs` (the array-valued
family: `ladderPairs`, that each of `quantile-steps`/`error-bars`/`candlestick` paints the
geometry it claims to — flat segments spanning the bin, risers present under `connect: true`
and absent under `false`, no riser across a slot gap, whiskers and caps, the dodge closing up
when a series is hidden, ladder-mode vs. `roles` candles — plus, on a real instance, the
y-extent test that **fails without `values: 'array'`**, the `pushData` concat of overlapping
ladder blocks, the hit test for all four types, and the tooltip's rung rows),
`test/area-types.test.mjs` (the area family: the exact path `multiline` traces under each
`step` mode — including the trailing segment that carries the last value across its own bin
— that `fill` closes on the zero line *under* the stroke and clamps to the plot box, that a
line bridges a slot gap but breaks on a null, `stackarea`'s bands sitting on the running
total and closing up when a series is hidden, `ohlc`'s tick geometry and its `candleColors`
direction, and — on a real instance — the y-extent test that **fails without
`stacked: true`**, paired with `multiline` over the identical data to show the two apart),
`test/waterfall.test.mjs` (the cumulative type: the levels each bar is drawn between, a
`totals` bar restating the sum without consuming a value, per-series accumulation,
non-mutation, the leader lines and their absence across a slot gap, and — on a real
instance — the extent following the running total rather than the largest step, the extent
surviving a pan unchanged, and a hit test that returns the raw step and misses *below* a
bar floating above zero, which is what the stacked branch would have got wrong),
`test/laned-types.test.mjs` (the categorical y-axis: the lane layout and its idempotence,
`plot.lanes` fixing order and labels, `layoutPlot` being a no-op for a renderer that
declares none, heatmap's cell geometry and its colour ramp incl. `colorScale` interpolation
and `vmin`/`vmax` pinning, horizon's folded slices, its partial slice, its mirrored
negatives and that it leaves `globalAlpha` to the cross-fade — plus, on a real instance,
the axis landing on `0…laneCount` rather than on the values, the stamped lane labels, the
by-row hit test, and that a hidden lane is blanked without moving the others; it also
asserts `isLanedType('gantt')`, since the rework must not take the lane axis away from the
renderer it came from),
and `test/crossfade.test.mjs` (the generic tier
dissolve: `plotData` applying `_fade` through `globalAlpha` for `multibar`/`multiline`/
`multipoint`/`quantile-bands`, faintest-first draw order, the interpolated y-extent across
the band, the hit test following the dominant tier, and `fadeHi`/`fadeLo`/`setFadeBand`
moving the switch point), and `test/rate.test.mjs` (the rate axis: `_vscale` through
`plotData` for each renderer, the `extensive` opt-in, both tiers landing on one extent across
the whole band, the hit test returning raw values, and the unit-swap dissolve), and
`test/resize.test.mjs` (zero-size canvases — see that section below: the clamp with no good
geometry to fall back on, no non-positive timer delay ever reaching `setTimeout`, a hidden
chart neither repainting nor re-arming, a hidden peer not dragging a visible one while still
tracking the viewport, geometry preserved across hide/unhide, `attachLegend` surviving a
0×0 construction, and a hidden follow leader still driving the group), and
`test/version.test.mjs` (that `package.json` and `src/version.js` still agree — nothing
enforces that at commit time since the auto-bump hook was removed — that `BUILD` is safe
to concatenate into the drawn pill, and `changelogSection()`'s slicing, which both
`scripts/release.mjs` and the release workflow depend on). The
renderer-level assertions there
use a **recording 2D context** defined in the test file — the Proxy context in
`test/helpers/dom.mjs` is a pure no-op and cannot report the alpha a draw call ran at.
`rate.test.mjs` goes one step further and swaps `canvas.getContext` for a recording one
*before* constructing, since the tick-set dissolve is only observable in what was drawn.


## Linting

`eslint.config.mjs` is deliberately narrow: it catches real defects (implicit globals, unused
bindings, unreachable code) and leaves style alone. **`no-var` is not enabled** — the source
uses `var` throughout, and converting wholesale would be a 300-finding diff with real risk
(`var` is function-scoped, `let` is block-scoped) for no behavioural gain.

`npm run lint:strict` is green at 0 errors and 0 warnings, so any new warning stands out
immediately. Keep it that way: prefer `===`/`!==` (`== null` is permitted — `eqeqeq` runs in
`smart` mode), declare each `var` once per function, and do not shadow the outer time-units
object or the `Y()`/`label()` helpers.

## Performance benchmarks

The `benchmark/` directory compares timeseries.js against uPlot and Chart.js. Two harnesses
complement each other — one measures the library's CPU cost in isolation, the other measures
what the user actually sees in a real browser.

**Micro (`npm run bench:micro`)** runs `ts.redraw()` in Node against the canvas no-op stub from
`test/helpers/dom.mjs`. Every drawing call is a no-op, so what we measure is library CPU —
`prepare_grid`, the render loop, layout, axis math — with zero backend cost. Five runs per
size, median; the first run is JIT warm-up and is dropped.

**Browser (`npm run bench:browser`)** spawns headless Chromium via Puppeteer, opens a single
harness page that mounts one library at a time, and reads back `window.__benchResult` once
two consecutive `requestAnimationFrame` ticks paint the same bitmap (the *settle contract*).
What gets reported: **TTFR** in milliseconds and **`performance.memory.usedJSHeapSize`** in
MiB. Heap is Chromium-only — Firefox and Safari read `null`, and the runner tolerates that.
Three runs per (library, size) cell, median.

Sizes are 1k / 10k / 100k for the browser run (one million points × three libraries would run
Chromium's tab close to its memory ceiling). The micro bench goes up to 1M because the canvas
stub has no such ceiling.

`npm run bench` runs both, micro first (no browser dependency, ~10 seconds) and browser
after (~1 minute including the Puppeteer Chromium download on a cold `node_modules`).

**What is deliberately not measured:** FPS during pan/zoom (requires CDP tracing or a 60 fps
rAF loop with event injection — both have been deferred to a second iteration), WebGL
renderers (ChartGPU, SciChart — not reproducible without a fixed GPU), and timeseries.js' own
LTTB path (it exists in `src/lttb.js` but the render loop does not call it; sampling fairness
is only meaningful once the library itself samples).

The full methodology, the LCG dataset generator, and the first measurement on the maintainer's
machine (2026-08-30, uPlot roughly 2× faster than timeseries.js and Chart.js at 100k points)
live in [`benchmark/README.md`](../benchmark/README.md). JSON snapshots from each run land in
`benchmark/results/` (gitignored — `latest` plus a timestamped file per run).

## Cutting a release

Write the notes into `CHANGELOG.md` under a `## [X.Y.Z] - YYYY-MM-DD` heading **first** —
the date is mandatory, so an entry cannot be left a placeholder. Then:

```bash
npm run release -- 0.9.1        # validates, sets both version files, commits, tags
git push && git push origin v0.9.1
```

`scripts/release.mjs` validates everything *before* writing anything: plain semver ahead of
the current version, clean tree, on `main`, tag free, changelog section present, `npm test`
and `npm run lint:strict` green. It then commits `Release X.Y.Z`, tags `vX.Y.Z`, and
**pushes nothing** — so a mistake stays local and fixable.

Pushing the tag fires `.github/workflows/release.yml`, which re-runs the suite, re-checks
that tag ↔ `package.json` ↔ `src/version.js` ↔ changelog all agree, stamps `BUILD = ''`,
builds, then publishes to npm with provenance and creates the GitHub release with both
bundles attached.

### Version and build

`package.json`'s `version` is the source of truth; `src/version.js` mirrors it, and
`test/version.test.mjs` asserts they agree. **Do not hand-edit either** — nothing bumps them
automatically any more, and nothing should.

`BUILD` is the other half: since `VERSION` no longer moves per commit, it cannot say *which*
build you are looking at. `src/version.js` exports `BUILD` too, and a chart with
[`versionMark`](configuration.md#version-watermark) on draws
`VERSION + (BUILD ? '+' + BUILD : '')`. It is `'dev'` in the repo and overwritten in CI by
`scripts/stamp-build.mjs` — the Pages deploy stamps the short commit SHA, the release
workflow stamps `''`. Neither commits the change.
