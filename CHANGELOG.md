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

## [0.9.0] - 2026-07-30

First published release. The library has been developed and deployed from `main`
for some time; what changes here is that a **specific, immutable version can now
be installed and pinned** instead of only the always-latest build on GitHub
Pages.

### Added

- **npm package** — `npm i timeseries.js`, which also makes pinned CDN URLs
  available via jsDelivr and unpkg (`…/npm/timeseries.js@0.9.0/dist/timeseries.min.js`).
  Both the ES modules under `src/` and the IIFE bundles under `dist/` ship in the
  tarball; `exports` resolves `import` to the former and everything else to the
  latter.
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
