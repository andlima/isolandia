#!/usr/bin/env node
// `npm run smoke`: build, serve the build, and open each genre combo in
// Playwright Chromium. Fails on console errors or page errors, on a blank
// canvas, or when the load-error screen shows up; saves screenshots under
// docs/screens/. Also checks that an unknown pack shows the error screen.
//
// Not a verify gate (needs a browser). Env: BENCH_CHROMIUM (path to a
// Chromium/Chrome binary when Playwright's own download is unavailable),
// SMOKE_HEADED=1 (headed browser).
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'docs/screens');
const combos = [
  ['std', 'std-needs', 'zombie'],
  ['std', 'vampire'],
  ['std', 'garden'],
];

await build({ root, logLevel: 'warn' });
const server = await preview({ root, preview: { port: 4175, strictPort: false, open: false }, logLevel: 'warn' });
const baseUrl = server.resolvedUrls?.local[0];
if (!baseUrl) throw new Error('vite preview did not report a URL');
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: process.env.SMOKE_HEADED !== '1',
  executablePath: process.env.BENCH_CHROMIUM || undefined,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const failures = [];
try {
  for (const packs of combos) {
    const name = packs.join('+');
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const problems = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    const url = `${baseUrl}?packs=${packs.join(',')}&seed=1`;
    console.log(`smoke: ${url}`);
    await page.goto(url);
    try {
      await page.waitForFunction(() => window.__iso?.ready || document.getElementById('errors'), null, { timeout: 30_000 });
    } catch {
      problems.push('timed out waiting for the first frame');
    }
    const errorScreen = await page.$('#errors');
    if (errorScreen) problems.push(`load errors:\n${await errorScreen.textContent()}`);
    else {
      // Walk a little (keyboard) and click a tile, then let it settle.
      await page.keyboard.down('KeyD');
      await page.waitForTimeout(600);
      await page.keyboard.up('KeyD');
      await page.mouse.click(700, 460);
      await page.waitForTimeout(800);
      const colors = await page.evaluate(() => window.__iso?.distinctColors() ?? 0);
      console.log(`  ${name}: ${colors} distinct colors sampled`);
      if (colors < 6) problems.push(`canvas looks blank (${colors} distinct colors)`);
      const hud = await page.textContent('#hud');
      if (!hud || !/Time: Day \d+ \d\d:\d\d/.test(hud)) problems.push(`HUD missing or malformed: ${JSON.stringify(hud)}`);
    }
    const shot = resolve(outDir, `${name}.png`);
    await page.screenshot({ path: shot });
    console.log(`  wrote ${shot}`);
    for (const p of problems) failures.push(`[${name}] ${p}`);
    await page.close();
  }

  // An unknown pack name shows the error list instead of the game.
  const page = await browser.newPage();
  await page.goto(`${baseUrl}?packs=std,nosuchpack`);
  await page.waitForSelector('#errors', { timeout: 15_000 }).catch(() => null);
  const text = (await page.textContent('#errors').catch(() => null)) ?? '';
  if (!text.includes("unknown pack 'nosuchpack'")) failures.push(`[error screen] expected an unknown-pack error, got ${JSON.stringify(text)}`);
  await page.close();
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}

if (failures.length) {
  console.error(`\nsmoke FAILED:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('\nsmoke OK');
