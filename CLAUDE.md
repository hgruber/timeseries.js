# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It holds what applies to **every** task here. Everything subsystem-specific lives in
`doc/internals/` — see *Before you touch X* below, and read the one page that covers what
you are about to change.

## Project Overview

A vanilla JavaScript canvas-based time series visualization library. The live demo is at https://hgruber.github.io/timeseries.js/index.html.

## Documentation layout

**`README.md` is for the impatient and is kept that way on purpose**: badges, a one-paragraph
pitch, a screenshot strip, one copy-paste quickstart, the feature list, and a table pointing
into `doc/`. Reference material does **not** go back into it — if a section starts growing an
options table or a second example, it belongs in `doc/`.

There are three levels, and keeping a fact at the right one is what stops any of them from
rotting:

| Level | For | Holds |
|---|---|---|
| `CLAUDE.md` | every task | Commands, hard prohibitions, and the pointer to the page that argues each one |
| `doc/*.md` | someone *using* the library | Shapes, options, methods, recipes — one topic per file |
| `doc/internals/*.md` | someone *changing* it | Why a mechanism exists and what breaks quietly without it |

`doc/` is the reference set, one topic per file, each with its own scannable heading
structure so a reader (or an agent) can load just the page it needs instead of the whole
manual:

| File | Covers |
|---|---|
| `doc/README.md` | The index: a "what do I want to do → read this" table, plus the cross-file conventions (ms vs. seconds, local time, series ids) |
| `doc/getting-started.md` | Installing, the CDN/npm/self-host choice, version pinning, versioning policy, first chart, the three common pitfalls |
| `doc/data-formats.md` | Every plot object shape with a field table each: binned, point, ladder, span; plus the line/area options, waterfall and laned blocks, and the renderer × shape matrix |
| `doc/configuration.md` | Constructor options, palette keys and themes, holidays, keyboard, mobile, hidden containers |
| `doc/api.md` | Every instance method and static, grouped by task; also what is deliberately *not* in the API |
| `doc/overlays.md` | `attachTooltip` / `attachLegend`, their override layers and controllers |
| `doc/sources.md` | Built-in sources with option tables, the two complete single-file server recipes, CORS |
| `doc/tiers.md` | Resolution tiers, the cross-fade, `rollupBinned`, the rate axis |
| `doc/plugins.md` | The renderer and source contracts, with a complete working example of each |
| `doc/comparison.md` | How embedding this chart differs from a Grafana or Zabbix panel |
| `doc/recipes.md` | Task-shaped copy-paste examples |
| `doc/development.md` | Build, demo pages, testing (incl. what each test file covers), linting, releasing |
| `doc/internals/` | The design record — see the table below |

Three rules that keep this from rotting:

- **Every code block in `doc/` was executed before being committed**, headlessly against
  `dist/` in a real browser — not eyeballed. That is how the `extensive` trap and the
  `initialView`-overwrites-`zoom()` trap were found. Re-verify any example you edit; a doc
  example that silently no-ops is worse than no example.
- **`doc/img/*.png` are screenshots of the actual demo pages**, captured over CDP at
  `deviceScaleFactor: 2` and clipped to the canvas element, so they re-shoot reproducibly
  when the rendering changes. The old hand-made `demo.png` is gone. Regenerate by driving
  a headless Chromium's `Page.captureScreenshot` with a clip from
  `getBoundingClientRect()` — note the clip's `scale` must stay `1` when
  `deviceScaleFactor` is already 2, or the capture doubles up. `types.png` is the
  `.type-grid` element of `demo/index.html` (the page caps it at 1252 CSS px, so the
  viewport width only has to exceed that); `captureBeyondViewport: true` is needed,
  since the grid is taller than any sane viewport. Do **not** post-process with a
  palette quantizer: it halves the file but adds a step the next person will not
  know to repeat, and re-shooting has to stay a one-command job.
- **`RELEASING.md` stays out of both** — it is the maintainer's runbook, written in German,
  **gitignored**, and present only in the maintainer's working copy. Do not link to it (the
  link would 404 on GitHub) and do not assume it is there. `doc/internals/packaging.md`
  explains the machinery, `RELEASING.md` the steps; keep the two in step.

