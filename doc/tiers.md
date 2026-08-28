# Resolution tiers, the cross-fade, and the rate axis

One signal, two resolutions. A month of minute-resolution data is millions of points and a
few pixels per bar; an hourly rollup of it is readable but useless when you zoom into an
hour. The chart holds both and switches between them as you zoom — without a visible pop.

## How tiers are recognised

Blocks of the **same `type` differing only in `interval`** are treated as resolution tiers
of one signal. You do not declare them; pushing two such blocks is the declaration.

```js
sources: [
  { 'source-type': 'artificial', type: 'multibar', interval: 3600, /* hourly  */ … },
  { 'source-type': 'artificial', type: 'multibar', interval:   60, /* minutes */ … },
]
```

Per frame, the chart picks the finest tier whose bars are at least `fadeHi` (2 px) wide.

## The cross-fade

Rather than popping from one tier to the other, both stay live across the
`fadeHi` → `fadeLo` band (2 px → 1 px of bar width) and dissolve: the outgoing tier fades
`1 → 0` while the incoming one fades `0 → 1`.

Two things make it look right, and both are generic — no renderer knows they exist:

- **Alpha is applied centrally**, around each renderer's `draw()` call, so every renderer
  including third-party ones gets the dissolve for free. Blocks are drawn faintest-first, so
  the nearly-invisible tier can never wash out the dominant one.
- **The y-extent is interpolated across the band.** Two tiers can sit on very different
  scales — a `sum` rollup makes hourly bars 60× the minute bars — and without this the axis
  would snap at the *start* of the dissolve, squashing the outgoing bars to a sliver.

The hit test follows whichever tier is visually dominant, so a tooltip mid-dissolve reports
the tier you can actually see.

> **If you write a renderer that sets `globalAlpha` itself**, restore it to the value you
> found, not to `1`. And never multiply a fade into your own colour alphas — it would double
> up with the central one.

## Controlling it

```js
ts.setFadeBand(4, 2);        // switch at 4 px instead of 2, dissolve down to 2 px
ts.setRenderInterval(3600);  // pin the hourly tier; the cross-fade is off
ts.setRenderInterval(null);  // back to automatic
```

`setFadeBand` rejects anything that is not `0 < lo < hi` rather than letting a NaN reach the
canvas.

**A host that fetches its own tiers must agree on the threshold.** If your source decides
which resolution to keep topped up, it has a switch point of its own — set `fadeHi` to that
same number. Otherwise the canvas renders one resolution while the host maintains another,
and panning punches holes in whatever is visually dominant.

---

## Producing a second tier: `rollupBinned`

```js
const hourly = TimeSeries.rollupBinned(minuteBlock, 3600, { agg: 'mean' });
```

Derives a coarser block from a finer one. Pure and non-mutating.

| Argument | Notes |
|---|---|
| `plot` | A **binned scalar** block. `category: 'point'` / `'span'` and [ladder blocks](data-formats.md#ladder-blocks-percentiles-minavgmax) (array-valued: `quantile-bands`, `quantile-steps`, `error-bars`, `candlestick`) return `null` |
| `coarseInterval` | Seconds. Must be an integer multiple of `plot.interval` |
| `opts.agg` | `'sum'` (default) \| `'mean'` \| `'max'` \| `'min'` \| `fn(values, seriesId, slot)` |

Buckets are gridded on absolute epoch time, not on the block's slot 0, so separately fetched
blocks land on the same coarse boundaries. `'mean'` divides by the fine slots actually
present, not by the bucket ratio, so a sparse hour is not diluted by its gaps.

`name`, `category`, `series_colors` and `series_directions` are carried over to the derived
block. **`extensive` is not** — and deliberately so: whether the *result* is extensive
depends on the aggregation, not on the input. A `'sum'` rollup of counts is still extensive;
a `'mean'` rollup of the same counts is not. Set it yourself on the derived block when it
applies:

```js
const coarse = TimeSeries.rollupBinned(fine, 3600, { agg: 'sum' });
coarse.extensive = true;                 // a sum of counts is still a count
```

[`data_until`](data-formats.md) is left behind for the same reason. Whether the *result* has
an incomplete bin is a property of the aggregation, and carrying it over would silently make
the coarse tier partial too, at a quite different fraction of its own longer interval. Set
it yourself if it applies: `coarse.data_until = fine.data_until;`

### Choosing `agg`

`'sum'` is right for counts — but it changes the effective unit across the dissolve
("per minute" becomes "per hour"), which is what makes bars visibly breathe through a
resolution swap. Two ways out:

- **`'mean'`** keeps both tiers on one scale. Simple, and usually enough.
- **The rate axis**, below, which keeps `'sum'` semantics and normalises at draw time.

---

## The rate axis

`ts.setRateUnit(seconds, opts)`

The cross-fade dissolves the tiers into each other, but it cannot make them the same
*size*. When values are amounts accumulated over the bin — counts, `'sum'` rollups — the
coarse tier's bars are `interval ratio` times the fine tier's.

`setRateUnit` draws such blocks **per N seconds** rather than per bin. Per second the two
tiers hold the same number, so they draw at the same height, the axis stands still, and the
tier switch changes only what is *printed* on the axis.

```js
ts.setRateUnit(1, { label: 'req/s', transition: 400 });
ts.setRateUnit(null);   // off — the default
```

| Argument | Notes |
|---|---|
| `seconds` | Draw per this many seconds. `null` = off |
| `opts.label` | Axis unit text, set in the same call so there is no ordering trap between scale and label |
| `opts.transition` | ms — fades the old tick set out while the new one fades in |

### Opt in per block

Only blocks marked `extensive: true` are scaled:

```js
{ …, type: 'multibar', extensive: true }   // values are counts / sums accumulated over the bin
```

You are the only one who knows whether a value is extensive (a count, a sum) or already
intensive (an average, a percentile, a gauge) — scaling an average by the bin length would
simply be wrong. Point and span blocks are never scaled, and the whole feature is inert
until `setRateUnit` is called.

### What it does and does not touch

- **Applied centrally**, like the fade: renderers receive an already-scaled render context,
  so every renderer including third-party ones gets the rate axis without knowing about it.
  Do not multiply the scale into a renderer's own arithmetic.
- **The hit test returns the raw value**, so a tooltip still reports the amount in the bin
  rather than whatever unit the axis happens to show.
- **The unit swap dissolves** — but only between two rate units. Switching the rate axis on
  or off rescales per block, since each factor depends on that block's interval, so that
  always snaps.

---

## Worked example: two tiers from one dataset

```js
// One minute-resolution block, and an hourly tier derived from it.
const fine = {
  'source-type': 'artificial',
  type: 'multibar',
  extensive: true,                     // values are counts
  interval_start: t0, interval_end: t0 + 86400,
  interval: 60, count: 1440,
  min: 0, max: 40,
  data: minuteData,
};

const coarse = Object.assign(
  { 'source-type': 'artificial', extensive: true },   // rollupBinned does not carry this — see above
  TimeSeries.rollupBinned(fine, 3600, { agg: 'sum' })
);

const ts = new TimeSeries({
  canvas: 'chart',
  initialView: 'today',
  sources: [coarse, fine],
});

ts.setRateUnit(60, { label: 'events/min' });   // both tiers now draw at the same height
```

Zoom out and the hourly tier takes over; zoom in and the minute bars resolve back — with the
axis holding still throughout. `demo/index.html` does exactly this with its main chart.
