# Internals — roadmap

Planned work, with the reasoning that produced the priority order. Nothing here is
built yet; when something ships, its section moves to the page that documents it.

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
