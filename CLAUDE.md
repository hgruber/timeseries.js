# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A vanilla JavaScript canvas-based time series visualization library. The live demo is at https://hgruber.github.io/timeseries.js/index.html.

## Documentation layout

**`README.md` is for the impatient and is kept that way on purpose**: badges, a one-paragraph
pitch, a screenshot strip, one copy-paste quickstart, the feature list, and a table pointing
into `doc/`. Reference material does **not** go back into it — if a section starts growing an
options table or a second example, it belongs in `doc/`.

`doc/` is the reference set, one topic per file, each with its own scannable heading
structure so a reader (or an agent) can load just the page it needs instead of the whole
manual:

| File | Covers |
|---|---|
| `doc/README.md` | The index: a "what do I want to do → read this" table, plus the cross-file conventions (ms vs. seconds, local time, series ids) |
| `doc/getting-started.md` | Installing, the CDN/npm/self-host choice, version pinning, versioning policy, first chart, the three common pitfalls |
| `doc/data-formats.md` | Every plot object shape with a field table each: binned, point, quantile-bands, span |
| `doc/configuration.md` | Constructor options, palette keys and themes, holidays, keyboard, mobile, hidden containers |
| `doc/api.md` | Every instance method and static, grouped by task; also what is deliberately *not* in the API |
| `doc/overlays.md` | `attachTooltip` / `attachLegend`, their override layers and controllers |
| `doc/sources.md` | Built-in sources with option tables, the two complete single-file server recipes, CORS |
| `doc/tiers.md` | Resolution tiers, the cross-fade, `rollupBinned`, the rate axis |
| `doc/plugins.md` | The renderer and source contracts, with a complete working example of each |
| `doc/recipes.md` | Task-shaped copy-paste examples |
| `doc/development.md` | Build, demo pages, testing, linting, releasing |

Three rules that keep this from rotting:

- **Every code block in `doc/` was executed before being committed**, headlessly against
  `dist/` in a real browser — not eyeballed. That is how the `extensive` trap below was
  found. Re-verify any example you edit; a doc example that silently no-ops is worse than
  no example.
- **`doc/img/*.png` are screenshots of the actual demo pages**, captured over CDP at
  `deviceScaleFactor: 2` and clipped to the canvas element, so they re-shoot reproducibly
  when the rendering changes. The old hand-made `demo.png` is gone. Regenerate by driving
  a headless Chromium's `Page.captureScreenshot` with a clip from
  `getBoundingClientRect()` — note the clip's `scale` must stay `1` when
  `deviceScaleFactor` is already 2, or the capture doubles up.
- **`RELEASING.md` stays out of both** — it is gitignored and German-only, see the
  Releasing section below.

## Development

