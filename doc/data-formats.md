# Data formats

Everything you hand the chart is a **plot object**. A data source produces them; the
built-in `artificial` source passes yours straight through, so with it the source object
*is* the plot object.

There are three shapes, selected by `category`:

| `category` | Time is… | `data` is… | Use for | Renderers |
|---|---|---|---|---|
| *(omitted)* — **binned** | fixed-width slots on a shared grid | an object keyed by slot index | pre-aggregated metrics | `multibar`, `multiline`, `multipoint`, `quantile-bands` |
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
  type: 'multibar',             // 'multibar' | 'multiline' | 'multipoint' | 'quantile-bands'
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

`data` is **sparse** — a slot with no data is simply absent, and renders as a gap rather
than as zero. Series keys are stable across slots and drive both the stacking order and the
legend.

### Stacked bars vs. lines

The same block renders as stacked bars, lines or points purely by changing `type`:

```js
{ …, type: 'multibar' }    // stacked areas, one segment per series
{ …, type: 'multiline' }   // one line per series, connecting slot centres
{ …, type: 'multipoint' }  // one marker per slot per series
```

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

## Quantile bands

A percentile fan per series rather than a single value. Each slot's value is an **array**
of percentile values, aligned to the block's `percentiles` ladder.

```js
{
  'source-type': 'artificial',
  type: 'quantile-bands',
  name: 'request latency',
  interval_start: 1717200000, interval_end: 1717286400,
  interval: 3600, count: 24,
  min: 0, max: 900,                   // smallest / largest percentile value
  percentiles: [5, 25, 50, 75, 95],   // ascending ladder; the median is drawn bold
  data: {
    0: { api: [12, 40, 88, 210, 640] },   // one entry per percentile, same order
    1: { api: [14, 44, 91, 230, 700] },
    // …
  },
}
```

Lines connect slot centres; the area between adjacent percentiles is shaded, most opaque
around the median and fading toward the tails.

Two constraints:

- **Binned only** — there is no `category: 'point'` form.
- **No per-bar hit target**, so click and hover callbacks do not fire for these series.

A two-entry ladder is the min/max envelope case, and a three-entry `[min, avg, max]` ladder
is what the [Zabbix source](sources.md#zabbix) uses for both its history and its trends
tier — which is how one renderer draws a fine tier as a single line (min = avg = max at one
sample per bucket) and a coarse tier as a filled band.

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
| `multiline` | ✓ | ✓ | | One line per series |
| `multipoint` | ✓ | ✓ | | One marker per sample |
| `scatter` | | ✓ | | Filled circle per point |
| `quantile-bands` | ✓ | | | Percentile fan with shaded bands |
| `gantt` | | | ✓ | Duration bars packed into rows |

Registering your own is two dozen lines — see [Plugins](plugins.md).
