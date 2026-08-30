# Internals — roadmap

Planned work, with the reasoning that produced the priority order. The must-have
sources from the 2026-07 market analysis have shipped — see `doc/sources.md` for the
Prometheus, Home Assistant and InfluxDB sections, and `internals/sources.md` for the
implementation notes (the tiered fold, the per-entity growing cache, the 1.x-vs-2.x
mode switch). Everything below is still to do.

## Data source roadmap

Beyond the built-in `zabbix`/`caldav` sources, a market analysis (2026-07) of OSS
monitoring/IoT ecosystems ranked candidates by market share (primary) and fit to the
source-plugin contract in `src/sources.js` (tie-breaker). The **must-have** entries
shipped (Prometheus, Home Assistant, InfluxDB); the remaining priority order is:

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
