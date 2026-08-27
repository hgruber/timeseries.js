# timeseries.js vs. dashboard panels (Grafana, Zabbix)

Grafana and Zabbix are monitoring *platforms* — a data store, alerting, users, dashboards.
timeseries.js is not a platform; it is the chart you embed in your own page. This page is
for the narrower question people actually ask: *if all I want is the time series chart
itself, embedded in something I control, how does it compare to what those platforms draw?*
Every row below is a factual difference, each backed by a spot in this repo you can check
yourself — not a marketing claim.

| | timeseries.js | Grafana / Zabbix panels |
|---|---|---|
| Runs inside your own page | Yes — one `<script>` tag, `new TimeSeries(...)`, no server | No — panels are served by the platform, typically via an iframe embed |
| Dependencies | Zero. ~76 KB minified, ~28 KB gzipped ([`npm run build:min`](development.md)) | Full platform install (Grafana) or a monitoring server (Zabbix) |
| Time zone / DST correctness | Day, week, month and year boundaries computed from the browser's local `Date` fields, so they land correctly across a DST transition (`panFloor`/`panAdd`, tested both `TZ=Europe/Berlin` and `TZ=UTC`) | Fixed dashboard time ranges are a frequent source of off-by-an-hour complaints around DST in both tools' issue trackers |
| Keyboard navigation | Arrow keys pan and zoom, snapped to the same grid the axis labels are drawn on — a keypress lands on a boundary you can actually read ([Configuration → Keyboard](configuration.md#keyboard)) | Mouse/touch-only time range control; no snapped keyboard paging of the plotted window |
| Resolution switching | Two tiers of one signal (e.g. minute + hourly rollup) cross-fade into each other as you zoom, no visible pop, axis travels smoothly across the switch ([Resolution tiers](tiers.md)) | Panels typically re-query and redraw at a new resolution with a visible refresh/pop |
| Partial (in-progress) bins | The still-filling bin can be drawn area-true (`scale` mode) instead of misleadingly full-height or full-width (`plot.data_until` / `setPartialBins`, see `CLAUDE.md`) | Not a concept either platform's panel exposes |
| Theming | Four built-in themes, one call re-themes chart *and* its tooltip/legend overlays together (`ts.setColors(...)`) | Grafana: platform-wide theme, not a per-panel embed concern. Zabbix: widely described by users as dated, not customisable per chart |
| Extending it | Register a renderer or a data source as a plain object — [Plugins](plugins.md) | Grafana: full plugin SDK, a build toolchain, and (for public/paid distribution) a signing process. Zabbix: no per-chart plugin model |

## What this page is not saying

It is not saying "don't run Grafana" or "don't run Zabbix" — if you need alerting, users,
long-term storage or dozens of prebuilt data source integrations, that is what those
platforms are for, and timeseries.js has no answer to any of it. The built-in
[`zabbix`](sources.md) and [`caldav`](sources.md) sources exist precisely because plenty of
people run those *backends* already and just want a nicer, embeddable chart on top of the
data — that is the gap this page is describing.
