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
| `doc/data-formats.md` | Every plot object shape with a field table each: binned, point, ladder (the five array-valued renderers), span; plus the `step`/`fill` line-and-area options |
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
  `deviceScaleFactor` is already 2, or the capture doubles up. `types.png` is the
  `.type-grid` element of `demo/index.html` (the page caps it at 1252 CSS px, so the
  viewport width only has to exceed that); `captureBeyondViewport: true` is needed,
  since the grid is taller than any sane viewport. Do **not** post-process with a
  palette quantizer: it halves the file but adds a step the next person will not
  know to repeat, and re-shooting has to stay a one-command job.
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
`test/keyboard.test.mjs` (focusability, all four arrows and their shift variants),
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
| `renderers.js` | Renderer plugin registry + built-in renderers: `multibar`, `multiline` (with `step`/`fill`), `stackarea`, `waterfall`, `multipoint`, `scatter`, and the ladder five (`quantile-bands`, `quantile-steps`, `error-bars`, `candlestick`, `ohlc`) |
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
  highlight(plot, n, item, rctx) { /* optional */ },
  coalesce(plot) { /* optional — key; blocks sharing it are merged before draw */ },
  values: 'array', /* optional — declares a ladder renderer, see below */
  stacked: true    /* optional — declares that series sum per slot, see below */
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
Orthogonally to `category`, a binned block's slot values may be **arrays** rather than
numbers — see *Ladder renderers* below.

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

### The area family — `multiline`'s `step`/`fill`, and `stackarea`

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
  a line is a missing *value* in a slot that exists. Note CLAUDE.md and the source used to
  claim `multiline` broke on a missing slot; it never did.
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

### `waterfall` — the one cumulative type

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

### Ladder renderers — one block, five ways to draw it

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

### Partial bins — `plot.data_until` / `setPartialBins`

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

### Zabbix source — zoom-adaptive history/trends

```js
{ 'source-type': 'zabbix',
  url, username, password, 'auth-token',           // see src/jpZabbix.js (token skips login)
  itemids: [itemid, …],                            // each item is one band series
  'value-type': 0,                                 // history.get value type (0 float, 3 unsigned)
  'history-interval': 60,                          // fine tier bucket seconds
  tiers: [{interval, kind:'history'|'trends'}],    // optional; default 60s history + 3600s trends
  padding: 0.5,                                    // prefetch fraction fetched either side
  render: 'quantile-bands',                        // any ladder type; applies to ALL tiers
  series_colors: { [itemid]: cssColor }, name }
```

`render` exists because a `[min, avg, max]` cell is equally a band, a step, an error bar or
a candle. It is validated against `isBandedType()` and falls back with a warning, and it
deliberately has no per-tier form: `_fade` groups by `plot.type`, so two types would pop
instead of dissolving.

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
`TimeSeries.rollupBinned(plot, coarseInterval, opts)`,
`TimeSeries.ladderPairs(npct)` / `TimeSeries.isBandedType(type)` (see *Ladder renderers*),
`TimeSeries.isStackedType(type)` / `TimeSeries.isCumulativeType(type)` /
`TimeSeries.waterfallLevels(plot)` (see the renderer contract and *`waterfall`* above).

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

### Keyboard, and the snap grid

`keyboard: true` (default) makes the canvas focusable (`tabindex=0`, `role=application`,
an `aria-label` unless the page set one) and binds all four arrows: ←/→ page
(`pan(∓1)`), ↑/↓ zoom (`zoomStep(±1)`), and Shift makes each the single-cell variant
(`{cells: 1}`). Handlers sit on the canvas, not the document, so a page with several charts
only moves the focused one. Set `keyboard: false` to opt out entirely. On the mouse side the
wheel zooms and **Shift+wheel pans**, both continuous.

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

### Point hit testing

`POINT_RADIUS` in `src/renderers.js` is the marker half-size per renderer type, shared
between drawing and the hit test in `get_element` — the same "keep these in step"
arrangement as `barRect()` in `gantt.js`. Point plots are hit-tested in *pixel* space
(nearest marker within its radius), unlike bars, which tile the plot area and can be
found arithmetically. Valid only while no renderer downsamples internally; a source
applying `lttb` before pushing is fine, since both draw and hit test then see the
reduced array.

