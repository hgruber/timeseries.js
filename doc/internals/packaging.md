# Internals — versioning, releasing and distribution

What the version number promises, what the release script guarantees before it writes
anything, and which of the three distribution channels is the pinnable one. The
operator's step-by-step is [Development → Cutting a release](../development.md#cutting-a-release).

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

## Releasing

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

## Distribution channels

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

