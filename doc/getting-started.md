# Getting started

Installing the library, pinning a version, and the first chart — plus the handful of
mistakes that cost everybody their first half hour.

## Installing

### Script tag (no build step)

```html
<script src="https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.10/dist/timeseries.min.js"></script>
```

That is an IIFE bundle: it defines a global `TimeSeries` and nothing else. No build, no
checkout, no dependencies.

### npm

```bash
npm i @hgruber/timeseries.js
```

```js
import TimeSeries from '@hgruber/timeseries.js';   // resolves to src/, unbundled ES modules
```

Everything else hangs off that default export as a static — `TimeSeries.attachTooltip`,
`TimeSeries.themes`, `TimeSeries.rollupBinned`, and so on. A few pure helpers are *also*
available as named exports, so they can be used without constructing a chart:

```js
import TimeSeries, { siFormat, Easter, isoWeekStart } from '@hgruber/timeseries.js';
```

> **CommonJS is not supported.** `require('@hgruber/timeseries.js')` resolves to the IIFE
> bundle, which assigns its global inside its own module scope and therefore exports nothing
> — you get an empty object. From CJS, use `await import(...)` or load
> `dist/timeseries.min.js` with a script tag.

### Which URL to use

| URL | What it gives you |
|---|---|
| `…/npm/@hgruber/timeseries.js@0.10.0/dist/timeseries.min.js` | **One exact version.** Immutable — npm never lets a published version change. Use this in production. |
| `…/npm/@hgruber/timeseries.js@0.10/dist/timeseries.min.js` | **The latest 0.10.x.** Picks up fixes, never a breaking change (see [Versioning](#versioning)). |
| [`hgruber.github.io/timeseries.js/dist/timeseries.min.js`](https://hgruber.github.io/timeseries.js/dist/timeseries.min.js) | **Always the tip of `main`.** Rebuilt on every push, deliberately unpinned — for trying things out, not for production. |

Prefix the first two with `https://cdn.jsdelivr.net`; `https://unpkg.com` serves the same
paths. Both bundles are available at every version:

- `timeseries.min.js` (~73 kB) — minified, for production.
- `timeseries.js` — unminified, readable in devtools.

Both are also attached to every
[GitHub release](https://github.com/hgruber/timeseries.js/releases) if you would rather host
a fixed copy yourself, and all are served with `Access-Control-Allow-Origin: *`.

`TimeSeries.VERSION` reports which version is loaded. `TimeSeries.BUILD` identifies the build
when it is not a release — empty for a published version, the commit hash for the
always-latest URL above. The small pill in the chart's bottom-right corner draws both, so a
screenshot always names its own build; clicking it opens the repository.

## Versioning

The project is pre-1.0 and follows the usual 0.x convention:

- a **minor** bump (`0.9.0` → `0.10.0`) may break the public API,
- a **patch** bump (`0.9.0` → `0.9.1`) never does.

So `^0.10.0` in a `package.json`, or `@0.10` in a CDN URL, gets you fixes without surprises.
Every release is listed in [CHANGELOG.md](../CHANGELOG.md), and breaking changes are called
out there under *Changed* or *Removed*.

The version changes only at a release — it is a compatibility signal, not a build counter.

## Your first chart

A complete file. Save it, open it, done.

```html
<!DOCTYPE html>
<meta charset="utf-8">
<title>timeseries.js</title>
<canvas id="chart" style="width: 900px; height: 360px"></canvas>

<script src="https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.10/dist/timeseries.min.js"></script>
<script>
  // 24 hourly slots, two series each. `data[slot][seriesId] = value`.
  const t0 = Math.floor(Date.now() / 3600000) * 3600 - 23 * 3600;   // Unix *seconds*, on the hour
  const data = {};
  for (let i = 0; i < 24; i++) {
    data[i] = { ok: 50 + Math.round(40 * Math.random()),
                error: Math.round(10 * Math.random()) };
  }

  const ts = new TimeSeries({
    canvas: 'chart',                 // id of the <canvas> above
    initialView: 'last24',           // frame the last 24 hours on load
    yAxisLabel: 'txn/h',
    sources: [{
      'source-type': 'artificial',   // "here is the data" — no fetching
      type: 'multibar',              // stacked bars
      name: 'transactions',
      interval_start: t0,            // Unix seconds, left edge
      interval_end: t0 + 24 * 3600,  // Unix seconds, right edge
      interval: 3600,                // seconds per slot
      count: 24,
      min: 0, max: 130,              // value range of the data
      data,
    }],
  });

  TimeSeries.attachTooltip(ts);      // hover card
  TimeSeries.attachLegend(ts);       // click a series to hide it
</script>
```

Drag to pan, scroll to zoom (shift+scroll to pan), click a time label to zoom to it,
arrow keys to page and zoom — snapped to the axis grid at every zoom level.

Next: [more examples](recipes.md) · [other data shapes](data-formats.md) ·
[fetch from a real server](sources.md) · [options](configuration.md)

## The three things that trip people up

### 1. The canvas needs a non-zero CSS size

The library reads `clientWidth`/`clientHeight` at construction and sizes its backing store
from them. A bare `<canvas id="chart">` with no CSS is 300×150; a canvas inside a
`display: none` container is 0×0.

```html
<canvas id="chart" style="width: 900px; height: 360px"></canvas>   <!-- fine -->
<canvas id="chart"></canvas>                                       <!-- 300×150 -->
```

A chart built inside a hidden container is handled — it keeps its last good geometry and
picks up the real size when the container is shown — but it draws nothing until then.

### 2. Seconds vs milliseconds

Binned plot objects (`interval_start`, `interval_end`, `interval`) are in **Unix seconds**.
Everything else — `zoom(tmin, tmax)`, `getViewport()`, point `t`, span `start`/`end`,
`tmin`/`tmax` on point and span blocks — is in **Unix milliseconds**. A chart that renders
empty at an absurd zoom is almost always this.

### 3. A canvas can only host one chart

There is no `destroy()`. A second `new TimeSeries` on the same canvas warns and returns a
half-built object. A page that needs to rebuild a chart (after new credentials, say) has to
reload — which is exactly what the "Disconnect" buttons in the live demos do.
