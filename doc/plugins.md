# Plugins

Two extension points, both registered before you construct a chart. Neither requires
touching library code.

```js
TimeSeries.registerRenderer(plugin);   // draw a new plot type
TimeSeries.registerSource(plugin);     // fetch data from somewhere new
```

Both are also named exports when importing from `src/`, for use inside modules.

---

## Custom renderer

```js
TimeSeries.registerRenderer({
  type: 'my-type',                      // matches plot.type
  draw(plot, rctx) { … },
  highlight(plot, n, item, rctx) { … }, // optional — the hover/selection emphasis
  coalesce(plot) { … },                 // optional — see "Drawing across fetch blocks"
  values: 'scalar',                     // optional — 'array' for a ladder renderer
});
```

### `values: 'array'` — declaring a ladder renderer

If your renderer's per-slot, per-series value is an **array** rather than a number — a
percentile ladder, an OHLC quadruple, an error envelope — say so. The core branches on it
in three places: whether overlapping blocks can be concatenated, how a trimmed block's
`min`/`max` are recomputed, and how the y-axis extent is measured.

Leaving it off does not raise an error; it fails *quietly*. The extent scan computes
`array * number`, gets `NaN`, and since `NaN >= 0` is false the slot contributes nothing —
so the axis silently falls back to the block's declared `max` and your chart is drawn at
the wrong scale with no warning anywhere.

