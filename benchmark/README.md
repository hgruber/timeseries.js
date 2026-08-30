# benchmark — Wo steht timeseries.js?

Performance-Vergleich gegen andere JavaScript-Zeitreihen-Libraries. Misst
zwei Dinge, die zusammen ein ehrliches Bild ergeben:

| Metrik | Was sie zeigt | Wo sie gemessen wird |
|---|---|---|
| **CPU-Zeit pro Frame** | Was kostet die Library selbst? | `npm run bench:micro` — Node + DOM-Stub, kein echter Canvas |
| **TTFR + Heap** | Was sieht der User + wie viel Memory allokiert wird? | `npm run bench:browser` — echtes Chromium via Puppeteer |

CPU-Zeit und TTFR sagen Verschiedenes: eine Library kann im CPU-Profil
schnell sein, aber durch Layout-Thrashing langsam wirken (oder umgekehrt).
Beide Zahlen nebeneinander sind der Lackmustest.

## Voraussetzungen

- Node.js (für den Micro-Bench reicht jede aktuelle Version)
- Python 3 (für `python3 -m http.server` — der Browser-Harness braucht
  einen HTTP-Server, weil ES-Module-Imports über `file://` blockiert sind)
- `npm install` installiert Puppeteer und lädt beim ersten Lauf ein
  Chromium nach `node_modules/puppeteer/`. Wer das nicht will, kann
  `puppeteer` aus den devDeps entfernen — `bench:micro` läuft auch ohne.

## Schnellstart

```bash
npm run bench           # micro + browser, vollständig
npm run bench:micro     # nur CPU-Zeit, ~10 Sekunden, kein Browser
npm run bench:browser   # nur TTFR + Heap, ~1 Minute
```

## Architektur

```
benchmark/
├── README.md          diese Datei
├── shared/
│   └── datasets.mjs   deterministischer LCG-Generator + timeseries-Wrapper
│                      (selbe Datei nutzt der Browser-Harness via import)
├── micro/
│   ├── run.mjs           Aggregator + Tabellen-Ausgabe
│   ├── timeseries.bench.mjs   misst ts.redraw() pro Datengröße
│   └── expected-budget.json    Schwellwerte (collect-only im ersten Lauf)
├── browser/
│   ├── index.html      Single-Page-Harness (Tabs via ?lib=…)
│   └── run.mjs         Puppeteer-Launch + Server + Report
└── results/           JSON-Ausgabe, in .gitignore
    ├── micro-latest.json
    └── browser-latest.json
```

## Methodik

### Was wird gemessen?

**Micro-Bench (`bench/micro/timeseries.bench.mjs`)** — misst `ts.redraw()`
im Node-DOM-Stub aus `test/helpers/dom.mjs`. Der Stub macht jeden
Canvas-Draw-Call zu einem No-op; wir messen also **Library-CPU-Zeit**
(`prepare_grid`, Render-Loop, Layout, Achsen-Mathe) ohne Backend-Kosten.

Warum `redraw()` und nicht `zoom()`? Letzteres startet eine Animation, die
asynchron via `setTimeout` tickt. `redraw()` ruft `plotAll()` direkt
synchron auf — was wir messen, ist genau der Renderpfad.

5 Runs pro Größe, Median. Erster Run ist JIT-Warmup und wird verworfen.

**Browser-Bench (`bench/browser/index.html`)** — misst **TTFR** (Zeit
vom ersten `performance.now()` bis zwei aufeinanderfolgende rAFs denselben
Canvas-Inhalt haben) und **`performance.memory.usedJSHeapSize`**. Beides
ist Chromium-spezifisch; Firefox/Safari meldet Heap als `null`.

Größen: 1k / 10k / 100k. 1M wird im Micro-Bench mitgemessen (Stub ist
kostenlos), im Browser-Bench weggelassen (drei Libraries × 1M × Pixel-
Buffer kommt Chromiums Tab-Limit nahe).

### Was wird NICHT gemessen?

- **FPS bei Pan/Zoom**. Komplex (CDP-Tracing oder 60-fps-rAF-Loop mit
  Event-Injection), nicht-trivial fehlerfrei zu bekommen, in der
  ersten Iteration bewusst ausgelassen. Folge-Iteration möglich.
- **WebGL-Renderer** (ChartGPU, SciChart). GPU-Vergleich ist ohne
  identische GPU nicht reproduzierbar.
- **timeseries.js-LTTB**. `src/lttb.js` existiert, wird aber im
  Renderloop nicht aufgerufen — Sampling-Fairness ist erst sinnvoll,
  wenn die Library selbst Sampled.

