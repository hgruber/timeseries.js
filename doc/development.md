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

Read the banner on either live page before pointing it at anything you care about. Served
from `localhost`, both are cross-origin to whatever server you point them at — see
[Cross-origin](sources.md#cross-origin-cors), including the `/dav-proxy` route that
`npm run serve:proxy` adds for the CalDAV page.

### Shared demo chrome

All five pages link `demo/demo.css` and load `demo/demo-nav.js`. The stylesheet holds the
page frame with four palettes as CSS custom properties on `body`; `demo-nav.js` is a
**classic** script (no `import`/`export`) so both the IIFE page and the module pages can load
it. It builds the nav bar and theme picker, owns the `<body>` theme class, persists the
choice in `localStorage`, and knows nothing about `TimeSeries`.

Pages repaint their own canvases via `window.demoTheme.onChange(fn)`, which fires
immediately with the current theme — so a chart built later (after a successful connect)
still comes up themed.

**Adding a page** means one entry in `PAGES` at the top of `demo-nav.js`; nothing else knows
the list. An entry is either `{href, label}` for a plain pill or
`{group, pages: [...]}` for a labelled pill-box, which is for pages on the same topic at a
different fidelity — that is why the two Zabbix pages and the two CalDAV pages are grouped.

## Testing

Plain `node:test` + `node:assert/strict`, no dependency.

```bash
npm test
TZ=Europe/Berlin npm test    # run both after touching date arithmetic
TZ=UTC npm test
```

`test/helpers/dom.mjs` stubs just enough DOM to construct a real `TimeSeries` headlessly and
dispatch synthetic mouse events at its actual handlers — the hit-test tests exercise the
real code path, not a reimplementation of it.

Two things to know when writing tests:

- **Timers.** A constructed instance keeps a self-rescheduling `setTimeout` alive forever to
  advance the "now" line. `installDOM()` overrides the global `setTimeout` so every library
  timer comes back `unref()`'d. Do **not** `await` a delay using the bare global
  `setTimeout` — it may not fire before the process exits. Use the helpers' `sleep`.
- **Viewport windows must use local midnight** (`new Date(y, m, d)`), not `Date.UTC` — pan
  snapping works in local time, so a UTC-pinned window sits mid-day in most zones and the
  first pan legitimately widens it.

The DST cases self-skip where the local zone has no DST.

> **Environment note:** on at least one build (Fedora's `nodejs22`, v22.22.2)
> `node --test <directory>` fails with `Cannot find module` — directory-based discovery does
> not work. `npm test` therefore expands a glob in the shell. If discovery seems broken in a
> fresh environment, try the explicit glob before suspecting the test files.

## Linting

`eslint.config.mjs` is deliberately narrow: it catches real defects (implicit globals, unused
bindings, unreachable code) and leaves style alone. **`no-var` is not enabled** — the source
uses `var` throughout, and converting wholesale would be a 300-finding diff with real risk
(`var` is function-scoped, `let` is block-scoped) for no behavioural gain.

`npm run lint:strict` is green at 0 errors and 0 warnings, so any new warning stands out
immediately. Keep it that way: prefer `===`/`!==` (`== null` is permitted — `eqeqeq` runs in
`smart` mode), declare each `var` once per function, and do not shadow the outer time-units
object or the `Y()`/`label()` helpers.

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
build you are looking at. `src/version.js` exports `BUILD` too, and the canvas pill draws
`VERSION + (BUILD ? '+' + BUILD : '')`. It is `'dev'` in the repo and overwritten in CI by
`scripts/stamp-build.mjs` — the Pages deploy stamps the short commit SHA, the release
workflow stamps `''`. Neither commits the change.