```bash
npm install          # install esbuild (only dev dependency)
npm run build        # bundle src/ → dist/timeseries.js (IIFE)
npm run build:min    # minified build → dist/timeseries.min.js
npm run watch        # rebuild on file changes
npm run serve        # python3 static server on :8080
npm run serve:proxy  # same, but node — adds the /dav-proxy route (see below)
npm test             # run test/*.test.mjs with node's built-in test runner
npm run lint         # eslint; must stay at 0 errors
npm run lint:strict  # same, but warnings fail too (--max-warnings 0); currently green
npm run release -- X.Y.Z   # cut a release (see "Versioning" below)
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

**Dev without building**: `demo/caldav.html`, `demo/caldav-live.html`, `demo/zabbix.html` and
`demo/zabbix-live.html` use `<script type="module">`
and import directly from `src/`, so they need no build step. `demo/index.html` does **not** — it loads
the IIFE bundle via `<script src="../dist/timeseries.js">`, so changes to `src/` only show
up there after `npm run build` (or with `npm run watch` running). `dist/` is gitignored;
the Pages deploy in `.github/workflows/deploy.yml` builds it in CI. Because those four pages
import `src/` directly even in production, that workflow also copies `src/`
into the deploy folder alongside `demo/` and `dist/` — otherwise they 404 on their
`../src/*.js` imports.

**Shared demo chrome**: all five demo pages link `demo/demo.css` and load `demo/demo-nav.js`.
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

**Production**: `dist/timeseries.js` is an IIFE bundle; include it via `<script src="dist/timeseries.js">` and use `new TimeSeries(...)` globally.

**Three distribution channels, and the README is careful about which is which.** npm is
the pinnable one: a published version is immutable, which also gives pinned CDN URLs
(`https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.9.0/dist/timeseries.min.js`; unpkg serves
the same paths) — that is what the README's `<script>` examples use, and what the recipes
below use. GitHub releases carry the same two bundles as attachments for self-hosting a
fixed copy. The Pages deploy still publishes `dist/` at
`https://hgruber.github.io/timeseries.js/dist/timeseries.min.js` (served with
`Access-Control-Allow-Origin: *`), rebuilt on every push to `main` — it pins nothing **on
purpose** and the README labels it as for trying things out, not production. Do not
present that URL as the production drop-in again; that framing predates npm publishing.

README's *Connect to a real server* hangs two single-file recipes off it (Zabbix, CalDAV),
whose whole CORS story is "put the file on the host that serves the API" — an origin is
scheme+host+port, so the path is free. Two traps those recipes encode, both verified by
constructing them headlessly against `test/helpers/dom.mjs`:

- **CalDAV's `url` must be absolute.** `absolute()` in `src/caldav.js` is
  `new URL(href, config.url)`, and a relative *base* is not a valid URL — it throws in the
  browser exactly as it does in Node. The recipe therefore uses `location.origin + '/…'`,
  which stays same-origin without hard-coding a host. Calendar hrefs, resolved *against*
  that base, may be relative.
- **Zabbix's `url` may be relative** (`/zabbix/api_jsonrpc.php`): `jpZabbix.api()` hands it
  to `XMLHttpRequest.open()`, which resolves against the document base.

`src/jpZabbix.js` has **no `proxy` option** (unlike `src/caldav.js`), so `serve:proxy`'s
forwarder is a CalDAV-only escape hatch; the README's CORS section says so rather than
papering over it. That was a deliberate call — the recipes solve CORS by placement, not by
proxying.

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
`test/gantt.test.mjs` (row packing, `layoutSpans`, and the `group` reservation —
including the interleaving case a foreign event used to split a group on),
`test/gantt-hittest.test.mjs`
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

**The version is a semver signal, and it used not to be.** Until 0.9.0 the patch number
incremented by exactly 1 on every commit — a build counter, explicitly documented here as
carrying no compatibility meaning. That is incompatible with consumers pinning a version,
which they now can (npm, and pinned jsDelivr/unpkg URLs), so it was replaced:

- The project is pre-1.0 and follows the **0.x convention**: a *minor* bump may break the
  public API, a *patch* bump never does. `^0.9.0` and `@0.9` therefore mean something.
- The version changes **only at a release**, via `npm run release -- X.Y.Z`. Nothing
  bumps it automatically any more; the pre-commit hook, `scripts/bump-version.mjs` and
  `scripts/install-hooks.sh` are gone, along with the npm `"prepare"` script that
  installed the hook. Do not reintroduce an auto-bump — it would silently move a number
  that consumers now depend on.
- **Do not hand-edit the version** in either file. `package.json`'s `version` is the
  source of truth and `src/version.js` mirrors it (`export const VERSION`);
  `test/version.test.mjs` asserts they agree, since no hook keeps them in step now.

**`BUILD` is the other half of the split.** Because `VERSION` no longer moves per commit,
it cannot say *which* build you are looking at — so `src/version.js` also exports
`BUILD`, bundled as `TimeSeries.BUILD`, and the canvas pill draws
`VERSION + (BUILD ? '+' + BUILD : '')`. It is `'dev'` in the repo and overwritten in CI
by `scripts/stamp-build.mjs`: `deploy.yml` stamps the short commit SHA (so a Pages demo
names its exact build, `0.9.0+g320a993`), `release.yml` stamps `''` (a published bundle
*is* an exact version, `0.9.0`). Neither commits the change — only the CI working tree
moves. `stamp-build.mjs` rejects anything outside `[A-Za-z0-9.-]`, because whatever it
writes gets drawn.

The canvas draws that string as a small tag in a rounded pill in the bottom margin, just inside the plot's right edge
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

### Releasing

`RELEASING.md` is the maintainer's runbook — the account/token setup, the per-release
handgriffe, and the recovery cases (a tag pushed with a broken changelog, a bad version
already on npm). It is written **in German**, unlike the rest of the docs, because it is
a personal operator checklist rather than public API documentation — and for the same
reason it is **gitignored**, existing only in the maintainer's working copy. Do not link
to it from the README (the link would 404 on GitHub) and do not assume it is present.
Keep the two in step: this section explains the machinery, `RELEASING.md` the steps.

`CHANGELOG.md` (Keep a Changelog) is written **first** — a section
`## [X.Y.Z] - YYYY-MM-DD`, date mandatory so an entry can't be left a placeholder. Then
`npm run release -- X.Y.Z` (`scripts/release.mjs`) validates everything *before* writing
anything: plain semver ahead of the current version, clean tree, on `main`, tag free,
changelog section present, `npm test` and `npm run lint:strict` green. It then sets both
version files, commits `Release X.Y.Z` and tags `vX.Y.Z` — and **pushes nothing**, so a
mistake stays local. Pushing the tag fires `.github/workflows/release.yml`, which
re-runs the suite, re-checks that tag ↔ `package.json` ↔ `src/version.js` ↔ changelog all
agree (`scripts/release-notes.mjs`, whose `changelogSection()` the release script shares
so the two can't disagree on what counts as a section), stamps `BUILD = ''`, builds, then
`npm publish --provenance` and `gh release create` with both bundles attached.

That gate is what makes a hand-cut release safe, and it is the reason nothing is pushed
by the script: everything that could be wrong is caught either locally or before the
publish step runs.

Three things worth knowing about the publish:

- **`dist/` is gitignored**, so the tarball only has bundles because the workflow builds
  them first; `"prepublishOnly"` in `package.json` repeats that build as a safety net for
  an accidental local `npm publish`. `files` ships `dist/`, `src/` and `CHANGELOG.md`.
- **`npm publish` needs the `NPM_TOKEN` secret.** npm's trusted publishing (OIDC) can only
  be configured for a package that already exists, so the first release uses a granular
  token; switching afterwards means deleting the secret and the `env:` block.
  `--provenance` works either way, since the workflow already has `id-token: write`.
- The `test`/`lint` steps in `release.yml` are **deliberately duplicated** from
  `deploy.yml`'s `test` job rather than factored into a `workflow_call` file — six lines
  of copy against a rework of a deploy that already works.

**The `exports` map, and what it does and does not support.** `"."` resolves `import` to
`src/timeseries.js` and everything else to the IIFE in `dist/`. Alongside it,
`"./src/*"`, `"./dist/*"` and `"./package.json"` are exported so the standalone clients can
be imported on their own (`@hgruber/timeseries.js/src/caldav.js`,
`.../src/jpZabbix.js`) — `files` has always shipped `src/`, and both clients are documented
as independently reusable, but before those entries an `exports` map with only `"."` made
every subpath an `ERR_PACKAGE_PATH_NOT_EXPORTED`.

**CommonJS `require()` does not work and the README used to claim it did.**
`require('@hgruber/timeseries.js')` resolves to the IIFE bundle, whose
`var TimeSeries = (() => {…})()` is module-scoped under CJS, so nothing is ever assigned to
`module.exports` — the caller gets `{}`, with no error. `doc/getting-started.md` says so
explicitly and points CJS consumers at `await import()` or a script tag. Fixing it properly
means emitting a real CJS build; do not "fix" it by re-adding the claim.

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
    /* callbacks: { pushData(plotObj) → id, replaceData(id, plotObj), removeData(id),
                    requestRedraw(), getViewport() → {tmin, tmax, ppms},
                    onViewportChange(fn) } */
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

