# Internals — roadmap

Planned work, with the reasoning that produced the priority order. Nothing here is
built yet; when something ships, its section moves to the page that documents it.

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