### Welche Libraries sind drin?

Aktuell: **uPlot 1.6.32** (Canvas, Zero-Dep, gilt als Geschwindigkeits-
Referenz) und **Chart.js 4.5.1** mit eingebauter Decimation
(`algorithm: 'lttb'`, `parsing: false`, `animation: false` — der von
Chart.js selbst empfohlene Fast-Path für Big Data).

Geplant: ECharts und/oder dygraphs, falls jemand das möchte.

### Wie werden sie konfiguriert?

Alle drei erhalten denselben Datensatz aus `shared/datasets.mjs`. Die
Daten sind deterministisch (LCG mit fixem Seed 42) — gleicher Lauf,
gleiche Zahlen, auf jeder Maschine. Jede Library bekommt den Datensatz
in ihrer eigenen Standard-Form (`multiline`-Block, `[xs, ys]`, bzw.
`{x, y}-Punkte`). Viewport ist überall 1000×400 px.

Die genauen Library-Konfigurationen sind im HTML-Kommentar in
`benchmark/browser/index.html` mit Quellen-URL und Datum dokumentiert
— wichtig, weil sich Defaults ändern.

## Ergebnisse lesen

`npm run bench:micro` schreibt eine Tabelle nach stdout:

```
timeseries.js micro-bench (CPU time per plotAll, canvas no-op)
| points | median ms | per-run ms |
|--------|-----------|------------|
|   1000 |      5.28 | 5.30, 4.95, 5.28, 6.19, 4.46 |
|  10000 |      6.04 | 14.57, 8.42, 6.03, 6.01, 4.48 |
| 100000 |     64.33 | 64.47, 62.52, 63.42, 64.48, 64.32 |
| 1000000 |   1046.42 | 1071.72, 984.73, 1046.42, 1137.22, 985.40 |
```

und JSON nach `benchmark/results/micro-latest.json`.

`npm run bench:browser` schreibt analog eine Tabelle pro Library ×
Datengröße und JSON nach `benchmark/results/browser-latest.json`.

## Erste Messung (Stand 2026-08-30)

CPU-Zeit im DOM-Stub (kein Backend-Rendering, reine Library-Kosten):

| points | median ms |
|--------|-----------|
|     1k |      5.28 |
|    10k |      6.04 |
|   100k |     64.33 |
|     1M |   1046.42 |

TTFR + Heap in Chromium (echtes Rendering, was der User sieht):

| Library    |     1k |    10k |   100k |
|------------|-------:|-------:|-------:|
| timeseries |  45 ms |  52 ms |  88 ms |
| uPlot      |  21 ms |  23 ms |  41 ms |
| Chart.js   |  55 ms |  56 ms |  86 ms |

Heap bei 100k Punkten: timeseries ~23 MiB, uPlot ~13 MiB, Chart.js ~15 MiB.
Gemessen auf einem Entwickler-Rechner; auf anderen Maschinen können die
absoluten Zahlen abweichen, die Reihenfolge sollte stabil sein.

## Sinn-Check

Wenn eine externe Benchmark-Quelle sagt "X ist schneller als Y bei
100k Punkten", und unsere Bench das **nicht** zeigt, ist die Bench
kaputt (Datensätze nicht identisch, oder Konfiguration unfair). Die
ersten Läufe sollten uPlot in der oberen Liga sehen — wenn nicht,
ist etwas faul.

## Bekannte Einschränkungen

- **Eine Maschine, ein Chromium-Build**: Cross-Machine-Vergleiche
  sind mit dem Browser-Bench gefährlich (CPU-Cache, JIT-Heuristiken,
  GPU-Treiber). Der Micro-Bench ist weniger anfällig, aber auch
  nicht null.
- **Nur ein Datensatz-Shape** (Sinus + Noise). Andere Verteilungen
  (Sprünge, Plateaus, viele NaNs) können die Reihenfolge ändern.
- **Kein CI-Threshold**. Die `expected-budget.json` ist da, wird aber
  erst aktiv genutzt, wenn genug Cross-Machine-Daten vorliegen, um
  Schwellwerte zu setzen, die fair sind.

## Hinzufügen einer weiteren Library

1. In `benchmark/browser/index.html`: Library-Skript laden, eigene
   `runXxx()`-Funktion nach dem `runChartJS`-Beispiel, im
   `try`-Block eine weitere Verzweigung.
2. In `benchmark/browser/run.mjs`: Library-Name in das `LIBS`-Array
   aufnehmen.
3. `npm run bench:browser` und visuell prüfen, dass die Library
   tatsächlich Daten zeichnet.