An optional `extensive: true` marks the values as amounts accumulated over the bin (counts,
sums) rather than already per-unit (averages, percentiles, gauges) — see the rate axis below.
It is inert unless `setRateUnit()` is in use.

### Span plots (`category: 'span'`) and the gantt renderer

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

Note the `timeout` key is only forwarded when set. `CalDAV`'s constructor merges via
`Object.assign`, which overwrites a default with a present-but-`undefined` key, so passing it
unconditionally replaced the 20 s default with `undefined` — and `caldav.js`'s
`ctl && config.timeout` then armed no abort timer at all, leaving a hung request pending forever.

Two demos, and the split between them mirrors the two Zabbix pages:

- **`demo/caldav.html`** needs no server. With none configured it parses the static fixtures in
  `demo/fixtures/` (shifted onto the current week), so the renderer and parser are testable with
  no infrastructure.
- **`demo/caldav-live.html`** talks to a *real* server: URL, user, password and an optional
  proxy prefix go into a connect form, `discover()` doubles as the credential probe and as the
  calendar list, and a `<select multiple>` picks which calendars are drawn. Credentials land in
  `sessionStorage` (a password, unlike an API token, cannot be revoked server-side) and only
  reach `localStorage` if the user ticks the box.

That page does **not** use the built-in `caldav` source, and deliberately so: the source's
calendar list is fixed once `init()` has run, and it reports failures to `console.warn` only, so
there is nothing to hang a status line, the per-calendar counts or the legend off. It registers
a page-local `caldav-live` source instead — the same arrangement `demo/zabbix-live.html` uses
for `zabbix-problems`/`zabbix-items`. What that source adds over the built-in one is
`setCalendars(list)` at runtime, backed by a per-calendar event cache keyed to the window
currently held, so deselecting a calendar costs no request and reselecting one is free unless
the window has moved since; plus `onUpdate`/`onError`. Everything else — the padded window, the
sequence guard, the span-plot shape, `setLayout` — mirrors `src/sources.js` on purpose.

