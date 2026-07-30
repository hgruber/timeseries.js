# Overlays: tooltip and legend

The core is canvas-only and builds no DOM. `attachTooltip` and `attachLegend` are the two
deliberate exceptions — the same hover card and the same swatch/label toggle list were being
re-implemented by every consumer, so they ship with the library.

Both hold to the same four rules:

- **Opt-in.** Nothing exists until you call them: no element, no listener, no cost.
- **Public hooks only.** They reach the chart through the same API you have. Anything a
  third-party overlay could not do, they do not do either.
- **Default plus override.** Zero config gives the full default; each override replaces one
  piece, and `formatter` replaces the body while still handing you the default content.
- **Palette-themed.** Colours come from the `tooltip*` / `legend*` keys in the palette, so
  `ts.setColors(TimeSeries.themes.dark)` re-themes them for free. No CSS required.

---

## Tooltip

```js
const tip = TimeSeries.attachTooltip(ts);   // that is the whole default setup
```

Out of the box: a colour swatch, the series label, `(value · interval)` and the slot
timestamp, positioned beside the cursor and flipped away from the viewport edges.

### Options

```js
TimeSeries.attachTooltip(ts, {
  labelFor:    (key, plot, value) => names[key] || key,
  colorFor:    (key, plot) => myColors[key],
  valueFormat: v => v.toFixed(1) + ' req/s',
  timeFormat:  (date, ctx) => date.toISOString(),
  plotTypes:   ['multibar'],          // or a predicate; default is every type
  colors:      { tooltipBg: '#222' }, // overrides on top of the palette
  container:   document.body,
  className:   'my-tooltip',          // for host CSS
});
```

### Full control: `formatter`

`formatter(ctx)` replaces the body. `ctx` carries
`{ plot, n, key, value, label, color, time, interval, colors, defaultContent() }`.

Call `ctx.defaultContent()` to get the standard nodes and build on them, rather than
starting over:

```js
TimeSeries.attachTooltip(ts, {
  formatter(ctx) {
    const nodes = [ctx.defaultContent()];
    const ev = ctx.plot.data?.[ctx.n];
    if (ev?.location) {
      const line = document.createElement('div');
      line.textContent = '📍 ' + ev.location;
      nodes.push(line);
    }
    return nodes;
  },
});
```

Return a `Node`, an array of them, a **string** (inserted as text, so untrusted labels are
safe), `{ html: '…' }` to opt into markup deliberately, or `null` to hide this hit.

### Controller

```js
const tip = TimeSeries.attachTooltip(ts);
tip.hide();
tip.refresh();
tip.setOptions({ valueFormat: v => v + ' ms' });
tip.destroy();     // removes the element and unsubscribes
```

Because the hover hook is multi-subscriber, your own `onHoverDataCallback` keeps working
alongside it.

---

## Legend

```js
const legend = TimeSeries.attachLegend(ts);   // the whole default setup
legend.refresh();                             // after data first loads — see the note below
```

A floating panel with a swatch and label per active series. Clicking a row toggles that
series (dimmed when hidden); the panel is draggable and themed from the palette's `legend*`
keys.

> `onSeriesChange` fires on **visibility** changes, not when new data introduces a new
> series. If your data arrives asynchronously, call `legend.refresh()` once it has.

### Options

```js
TimeSeries.attachLegend(ts, {
  title:       'Region',                          // optional header
  labelFor:    (id, series) => names[id] || id,
  colorFor:    (id, series) => myColors[id],
  extra:       series => totals[series.id],       // trailing text/Node per row
  onItemClick: (id, series, ev) => filterTo(id),  // replaces the default visibility toggle
  colors:      { legendBg: '#222' },
  container:   document.body,
  className:   'my-legend',
});
```

### Full control: `formatter`

`formatter(ctx)` replaces a row's content. `ctx` carries
`{ ts, series, id, label, color, hidden, colors, defaultRow() }`.

```js
TimeSeries.attachLegend(ts, {
  formatter(ctx) {
    if (ctx.id.startsWith('_internal')) return null;   // drop this series from the list
    return ctx.defaultRow();
  },
});
```

Return a `Node`, an array of them, a string (inserted as text), `{ html }` for deliberate
markup, or `null` / `false` to drop that series.

### Controller

```js
const legend = TimeSeries.attachLegend(ts);
legend.refresh();
legend.setOptions({ title: 'Hosts' });
legend.show(); legend.hide(); legend.toggle();
legend.destroy();   // removes the element and unsubscribes
```

---

## Where the line is

`attachLegend` is a **series-visibility** legend, not an analytical panel. Viewport-windowed
totals, quantile aggregation, selection-driven filtering, CSV export — those are bound to an
application's data model and belong in the application. The generic 20% ships here; extend
it through `formatter`, `extra` and `onItemClick` when you need more.

If you need something the hooks cannot express, build your own from
[`ts.getSeries()`](api.md#series-visibility) — the shipped helpers use nothing you do not
have.
