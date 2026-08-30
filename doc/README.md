# Documentation

Full documentation for [timeseries.js](../README.md). The [README](../README.md) is the
five-minute version; everything else lives here.

## Find what you need

| I want to… | Read |
|---|---|
| Load the library and draw my first chart | [Getting started](getting-started.md) |
| Pin a version, or pick between CDN / npm / self-hosting | [Getting started → Installing](getting-started.md#installing) |
| Know what a breaking change looks like | [Getting started → Versioning](getting-started.md#versioning) |
| Hand my data to the chart in the right shape | [Data formats](data-formats.md) |
| Draw bars / lines / points / scatter | [Data formats → Binned series](data-formats.md#binned-series), [Point series](data-formats.md#point-series) |
| Shade under a line, stack areas, or draw a step chart | [Data formats → Line and area options](data-formats.md#line-and-area-options) |
| Draw a running total broken into its contributions | [Data formats → Waterfall blocks](data-formats.md#waterfall-blocks) |
| Give each series its own row (heatmap, horizon) | [Data formats → Laned blocks](data-formats.md#laned-blocks--heatmap-and-horizon) |
| Draw percentile fans, error bars, box plots or candlesticks | [Data formats → Ladder blocks](data-formats.md#ladder-blocks-percentiles-minavgmax) |
| Stop a chart interpolating between two measurements | [Data formats → The five renderers](data-formats.md#the-five-renderers) |
| Draw calendar events, jobs or outages | [Data formats → Spans (Gantt)](data-formats.md#spans-gantt) |
| Set constructor options, colours, themes, holidays | [Configuration](configuration.md) |
| Navigate, zoom, follow "now", sync several charts | [API reference → Navigation](api.md#navigation) |
| Read or change what is on screen at runtime | [API reference](api.md) |
| Add a hover tooltip or a clickable legend | [Overlays](overlays.md) |
| Pull data from Zabbix, a CalDAV server, Prometheus… | [Data sources](sources.md) |
| Get past a CORS error | [Data sources → Cross-origin](sources.md#cross-origin-cors) |
| Write my own renderer or data source | [Plugins](plugins.md) |
| Show two resolutions of one signal without a visible pop | [Resolution tiers](tiers.md) |
| See how this differs from a Grafana/Zabbix panel | [Comparison](comparison.md) |
| Copy a working example | [Recipes](recipes.md) |
| Compare performance against other libraries | [Performance](../benchmark/README.md) |
| Build, test or release the project | [Development](development.md) |
| Understand *why* the core does something the way it does | [Internals](internals/) |

## The pages

| Page | Contents |
|---|---|
| [getting-started.md](getting-started.md) | Installing (CDN, npm, self-hosted), version pinning, versioning policy, first chart, the three mistakes everybody makes first |
| [data-formats.md](data-formats.md) | Every plot object shape the core understands: binned, point, ladder, span — with a field table each |
| [configuration.md](configuration.md) | All constructor options, the palette and the four themes, holidays, keyboard, mobile |
| [api.md](api.md) | Every instance method and static, grouped by task |
| [overlays.md](overlays.md) | `attachTooltip` and `attachLegend`: defaults, the override layers, the controller objects |
| [sources.md](sources.md) | The built-in `artificial`, `zabbix` and `caldav` sources, complete single-file recipes against a real server, and CORS |
| [tiers.md](tiers.md) | Resolution tiers, the cross-fade, `rollupBinned`, and the rate axis (`setRateUnit`) |
| [comparison.md](comparison.md) | How embedding this chart differs from a Grafana or Zabbix panel |
| [plugins.md](plugins.md) | The renderer and source plugin contracts |
| [recipes.md](recipes.md) | Copy-paste examples, one per task |
| [benchmark/README.md](../benchmark/README.md) | Performance comparison methodology; the micro and browser harness, and the latest numbers |
| [development.md](development.md) | Build, test, lint, the demo pages, cutting a release |
| [internals/](internals/) | The design record: why each mechanism exists and what breaks without it. For changing the library, not for using it |

## Conventions used throughout

- **Times are Unix milliseconds** in the viewport API (`zoom`, `getViewport`, span
  `start`/`end`, point `t`) and **Unix seconds** in binned plot objects
  (`interval_start`, `interval_end`, `interval`). The split is historical but consistent:
  anything named `interval*` is seconds, everything else is milliseconds.
- **All date arithmetic is local-time** — day, week, month and year boundaries follow the
  browser's zone, including DST transitions.
- **A series id is a string key** that means the same measurement in every block. Colours,
  visibility and legend entries are all keyed by it.
- Code blocks are complete unless they end in `// …`.