The four built-in ladder renderers ([ladder blocks](data-formats.md#ladder-blocks-percentiles-minavgmax))
declare it, and `TimeSeries.isBandedType(type)` reports it back. `TimeSeries.ladderPairs(n)`
gives you the same symmetric centre/pairs reading of `plot.percentiles` that `error-bars`
and `candlestick` use, so a fifth ladder renderer stays consistent with them.

### Drawing across fetch blocks (`coalesce`)

A polling source stores each fetch as its own block. A renderer that connects one bin to the
next therefore leaves a one-slot hole at every block margin. Returning a key from
`coalesce(plot)` merges the active blocks that share it into one synthetic block — rebased
onto a common slot grid — which is then drawn in a single `draw()` call:

```js
coalesce(plot) { return (plot.name || '') + '|' + plot.interval; }
```

Blocks in a group must share an `interval` (put it in the key, as above), since the merge
renumbers slots against it. A renderer that draws nothing between two bins — `error-bars`,
`candlestick` — has no margin to bridge and should leave `coalesce` off.

### The render context

```js
{
  c,            // CanvasRenderingContext2D
  X,            // (unixMs)  → x pixel
  Y,            // (value)   → y pixel
  ppms,         // pixels per millisecond
  ppv,          // pixels per value unit
  margin,       // { top, right, bottom, left }
  plotWidth,
  plotHeight,
  hidden,       // Set of hidden series ids
}
```

`X` and `Y` already account for the current zoom, the axis animation, and — if in use — the
[rate axis](tiers.md#the-rate-axis) scale. Use them rather than doing your own arithmetic.

### A minimal renderer

A step-line for binned data, in full:

```js
TimeSeries.registerRenderer({
  type: 'steps',
  draw(plot, rctx) {
    const { c, X, Y, hidden } = rctx;
    const start = plot.interval_start * 1000;
    const step  = plot.interval * 1000;

    // Series ids are the union of the keys across slots.
    const ids = new Set();
    for (const values of Object.values(plot.data)) for (const k of Object.keys(values)) ids.add(k);

    for (const id of ids) {
      if (hidden && hidden.has(id)) continue;

      c.beginPath();
      c.strokeStyle = TimeSeries.resolveColor(plot, id, 1);
      c.lineWidth = 2;
      let first = true;
      for (const [slot, values] of Object.entries(plot.data)) {
        const v = values[id];
        if (v == null) continue;
        const x0 = X(start + slot * step), x1 = X(start + (+slot + 1) * step), y = Y(v);
        if (first) { c.moveTo(x0, y); first = false; } else { c.lineTo(x0, y); }
        c.lineTo(x1, y);
      }
      c.stroke();
    }
  },
});
```

Then use it like any built-in type:

```js
sources: [{ 'source-type': 'artificial', type: 'steps', interval: 3600, … }]
```

### Rules a renderer must follow

- **Colour by series id**, via `TimeSeries.resolveColor(plot, seriesId, alpha)` — never by
  ordinal index. Colouring by index means hiding one series recolours every series after it.
- **Skip hidden series entirely**, do not draw them transparent. In a stacked renderer a
  hidden series must not occupy stack height either, or the visible bars float off the axis.
- **Restore `globalAlpha` to the value you found**, not to `1` — the
  [tier cross-fade](tiers.md) sets it around your `draw()` call.
- **Do not apply the fade or the rate scale yourself.** Both are applied centrally; doing it
  again doubles up.
- **Keep drawing and hit testing in step.** The core's hit test is arithmetic for binned
  bars, bin-and-ladder-range for `values: 'array'` blocks, and pixel-nearest for point
  plots; if your geometry differs, hover will point at the wrong thing.
- **Declare `values: 'array'` if your slot values are arrays** — see above for what goes
  quietly wrong otherwise.

---

## Custom data source

```js
TimeSeries.registerSource({
  type: 'my-source',                    // matches the 'source-type' key
  init(source, callbacks) { … },
});
```

`source` is the object from the constructor's `sources` array — your options, verbatim.

### The callbacks

```js
{
  pushData(plotObj),        // add or replace a block; returns an id
  replaceData(id, plotObj), // replace a block you pushed earlier, keeping its id
  removeData(id),           // drop a block
  requestRedraw(),          // repaint without changing data
  getViewport(),            // → { tmin, tmax, ppms }  — ms, and px per ms
  onViewportChange(fn),     // called when the user pans or zooms
}
```

### A polling source, in full

```js
TimeSeries.registerSource({
  type: 'my-api',
  init(source, cb) {
    let id = null;
    let seq = 0;

    async function load() {
      const { tmin, tmax } = cb.getViewport();
      const mine = ++seq;

      const rows = await fetch(
        `${source.url}?from=${Math.floor(tmin / 1000)}&to=${Math.ceil(tmax / 1000)}`
      ).then(r => r.json());

      if (mine !== seq) return;          // a newer request already went out — drop this one

      const plot = {
        type: 'multiline',
        category: 'point',
        name: source.name,
        tmin, tmax,
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
```

```js
sources: [{ 'source-type': 'my-api', url: '/metrics', metric: 'cpu', name: 'CPU' }]
```

### Rules a source should follow

- **Guard against out-of-order responses.** Pan quickly and several requests are in flight;
  without a sequence number an older response can overwrite a newer one. Every built-in
  source does this.
- **Reuse your block id.** `replaceData(id, plot)` keeps the slot; `pushData` on every poll
  leaks blocks, and the id you hold is a slot index, so ids are never reshuffled behind you.
- **Fetch a padded window.** Fetching exactly the viewport means every pixel of panning is a
  request. The built-in sources fetch ±50% and refetch only when panning nears the edge.
- **Decide resolution from `ppms`.** `getViewport().ppms` is pixels per millisecond — bar
  width in pixels is `ppms * intervalMs`. If you switch tiers at some width, tell the chart
  the same number with [`setFadeBand`](tiers.md#controlling-it), or it will draw one
  resolution while you maintain another.
- **Report failures somewhere the page can see.** The built-in sources only `console.warn`,
  which is exactly why both live demos register page-local sources instead — they need a
  status line, per-item counts and a reconnect button.

### Two resolution tiers from one source

Push two blocks that differ only in `interval` and the chart cross-fades between them —
nothing else is needed. See [Resolution tiers](tiers.md).

---

## Where to look in the source

| For | Read |
|---|---|
| The built-in renderers | [`src/renderers.js`](../src/renderers.js) |
| The span/Gantt renderer and its row packing | [`src/gantt.js`](../src/gantt.js) |
| The built-in sources, incl. the Zabbix ring cache | [`src/sources.js`](../src/sources.js) |
| A source with a real network protocol behind it | [`src/caldav.js`](../src/caldav.js) |
