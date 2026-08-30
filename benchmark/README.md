# benchmark — Where does timeseries.js stand?

Performance comparison against other JavaScript time-series libraries. Two things are
measured — together they give an honest picture:

| Metric | What it shows | Where it is measured |
|---|---|---|
| **CPU time per frame** | What does the library itself cost? | `npm run bench:micro` — Node + DOM stub, no real canvas |
| **TTFR + heap** | What does the user see + how much memory is allocated? | `npm run bench:browser` — real Chromium via Puppeteer |

CPU time and TTFR tell different stories: a library can be fast in the CPU profile yet feel
slow because of layout thrashing (or the other way around). Both numbers side by side are
the litmus test.

## Prerequisites

- Node.js (any current version is fine for the micro bench)
- Python 3 (for `python3 -m http.server` — the browser harness needs an HTTP server because
  ES-module imports are blocked over `file://`)
- `npm install` installs Puppeteer and downloads a Chromium into `node_modules/puppeteer/`
  on first run. Anyone who would rather skip that can drop `puppeteer` from the devDeps —
  `bench:micro` still runs.

## Quick start

```bash
npm run bench           # micro + browser, full run
npm run bench:micro     # CPU time only, ~10 seconds, no browser
npm run bench:browser   # TTFR + heap only, ~1 minute
```

## Architecture

```
benchmark/
├── README.md          this file
├── shared/
│   └── datasets.mjs   deterministic LCG generator + timeseries wrapper
│                      (the browser harness imports the same module)
├── micro/
│   ├── run.mjs           aggregator + table output
│   ├── timeseries.bench.mjs   measures ts.redraw() per dataset size
│   └── expected-budget.json    thresholds (collect-only for the first run)
├── browser/
│   ├── index.html      single-page harness (tabs via ?lib=…)
│   └── run.mjs         puppeteer launch + server + report
└── results/           JSON output, in .gitignore
    ├── micro-latest.json
    └── browser-latest.json
```

## Methodology

### What is measured?

**Micro bench (`bench/micro/timeseries.bench.mjs`)** — measures `ts.redraw()` against the
Node DOM stub from `test/helpers/dom.mjs`. The stub turns every canvas draw call into a
no-op; what we measure is **library CPU time** (`prepare_grid`, the render loop, layout,
axis math) with no backend cost.

Why `redraw()` and not `zoom()`? The latter starts an animation that ticks asynchronously
via `setTimeout`. `redraw()` calls `plotAll()` directly and synchronously — what we measure
is exactly the render path.

Five runs per size, median. The first run is JIT warm-up and is dropped.

**Browser bench (`bench/browser/index.html`)** — measures **TTFR** (time from the first
`performance.now()` until two consecutive rAFs paint the same canvas content) and
**`performance.memory.usedJSHeapSize`**. Both are Chromium-specific; Firefox and Safari
report heap as `null`.

Sizes: 1k / 10k / 100k. 1M is included in the micro bench (the stub is free); it is omitted
from the browser bench (three libraries × 1M × pixel buffer would push Chromium's tab close
to its memory ceiling).

### What is NOT measured?

- **FPS during pan/zoom.** Complex (CDP tracing or a 60 fps rAF loop with event injection),
  hard to get right, deliberately left out of the first iteration. A second iteration could
  add it.
- **WebGL renderers** (ChartGPU, SciChart). GPU comparisons are not reproducible without a
  fixed GPU.
- **timeseries.js' own LTTB path.** `src/lttb.js` exists but is not called from the render
  loop — sampling fairness only makes sense once the library itself samples.

### Which libraries are included?

Currently: **uPlot 1.6.32** (Canvas, zero deps, widely seen as the speed reference) and
**Chart.js 4.5.1** with its built-in decimation (`algorithm: 'lttb'`, `parsing: false`,
`animation: false` — the fast path Chart.js itself recommends for big data).

Planned: ECharts and/or dygraphs if anyone wants it.

### How are they configured?

All three receive the same dataset from `shared/datasets.mjs`. The data is deterministic
(LCG with a fixed seed of 42) — same run, same numbers, on any machine. Each library gets
the dataset in its own native form (a `multiline` block, `[xs, ys]`, or `{x, y}` points).
Viewport is 1000×400 px everywhere.

The exact library configurations are documented in the HTML comment at the top of
`benchmark/browser/index.html`, with source URL and date — important because defaults change.

## Reading the results

`npm run bench:micro` writes a table to stdout:

```
timeseries.js micro-bench (CPU time per plotAll, canvas no-op)
| points | median ms | per-run ms |
|--------|-----------|------------|
|   1000 |      5.28 | 5.30, 4.95, 5.28, 6.19, 4.46 |
|  10000 |      6.04 | 14.57, 8.42, 6.03, 6.01, 4.48 |
| 100000 |     64.33 | 64.47, 62.52, 63.42, 64.48, 64.32 |
| 1000000 |   1046.42 | 1071.72, 984.73, 1046.42, 1137.22, 985.40 |
```

and JSON to `benchmark/results/micro-latest.json`.

`npm run bench:browser` writes the analogous table per library × dataset size and JSON to
`benchmark/results/browser-latest.json`.

## First measurement (as of 2026-08-30)

CPU time in the DOM stub (no backend rendering, library cost only):

| points | median ms |
|--------|-----------|
|     1k |      5.28 |
|    10k |      6.04 |
|   100k |     64.33 |
|     1M |   1046.42 |

TTFR + heap in Chromium (real rendering, what the user sees):

| Library    |     1k |    10k |   100k |
|------------|-------:|-------:|-------:|
| timeseries |  45 ms |  52 ms |  88 ms |
| uPlot      |  21 ms |  23 ms |  41 ms |
| Chart.js   |  55 ms |  56 ms |  86 ms |

Heap at 100k points: timeseries ~23 MiB, uPlot ~13 MiB, Chart.js ~15 MiB.
Measured on a developer's machine; absolute numbers may vary on other hardware, the ranking
should be stable.

## Sanity check

If an external benchmark source says "X is faster than Y at 100k points" and our bench does
**not** show that, the bench is broken (datasets not identical, or configuration unfair).
The early runs should put uPlot in the top league — if they don't, something is wrong.

## Known limitations

- **One machine, one Chromium build.** Cross-machine comparisons are dangerous with the
  browser bench (CPU cache, JIT heuristics, GPU drivers). The micro bench is less fragile,
  but not zero.
- **One dataset shape** (sine + noise). Other distributions (jumps, plateaus, lots of NaNs)
  can change the ranking.
- **No CI threshold.** The `expected-budget.json` is there, but it stays inactive until
  enough cross-machine data exists to set thresholds that are fair.

## Adding another library

1. In `benchmark/browser/index.html`: load the library's script, add a `runXxx()` function
   after the `runChartJS` example, and another branch in the `try` block.
2. In `benchmark/browser/run.mjs`: add the library name to the `LIBS` array.
3. Run `npm run bench:browser` and visually verify the library actually draws data.
