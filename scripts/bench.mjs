#!/usr/bin/env node
// `npm run bench`: build, serve the build, run ?bench=<s> in Playwright
// Chromium for n=500 and n=2000, and write docs/spikes/s0-bench.json.
//
// Env: BENCH_SECONDS (default 20), BENCH_HEADED=1 (headed browser, uses the
// real GPU when available), BENCH_SEED, BENCH_N (comma-separated counts),
// BENCH_CHROMIUM (path to a Chromium/Chrome binary when Playwright's own
// download is unavailable for the host OS).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seconds = Number(process.env.BENCH_SECONDS ?? 20);
const counts = (process.env.BENCH_N ?? '500,2000').split(',').map(Number);
const seed = process.env.BENCH_SEED;
const headed = process.env.BENCH_HEADED === '1';
const outFile = resolve(root, 'docs/spikes/s0-bench.json');

await build({ root, logLevel: 'warn' });
const server = await preview({ root, preview: { port: 4174, strictPort: false, open: false }, logLevel: 'warn' });
const baseUrl = server.resolvedUrls?.local[0];
if (!baseUrl) throw new Error('vite preview did not report a URL');

const browser = await chromium.launch({
  headless: !headed,
  executablePath: process.env.BENCH_CHROMIUM || undefined,
  // Ask for GPU rasterization; headless Chromium may still fall back to
  // SwiftShader — the result's `gpu` field records what was actually used.
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const runs = [];
try {
  for (const n of counts) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', (err) => console.error(`[n=${n}] page error:`, err));
    const qs = new URLSearchParams({ bench: String(seconds), n: String(n) });
    if (seed) qs.set('seed', seed);
    const url = `${baseUrl}?${qs}`;
    console.log(`bench: ${url}`);
    await page.goto(url);
    await page.waitForFunction(() => window.__benchResult !== undefined, null, {
      timeout: (seconds + 60) * 1000,
      polling: 500,
    });
    const result = await page.evaluate(() => window.__benchResult);
    console.log(
      `  n=${n}: fps avg ${result.fpsAvg} p5 ${result.fpsP5} min ${result.fpsMin}, ` +
        `frame p95 ${result.frameMsP95} ms, tick avg ${result.tickMsAvg} p95 ${result.tickMsP95} ms, gpu ${result.gpu}`,
    );
    runs.push(result);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}

const out = {
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  browser: `chromium ${browser.version()}${headed ? ' (headed)' : ' (headless)'}`,
  seconds,
  runs,
};
await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${outFile}`);
