# Configuration

Everything is passed to the constructor. Only `canvas` is required; every other key falls
back to the default shown.

```js
const ts = new TimeSeries({
  canvas:         'chart',       // REQUIRED — id of the target <canvas>
  sources:        [],            // source / plot objects — see doc/data-formats.md
  group:          undefined,     // viewport-sync group; instances sharing it move together
  initialView:    'last24',      // navigation method name, [tmin, tmax] window, or null
  follow:         undefined,     // true | false | 0–100; absent = whatever initialView implies
  zoomDuration:   500,           // ms — zoom transition length
  zoomFactor:     0.1,           // wheel-zoom sensitivity (smaller = finer steps)
  autoFollow:     false,         // enter follow mode when "now" reaches the right edge
  keyboard:       true,          // focusable canvas + arrow-key paging and zooming
  panSnap:        'grid',        // 'grid' | 'off' — snap keyboard navigation to the axis grid
  fadeHi:         2,             // resolution-tier switch point, px of bar width
  fadeLo:         1,             // dissolve band lower edge, px of bar width
  partialBins:    'full',        // 'full' | 'clip' | 'scale' — how an incomplete bin is drawn
  yAxisFormat:    null,          // (value) => string; defaults to SI prefixes
  yAxisLabel:     '',            // unit text above the y-axis, e.g. 'txn/s'
  colors:         { … },         // full palette object — see below
  holidays:       { … },         // holiday map — see below
  watermark:      null,          // URL string or HTMLImageElement, drawn behind the chart
  watermarkWidth: 0.63,          // watermark width as a fraction of plot width
  watermarkAlpha: 0.2,           // watermark opacity, 0 … 1
});
```

## Every option