## Before you touch X, read Y

| Working on… | Read |
|---|---|
| A renderer, a plot shape, the hit test, series colours | [`doc/internals/renderers.md`](doc/internals/renderers.md) |
| Axes, resolution tiers, the rate axis, partial bins, the snap grid, resize, the DOM overlays | [`doc/internals/core.md`](doc/internals/core.md) |
| A data source, CORS, the dev proxy | [`doc/internals/sources.md`](doc/internals/sources.md) |
| Versions, releasing, the `exports` map, distribution | [`doc/internals/packaging.md`](doc/internals/packaging.md) |
| Tests, lint, the build, the demo pages | [`doc/development.md`](doc/development.md) |
| The user-facing docs | [`doc/README.md`](doc/README.md), plus the layout rules above |
| Something not built yet | [`doc/internals/roadmap.md`](doc/internals/roadmap.md) |

## Do not

Each line is a decision already taken, with its argument on the page named. Reversing one
is a deliberate act with its own commit — not a cleanup.

- **Do not reintroduce an auto-bump of the version**, and do not hand-edit `version` in
  `package.json` or `src/version.js`. Consumers pin these now. → `packaging.md`
- **Do not compact `data[]`.** A plot id *is* its index; freed slots go on `freeSlots` and
  are released through `releaseSlot(i)`, never by assigning `data[i] = null`. → `core.md`
- **Do not multiply `_fade` or `_vscale` into a renderer's own arithmetic.** Both are
  applied centrally in `plotData()`; doing it again doubles up. A renderer that sets
  `globalAlpha` must restore it to the value it *found*, not to `1`. → `core.md`
- **Do not drop any of the six `clampPlot(px)` calls** guarding zero-size canvases, and do
  not simplify the ResizeObserver's or `plotAll()`'s bail-outs. One hidden chart used to
  spin every visible peer at ~250 fps. → `core.md`
- **Do not cache the canvas offset.** `refreshOffset()` re-reads the rect on every pointer
  handler because the canvas moves without resizing. → `core.md`
- **Do not turn `ensureGrid()` into a pure function of `tmin`/`tmax`** — deriving the grid
  from the viewport feeds back on itself, and a fixpoint iteration provably does not fix
  it. Nor reintroduce `panSnapUnit`/`panSnapEdge` edge-wise snapping. → `core.md`
- **Do not enable `no-var`.** `npm run lint:strict` is green at 0/0 and must stay there;
  a wholesale `var`→`let` conversion is a 300-finding diff with real scoping risk.
- **Do not claim CommonJS `require()` works.** It resolves to the IIFE and silently returns
  `{}`. → `packaging.md`
- **Do not present the Pages `dist/` URL as the production drop-in.** It pins nothing, on
  purpose. → `packaging.md`
- **Do not let a renderer skip its declarations.** `values: 'array'`, `stacked`,
  `cumulative` and `lanes` are facts only the renderer knows; omitting one does not error,
  it silently mismeasures the axis. → `renderers.md`
- **Do not let `barRect()` (`gantt.js`) and `get_element()` (`timeseries.js`) drift.** They
  are hand-kept in sync; `test/gantt-hittest.test.mjs` is what catches it. → `renderers.md`
- **Do not absorb app-specific analytics into `attachLegend`.** It is a series-visibility
  legend; extend via `formatter`/`extra`/`onItemClick`. → `core.md`

## Development

```bash
npm install          # install esbuild + eslint (the only dev dependencies)
npm run build        # bundle src/ → dist/timeseries.js (IIFE)
npm run build:min    # minified build → dist/timeseries.min.js
npm run watch        # rebuild on file changes
npm run serve        # python3 static server on :8080
npm run serve:proxy  # same, but node — adds the /dav-proxy route (CalDAV only)
npm test             # run test/*.test.mjs with node's built-in test runner
npm run lint         # eslint; must stay at 0 errors
npm run lint:strict  # same, but warnings fail too (--max-warnings 0); currently green
npm run release -- X.Y.Z   # cut a release
```

