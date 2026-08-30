// Micro-bench orchestrator.
//
// Reads the JSON line from timeseries.bench.mjs, computes the median per
// size, formats a small comparison table, and writes both the raw and the
// aggregated result to benchmark/results/. The aggregated JSON is what a
// future regression-check (or a future PR comment) would diff against.
//
// The expected-budget file (if present) is informational only in this
// first iteration — the README explains that the bench is in
// "collect-only" mode until we have enough cross-machine data to set
// thresholds we trust. A second iteration can wire it into a test runner
// failure path; not now, when one man's machine sets the bar for everyone.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(HERE, '..', 'results');

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  const child = spawnSync(
    process.execPath,
    [resolve(HERE, 'timeseries.bench.mjs')],
    { encoding: 'utf8' },
  );
  if (child.status !== 0) {
    process.stderr.write(child.stderr);
    process.exit(child.status ?? 1);
  }
  const raw = JSON.parse(child.stdout.trim());

  // Aggregate: median per size. Sort, take middle for odd RUNS (5 → index 2).
  const aggregated = raw.results.map(({ points, runs }) => {
    const sorted = [...runs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { points, medianMs: Number(median.toFixed(3)), allRunsMs: runs };
  });

  // Persist. Latest pointer + timestamped history, like a CI artifact.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tsFile = resolve(RESULTS_DIR, `micro-${ts}.json`);
  const latestFile = resolve(RESULTS_DIR, 'micro-latest.json');
  const payload = { bench: 'timeseries.micro', generatedAt: new Date().toISOString(), aggregated };
  await writeFile(tsFile, JSON.stringify(payload, null, 2) + '\n');
  await writeFile(latestFile, JSON.stringify(payload, null, 2) + '\n');

  // Pretty table for the human reading CI logs.
  const header = '| points | median ms | per-run ms |';
  const sep    = '|--------|-----------|------------|';
  const rows = aggregated.map(a =>
    `| ${String(a.points).padStart(6)} | ${String(a.medianMs.toFixed(2)).padStart(9)} | ${a.allRunsMs.map(x => x.toFixed(2)).join(', ')} |`
  );
  process.stdout.write(`\ntimeseries.js micro-bench (CPU time per plotAll, canvas no-op)\n`);
  process.stdout.write(`${header}\n${sep}\n${rows.join('\n')}\n\n`);
  process.stdout.write(`Wrote ${tsFile}\nWrote ${latestFile}\n`);
}

main().catch(err => {
  process.stderr.write(String(err && err.stack || err) + '\n');
  process.exit(1);
});