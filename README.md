# timeseries.js

A lightweight, dependency-free JavaScript library for interactive time series visualization on HTML canvas. Designed for fluid navigation at any time scale — from minutes to years — with correct daylight saving time handling and calendar-aware labeling.

**[Live demo](https://hgruber.github.io/timeseries.js/demo/)**

[![demo image](demo.png)](https://hgruber.github.io/timeseries.js/demo/)

---

## Features

- **Fluid navigation** — drag to pan, scroll wheel to zoom, animated transitions on click
- **Calendar-aware time axis** — labels adapt to the zoom level (day/month/year), shows calendar weeks, public holidays, and working days
- **Daylight saving time** — all day and month boundaries computed correctly in the browser's local time zone
- **Rolling mode** — when the current time reaches the right edge, the chart follows it like a seismograph
- **Viewport sync** — synchronize multiple chart instances' viewports to zoom/pan together
- **Smart downsampling** — LTTB algorithm optimizes rendering performance for large PointSeries datasets
- **Extended navigation** — month/year navigation, calendar weeks (ISO 8601), plus date helpers for day/week intervals
- **Plugin architecture** — register custom renderers and data sources without modifying library code
- **Customizable colors** — 4 built-in color schemas to match your theme
- **Built-in chart types** — stacked bars (`multibar`), lines (`multiline`), points (`multipoint`), scatter (`scatter`), percentile bands (`quantile-bands`), calendar/Gantt spans (`gantt`)
- **Built-in data sources** — Zabbix JSON-RPC API, CalDAV calendars, static/generated data

---

## Getting started

### Via script tag (production)

```html
<canvas id="chart" style="width: 900px; height: 360px"></canvas>

<script src="dist/timeseries.js"></script>
<script>
  // A minimal stacked-bar dataset: 24 hourly slots, two series each.
  const today0 = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const data = {};
  for (let i = 0; i < 24; i++) {
    data[i] = { ok: Math.round(50 + 40 * Math.random()),
                error: Math.round(5 + 10 * Math.random()) };
  }

  const ts = new TimeSeries({
    canvas: 'chart',                 // id of the <canvas> element
    initialView: 'today',            // frame the current day on load
    yAxisLabel: 'txn/h',
    sources: [{
      'source-type': 'artificial',   // built-in pass-through source
      type: 'multibar',              // renderer: stacked bars
      name: 'transactions',
      interval_start: today0,        // Unix seconds
      interval_end: today0 + 24 * 3600,
      interval: 3600,                // seconds per slot
      count: 24,
      min: 0, max: 120,
      data,                          // { slotIndex: { seriesId: value } }
    }],
  });
</script>
```

The canvas must have a non-zero CSS width/height — the library reads
`clientWidth`/`clientHeight` once at construction and sizes its backing
store from them.

### Development

```bash
npm run build   # build dist/timeseries.js first
npm run serve   # static server on :8080
# open http://localhost:8080/demo/index.html
```

`demo/caldav.html` shows the `gantt` renderer and the `caldav` source; with no
server configured it parses the static fixtures in `demo/fixtures/` instead,
so it works with no infrastructure.

---

## Building

```bash
npm install          # installs esbuild (only dev dependency)
npm run build        # bundle → dist/timeseries.js
npm run build:min    # minified → dist/timeseries.min.js
npm run watch        # rebuild on file changes
npm run serve        # static server on :8080
npm test             # run the test suite (node's built-in test runner)
```

---

## Instance API

### Navigation

Any of these method names is also a valid `initialView` value.

```js
ts.today()       ts.yesterday()   ts.tomorrow()
ts.thisWeek()    ts.lastWeek()    ts.nextWeek()
ts.thisMonth()   ts.lastMonth()   ts.nextMonth()
ts.thisYear()    ts.lastYear()    ts.nextYear()
ts.last24()      ts.next24()

ts.zoom(tmin, tmax, animationMs)   // explicit window; tmin/tmax in Unix ms
                                   // animationMs optional: omit for zoomDuration, 0 = no animation
ts.zoomWeek(year, week)            // ISO 8601 week
ts.zoomMonth(year, month)          // month is 1-12
ts.zoomYear(year)
ts.pan(dir)                        // calendar-aware pan; dir < 0 back, > 0 forward
```

### Follow (rolling) mode

```js
ts.follow(fraction)    // start following "now"; fraction 0-100 = right-edge offset
ts.previewNow()        // jump to now without locking into follow mode
ts.onFollow(fn)        // called when follow mode (re)starts, with the percentage
ts.onStopFollow(fn)    // called when follow mode stops
```

### Viewport sync groups

Instances in the same group pan/zoom and follow together. Set `group` in
the constructor, or join/leave at runtime:

```js
ts.joinGroup('dashboard');
ts.leaveGroup();
```

### Data & introspection

```js
ts.clearAll();                 // drop every dataset
ts.dropData(plot => …);        // remove datasets matching a predicate
ts.getData();                  // all loaded plot objects
ts.getActiveData();            // only those intersecting the viewport
ts.getViewport();              // { tmin, tmax, ppms }  (tmin/tmax in ms)
ts.getRenderBounds();          // visible value range actually drawn
ts.getPlotArea();              // { margin, plotWidth, plotHeight }
ts.redraw();                   // force a repaint, e.g. after mutating a pushed plot in place
```

### Runtime setters & callbacks

```js
ts.setColors(TimeSeries.themes.dark);   // swap palette (merges, then redraws)
ts.getColors();                         // current palette (a copy)
ts.getHolidays();                       // current holiday map (a copy)
ts.setYAxisLabel('req/s');
ts.setWatermark(urlOrImage);            // string URL or HTMLImageElement; null clears
ts.setRenderInterval(ms);               // force a fixed redraw cadence; null = on demand

ts.onClickDataCallback((plot, slot, item) => { … });
ts.onHoverDataCallback((plot, slot, item) => { … });
```

### Series visibility (building a legend)

The library supplies the data; it never creates DOM for a legend, so the markup and
styling stay yours.

```js
ts.getSeries();
// → [{ id: 'cpu', label: 'cpu', color: 'hsla(…)', hidden: false }, … ]

ts.setSeriesHidden('cpu', true);   // hide one series and redraw
ts.toggleSeries('cpu');
ts.showAllSeries();
ts.onSeriesChange(() => renderLegend());   // fires when the hidden set changes
```

`color` is exactly what was painted, including any `series_colors` override, so a swatch
matches the chart. Hiding is by series id across every plot in the instance, and a hidden
series drops out of the y-axis extent as well — hide the tallest one and the axis
rescales to what is left. `demo/index.html` has a worked example (`renderLegend`).

Note `onSeriesChange` does **not** fire when incoming data introduces a new series; call
`getSeries()` again after pushing data if that matters.

### Keyboard

With `keyboard: true` (the default) the canvas joins the tab order and gets an
`aria-label`, and the left/right arrow keys page through time by one screenful, snapped
to whichever calendar unit suits the current zoom — the same movement as `ts.pan(∓1)`.
Handlers are bound to the canvas, so on a page with several charts only the focused one
moves. Pass `keyboard: false` to leave the element untouched.

---

## Plugin interfaces

### Custom renderer

```js
TimeSeries.registerRenderer({
  type: 'my-type',
  draw(plot, rctx) {
    // rctx: { c, X, Y, ppms, ppv, margin, plotWidth, plotHeight }
  },
  highlight(plot, n, item, rctx) { /* optional */ }
});
```

### Custom data source

```js
TimeSeries.registerSource({
  type: 'my-source',
  init(source, callbacks) {
    // callbacks: { pushData(plotObj), requestRedraw(), getViewport() → {tmin, tmax} }
  }
});
```

---

## Source / plot object format

Each entry in `sources` is handed to the data-source plugin named by its
`source-type` key (`'artificial'` for static/pre-binned data, `'zabbix'`
for the JSON-RPC adapter, `'caldav'` for calendar events, or any plugin you
register). For the `artificial` source the object *is* the plot and is
rendered as-is:

```js
{
  'source-type': 'artificial',  // which source plugin loads it
  type: 'multibar',             // renderer: 'multibar' | 'multiline' | 'multipoint' | 'scatter' | 'quantile-bands'
  name: 'transactions',         // label shown in the legend
  interval_start: number,       // Unix seconds (left edge of the data)
  interval_end: number,         // Unix seconds (right edge)
  interval: number,             // seconds per slot
  count: number,                // number of slots
  min: number,
  max: number,                  // for multibar, the max stacked total
  data: { [slotIndex]: { [seriesId]: value } }
}
```

`data` is sparse: only slots with values need keys, and each slot is a
`{ seriesId: value }` map. Series keys are stable across slots and drive
both the stacking order and the legend.

### Point series

The shape above is a *binned* series — values pre-aggregated into fixed
`interval`-wide slots. The alternative is a **point series**, where every
data point carries its own timestamp. Set `category: 'point'` and supply
`data` as an **array** of `{ t, values }` points (`t` in Unix
milliseconds), with an optional `series` array naming and ordering the
series for the legend:

```js
{
  'source-type': 'artificial',
  type: 'scatter',                  // 'scatter' | 'multiline' | 'multipoint'
  category: 'point',
  name: 'latency samples',
  tmin: number, tmax: number,       // Unix ms — data extent
  min: number, max: number,
  series: [                         // optional; otherwise inferred from data[0]
    { id: 'a', name: 'Series A' },
    { id: 'b', name: 'Series B' },
  ],
  data: [
    { t: 1717200000000, values: { a: 12, b: 7 } },
    { t: 1717200060000, values: { a: 15, b: 9 } },
    // …
  ]
}
```

`scatter` (a filled circle per point) is **point-only**. `multiline` and
`multipoint` render either form — binned slots or `category: 'point'`
arrays. Large point series are automatically thinned for drawing by the
LTTB downsampling pass.

### Quantile bands

The `quantile-bands` renderer draws a percentile fan per series rather than a
single value: each slot's `value` is an **array of percentile values** (one
line per percentile, with the area between adjacent percentiles shaded), and
the plot carries a `percentiles` array giving the ascending percentile ladder
those entries align to. Lines connect slot centers; the band fill is most
opaque around the median and fades toward the tails. The median line is drawn
bold. Binned data only (no `category: 'point'`), and the series have no
per-bar hit target, so click/hover data callbacks do not fire for them.

```js
{
  'source-type': 'artificial',
  type: 'quantile-bands',
  name: 'latency',
  interval_start: number,
  interval_end: number,
  interval: number,
  count: number,
  min: number, max: number,           // smallest / largest percentile value
  percentiles: [5, 25, 50, 75, 95],   // ascending ladder; median is drawn bold
  // each slot's value is an array aligned to `percentiles`
  data: { [slotIndex]: { [seriesId]: [p5, p25, p50, p75, p95] } }
}
```

### Calendar spans (Gantt) and CalDAV

For data with arbitrary start/end pairs — calendar events, jobs, outages —
where bar width should mean duration rather than a slot on a shared grid, use
`category: 'span'` with the `gantt` renderer. Events are laid out into rows
either grouped by lane (`layout: 'calendar'`, one block of rows per calendar)
or greedy-packed into a single band (`layout: 'packed'`, minimizing total
rows):

```js
{
  type: 'gantt', category: 'span',
  tmin: number, tmax: number,          // Unix ms — window this block covers
  layout: 'calendar',                  // or 'packed'
  lanes: [{ id: 'work', label: 'Work', color: '#2d6a9f' }],
  data: [
    { id: 'e1', lane: 'work', start: 1717200000000, end: 1717203600000,
      label: 'Standup', location: 'Room A' },
    // …
  ],
}
```

The built-in `caldav` source fetches VEVENTs from a CalDAV server and hands
them to the `gantt` renderer as this shape, refetching only when panning
leaves the fetched (padded) window:

```js
{
  'source-type': 'caldav',
  url: 'https://dav.example.org/',
  username: 'me', password: '…',      // or 'auth-token' for bearer auth
  // calendars: [href, …],            // omit to auto-discover
  layout: 'calendar',                  // or 'packed'
  padding: 0.5,                        // extra window fetched either side
}
```

Recurring events are expanded **server-side** (`<C:expand>` in the CalDAV
REPORT) — the bundled parser deliberately does not implement RRULE. Servers
that ignore `expand` return the master event only, which still renders as a
single bar. Cross-origin servers need to allow the `PROPFIND`/`REPORT`
methods and the `Authorization` header in their CORS response, or you can set
`proxy` to front the server through a same-origin forwarder. See
`demo/caldav.html` for a working example (it falls back to parsing the static
fixtures in `demo/fixtures/` when no server is configured).

---

## Configuration

All options are passed to the constructor. Only `canvas` is required;
every other key falls back to the default shown.

```js
const ts = new TimeSeries({
  canvas:        'chart',        // REQUIRED — id of the target <canvas> element
  sources:       [],             // array of source/plot objects (see above)
  group:         undefined,      // viewport-sync group name; instances sharing it move together
  initialView:   'last24',       // navigation method to call on load, or null
  zoomDuration:  500,            // ms — animation duration for zoom transitions
  zoomFactor:    0.1,            // wheel-zoom sensitivity (smaller = finer steps)
  autoFollow:    false,          // auto-enter follow mode when "now" reaches the right edge
  yAxisFormat:   null,           // (value) => string; defaults to SI prefixes (k/M/G/T)
  yAxisLabel:    '',             // unit text drawn above the y-axis, e.g. 'txn/s'
  colors:        { … },          // palette object — see Colors & themes below
  holidays:      { … },          // holiday map — see Holidays below
  watermark:     null,           // URL string or HTMLImageElement drawn behind the chart
  watermarkWidth: 0.63,          // watermark width as a fraction of the plot width
  watermarkAlpha: 0.2,           // watermark opacity, 0 (invisible) … 1 (opaque)
});
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `canvas` | string | `"timeseries"` | `id` of the `<canvas>`. Must already be in the DOM with non-zero CSS size. |
| `sources` | array | `[]` | Source/plot objects; each needs a `source-type`. |
| `group` | string | — | Shared viewport-sync group. Equivalent to calling `ts.joinGroup(name)`. |
| `initialView` | string \| null | `'last24'` | Name of any navigation method (`today`, `thisWeek`, `lastMonth`, …). `null` leaves the default window. |
| `zoomDuration` | number (ms) | `500` | Click/`zoom()` transition length. |
| `zoomFactor` | number | `0.1` | Mouse-wheel zoom step. |
| `autoFollow` | boolean | `false` | Begin rolling automatically once the viewport's right edge reaches the present. |
| `keyboard` | boolean | `true` | Make the canvas focusable and bind arrow-key paging. |
| `yAxisFormat` | function | SI format | `(value) => string` for y-axis tick labels. |
| `yAxisLabel` | string | `''` | Unit caption above the axis. |
| `colors` | object | light theme | Full palette object (not a name) — see below. |
| `holidays` | object | German set | Fixed and Easter-relative holidays — see below. |
| `watermark` | string \| Image | `null` | Background image, behind all chart content. |
| `watermarkWidth` | number | `0.63` | Fraction of plot width. |
| `watermarkAlpha` | number | `0.2` | `0`–`1` opacity. |

### Colors & themes

`colors` is a **full palette object**, not a preset name. Four ready-made
palettes ship on `TimeSeries.themes`: `light` (the default), `dark`,
`highContrast`, and `warm`. Pass one in, or merge it at runtime:

```js
const ts = new TimeSeries({ canvas: 'chart', colors: TimeSeries.themes.dark });

// later — e.g. reacting to a prefers-color-scheme change:
ts.setColors(TimeSeries.themes.light);
```

To customise, spread a theme and override only the keys you care about:

```js
const ts = new TimeSeries({
  canvas: 'chart',
  colors: { ...TimeSeries.themes.light, nowLine: 'rgba(0,140,255,0.8)' },
});
```

Every palette key:

| Key | Meaning |
|---|---|
| `frameBg` | Margin / axis-area background |
| `text` | All text and the plot border |
| `plotBg` | Plot area background |
| `gridLine` | Vertical time grid lines |
| `gridLineY` | Horizontal y-axis lines |
| `weekNumber` | Calendar-week label colour |
| `nowLine` | The "now" indicator line |
| `future` | Fog-of-future overlay |
| `stripMs` / `stripSecond` / `stripMinute` / `stripHour` | `[odd, even]` alternating stripes per time unit |
| `dayDefault` / `dayWeekend` / `dayOdd` | Weekday / weekend+holiday / alternate-day stripes |
| `yearOdd` / `yearEven` | Alternating year stripes |
| `monthOdd` / `monthEven` | Alternating month stripes |

### Holidays

The time axis paints holidays with the weekend stripe colour and shows the
holiday name when there's room. `holidays` is a flat map of **date key →
display name**. Two key forms are supported:

- **Fixed dates** — `"day.month"` (day first, the German convention).
  **Always quote the key.** An unquoted `3.10` is the *number* `3.1`, which
  reads back as 3 January — the October date is lost silently, with no error.
  The same applies to any month ending in a zero. The built-in German set
  quotes every key for this reason.
- **Easter-relative dates** — a string offset in days from Easter Sunday,
  prefixed with `+` or `-`. Easter itself is `"+0"`. The date is computed
  per displayed year (Gauss/Butcher computus), so these track the moving
  feast automatically.

```js
const ts = new TimeSeries({
  canvas: 'chart',
  holidays: {
    // fixed (day.month)
    '1.1':   "New Year's Day",
    '4.7':   'Independence Day',
    '25.12': 'Christmas Day',
    '1.10':  'Quoted — October needs quotes',   // NOT 1.10 the number (= 1.1)

    // Easter-relative (days from Easter Sunday)
    '-2':  'Good Friday',
    '+0':  'Easter Sunday',
    '+1':  'Easter Monday',
    '+39': 'Ascension',
    '+49': 'Pentecost',
  },
});
```

Pass `holidays: {}` to disable holiday highlighting entirely. (Weekends are
always stripe-highlighted via `dayWeekend`, independent of this map.)

### Mobile support

- Full-screen layout
- Disabled page zoom
- Touch-locked in follow mode

---

## License

MIT — see [LICENSE](LICENSE).