The one bar that does **not** tile its bin is the partial one (see *Partial bins* below):
right of `data_until` nothing is drawn, so `get_element` has to stop there explicitly
instead of inferring the bar from its slot index alone. That is the whole reason the
feature needed a hit-test change, and why a third consumer of the bar geometry had to be
kept in step with the other two.

`ts.zoom()`'s third argument overrides the animation duration for that one transition;
`0` jumps without animating. Omit it for the configured `zoomDuration`.

### Module-level exports

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

### Option merging

`colors` is merged key-by-key with the defaults, so a partial override keeps the rest of
the palette (an undefined colour would reach the canvas as an invalid `fillStyle`).
Everything else, **including `holidays`**, replaces the default wholesale — that is how a
caller swaps the German holiday set for another country's. `TimeSeries.themes.light` is
the same object as the built-in default palette, not a copy of it.

## API roadmap

### The constructor needs an optional start window and an explicit follow state

Both are missing today, and a host that wants anything other than "the last 24
hours, following" has to correct the instance *after* construction — which is
visible on screen.

**What the constructor does now.** `tmax = Date.now()`, `tmin = tmax - 86400000`
are hard-coded locals (`src/timeseries.js:428-429`), and the last thing the
constructor does is `plotAll()` (`src/timeseries.js:3222`), so that window is
painted before the caller ever gets the object back. `initialView` does not help:
it takes a *method name*, dispatched from `setTimeout(…, 0)`
(`src/timeseries.js:3224`), i.e. after the first paint, and the set of methods is
fixed (`today`, `lastWeek`, `thisMonth`, …) — none of them expresses "this
window, which I computed myself".

**Why it matters — the case that prompted this.** starcubes computes its start
window from the datasource metadata (typically today 00:00 → tomorrow 00:00, or
`?from=`/`?to=` off the URL) and passes `initialView: null`, then calls
`ts.zoom(tmin, tmax)`. With the default `zoomDuration` that animates, so the page
opened on the last 24 hours and visibly slid to the real window on every load.
Its fix is to pass an explicit duration of `0`, which lands the viewport
synchronously inside `animate()` (span 0 → factor 1, no rAF, no `setTimeout`) and
therefore inside the same task as the constructor's paint, so the browser never
composites the 24 h frame. That works, but it is a workaround resting on an
implementation detail of `animate()`, it costs a wasted `plotAll()`, and it forces
the host to stash the pre-construction values because constructing the instance
fires `onViewportChange` and overwrites whatever the host was tracking.

**Follow is the second half, and it is currently only expressible as a side
effect of `initialView`.** `last24()`/`next24()` call `doFollow()` plus
`start_follower()` (`src/timeseries.js:1183-1191`); every other navigation method
calls `doStop()`. So the two concerns — *which window* and *is it rolling* — are
welded together, and the only way to say "this window, and follow it" or "the
last 24 hours, but do not follow" is to construct and then override. Note also
that `initialView: null` leaves the instance in neither state: `follow_stopped`
is `false` but no follower timer is running, so a host rendering a follow toggle
has to call `ts.stop()` itself purely to get the `onStop` callback that syncs its
button — which is exactly what starcubes does today.

`autoFollow` is not this option. It means "start rolling once the right edge
reaches the present", not "start rolling now".

**Shape to build.** Overload `initialView` rather than adding a second option
that overlaps it — one option, read as "either a named view or a concrete
window":

```js
new TimeSeries({
  initialView: [tmin, tmax],           // ms epoch; or 'last24' | null as today
  follow: false,                       // explicit, independent of the window
});
```

The window has to be applied where `tmin`/`tmax` are initialised
(`src/timeseries.js:428-429`), not from the `setTimeout` dispatch — applying it
later is precisely the bug. `ppms` is derived immediately below and so comes out
right for free. Keep the string form dispatching as it does now:

```js
if (typeof settings.initialView === 'string')
  setTimeout(function () { self[settings.initialView](); }, 0);
```

Both are additive and backward-compatible: an absent `follow` keeps whatever the
`initialView` method implies, and a string or `null` `initialView` behaves
exactly as it does today. Worth a test in `test/options.test.mjs` asserting that
`getViewport()` matches the passed range *immediately* after construction, since
"synchronously, before the first paint" is the entire contract and a later
refactor could satisfy the value while losing the timing.

Downstream: starcubes can then drop its `_initTmin`/`_initTmax` capture, the
`zoom(…, 0)` workaround and the standalone `ts.stop()` — see that repo's
`docs/chart-app.md`, "Init and the start window".

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
