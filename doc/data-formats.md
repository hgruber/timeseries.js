# Data formats

Everything you hand the chart is a **plot object**. A data source produces them; the
built-in `artificial` source passes yours straight through, so with it the source object
*is* the plot object.

There are three shapes, selected by `category`:

| `category` | Time is… | `data` is… | Use for | Renderers |
|---|---|---|---|---|
| *(omitted)* — **binned** | fixed-width slots on a shared grid | an object keyed by slot index | pre-aggregated metrics | `multibar`, `multiline`, `stackarea`, `multipoint`, and the ladder five: `quantile-bands`, `quantile-steps`, `error-bars`, `candlestick`, `ohlc` |
| `'point'` | a timestamp per sample | an array of `{t, values}` | raw samples, irregular data | `multiline`, `multipoint`, `scatter` |
| `'span'` | a start/end pair per item | an array of `{start, end, …}` | calendar events, jobs, outages | `gantt` |

> **Units:** binned blocks use **Unix seconds** (`interval_start`, `interval_end`,
> `interval`). Point and span blocks use **Unix milliseconds** (`tmin`, `tmax`, `t`,
> `start`, `end`).

---

## Binned series

Values already aggregated into fixed `interval`-wide slots. This is the default shape — no
`category` key.

```js
{
  'source-type': 'artificial',  // which source plugin loads it
  type: 'multibar',             // 'multibar' | 'multiline' | 'multipoint' (or a ladder type)
  name: 'transactions',         // label for the legend
  interval_start: 1717200000,   // Unix SECONDS — left edge of the data
  interval_end:   1717286400,   // Unix SECONDS — right edge
  interval: 3600,               // SECONDS per slot
  count: 24,                    // number of slots
  min: 0,
  max: 1400,                    // for multibar, the largest stacked total
  data: {
    0: { ok: 91, error: 7 },    // data[slotIndex][seriesId] = value
    1: { ok: 88, error: 3 },
    // …
  },
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | ✓ | Renderer name |
| `interval_start` / `interval_end` | number | ✓ | Unix **seconds** |
| `interval` | number | ✓ | Seconds per slot |
| `count` | number | ✓ | Slot count; slot `n` covers `interval_start + n * interval` |
| `min` / `max` | number | ✓ | Value range; drives the initial y-axis extent |
| `data` | object | ✓ | Sparse: only slots that have values need keys |
| `name` | string | | Block label |
| `series_colors` | object | | `{ seriesId: cssColor }` — overrides the automatic palette |
| `extensive` | boolean | | Values are amounts accumulated over the bin (counts, sums) rather than per-unit rates. Only read when [`setRateUnit`](tiers.md#the-rate-axis) is in use |
| `data_until` | number | | Unix **seconds**. The block's data only reaches this far; the bin holding it is incomplete. Only read when [`setPartialBins`](api.md#partial-bins) is not `'full'` |

`data` is **sparse** — a slot with no data is simply absent, and renders as a gap rather
than as zero. Series keys are stable across slots and drive both the stacking order and the
legend.

`data_until` is for a source that is still catching up — an ETL high-water mark, a feed with
a known lag. Only the block's **last populated bin** can be the incomplete one; a
`data_until` pointing anywhere else is ignored, which is what keeps a stale value harmless
once a block has been trimmed. A source replacing a block sets `data_until` on the new
block; it is never inherited from the old one.

### Stacked bars vs. lines

The same block renders as stacked bars, lines or points purely by changing `type`:

```js
{ …, type: 'multibar' }    // stacked areas, one segment per series
{ …, type: 'multiline' }   // one line per series, connecting slot centres
{ …, type: 'multipoint' }  // one marker per slot per series
```

If a slot's value is an **array** rather than a number, you have a
[ladder block](#ladder-blocks-percentiles-minavgmax) and four more types to pick from.

### Butterfly charts (`series_directions`)

`multibar` normally stacks every series upward from zero. Name some series in
`series_directions` and they stack **downward** instead, giving a butterfly/tornado chart
from the same data — inbound vs. outbound traffic, wins vs. losses:

```js
{
  …,
  type: 'multibar',
  series_directions: { error: 'down', retry: 'down' },   // everything else stacks up
}
```

Only `'down'` is special; any other value (or an absent key) stacks up. The y-extent
accounts for both directions, so set `min` to the most negative stacked total you expect.
`rollupBinned` carries the key through to a derived tier.

---

## Point series

Every sample carries its own timestamp. Set `category: 'point'` and make `data` an
**array**.

```js
{
  'source-type': 'artificial',
  type: 'scatter',                  // 'scatter' | 'multiline' | 'multipoint'
  category: 'point',
  name: 'latency samples',
  tmin: 1717200000000,              // Unix MILLISECONDS — data extent
  tmax: 1717286400000,
  min: 0, max: 500,
  series: [                         // optional; otherwise inferred from data[0]
    { id: 'a', name: 'Frontend' },
    { id: 'b', name: 'Backend' },
  ],
  data: [
    { t: 1717200000000, values: { a: 12, b: 7 } },
    { t: 1717200060000, values: { a: 15, b: 9 } },
    // …
  ],
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `category` | `'point'` | ✓ | Selects this shape |
| `tmin` / `tmax` | number | ✓ | Unix **milliseconds** |
| `data` | array | ✓ | `{ t, values }`, `t` in Unix ms; should be sorted ascending |
| `series` | array | | `{ id, name }` — names and orders the legend. Inferred from the first point if omitted |

`scatter` (a filled circle per point) is **point-only**. `multiline` and `multipoint` render
either form. Large point series are thinned for drawing by the built-in LTTB downsampling
pass, which preserves visual shape rather than sampling evenly — hit testing follows the
reduced array, so a tooltip always points at a marker that is actually drawn.

---

## Ladder blocks (percentiles, min/avg/max)

A distribution per bin rather than a single value. Each slot's value is an **array** of
values aligned to the block's `percentiles` ladder — a percentile fan, a min/avg/max
envelope, an OHLC quadruple.

```js
{
  'source-type': 'artificial',
  type: 'quantile-steps',             // any of the five ladder renderers below
  name: 'request latency',
  interval_start: 1717200000, interval_end: 1717286400,
  interval: 3600, count: 24,
  min: 0, max: 900,                   // smallest / largest ladder value
  percentiles: [5, 25, 50, 75, 95],   // ascending ladder; the median is drawn bold
  data: {
    0: { api: [12, 40, 88, 210, 640] },   // one entry per percentile, same order
    1: { api: [14, 44, 91, 230, 700] },
    // …
  },
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `percentiles` | array | ✓ | The ladder. Ascending. Entries may be numbers (`50` → `p50` in the tooltip) or strings (`'avg'`) — only the **length** and the **order** are read |
| `connect` | boolean | | `quantile-steps` only. `false` drops the vertical risers, leaving the segments free-standing. Default `true` |
| `roles` | object | | `candlestick` only. `{ open, high, low, close }`, each an **index** into the value array. Opts into true OHLC — see below |
| `candleColors` | object | | `candlestick` only. `{ up, down }` CSS colours, overriding the hollow/filled convention |

Everything else is the ordinary binned block above: `interval`, `count`, `series_colors`,
`data_until` and the rest all mean exactly what they mean there.

**Binned only** — there is no `category: 'point'` form for any of these. A ladder needs a
bin to belong to.

### The four renderers

All four read the same block. They differ in one thing: whether they claim anything about
the time *between* two bins.

```js
{ …, type: 'quantile-bands' }   // lines through the slot CENTRES, shaded between
{ …, type: 'quantile-steps' }   // a flat segment across each BIN, shaded between
{ …, type: 'error-bars' }       // a marker on the centre rung, whiskers over the pairs
{ …, type: 'candlestick' }      // wick, body and median tick per bin
```

`quantile-bands` interpolates: it draws a straight line from one bin's median to the next
one's, through the gap where nothing was measured. That reads well as a trend and badly as
a statement of fact.

The other three are **bin-local**. `quantile-steps` is the direct swap for the bands — same
ladder, same shading, same bold median — except each rung is a horizontal segment spanning
its own interval, joined to its neighbour by a vertical riser. Nothing is drawn on a slant,
so nothing suggests a value that was never measured. `connect: false` removes the risers
too, if even the jump should go unstated.

`error-bars` and `candlestick` go further and draw each bin as an isolated glyph.

### How the rungs are read

`error-bars` and `candlestick` decompose the ladder symmetrically — outermost pair first,
working inward, with the middle entry (if the ladder has an odd length) as the centre:

| `percentiles` | Pairs, outermost first | Centre |
|---|---|---|
| `[25, 75]` | `25↔75` | *none* |
| `['min','avg','max']` | `min↔max` | `avg` |
| `[5, 25, 50, 75, 95]` | `5↔95`, `25↔75` | `50` |

**An even-length ladder has no centre**, so `error-bars` draws no marker and `candlestick`
no median tick. Rounding to a neighbouring rung would label a value the data never claimed.

`error-bars` puts a marker on the centre and a whisker over every pair, the innermost bold
and the outermost thin, with caps only on the outermost. `candlestick` uses the outermost
pair as the wick and the next one in as the body — the box plot a percentile ladder
actually supports. A ladder with only **one** pair (`[min, avg, max]`, `[p25, p75]`) becomes
a plain filled box over that pair rather than a bodyless hairline.

### True OHLC candles (`roles`)

A percentile ladder has no direction, so there is nothing to colour rising against falling.
`plot.roles` supplies one by naming which array index is which:

```js
{
  type: 'candlestick',
  percentiles: ['open', 'high', 'low', 'close'],
  roles: { open: 0, high: 1, low: 2, close: 3 },   // indices into the value array
  data: { 0: { eurusd: [1.081, 1.090, 1.078, 1.087] } },
}
```

Rising bins (`close >= open`) are drawn **hollow**, falling ones **filled** — the classic
convention, and the one that needs no second colour, so the candles re-theme with the
series. `candleColors: { up, down }` overrides that with explicit colours. A `roles` map
naming an index outside the array is ignored and the ladder reading above is used instead.

### Hover and click

A ladder bin **is** a hit target: hovering one hands the whole array to
`onHoverDataCallback` as `value`, with the series id as `key`. The shipped tooltip renders
one labelled row per rung, highest first (`p95`, `p75`, …), which
[`percentileLabel`](overlays.md#tooltip) retargets. Hidden series are not hittable.

A two-entry ladder is the min/max envelope case, and a three-entry `[min, avg, max]` ladder
is what the [Zabbix source](sources.md#zabbix) uses for both its history and its trends
tier — which is how one renderer draws a fine tier as a single line (min = avg = max at one
sample per bucket) and a coarse tier as a filled band.

> All tiers of one signal must use the **same** ladder type: the resolution cross-fade
> groups blocks by `plot.type`, so mixing two of them pops instead of dissolving.

---

## Spans (Gantt)

Arbitrary start/end pairs, where bar width means duration rather than a slot on a shared
grid. Calendar events, batch jobs, outages, maintenance windows.

```js
{
  type: 'gantt',
  category: 'span',
  tmin: 1717200000000,                 // Unix MILLISECONDS — window this block covers
  tmax: 1717804800000,
  layout: 'calendar',                  // 'calendar' | 'packed'
  lanes: [                             // 'calendar' layout: one row-block per lane
    { id: 'work',     label: 'Work',     color: '#2d6a9f' },
    { id: 'personal', label: 'Personal', color: '#7fbf3f' },
  ],
  data: [
    { id: 'e1', lane: 'work', start: 1717200000000, end: 1717203600000,
      label: 'Standup', location: 'Room A' },
    { id: 'e2', lane: 'work', start: 1717221600000, end: 1717229000000,
      label: 'Review', group: 'ci' },
    // …
  ],
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `category` | `'span'` | ✓ | Selects this shape |
| `tmin` / `tmax` | number | ✓ | Unix **milliseconds** |
| `layout` | string | | `'calendar'` (default) — one row block per lane, lane names on the y-axis. `'packed'` — greedy-packed into a single band, minimising rows |
| `lanes` | array | for `'calendar'` | `{ id, label, color }` |
| `data[].start` / `.end` | number | ✓ | Unix **milliseconds** |
| `data[].lane` | string | | Matches a `lanes[].id` |
| `data[].label` | string | | Drawn inside the bar when it fits |
| `data[].color` | string | | Overrides the lane colour for one event |
| `data[].group` | string | | Row-packing hint — see below |

### `group`: keeping related events on one row

Within a lane, the packer prefers to reuse the same row for every event sharing a `group`
value, as long as that row is free at the event's start. Without it, several short
non-overlapping events that you consider "the same thing" — one flapping trigger firing
repeatedly, say — land in whichever row happened to be free at each moment, and read as
unrelated.

It never causes an incorrect overlap: if the preferred row is taken, packing falls back to
ordinary first-fit. Leave it unset for independent events; the CalDAV source does, since
each calendar entry is its own thing.

### Mutating spans in place

`layoutSpans(plot)` assigns each event a `_row` and derives `laneCount`, `yticks` and
`laneBounds`. It is idempotent, stamped via `plot._laidOut`, and runs before the y-extent is
computed. **If you mutate `data` in place, clear `plot._laidOut`** and call `ts.redraw()`,
or the old layout is reused.

---

## Which renderer accepts which shape

| Renderer | Binned | Point | Span | Draws |
|---|:--:|:--:|:--:|---|
| `multibar` | ✓ | | | Stacked bars, negatives downward |
| `multiline` | ✓ | ✓ | | One line per series; `step` and `fill` below |
| `stackarea` | ✓ | ✓ | | Filled bands stacked on one another |
| `multipoint` | ✓ | ✓ | | One marker per sample |
| `scatter` | | ✓ | | Filled circle per point |
| `quantile-bands` | ✓ | | | Percentile fan, interpolated between slot centres |
| `quantile-steps` | ✓ | | | The same fan, flat across each bin |
| `error-bars` | ✓ | | | Marker plus whiskers per bin |
| `candlestick` | ✓ | | | Wick and body per bin; OHLC via `roles` |
| `ohlc` | ✓ | | | High–low bar, open ticked left and close right |
| `waterfall` | ✓ | | | Cumulative bars: each starts where the last ended |
| `gantt` | | | ✓ | Duration bars packed into rows |

The five ladder renderers take a slot value that is an **array**
([ladder blocks](#ladder-blocks-percentiles-minavgmax)); everything else takes a number.

### Line and area options

`multiline` takes two per-block options; both apply to binned and point blocks,
and both combine.

| Field | Values | Effect |
|---|---|---|
| `step` | `'after'` \| `'before'` | Draw a staircase instead of interpolating. `'after'` holds each value across its own bin — what a binned slot actually claims, since nothing was measured part-way through it. `'before'` raises the value at the previous point. Any other value is ignored. |
| `fill` | `true` | Shade each series down to the zero line, under the stroke. Series are drawn independently, so the areas **overlap**; use `stackarea` to stack them instead. |

`stackarea` reads `step` too. It sums the visible series per slot, so hiding one
closes the stack up rather than leaving a hole, and the y-axis is measured from
the stacked total rather than the tallest single series.

A line bridges a gap in the slot numbering; a *missing value* in a slot that
exists breaks it. The filled forms (`stackarea`, `quantile-steps`) break on an
absent slot as well — shading across unmeasured time asserts more than a line
through it does.

### Waterfall blocks

An ordinary binned block of **deltas**. Each bar starts where the previous one
ended, so the chart reads as a running total broken into its contributions.

| Field | Type | Meaning |
|---|---|---|
| `data` | `{slot: {series: delta}}` | The change this slot contributes, not the level it reaches |
| `totals` | `number[]` | Slots that restate the running sum from zero — the subtotal and total bars. They consume no value of their own, so the running total passes through them |
| `waterfallColors` | `{up, down, total}` | Optional. Without it every bar takes the series colour and only the geometry shows direction |
| `connect` | `false` | Drops the leader lines between bars |

Two things follow from the running total being *cumulative*, and both matter:

- **It is accumulated from the block's first slot, never from the left edge of
  the viewport.** A zero point that moved as you panned would make every bar jump
  on every drag.
- **The y-axis follows the running total**, not the largest single step. Twelve
  steps of +10 reach 120, and the axis says so.

Each series accumulates independently, and several visible series are dodged
apart within the bin. A slot a series is missing from contributes nothing and
does not break its total.

Registering your own is two dozen lines — see [Plugins](plugins.md).