**The CORS wall, and `scripts/dev-server.mjs`.** A browser will not talk to a CalDAV server on
another origin unless that server answers the `OPTIONS` preflight — and most do not: they demand
authentication for it and answer `401`, which is fatal *regardless of any header*, because a
preflight must return 2xx. There is no client-side fix; the server has to answer `OPTIONS`
before its auth layer (Nextcloud behind Apache/nginx/HAProxy, an `Allow-Headers` list that names
`Authorization` explicitly — a `*` provably does not cover it).

For local development the way around it is the `proxy` option `src/caldav.js` already has:
`endpoint()` builds `proxy + encodeURIComponent(absoluteURL)`, so a same-origin forwarder makes
the whole CORS question disappear rather than satisfying it. `npm run serve:proxy`
(`scripts/dev-server.mjs`) is that forwarder: the same static server as `npm run serve` plus one
route, `/dav-proxy?url=…`, which replays the request (method, `Authorization`, `Depth`,
`Content-Type`, body) from Node — where the same-origin policy, a browser rule, does not exist.
Enter `/dav-proxy?url=` in the page's Proxy field. It binds to 127.0.0.1 only, since a proxy
that forwards to an arbitrary target URL is an open relay; `DAV_PROXY_ALLOW` narrows it to a
host list. `npm run serve` stays as it was — the proxy is opt-in, and the deployed Pages copy
has none, so there the server-side CORS config is the only option.

### Resolution tiers and the cross-fade (any renderer)

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
  it to the value it found, not to `1`.
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

### The rate axis — `setRateUnit(seconds, opts)`

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

Two demos, and the split between them is deliberate:

- **`demo/zabbix.html`** needs no server. It installs a synthetic `api_jsonrpc.php` (a fake
  `XMLHttpRequest` answering `history.get`/`trends.get` with a generated signal), so the
  **real** `zabbix` source — login flow, tiering, prefetch, ring, cross-fade — runs unchanged
  with no infrastructure.
- **`demo/zabbix-live.html`** talks to a *real* Zabbix server: API URL and token go into a
  connect form (stored in `localStorage` only after one successful authenticated round trip;
  the page says so in a banner) and it registers two page-local sources of its own,
  `zabbix-problems` (an `event.get`/`problem.get` gantt) and `zabbix-items` (a picker feeding
  the history/trends band), on two viewport-synced instances. It carries no credentials in the
  source, which is why it lives in `demo/` and is deployed like the rest — see the banner for
  what that means for a token typed into the Pages copy.

