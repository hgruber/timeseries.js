// Puppeteer-driven browser bench.
//
// What it does:
//   1. Ensures dist/timeseries.js exists (npm run build, idempotent — esbuild
//      is fast).
//   2. Spawns `python3 -m http.server 8080` rooted at the repo, so the
//      harness can fetch ../dist/timeseries.js, ../shared/datasets.mjs, and
//      both CDN bundles. Kills the server on exit.
//   3. Launches Chromium via puppeteer, opens the harness with each
//      (lib, size) cell, reads window.__benchResult, repeats RUNS times per
//      cell and takes the median.
//   4. Writes a Markdown summary + raw JSON to benchmark/results/.
//
// Why python3 -m http.server and not express:
//   * The repo already documents `npm run serve` pointing at python3
//     (see CLAUDE.md); using the same server avoids a node-side dependency
//     for the harness itself, which keeps `npm test` lean.
//   * It's a separate process we can SIGTERM at the end — no leak risk if
//     Puppeteer crashes.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const RESULTS_DIR = resolve(HERE, '..', 'results');
const BASE_PORT = 8090; // distinct from npm run serve (8080) so we don't fight a parallel session
let BASE = `http://localhost:${BASE_PORT}/benchmark/browser/index.html`;
const RUNS = 3;
const LIBS = ['timeseries', 'uplot', 'chartjs'];
const SIZES = [1000, 10000, 100000];

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function ensureBuilt() {
  // npm run build is idempotent. Skip if dist/ is newer than src/timeseries.js
  // — esbuild caches nothing, so this avoids a 1-2s rebuild on every bench.
  const fs = await import('node:fs/promises');
  let needsBuild = true;
  try {
    const [srcStat, distStat] = await Promise.all([
      fs.stat(resolve(REPO, 'src', 'timeseries.js')),
      fs.stat(resolve(REPO, 'dist', 'timeseries.js')),
    ]);
    if (distStat.mtimeMs >= srcStat.mtimeMs) needsBuild = false;
  } catch { /* dist missing — fall through to build */ }
  if (!needsBuild) return;

  await new Promise((resolveP, rejectP) => {
    const p = spawn('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
    p.on('exit', code => code === 0 ? resolveP() : rejectP(new Error('build failed')));
  });
}

async function findFreePort(start) {
  // If anything is squatting on the base port (e.g. an orphan from a
  // crashed earlier run), step forward until we find a free one. Avoids
  // failing the whole bench on stale processes.
  const net = await import('node:net');
  for (let p = start; p < start + 20; p++) {
    const ok = await new Promise(resolve => {
      const sock = net.createServer();
      sock.once('error', () => resolve(false));
      sock.once('listening', () => sock.close(() => resolve(true)));
      sock.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error(`no free port in [${start}, ${start + 19}]`);
}

async function startServer() {
  const PORT = await findFreePort(BASE_PORT);
  // BASE is captured by closure of runCell — set it on the module-scope
  // mutable once we know the actual port.
  BASE = `http://localhost:${PORT}/benchmark/browser/index.html`;
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait until /benchmark/browser/index.html answers 200. Polling is more
  // portable than juggling python's stdout (it logs the listening line only
  // on some Python builds).
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}?lib=timeseries&size=1000`);
      if (res.ok) {
        await res.text(); // drain
        return server;
      }
    } catch { /* server not ready yet */ }
    await sleep(100);
  }
  server.kill('SIGTERM');
  throw new Error(`server failed to come up on :${PORT}`);
}

async function runCell(page, lib, size) {
  await page.goto(`${BASE}?lib=${lib}&size=${size}`, { waitUntil: 'load' });
  // window.__benchResult is set by the harness once it observes two
  // consecutive identical canvas frames (settle contract). Wait for it
  // with a generous cap so a hang fails loudly instead of returning
  // nonsense. We use page.waitForFunction + page.evaluate (not
  // handle.jsonValue) because jsonValue on a non-primitive flag returns
  // `true` rather than the object's contents — caught the hard way the
  // first time around.
  await page.waitForFunction(
    'window.__benchResult !== undefined',
    { timeout: 30000, polling: 100 },
  );
  const result = await page.evaluate(() => window.__benchResult);
  if (!result || result.error) throw new Error(`${lib}/${size}: ${result && result.error || 'no result'}`);
  if (typeof result.ttfrMs !== 'number') throw new Error(`${lib}/${size}: missing ttfrMs in ${JSON.stringify(result)}`);
  return result;
}

async function main() {
  await ensureBuilt();
  await mkdir(RESULTS_DIR, { recursive: true });
  const server = await startServer();

  const puppeteer = (await import('puppeteer')).default;
  const page = await browserPage(puppeteer);

  const cells = [];
  try {
    for (const lib of LIBS) {
      for (const size of SIZES) {
        const samples = [];
        for (let r = 0; r < RUNS; r++) {
          // Force a fresh navigation each time — back/forward cache
          // would otherwise return the previous cell's cached result.
          await page.goto('about:blank');
          try {
            samples.push(await runCell(page, lib, size));
          } catch (cellErr) {
            process.stderr.write(`  ! ${lib}/${size} run ${r + 1} failed: ${cellErr.message}\n`);
          }
        }
        if (samples.length === 0) {
          process.stderr.write(`  ! ${lib}/${size} skipped (no successful runs)\n`);
          continue;
        }
        const ttfrMed = median(samples.map(s => s.ttfrMs));
        const heaps = samples.map(s => s.heap).filter(h => h != null);
        const heapMed = heaps.length ? median(heaps) : null;
        cells.push({ lib, size, medianTtfrMs: Number(ttfrMed.toFixed(2)), medianHeapBytes: heapMed ? Number(heapMed.toFixed(0)) : null, samples });
        process.stdout.write(`  ${lib.padEnd(11)} N=${String(size).padStart(6)}  ttfr=${ttfrMed.toFixed(1).padStart(6)} ms` +
          (heapMed ? `  heap=${(heapMed/1048576).toFixed(1)} MiB` : '') + '\n');
      }
    }
  } finally {
    await page.close();
    const browser = page.browser();
    await browser.close();
    server.kill('SIGTERM');
  }

  // Persist and print the table. The Markdown table is the human-readable
  // form for the README / PR comments; the JSON is the machine form for
  // future diffing.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const latestFile = resolve(RESULTS_DIR, 'browser-latest.json');
  const tsFile = resolve(RESULTS_DIR, `browser-${ts}.json`);
  const payload = { bench: 'browser', generatedAt: new Date().toISOString(), cells };
  await writeFile(tsFile, JSON.stringify(payload, null, 2) + '\n');
  await writeFile(latestFile, JSON.stringify(payload, null, 2) + '\n');

  process.stdout.write('\n| Library    |     1k |    10k |   100k |\n');
  process.stdout.write('|------------|-------:|-------:|-------:|\n');
  for (const lib of LIBS) {
    const row = [lib.padEnd(11)];
    for (const size of SIZES) {
      const cell = cells.find(c => c.lib === lib && c.size === size);
      row.push(cell && cell.medianTtfrMs != null ? String(cell.medianTtfrMs.toFixed(1)).padStart(7) : '   n/a');
    }
    process.stdout.write(`| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |\n`);
  }
  process.stdout.write(`\nWrote ${tsFile}\nWrote ${latestFile}\n`);
}

async function browserPage(puppeteer) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 500 });
  // Mirror page console + network failures to our stdout so harness
  // load problems surface in the bench log.
  page.on('console', msg => process.stderr.write(`  [page-console:${msg.type()}] ${msg.text()}\n`));
  page.on('pageerror', err => process.stderr.write(`  [page-error] ${err.message}\n`));
  page.on('requestfailed', req => process.stderr.write(`  [req-failed] ${req.url()} ${req.failure() && req.failure().errorText}\n`));
  page.on('response', resp => { if (resp.status() >= 400) process.stderr.write(`  [${resp.status()}] ${resp.url()}\n`); });
  return page;
}

main().catch(err => {
  process.stderr.write(String(err && err.stack || err) + '\n');
  process.exit(1);
});