Full details — the demo pages and which need a build, the DOM stubs, what each test file
covers, the lint policy, the release gate — are in [`doc/development.md`](doc/development.md).
Three things worth knowing before the first command:

- **`demo/index.html` loads the IIFE bundle**, so changes to `src/` only show up there
  after `npm run build`. The other four demo pages import `src/` directly and need no
  build step.
- **Run `TZ=Europe/Berlin npm test` *and* `TZ=UTC npm test`** after touching date
  arithmetic. The DST cases self-skip in a zone without DST.
- **`npm test` expands a glob rather than passing a directory** to `node --test`:
  directory discovery is broken on at least one Node build (Fedora's `nodejs22`,
  v22.22.2). If discovery seems broken in a fresh environment, that is why.

## Architecture

### Source files (`src/`)

| File | Purpose |
|---|---|
| `timeseries.js` | Main constructor. Canvas lifecycle, time axis, grid generation, coordinate math, event handlers, animation, navigation API |
| `tooltip.js` | `attachTooltip()` — shipped opt-in hover overlay |
| `legend.js` | `attachLegend()` — shipped opt-in series-visibility legend overlay |
| `intervals.js` | Six standalone interval-arithmetic utility functions (no global side effects) |
| `rollup.js` | `rollupBinned()` — pure helper deriving a coarser resolution tier from a binned block |
| `renderers.js` | Renderer plugin registry + built-in renderers: `multibar`, `multiline` (with `step`/`fill`), `stackarea`, `waterfall`, `heatmap`, `horizon`, `multipoint`, `scatter`, and the ladder five (`quantile-bands`, `quantile-steps`, `error-bars`, `candlestick`, `ohlc`) |
| `gantt.js` | `gantt` renderer + `layoutSpans()` row packing for `category: 'span'` plots |
| `sources.js` | Data source plugin registry + built-in adapters: `zabbix`, `artificial`, `caldav` |
| `jpZabbix.js` | Standalone Zabbix JSON-RPC client (Promise-based, reusable independently) |
| `caldav.js` | Standalone CalDAV client + iCalendar parser (Promise-based, reusable independently) |

`demo/artificial.js` — demo data generator, not part of the library. It also derives an
hourly tier from the minute data via `TimeSeries.rollupBinned`, so `demo/index.html`'s main
chart shows the resolution cross-fade.

The entire library is a single closure function `TimeSeries(options)`; all internal state
is shared through closure variables, and `plotAll()` rebuilds a render context `rctx` on
every interaction. [`doc/internals/core.md`](doc/internals/core.md) has the detail.

### What a renderer declares

Four flags, and each is a fact the core cannot infer. Omitting one fails **quietly** — the
axis is simply measured wrong. [`doc/internals/renderers.md`](doc/internals/renderers.md)
spells out each failure mode.

| Flag | Means | Read by |
|---|---|---|
| `values: 'array'` | Slot values are arrays (the ladder five) | `isBandedType()` |
| `stacked: true` | Series sum per slot, so the extent is the stack total | `isStackedType()` |
| `cumulative: true` | Values are deltas; the extent follows the running total | `isCumulativeType()` |
| `lanes: true` + `layout(plot)` | Categorical y-axis; `layout` stamps `laneCount`/`yticks` | `isLanedType()` / `layoutPlot()` |

The 14 built-in types and which data shape each accepts are tabulated in
[`doc/data-formats.md`](doc/data-formats.md); the contracts for writing your own are in
[`doc/plugins.md`](doc/plugins.md).

### Public API

Documented in full in [`doc/api.md`](doc/api.md) — navigation, follow mode, viewport sync,
data, introspection, series visibility, appearance, events, resolution tiers, partial bins,
the statics on the constructor and the module-level exports. There is deliberately **no
`destroy()`**: a canvas cannot be reused, and a page needing a rebuild reloads (both live
demos' "Disconnect" does exactly that).
