# API reference

Everything on a `TimeSeries` instance and on the constructor itself, grouped by what you
are trying to do.

- [Navigation](#navigation) · [Follow mode](#follow-rolling-mode) · [Viewport sync](#viewport-sync-groups)
- [Data](#data) · [Introspection](#introspection) · [Series visibility](#series-visibility)
- [Appearance](#appearance) · [Events](#events) · [Resolution tiers](#resolution-tiers)
- [Statics](#statics-on-the-constructor) · [Module exports](#module-exports)

---

## Navigation

Any of these method names is also a valid `initialView` value. `initialView` additionally accepts a `[tmin, tmax]` window in ms (Date objects are accepted too), which is applied synchronously — before the first paint — for the case where the host has computed the start window itself and wants it on screen without the brief flash of the default window. The follow state is a separate concern: see [Follow mode](#follow-rolling-mode) and the `follow` option in [Configuration](configuration.md).

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
ts.zoomMonth(year, month);         // month is 0–11, as Date takes it
ts.zoomYear(year);
ts.zoomDayAt(t);                   // the calendar unit containing the moment t —
ts.zoomWeekAt(t);                  // the timestamp counterparts to the three above,
ts.zoomMonthAt(t);                 // for a caller holding a moment rather than
ts.zoomYearAt(t);                  // calendar numbers. Local boundaries throughout.
ts.pan(dir, opts);                 // one screenful; dir < 0 back, > 0 forward
                                   // opts: { cells: n } move n grid cells instead of a page
                                   //       { snap: false } move by the exact width, unsnapped
ts.zoomStep(dir, opts);            // dir > 0 in, < 0 out; halves/doubles the window
                                   // opts: { cells: n } change the cell count by n instead
ts.snapView();                     // align the window to the grid without moving it on
ts.setPanSnap(mode);               // 'grid' (default) | 'off'
ts.getPanSnap();
ts.togglePanSnap();                // flip between the two; returns the mode now in force
ts.getSnapGrid();                  // { unit, mult, k, tmin, tmax } currently in force
```

`pan()` and `zoomStep()` move in whole cells of the **coarsest x-axis level that is currently
labelled and fits the window**, so they land on readable boundaries at any zoom: 18:55–20:04
pages to 20:00–21:00, a six-hour window pages six full hours on without changing width, a
month-wide viewport lands on month boundaries rather than drifting by 30 days, and a 23-hour
DST day still pans to local midnight.

The `…At(t)` four resolve their boundaries in **local** time, so a day spanning a
daylight-saving change comes out 23 or 25 hours long rather than a wrong 24, and a week runs
Monday to Monday. `zoomWeekAt()` is not `zoomWeek()` with a week number worked out for you:
the ISO week-numbering year is not the calendar year around new year — 31 December 2025 sits
in week 1 of 2026 — and walking back to the Monday sidesteps that entirely.

The grid is attached once — rounding the window onto whole cells by at most 20 % of its width
— and then held, so repeated paging is exact and never drifts. Wheel, drag and pinch are never
snapped and release it; the next call attaches a fresh one. `panSnap: 'off'` (or
`{ snap: false }` for a single call) skips all of it and moves by the exact current width.
See [Keyboard](configuration.md#keyboard) for the key bindings that drive this.

## Follow (rolling) mode

The chart tracks "now" like a seismograph, scrolling the window as time passes.

```js
ts.follow(fraction);   // start; fraction 0–100 = where "now" sits, 0 = left edge … 100 = right
ts.followNow();        // animate to "now" at the right edge, then roll — the window looks back
ts.previewNow();       // animate to "now" at the left edge, then roll — the window looks ahead
ts.centerNow();        // animate to "now" in the middle, then roll — half back, half ahead
ts.followNowStretch(); // as followNow(), but the left edge stays put and the window stretches
ts.previewNowStretch();// as previewNow(), but the right edge stays put
ts.stop();             // leave follow mode, keeping the window where it is
ts.onFollow(fn);       // called when follow mode (re)starts, with the percentage
ts.onStop(fn);         // called when follow mode stops
```

Every one of them ends in the same rolling state — the width is held and the window slides
to keep "now" at the fraction — so they differ only in how they get there. `follow()` snaps
in one frame; the rest animate over `zoomDuration`. `followNow()`, `previewNow()` and
`centerNow()` are the same call at three points of the fraction and keep the current window
**width**, moving it onto now.

The two `…Stretch()` variants are the exception: instead of sliding the window they pin the
far edge — the left for `followNowStretch()`, the right for `previewNowStretch()` — and run
the other one out to now, so the width becomes "from where I was looking, up to the present"
(or from the present up to where I was looking). Once there they roll like their plain
counterparts, held edge travelling along; the pinning is the target of the animation, not a
lasting constraint. A window lying entirely on the wrong side of now has no span to stretch
to, and the call falls back to the plain one.

All of them end up rolling, so use `stop()` if you want the viewport moved without entering
follow mode.

The constructor option `follow` is the explicit start-state equivalent: `true` rolls,
keeping "now" where it sits in the start window (so an explicit `initialView: [tmin, tmax]`
is preserved instead of snapping back onto now); `false` stops; a number sets the fraction
directly. It is applied **after** `initialView`, so `onStop` and `onFollow` fire for the
start state — a follow toggle can be wired straight to those callbacks and stay correct
without a manual `ts.stop()` after construction. Set `autoFollow: true` instead if you want
follow to begin only once the right edge has reached the present.

Every navigation method (`today()`, `zoom()`, a pan, …) leaves follow mode on its own, so
`stop()` is only needed when a UI of your own has to leave the rolling state without moving
the viewport. `onStop` is what keeps a follow toggle in step with both paths.

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
ts.setLegend(ctrl);    // register a legend the `l` key can flip — any { toggle() }
ts.getLegend();        // the registered controller, or null
ts.toggleLegend();     // flip it; inert when nothing is registered
ts.getColors();        // the current palette (a copy)
ts.getHolidays();      // the current holiday map (a copy)
ts.getRateUnit();      // the current rate unit, or null
```

`attachLegend()` calls `setLegend()` itself, so the `l` key works as soon as the shipped
legend is attached — see [Overlays → Controller](overlays.md#controller-1). The slot exists
so the keyboard has something to reach; a host with its own panel can take it instead.

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

TimeSeries.ladderPairs(n);        // { centre, pairs } — how the ladder renderers read
                                  //   plot.percentiles; see doc/data-formats.md
TimeSeries.isBandedType(type);    // does this plot type store an array per slot?
TimeSeries.isStackedType(type);   // does this plot type sum its series per slot?
TimeSeries.isCumulativeType(type);// does this plot type draw a running total?
TimeSeries.waterfallLevels(plot); // {slot: {series: {base, top, total}}} — the levels
                                  // the waterfall renderer, axis and hit test share
TimeSeries.isLanedType(type);     // does this plot type use a categorical y-axis?

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
  panFloor,      // (ms, unit) → ms, floored to that unit's boundary
  panAdd,        // (ms, unit, n) → ms, n units later (DST-safe)
  panDiff,       // (lo, hi, unit) → whole units between
  floorToGrid,   // (ms, unit, mult) → ms, floored to a boundary of `mult` units
  addGrid,       // (ms, unit, mult, n) → ms, n cells later (DST-safe)
  gridCell,      // (ms, unit, mult) → length of one cell there, on the calendar
  nearestGrid,   // (ms, unit, mult) → ms, rounded to the nearest cell boundary
  pickGridLevel, // (levels, tmin, span[, tol]) → { unit, mult, k, lo, hi }
  GRID_TOLERANCE,// 0.2 — how far attaching a grid may round a window
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
