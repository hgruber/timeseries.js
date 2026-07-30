# Recipes

Copy-paste examples, one per task. Each assumes the library is loaded and a sized canvas
exists:

```html
<canvas id="chart" style="width:100%;height:360px"></canvas>
<script src="https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.9/dist/timeseries.min.js"></script>
```

- [Stacked bars from an array](#stacked-bars-from-an-array-of-rows)
- [A line chart from irregular samples](#a-line-chart-from-irregular-samples)
- [Latency percentiles](#latency-percentiles)
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
| `demo/index.html` | Stacked bars, butterfly, lines, points, scatter, the resolution cross-fade, follow mode, the legend |
| `demo/caldav.html` | Spans and the `gantt` renderer, against static fixtures — no server needed |
| `demo/zabbix.html` | The real `zabbix` source against a synthetic API — no server needed |
| `demo/caldav-live.html` | A real CalDAV server, with a connect form |
| `demo/zabbix-live.html` | A real Zabbix server, with a connect form |