### Public API (TimeSeries instance)

`ts.today()`, `ts.yesterday()`, `ts.tomorrow()`, `ts.last24()`, `ts.next24()`, `ts.lastWeek()`, `ts.thisWeek()`, `ts.nextWeek()`, `ts.zoom(tmin, tmax, animationMs)`, `ts.pan(dir)`, `ts.setWatermark(src)`, `ts.redraw()`, `ts.setColors(obj)` / `ts.getColors()`, `ts.getHolidays()`, `ts.getSeries()`, `ts.setSeriesHidden(id, bool)`, `ts.toggleSeries(id)`, `ts.showAllSeries()`, `ts.onSeriesChange(fn)`, `ts.onColorsChange(fn)`, `ts.getCanvas()`,
`ts.getViewport()` / `ts.getValueRange()` (the horizontal and vertical range currently drawn —
`getValueRange` reflects hidden series and any tier cross-fade),
`ts.setRenderInterval(iv)` / `ts.setFadeBand(hi, lo)` (resolution-tier policy — see the
cross-fade section above), `ts.setRateUnit(seconds, opts)` / `ts.getRateUnit()` (rate axis —
see the section above), `ts.setYAxisLabel(lbl)`

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

### Zero-size canvases (hidden containers)

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

## Data source roadmap

Beyond the built-in `zabbix`/`caldav` sources, a market analysis (2026-07) of OSS
monitoring/IoT ecosystems ranked candidates by market share (primary) and fit to the
source-plugin contract in `src/sources.js` (tie-breaker). Priority order:

**Must-have — build these first:**
- **Prometheus** — de-facto OSS metrics standard (67% production use, CNCF survey 2025).
  `/api/v1/query_range` HTTP+JSON, `step` param controls resolution. Building against the
  plain PromQL HTTP API also covers VictoriaMetrics, Thanos, Cortex and Grafana Mimir,
  since all four implement the same API for drop-in compatibility — one source, whole
  ecosystem.
- **Home Assistant** — dominant OSS smart-home hub (openHAB/Domoticz are a distant
  second/third). REST `/api/history`, Bearer token (same shape as Zabbix's API token).
  Mixed data form: numeric sensors fit `category:'point'`, state/binary sensors fit the
  `category:'span'` gantt shape already proven by `caldav`.
- **InfluxDB** — the largest remaining gap outside the Prometheus-compatible ecosystem
  (non-Kubernetes metrics, industrial/IoT). Build against the stable 1.x InfluxQL HTTP
  API first; 2.x/3.x speak Flux/SQL instead and are a separate, optional effort.

**Should-have:**
- **Netdata** — simple REST API (`/api/v1/data`, no login flow), large self-hosted/
  homelab following; cheap to build, same target audience as Zabbix/Prometheus self-hosters.
- **Graphite** — declining share (being replaced by Prometheus/VictoriaMetrics in new
  deployments) but the Render API returns plain `[[value, timestamp], …]` arrays with
  minimal auth — worth doing opportunistically for the low effort.
- **MQTT** — huge as an IoT *protocol*, not a queryable store; push-based (WebSocket/
  `mqtt.js`), no history without a backing TSDB. Doesn't fit the poll/ring-cache source
  model used everywhere else in `src/sources.js`. Home Assistant already consumes MQTT
  internally, so this mostly matters only if a live-tail/streaming source type is wanted
  later — not a near-term pick.

**Low priority:** Icinga/Nagios (status-check shape fits the span/gantt pattern well, but
smaller and shrinking OSS mindshare vs. Prometheus), openHAB/Domoticz (Home Assistant
already covers the category). OpenTelemetry has strong momentum but is an instrumentation
protocol, not a backend with a query API of its own — data lands in Prometheus/Mimir,
Tempo, Jaeger, etc., so it doesn't correspond to a source plugin directly.
