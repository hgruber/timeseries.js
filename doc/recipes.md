# Recipes

Copy-paste examples, one per task. Each assumes the library is loaded and a sized canvas
exists:

```html
<canvas id="chart" style="width:100%;height:360px"></canvas>
<script src="https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.10/dist/timeseries.min.js"></script>
```

- [Stacked bars from an array](#stacked-bars-from-an-array-of-rows)
- [The same stack as filled areas](#the-same-stack-as-filled-areas)
- [A line chart from irregular samples](#a-line-chart-from-irregular-samples)
- [Latency percentiles](#latency-percentiles)
- [Candlesticks from OHLC data](#candlesticks-from-ohlc-data)
- [A running total (waterfall)](#a-running-total-broken-into-its-contributions)
- [Many series, one row each (heatmap)](#many-series-one-row-each)
- [The same rows folded into bands (horizon)](#the-same-rows-folded-into-bands)
- [Calendar events / job runs](#calendar-events-or-job-runs)
- [Two synced charts](#two-synced-charts)
- [Live tail](#live-tail-follow-mode)
- [Dark mode that follows the OS](#dark-mode-that-follows-the-os)
- [Fetch from your own API](#fetch-from-your-own-api)
- [Click a bar to drill down](#click-a-bar-to-drill-down)
- [Custom tooltip content](#custom-tooltip-content)
- [Two resolutions of one signal](#two-resolutions-of-one-signal)
- [Export the visible window](#export-the-visible-window)

---

## Stacked bars from an array of rows

The most common starting point: you have rows, you want bars.

```js
// rows: [{ ts: 1717200000, ok: 91, error: 7 }, …]  — ts in Unix seconds, hourly
const INTERVAL = 3600;
const t0 = rows[0].ts;

const data = {};
rows.forEach(r => {
  data[(r.ts - t0) / INTERVAL] = { ok: r.ok, error: r.error };
});

const max = Math.max(...rows.map(r => r.ok + r.error));

const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'today',
  yAxisLabel: 'requests',
  sources: [{
    'source-type': 'artificial',
    type: 'multibar',
    name: 'requests',
    interval_start: t0,
    interval_end: t0 + rows.length * INTERVAL,
    interval: INTERVAL,
    count: rows.length,
    min: 0, max,
    data,
    series_colors: { ok: '#3d9970', error: '#c0392b' },
  }],
});

TimeSeries.attachTooltip(ts);
TimeSeries.attachLegend(ts);
```

## The same stack as filled areas

`stackarea` takes the identical block — only the `type` changes. Bars read as
discrete counts per bin; a stacked area reads as a composition changing over
time, which is the better picture once the bars get narrow enough to touch.

```js
// Same `data`, `t0` and `max` as above.
const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'today',
  yAxisLabel: 'requests',
  sources: [{
    'source-type': 'artificial',
    type: 'stackarea',
    name: 'requests',
    step: 'after',            // optional: hold each value across its own bin
    interval_start: t0,
    interval_end: t0 + rows.length * INTERVAL,
    interval: INTERVAL,
    count: rows.length,
    min: 0, max,
    data,
    series_colors: { ok: '#3d9970', error: '#c0392b' },
  }],
});

TimeSeries.attachLegend(ts);
```

Two things it does that `multiline` with `fill: true` does not: the bands sit on
the running total rather than overlapping each other, and the y-axis is measured
from the stacked total. Hiding a series through the legend closes the stack up
instead of leaving a hole. Leave `step` out for straight interpolation between
bin centres.

## A line chart from irregular samples

No fixed grid — every sample carries its own timestamp.

```js
// samples: [{ t: 1717200000000, cpu: 12.4, mem: 61.0 }, …]  — t in Unix MILLISECONDS
const values = samples.flatMap(s => [s.cpu, s.mem]);

const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'last24',
  yAxisLabel: '%',
  sources: [{
    'source-type': 'artificial',
    type: 'multiline',
    category: 'point',
    name: 'host-01',
    tmin: samples[0].t,
    tmax: samples[samples.length - 1].t,
    min: Math.min(...values),
    max: Math.max(...values),
    series: [{ id: 'cpu', name: 'CPU' }, { id: 'mem', name: 'Memory' }],
    data: samples.map(s => ({ t: s.t, values: { cpu: s.cpu, mem: s.mem } })),
  }],
});
```

Swap `type` for `'scatter'` to get markers without lines. Large arrays are downsampled for
drawing automatically.

## Latency percentiles

```js
// buckets: [{ ts, p50, p90, p99 }, …] — ts in Unix seconds, per minute
const data = {};
buckets.forEach((b, i) => { data[i] = { api: [b.p50, b.p90, b.p99] }; });

const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'last24',
  yAxisLabel: 'ms',
  sources: [{
    'source-type': 'artificial',
    type: 'quantile-bands',
    name: 'API latency',
    percentiles: [50, 90, 99],          // ascending; the median is drawn bold
    interval_start: buckets[0].ts,
    interval_end: buckets[0].ts + buckets.length * 60,
    interval: 60,
    count: buckets.length,
    min: 0,
    max: Math.max(...buckets.map(b => b.p99)),
    data,
  }],
});
```

`quantile-bands` draws a straight line from one bucket's p50 to the next one's — through a
minute in which nothing was measured. If that reads as a claim you would rather not make,
swap one word:

```js
type: 'quantile-steps',   // each percentile flat across its own minute, no interpolation
```

Same block, same ladder, same bold median — only now every value is drawn over the interval
it was actually measured in. `connect: false` also drops the vertical risers between
buckets. `'error-bars'` and `'candlestick'` read the very same block as a marker-and-whisker
or a box-and-wick per bucket; see
[Ladder blocks](data-formats.md#ladder-blocks-percentiles-minavgmax).

## Candlesticks from OHLC data

```js
// bars: [{ ts, open, high, low, close }, …] — ts in Unix seconds, hourly
const data = {};
bars.forEach((b, i) => { data[i] = { eurusd: [b.open, b.high, b.low, b.close] }; });

const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'lastWeek',
  sources: [{
    'source-type': 'artificial',
    type: 'candlestick',
    name: 'EUR/USD',
    // `roles` names which array index is which, which is what gives the block a
    // direction: rising bars are drawn hollow, falling ones filled.
    percentiles: ['open', 'high', 'low', 'close'],
    roles: { open: 0, high: 1, low: 2, close: 3 },
    interval_start: bars[0].ts,
    interval_end: bars[0].ts + bars.length * 3600,
    interval: 3600,
    count: bars.length,
    min: Math.min(...bars.map(b => b.low)),
    max: Math.max(...bars.map(b => b.high)),
    data,
  }],
});
```

Without `roles` the same renderer reads the array as an ascending ladder instead and draws a
box plot — outermost pair as the wick, next pair in as the body.

## A running total broken into its contributions

`waterfall` takes **deltas**, not levels: each bar is drawn between the running
total before its value and after it, so the chart shows both the steps and where
they arrive.

```js
// steps: [{ label: 'Opening', delta: 1200 }, { label: 'Sales', delta: 430 }, …]
// One slot per step, on a daily grid so each bar owns a readable bin.
const DAY = 86400;
const t0 = Math.floor(Date.now() / 1000 / DAY) * DAY - steps.length * DAY;

const data = {};
steps.forEach((s, i) => { data[i] = { budget: s.delta }; });

// Slots that restate the sum from zero instead of adding to it. They consume no
// value of their own, so the running total passes straight through them.
const totals = steps
  .map((s, i) => (s.total ? i : -1))
  .filter(i => i >= 0);

const ts = new TimeSeries({
  canvas: 'chart',
  yAxisLabel: '€',
  // A waterfall is as wide as it has steps, so the window is computed rather
  // than named. Passing it as an array is synchronous — the constructor paints
  // this window on the first frame, no second zoom() needed.
  initialView: [t0 * 1000, (t0 + steps.length * DAY) * 1000],
  sources: [{
    'source-type': 'artificial',
    type: 'waterfall',
    name: 'budget',
    interval_start: t0,
    interval_end: t0 + steps.length * DAY,
    interval: DAY,
    count: steps.length,
    min: 0,
    max: steps.reduce((a, s) => a + Math.max(0, s.delta), 0),
    data,
    totals,
    waterfallColors: { up: '#3d9970', down: '#c0392b', total: '#34495e' },
    // connect: false,        // drops the leader lines between bars
  }],
});
```

The axis follows the **running total**, not the largest single step: twelve steps
of +10 reach 120 and the axis says so. The total accumulates from the block's
first slot and never from the left edge of the viewport, so panning does not move
the bars. Hover returns the raw delta, not the level the bar happens to sit at.

## Many series, one row each

`heatmap` puts every series on its own row and shows the value as colour — the
shape to reach for when twenty signals would be twenty unreadable overlapping
lines.

```js
// readings: [{ ts, sensors: { 'rack-a': 21.4, 'rack-b': 24.9, … } }, …]
const INTERVAL = 300;
const t0 = readings[0].ts;

const data = {};
readings.forEach(r => { data[(r.ts - t0) / INTERVAL] = r.sensors; });
const all = readings.flatMap(r => Object.values(r.sensors));

const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'today',
  sources: [{
    'source-type': 'artificial',
    type: 'heatmap',
    name: 'rack temperatures',
    interval_start: t0,
    interval_end: t0 + readings.length * INTERVAL,
    interval: INTERVAL,
    count: readings.length,
    min: Math.min(...all), max: Math.max(...all),
    data,
    // Fixes the row order and the axis labels. Without it, rows follow the
    // series order and are labelled by series id.
    lanes: [{ id: 'rack-a', label: 'Rack A' }, { id: 'rack-b', label: 'Rack B' }],
    vmin: 18, vmax: 30,        // pin the colour range — see below
  }],
});
```

Without `colorScale`, each cell is its **own series colour** at an intensity that
follows the value: that re-themes for free and keeps two rows apart at a glance.
Pass hex stops to override it with one sequential ramp:

```js
colorScale: ['#f7fbff', '#6baed6', '#08306b'],
```

**Set `vmin`/`vmax` whenever two charts have to be comparable.** Without them the
range is measured over the block, so the same temperature reads as two different
colours in two charts — or in one chart after new data arrives. The range is
measured over the whole block and not the viewport, so panning never recolours a
cell that is already on screen.

Hiding a row through the legend blanks it but keeps it in place: closing the row
up would relabel every lane below it and move the axis under the pointer.

## The same rows folded into bands

`horizon` reads exactly the block above. Instead of colouring the row it folds
the value into a few stacked slices, so a row a fraction of the height still
shows its shape — useful when the rows have to fit into a small chart.

```js
// Same block as the heatmap, two fields different:
type: 'horizon',
horizonBands: 3,             // slices the value is folded into
horizonNegative: '#c0392b',  // negatives mirror from the band's top edge
```

`vmin`/`vmax` pin the fold range the same way they pin the colour range, and both
renderers share the lane layout — so the two are interchangeable on one block and
a toggle between them costs a `type` swap and a `redraw()`.

## Calendar events or job runs

```js
// jobs: [{ name, queue, startedAt, finishedAt, failed }, …] — Date objects
const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'today',
  sources: [{
    'source-type': 'artificial',
    type: 'gantt',
    category: 'span',
    tmin: +new Date().setHours(0, 0, 0, 0),
    tmax: +new Date().setHours(24, 0, 0, 0),
    layout: 'calendar',                       // 'packed' to compact into one band
    lanes: [
      { id: 'etl',     label: 'ETL',     color: '#2d6a9f' },
      { id: 'reports', label: 'Reports', color: '#7fbf3f' },
    ],
    data: jobs.map((j, i) => ({
      id: 'job-' + i,
      lane: j.queue,
      start: +j.startedAt,
      end: +j.finishedAt,
      label: j.name,
      group: j.name,                          // keep repeats of one job on one row
      color: j.failed ? '#c0392b' : undefined,
    })),
  }],
});

TimeSeries.attachTooltip(ts);
```

## Two synced charts

Instances sharing a `group` pan, zoom and follow together.

```html
<canvas id="top"    style="width:100%;height:260px"></canvas>
<canvas id="bottom" style="width:100%;height:200px"></canvas>
```

```js
const top    = new TimeSeries({ canvas: 'top',    group: 'dash', sources: [metrics] });
const bottom = new TimeSeries({ canvas: 'bottom', group: 'dash', sources: [events]  });
```

Join and leave at runtime with `ts.joinGroup('dash')` / `ts.leaveGroup()`.

## Live tail (follow mode)

```js
const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'last24',
  autoFollow: true,          // start rolling once "now" reaches the right edge
  sources: [live],
});

ts.follow(0);                // or start immediately: 0 = now sits at the right edge
ts.onFollow(pct => statusEl.textContent = `live (${pct}%)`);
ts.onStop(()    => statusEl.textContent = 'paused');
```

The chart scrolls itself; your source keeps pushing. Any drag or zoom stops following.

## Dark mode that follows the OS

```js
const mq = matchMedia('(prefers-color-scheme: dark)');
const apply = () => ts.setColors(mq.matches ? TimeSeries.themes.dark : TimeSeries.themes.light);
mq.addEventListener('change', apply);
apply();
```

`setColors` fires `onColorsChange`, so an attached tooltip and legend re-theme themselves.

## Fetch from your own API

Register a source once; it then refetches on every pan and zoom.

```js
TimeSeries.registerSource({
  type: 'my-api',
  init(source, cb) {
    let id = null, seq = 0;

    async function load() {
      const { tmin, tmax } = cb.getViewport();
      const mine = ++seq;
      const pad = (tmax - tmin) * 0.5;      // fetch ±50% so small pans need no request

      const rows = await fetch(
        `${source.url}?from=${Math.floor((tmin - pad) / 1000)}&to=${Math.ceil((tmax + pad) / 1000)}`
      ).then(r => r.json());

      if (mine !== seq) return;             // a newer request overtook this one

      const plot = {
        type: 'multiline', category: 'point', name: source.name,
        tmin: tmin - pad, tmax: tmax + pad,
        min: Math.min(...rows.map(r => r.v)),
        max: Math.max(...rows.map(r => r.v)),
        data: rows.map(r => ({ t: r.ts * 1000, values: { [source.metric]: r.v } })),
      };

      id = (id === null) ? cb.pushData(plot) : cb.replaceData(id, plot);
      cb.requestRedraw();
    }

    load();
    cb.onViewportChange(load);
  },
});

const ts = new TimeSeries({
  canvas: 'chart',
  sources: [{ 'source-type': 'my-api', url: '/api/metrics', metric: 'cpu', name: 'CPU' }],
});
```

Full contract and the rules that matter: [Plugins](plugins.md#custom-data-source).

## Click a bar to drill down

```js
ts.onClickDataCallback((plot, slot, item) => {
  const from = (plot.interval_start + slot * plot.interval) * 1000;
  const to   = from + plot.interval * 1000;
  location.href = `/logs?from=${from}&to=${to}`;
});
```

## Custom tooltip content

Extend the default rather than replacing it:

```js
TimeSeries.attachTooltip(ts, {
  labelFor: (key) => SERIES_NAMES[key] || key,
  valueFormat: v => v.toLocaleString() + ' req',
  formatter(ctx) {
    const nodes = [ctx.defaultContent()];
    if (ctx.value > 1000) {
      const warn = document.createElement('div');
      warn.textContent = '⚠ above threshold';
      warn.style.color = ctx.colors.tooltipMuted;
      nodes.push(warn);
    }
    return nodes;
  },
});
```

## Two resolutions of one signal

Push both; the chart cross-fades between them as you zoom.

```js
const fine = {
  'source-type': 'artificial', type: 'multibar', extensive: true,
  interval_start: t0, interval_end: t0 + 86400,
  interval: 60, count: 1440, min: 0, max: 40, data: minuteData,
};

const coarse = Object.assign(
  { 'source-type': 'artificial', extensive: true },   // rollupBinned does not carry `extensive`
  TimeSeries.rollupBinned(fine, 3600, { agg: 'sum' })
);

const ts = new TimeSeries({ canvas: 'chart', initialView: 'today', sources: [coarse, fine] });
ts.setRateUnit(60, { label: 'events/min' });   // keeps both tiers at the same bar height
```

Details and the trade-offs: [Resolution tiers](tiers.md).

## Export the visible window

```js
function exportCSV() {
  const { tmin, tmax } = ts.getViewport();
  const lines = ['time,series,value'];

  for (const plot of ts.getActiveData()) {
    if (plot.category) continue;                        // binned blocks only
    for (const [slot, values] of Object.entries(plot.data)) {
      const t = (plot.interval_start + slot * plot.interval) * 1000;
      if (t < tmin || t > tmax) continue;
      for (const [id, v] of Object.entries(values)) {
        lines.push(`${new Date(t).toISOString()},${id},${v}`);
      }
    }
  }

  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  Object.assign(document.createElement('a'), { href: url, download: 'export.csv' }).click();
  URL.revokeObjectURL(url);
}
```

---

## Runnable demos

Every one of these patterns is live in the [demo pages](../demo), which run from a checkout
with `npm run build && npm run serve`:

| Page | Shows |
|---|---|
| `demo/index.html` | All nineteen cards of the type grid: stacked bars, butterfly, lines (plain, stepped, filled), stacked areas, points, scatter, the five ladder types, `waterfall`, `heatmap` and `horizon` — plus the resolution cross-fade, follow mode and the legend |
| `demo/caldav.html` | Spans and the `gantt` renderer, against static fixtures — no server needed |
| `demo/zabbix.html` | The real `zabbix` source against a synthetic API — no server needed |
| `demo/caldav-live.html` | A real CalDAV server, with a connect form |
| `demo/zabbix-live.html` | A real Zabbix server, with a connect form |
