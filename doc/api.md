# API reference

Everything on a `TimeSeries` instance and on the constructor itself, grouped by what you
are trying to do.

- [Navigation](#navigation) · [Follow mode](#follow-rolling-mode) · [Viewport sync](#viewport-sync-groups)
- [Data](#data) · [Introspection](#introspection) · [Series visibility](#series-visibility)
- [Appearance](#appearance) · [Events](#events) · [Resolution tiers](#resolution-tiers)
- [Statics](#statics-on-the-constructor) · [Module exports](#module-exports)

---

## Navigation

Any of these method names is also a valid `initialView` value.

```js
ts.today()       ts.yesterday()   ts.tomorrow()
ts.thisWeek()    ts.lastWeek()    ts.nextWeek()
ts.thisMonth()   ts.lastMonth()   ts.nextMonth()
ts.thisYear()    ts.lastYear()    ts.nextYear()
ts.last24()      ts.next24()
```

```js
ts.zoom(tmin, tmax, animationMs);  // explicit window; tmin/tmax in Unix MILLISECONDS
                                   // animationMs: omit for the configured zoomDuration, 0 = jump
ts.zoomWeek(year, week);           // ISO 8601 week number
ts.zoomMonth(year, month);         // month is 1–12
ts.zoomYear(year);
ts.pan(dir);                       // one screenful; dir < 0 back, > 0 forward
```

`pan()` is calendar-aware: it snaps to whichever unit fits the current zoom, so paging a
month-wide viewport lands on month boundaries rather than drifting by 30 days, and a
23-hour DST day still pans to local midnight.

## Follow (rolling) mode

The chart tracks "now" like a seismograph, scrolling the window as time passes.

```js
ts.follow(fraction);   // start; fraction 0–100 = where "now" sits, 0 = right edge … 100 = left
ts.previewNow();       // jump to now without locking into follow mode
ts.onFollow(fn);       // called when follow mode (re)starts, with the percentage
ts.onStop(fn);         // called when follow mode stops
```

Set `autoFollow: true` in the constructor to enter follow mode automatically once the
viewport's right edge reaches the present.

## Viewport sync groups

Instances in the same group pan, zoom and follow together. Set `group` in the constructor,
or join and leave at runtime:

```js
ts.joinGroup('dashboard');
ts.leaveGroup();
```

Within a group one instance is elected to drive the clock in follow mode. The election runs
once, when following starts, and the widest visible canvas wins — a chart in a hidden
container reports zero width and stays out of it.

## Data

```js
ts.clearAll();                 // drop every dataset
ts.dropData(plot => …);        // remove datasets matching a predicate
ts.redraw();                   // force a repaint — e.g. after mutating a pushed plot in place
```

To *add* data, either pass it in `sources` at construction or push it from a
[source plugin](plugins.md#custom-data-source). There is no public `pushData` on the
instance: a plot's id is its slot in the internal array, and sources hold those ids across
updates.

## Introspection

```js
ts.getData();          // every loaded plot object
ts.getActiveData();    // only those intersecting the current viewport
ts.getViewport();      // { tmin, tmax, ppms }        — time window, Unix ms; ppms = px per ms
ts.getValueRange();    // { ymin, ymax }              — the value range the y-axis spans
ts.getRenderBounds();  // { tmin, tmax }              — the time range at the plot's pixel edges
ts.getPlotArea();      // { margin, plotWidth, plotHeight }
ts.getCanvas();        // the <canvas> element
ts.getColors();        // the current palette (a copy)
ts.getHolidays();      // the current holiday map (a copy)
ts.getRateUnit();      // the current rate unit, or null
```

`getValueRange()` reflects hidden series and any tier cross-fade in progress, so it is what
is *actually* on the axis, not what the data would suggest.

`getViewport().ppms` is the pixel-per-millisecond scale — the number a data source uses to
decide which resolution to fetch.

## Series visibility

The core never builds DOM for a legend; it exposes the data so you can build one — or use
the shipped [`attachLegend`](overlays.md#legend).

```js
ts.getSeries();
// → [{ id: 'cpu', label: 'cpu', color: 'hsla(…)', hidden: false }, … ]

ts.setSeriesHidden('cpu', true);
ts.toggleSeries('cpu');
ts.showAllSeries();

const off = ts.onSeriesChange(() => renderLegend());   // returns an unsubscribe
```

`color` is exactly what was painted, including any `series_colors` override, so a swatch
always matches the chart.

Hiding is **by series id across every plot** in the instance — an id names the same
measurement in every block a source pushes, and hiding it in one block only would flicker as
blocks scroll past. A hidden series also drops out of the y-axis extent, so hiding the
tallest one rescales the axis to what is left.

> `onSeriesChange` fires when the *hidden set* changes, **not** when incoming data
> introduces a new series. Call `getSeries()` again after data arrives if that matters —
> the legend controller's `refresh()` does exactly this.

## Appearance

```js
ts.setColors(TimeSeries.themes.dark);   // merges key-by-key with the current palette, then redraws
ts.setYAxisLabel('req/s');
ts.setWatermark(urlOrImage);            // string URL or HTMLImageElement; null clears
```

`setColors` merges, so a partial object overrides only the keys it names. It also fires
`onColorsChange`, which is how the tooltip and legend restyle themselves on a theme switch.

See [Configuration → Colours and themes](configuration.md#colours-and-themes) for the palette keys.

## Events

```js
ts.onClickDataCallback((plot, slot, item) => { … });

// Hover SUBSCRIBES rather than replaces, and returns an unsubscribe.
// All arguments arrive null when nothing is hit — that is the "hide" signal.
const off = ts.onHoverDataCallback((plot, slot, key, value) => { … });
off();

ts.onColorsChange(fn);    // after setColors — DOM overlays restyle here
ts.onSeriesChange(fn);    // after a visibility change; returns an unsubscribe
ts.onFollow(fn);          // follow mode started
ts.onStop(fn);            // follow mode stopped
```

`onHoverDataCallback` and `onSeriesChange` are multi-subscriber, so attaching the shipped
tooltip or legend never displaces a handler of your own.

## Resolution tiers

Two blocks of the same `type` differing only in `interval` are treated as resolution tiers
of one signal, and dissolved into each other as you zoom. Full explanation in
[Resolution tiers](tiers.md).

```js
ts.setRenderInterval(iv);      // pin one tier by its `interval` (SECONDS); null re-enables the cross-fade
ts.setFadeBand(hi, lo);        // move the switch point / dissolve band, in px of bar width (default 2, 1)
ts.setRateUnit(seconds, opts); // draw `extensive` blocks per N seconds instead of per bin
ts.getRateUnit();
```

```js
ts.setRateUnit(1, { label: 'req/s', transition: 400 });   // per-second axis, dissolve the unit swap
ts.setRateUnit(null);                                     // back to per-bin values
```

## Partial bins

A block may carry `data_until` (Unix seconds): its data reaches only that far, so the bin
holding that point is incomplete. Drawn at full width such a bar is both too short — it
holds a fraction of a bin's worth — and too long, reaching into a span that holds no data.

```js
ts.setPartialBins('scale');   // 'full' (default) | 'clip' | 'scale'
ts.getPartialBins();
```

| Mode | Effect |
|---|---|
| `'full'` | Ignore `data_until`; the bin is drawn full width. What every version before 0.9.1 did. |
| `'clip'` | The bar's right edge lands on `data_until`. The height stays the raw value. |
| `'scale'` | Clip, and divide the height by the filled fraction, so the bar's **area** equals the value it holds and its density matches the full bins beside it. |

`'scale'` applies only to blocks marked [`extensive`](data-formats.md); an average or a
percentile is already per-unit and falls back to `'clip'`. A bin filled to less than 10 % is
left out entirely — of the drawing, of the y-axis extent and of hit-testing — because
below that the extrapolation is noise. Tooltips and drill-down keep reporting the **raw**
value in the bin, never the extrapolated one.

The resolved geometry is readable as `_partial` on the blocks from `getActiveData()`, in
case an overlay wants to annotate the bar. Treat it as read-only render state, like `_fade`
and `_vscale`: it is recomputed every frame.

## Statics on the constructor

```js
TimeSeries.attachTooltip(ts, opts);   // → controller — see doc/overlays.md
TimeSeries.attachLegend(ts, opts);    // → controller — see doc/overlays.md

TimeSeries.registerRenderer(plugin);  // see doc/plugins.md
TimeSeries.registerSource(plugin);

TimeSeries.rollupBinned(plot, coarseInterval, { agg });  // derive a coarser tier — see doc/tiers.md
TimeSeries.lttb(points, threshold, seriesId);            // downsample a point array
TimeSeries.resolveColor(plot, seriesId, alpha);          // the colour a series is painted in
TimeSeries.seriesColor(index, alpha);                    // the automatic palette, by ordinal
TimeSeries.siFormat(value);                              // 1234 → '1.2k'

TimeSeries.themes;    // { light, dark, highContrast, warm }
TimeSeries.VERSION;   // '0.9.0'
TimeSeries.BUILD;     // '' for a release, otherwise a commit hash or 'dev'
```

## Module exports

Importing from `src/` (npm, or a bundler) also gives you the pure date and format helpers,
usable without constructing a chart:

```js
import TimeSeries, {
  Easter,        // (year) → Date of Easter Sunday, Gauss/Butcher computus
  isoWeekStart,  // (year, week) → Date of that ISO week's Monday
  siFormat,      // (value) → '1.2k'
  panSnapUnit,   // (tmin, tmax) → 'hour' | 'day' | 'week' | 'month' | 'year'
  panFloor,      // (ms, unit) → ms, floored to that unit's boundary
  panAdd,        // (ms, unit, n) → ms, n units later (DST-safe)
  panDiff,       // (lo, hi, unit) → whole units between
  panSnapEdge,   // (ms, unit, roundUpIfAmbiguous) → ms, snapped within PAN_TOLERANCE
  PAN_TOLERANCE, // 0.05
} from '@hgruber/timeseries.js';
```

The standalone clients are importable on their own paths, and neither touches the chart:

```js
import jpZabbix from '@hgruber/timeseries.js/src/jpZabbix.js';   // Promise-based JSON-RPC client
import CalDAV, { parseICS } from '@hgruber/timeseries.js/src/caldav.js';
```

## Not in the API

- **There is no `destroy()`.** A canvas hosts one chart for the lifetime of the page; a
  second `new TimeSeries` on it warns and returns a half-built object. Rebuild by reloading.
- **There is no public `pushData`.** Data enters through a [source](plugins.md#custom-data-source).