| Option | Type | Default | Notes |
|---|---|---|---|
| `canvas` | string | `'timeseries'` | `id` of the `<canvas>`. Must be in the DOM with a non-zero CSS size. |
| `sources` | array | `[]` | Source / plot objects; each needs a `source-type`. |
| `group` | string | — | Shared viewport-sync group. Same as calling `ts.joinGroup(name)`. |
| `initialView` | string \| [number, number] \| null | `'last24'` | Any navigation method name (`today`, `thisWeek`, `lastMonth`, …). A `[tmin, tmax]` window in ms (Date objects also accepted) is applied synchronously, before the first paint. `null` keeps the default window. |
| `follow` | boolean \| number (0–100) | — | Explicit follow state, independent of the window. `true` rolls while keeping "now" where it sits in the start window; `false` stops; a number sets the fraction directly. Applied after `initialView`, so `onStop` / `onFollow` fire for the start state too. Absent = whatever `initialView` implies (named `last24`/`next24` start rolling; everything else starts stopped). |
| `zoomDuration` | number (ms) | `500` | Click / `zoom()` transition length. |
| `zoomFactor` | number | `0.1` | Mouse-wheel zoom step. |
| `autoFollow` | boolean | `false` | Start rolling once the right edge reaches the present. `follow` is the explicit "roll now"; `autoFollow` is the trigger that starts it later. |
| `keyboard` | boolean | `true` | Focusable canvas and arrow-key navigation — see [below](#keyboard). |
| `panSnap` | string | `'grid'` | `'grid'` snaps keyboard navigation to the labelled axis grid, `'off'` moves continuously — see [below](#keyboard). |
| `fadeHi` / `fadeLo` | number (px) | `2` / `1` | Resolution-tier switch point and dissolve band — see [Resolution tiers](tiers.md). |
| `partialBins` | string | `'full'` | How the bin holding a block's `data_until` is drawn — see [Partial bins](api.md#partial-bins). |
| `yAxisFormat` | function | SI format | `(value) => string` for y-axis tick labels. |
| `yAxisLabel` | string | `''` | Unit caption above the axis. |
| `colors` | object | light theme | A **full palette object**, not a name — see below. |
| `holidays` | object | German set | Fixed and Easter-relative holidays — see below. |
| `watermark` | string \| Image | `null` | Background image, behind all chart content. |
| `watermarkWidth` | number | `0.63` | Fraction of the plot width. |
| `watermarkAlpha` | number | `0.2` | `0`–`1` opacity. |

### How options merge

`colors` is merged **key by key** with the defaults, so a partial override keeps the rest of
the palette. Everything else — **including `holidays`** — replaces the default wholesale.
That asymmetry is deliberate: an undefined colour would reach the canvas as an invalid
`fillStyle`, whereas replacing the holiday map wholesale is exactly how you swap the German
set for another country's.

---

## Colours and themes

`colors` takes a full palette object, not a preset name. Four ready-made palettes ship on
`TimeSeries.themes`: `light` (the default), `dark`, `highContrast` and `warm`.

```js
const ts = new TimeSeries({ canvas: 'chart', colors: TimeSeries.themes.dark });

// later — e.g. reacting to a prefers-color-scheme change:
ts.setColors(TimeSeries.themes.light);
```

To customise, spread a theme and override only what you care about:

```js
const ts = new TimeSeries({
  canvas: 'chart',
  colors: { ...TimeSeries.themes.light, nowLine: 'rgba(0,140,255,0.8)' },
});
```

`ts.setColors()` merges too, so this restyles one key and leaves the rest:

```js
ts.setColors({ nowLine: 'red' });
```

> `TimeSeries.themes.light` **is** the built-in default palette object, not a copy. Do not
> mutate it in place.

### Every palette key

| Key | Paints |
|---|---|
| `frameBg` | Margin / axis-area background |
| `text` | All text and the plot border |
| `plotBg` | Plot area background |
| `gridLine` | Vertical time grid lines |
| `gridLineY` | Horizontal y-axis lines |
| `weekNumber` | Calendar-week labels |
| `nowLine` | The "now" indicator |
| `future` | Fog-of-future overlay |
| `stripMs` / `stripSecond` / `stripMinute` / `stripHour` | `[odd, even]` alternating stripes per time unit |
| `dayDefault` / `dayWeekend` / `dayOdd` | Weekday / weekend + holiday / alternate-day stripes |
| `monthOdd` / `monthEven` | Alternating month stripes |
| `yearOdd` / `yearEven` | Alternating year stripes |
| `tooltipBg` / `tooltipBorder` / `tooltipShadow` | Tooltip card background, border, shadow |
| `tooltipText` / `tooltipTitle` / `tooltipMuted` | Tooltip value, title row, timestamp |
| `legendBg` / `legendBorder` / `legendShadow` | Legend panel background, border, shadow |
| `legendText` / `legendTitle` / `legendMuted` / `legendHover` | Legend row text, header, extra text, row hover |

The `tooltip*` and `legend*` keys are the only ones the canvas never reads — they style the
optional [overlays](overlays.md), and live in the palette precisely so that one
`setColors()` re-themes the chart and its overlays together.

### Following the OS colour scheme

```js
const mq = matchMedia('(prefers-color-scheme: dark)');
const apply = () => ts.setColors(mq.matches ? TimeSeries.themes.dark : TimeSeries.themes.light);
mq.addEventListener('change', apply);
apply();
```

### Series colours

Series get colours from an automatic palette, keyed by **series id**. Override per block:

```js
{ …, series_colors: { cpu: '#2d6a9f', mem: '#c0392b' } }
```

`ts.getSeries()` reports the colour each series was actually painted in, override included,
so a hand-built legend always matches.

---

## Holidays

The time axis paints holidays with the weekend stripe colour and shows the name when there
is room. `holidays` is a flat map of **date key → display name**, in one of two forms:

- **Fixed dates** — `"day.month"`, day first (the German convention).
  **Always quote the key.** An unquoted `3.10` is the *number* `3.1`, which reads back as
  3 January — the October date is lost silently, with no error. The same applies to any
  month ending in a zero.
- **Easter-relative** — a string day offset from Easter Sunday, prefixed `+` or `-`. Easter
  itself is `"+0"`. Computed per displayed year (Gauss/Butcher computus), so these track the
  moving feast automatically.

```js
const ts = new TimeSeries({
  canvas: 'chart',
  holidays: {
    // fixed (day.month) — quote every key
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

Pass `holidays: {}` to switch holiday highlighting off. Weekends are always striped via
`dayWeekend`, independently of this map.

The default is the German set (`Neujahr`, `Karfreitag`, `Tag der Einheit`, …). Since
`holidays` replaces rather than merges, naming the key at all means you own the whole list.

---

## Keyboard

With `keyboard: true` (the default) the canvas joins the tab order (`tabindex=0`,
`role="application"`, and an `aria-label` unless the page set one) and binds four keys:

| Key | Movement | API equivalent |
|---|---|---|
| ←/→ | one page back/forward | `ts.pan(∓1)` |
| Shift+←/→ | one grid cell back/forward | `ts.pan(∓1, { cells: 1 })` |
| ↑/↓ | zoom in/out, halving or doubling the window | `ts.zoomStep(±1)` |
| Shift+↑/↓ | one cell narrower/wider | `ts.zoomStep(±1, { cells: 1 })` |

### The snap grid

Keyboard navigation moves in whole cells of the **coarsest x-axis level that is currently
labelled and fits the window**. That one rule covers every zoom level: a window of 18:55–20:04
is one hour cell, so → pages to 20:00–21:00; a six-hour window is six hour cells, so it pages
to the next six full hours without changing width; a window over a day lands on midnight, and
one over a month on the first. When a level stops being labelled because the canvas is too
narrow for it, the grid moves up to the next coarser one — you can only snap to something you
can read.

Attaching a grid rounds the window onto whole cells once, by at most 20 % of its width. From
then on the grid is *held*: every key press is exact, so paging out and back returns to the
same window and the width never drifts. Analogue gestures — wheel, drag, pinch — are never
snapped and release the grid; the next key press attaches a fresh one.

`panSnap: 'off'` turns this off: ←/→ then move by the exact current width and ↑/↓ zoom by a
factor of two, with no rounding anywhere. It can also be switched at runtime with
`ts.setPanSnap(mode)`, and `ts.getSnapGrid()` reports the grid currently in force.

Handlers are bound to the canvas, not the document, so on a page with several charts only
the focused one moves. `keyboard: false` leaves the element untouched.

Two mouse gestures round the model out: the wheel zooms at the cursor, and **Shift+wheel pans**
— both continuous, both unsnapped.

## Mobile

Touch is supported out of the box: drag to pan, pinch to zoom. In follow mode touch is
locked so the rolling window is not fought by a stray drag.

## Hidden containers

A chart whose container is `display: none` measures 0×0. That case is handled — the chart
keeps its last good geometry, stops repainting, and picks up real dimensions when the
container is shown. Constructing a chart inside a hidden tab panel is therefore safe,
including attaching a legend to it.
