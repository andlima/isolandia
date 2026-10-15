#!/usr/bin/env node
// `npm run bench`: build, serve the build, and run the benchmark targets in
// Chromium (launched by Playwright, or an already running browser attached
// over CDP), writing one JSON per target to docs/bench/<target>.json and
// printing a one-line summary per run.
//
// Targets (BENCH_TARGETS, comma-separated; default `spike,zombie,vampire`):
// `spike` is spike.html?bench=<s> for each BENCH_N count (default 500,2000;
// 20 s), any other name is a game: index.html?packs=<name>&bench=<s> (60 s;
// the stack resolver adds the game's dependencies, as `npm run smoke`).
//
// Env: BENCH_SECONDS (every target), BENCH_SEED, BENCH_N, BENCH_HEADED=1
// (a headed launched browser, uses the real GPU when there is one),
// BENCH_CHROMIUM=<path> (a Chromium/Chrome binary when Playwright's own
// download is unavailable), BENCH_CDP=<http://host:port | ws://…> (attach to
// a running browser's DevTools endpoint instead of launching; only the
// context this script opens is closed), BENCH_HOST (the address the Vite
// preview binds, default localhost; 0.0.0.0 for the LAN), BENCH_PUBLIC_URL
// (the base URL the browser opens, default the preview's own URL),
// BENCH_VIEWPORT=WxH (default 1920x1080 for a launched browser; an attached
// one keeps its window size unless given).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = (process.env.BENCH_TARGETS ?? 'spike,zombie,vampire').split(',').map((s) => s.trim()).filter(Boolean);
const secondsEnv = process.env.BENCH_SECONDS ? Number(process.env.BENCH_SECONDS) : null;
if (secondsEnv !== null && !(secondsEnv > 0)) throw new Error(`BENCH_SECONDS expects a positive number, got '${process.env.BENCH_SECONDS}'`);
const counts = (process.env.BENCH_N ?? '500,2000').split(',').map(Number);
const seed = process.env.BENCH_SEED;
const headed = process.env.BENCH_HEADED === '1';
const cdp = process.env.BENCH_CDP || null;
const host = process.env.BENCH_HOST || 'localhost';
const outDir = resolve(root, 'docs/bench');

/** `WxH` → `{ width, height }`. */
function parseViewport(s) {
  const m = /^(\d+)x(\d+)$/i.exec(s.trim());
  if (!m) throw new Error(`BENCH_VIEWPORT expects WxH (e.g. 1920x1080), got '${s}'`);
  return { width: Number(m[1]), height: Number(m[2]) };
}
// A launched browser gets a fixed viewport; an attached one keeps its own window size unless told otherwise.
const viewport = process.env.BENCH_VIEWPORT ? parseViewport(process.env.BENCH_VIEWPORT) : cdp ? null : { width: 1920, height: 1080 };

await build({ root, logLevel: 'warn' });
const server = await preview({ root, preview: { host, port: 4174, strictPort: false, open: false }, logLevel: 'warn' });
const served = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
if (!served) throw new Error('vite preview did not report a URL');
const baseUrl = process.env.BENCH_PUBLIC_URL ? process.env.BENCH_PUBLIC_URL.replace(/\/?$/, '/') : served;
if (baseUrl !== served) console.log(`bench: serving ${served} (and ${server.resolvedUrls?.network.join(', ') || 'no network URL'}), the browser opens ${baseUrl}`);

let browser;
let context;
if (cdp) {
  console.log(`bench: attaching to ${cdp}`);
  browser = await chromium.connectOverCDP(cdp);
  // `contexts()[0]` is the user's own; everything this script opens lives in a fresh context.
  context = await browser.newContext({ viewport });
} else {
  browser = await chromium.launch({
    headless: !headed,
    executablePath: process.env.BENCH_CHROMIUM || undefined,
    // Ask for GPU rasterization; headless Chromium may still fall back to
    // SwiftShader or llvmpipe — the result's `gpu` field records what was used.
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  context = await browser.newContext({ viewport });
}
const browserLabel = `chromium ${browser.version()} ${cdp ? '(attached)' : headed ? '(headed)' : '(headless)'}`;

/** Open `url` in a new page of the context and wait for its `window.__benchResult`. */
async function runPage(url, label, seconds) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`[${label}] page error:`, err));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[${label}] console error: ${m.text()}`);
  });
  console.log(`bench: ${url}`);
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__benchResult !== undefined || document.getElementById('errors') !== null, null, {
      timeout: (seconds + 90) * 1000,
      polling: 500,
    });
    const errors = await page.$('#errors');
    if (errors) throw new Error(`[${label}] the page showed errors:\n${await errors.textContent()}`);
    return await page.evaluate(() => window.__benchResult);
  } finally {
    await page.close();
  }
}

const fmt = (r) => `fps avg ${r.fpsAvg} p5 ${r.fpsP5} min ${r.fpsMin}, frame p95 ${r.frameMsP95} ms, tick avg ${r.tickMsAvg} p95 ${r.tickMsP95} ms`;
const failures = [];
try {
  for (const target of targets) {
    const seconds = secondsEnv ?? (target === 'spike' ? 20 : 60);
    const runs = [];
    try {
      if (target === 'spike') {
        for (const n of counts) {
          const qs = new URLSearchParams({ bench: String(seconds), n: String(n) });
          if (seed) qs.set('seed', seed);
          const r = await runPage(`${new URL('spike.html', baseUrl)}?${qs}`, `spike n=${n}`, seconds);
          console.log(`  spike n=${n}: ${fmt(r)}, gpu ${r.gpu}`);
          runs.push(r);
        }
      } else {
        const qs = new URLSearchParams({ packs: target, bench: String(seconds) });
        if (seed) qs.set('seed', seed);
        const r = await runPage(`${new URL('index.html', baseUrl)}?${qs}`, target, seconds);
        console.log(
          `  ${target}: ${fmt(r)}, cpu avg ${r.cpuMsAvg} ms, ticks ${r.ticks}, dropped ${r.droppedMs} ms, ` +
            `sweep ${r.phases.sweep.fpsAvg} fps / overview ${r.phases.overview.fpsAvg} fps, ` +
            `chunks built max ${r.builtChunksMax}, entities visible avg ${r.visibleEntitiesAvg} of ${r.entities}, ${r.renderer} ${r.gpu}`,
        );
        runs.push(r);
      }
    } catch (err) {
      failures.push(`[${target}] ${err instanceof Error ? err.message : String(err)}`);
      console.error(`bench: ${target} failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const out = {
      generatedAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version },
      browser: browserLabel,
      seconds,
      runs,
    };
    const outFile = resolve(outDir, `${target}.json`);
    await mkdir(outDir, { recursive: true });
    await writeFile(outFile, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${outFile}`);
  }
} finally {
  // Only what this script opened: the context (and, when launched, the browser; attached, this just disconnects).
  await context.close();
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}

if (failures.length) {
  console.error(`\nbench FAILED:\n${failures.join('\n')}`);
  process.exit(1);
}
