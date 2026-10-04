/**
 * Browser entry: load packs from the Vite glob, build the World, and run
 * the iso view at 10 ticks/s with per-frame interpolation.
 */

import { Application } from 'pixi.js';
import { loadPacks, renderPosition, World, type GotoRecord } from '../core/index.ts';
import { CameraRig } from '../iso/camera.ts';
import { groundCentreIso, isoToScreen, pickTile } from '../iso/projection.ts';
import { IsoScene } from '../iso/scene.ts';
import { loadAssetTextures, TextureBank } from '../iso/textures.ts';
import { showErrors } from './errors.ts';
import { Hud } from './hud.ts';
import { Input } from './input.ts';
import { FixedTickLoop } from './loop.ts';
import { ContextMenu } from './menu-dom.ts';
import { assetUrls, buildPackSources } from './packs.ts';
import { clickIntent, Panels } from './panels.ts';
import { parseParams } from './params.ts';

declare global {
  interface Window {
    /** Set once the first frame is drawn; used by `npm run smoke`. */
    __iso?: { ready: boolean; packs: string[]; distinctColors(): number };
  }
}

const YAML = import.meta.glob<string>('/packs/**/*.{yaml,yml}', { query: '?raw', import: 'default', eager: true });
const FILES = import.meta.glob<string>(['/packs/**/*', '!/packs/**/*.{yaml,yml}'], { query: '?url', import: 'default', eager: true });

async function main(): Promise<void> {
  const defaults = (document.body.dataset['defaultPacks'] ?? '').split(',').filter(Boolean);
  const params = parseParams(location.search, defaults);
  if (params.errors.length) return showErrors(params.errors);

  const web = buildPackSources(YAML, FILES, params.packs);
  if (web.errors.length) return showErrors(web.errors);
  const loaded = loadPacks(web.sources);
  if (!loaded.ok) return showErrors(loaded.errors);
  const def = loaded.definition;
  const world = World.create(def, params.seed);

  const app = new Application();
  await app.init({
    resizeTo: window,
    background: 0x1b1d22,
    antialias: false,
    autoStart: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.body.appendChild(app.canvas);

  const urls = assetUrls(
    def.assets,
    def.packs.map((p) => p.namespace),
    web.urls,
  );
  const textures = new TextureBank(app.renderer, def, await loadAssetTextures(def, urls));
  const scene = new IsoScene(world, textures);
  app.stage.addChild(scene.root);

  const hud = new Hud(document.body);
  const panels = new Panels(document.body, world);
  const menu = new ContextMenu(document.body, world, (id) => panels.openLoot(id));
  const rig = new CameraRig();
  const playerIso = (alpha: number) => {
    const r = renderPosition(world.player, world.tick, alpha);
    return groundCentreIso(r.x, r.y);
  };
  const tileAt = (sx: number, sy: number) => pickTile(sx, sy, rig.cam, (x, y) => world.grid.tileAt(x, y)?.raised ?? false);
  const openMenu = (sx: number, sy: number) => {
    const t = tileAt(sx, sy);
    menu.open(t.x, t.y, sx, sy);
  };

  const loop = new FixedTickLoop(
    () => {
      input.beforeTick();
      world.step();
    },
    { ticksPerSecond: def.ticksPerSecond, maxTicksPerFrame: 5 },
  );

  const input = new Input(app.canvas, world, {
    pan: (dx, dy) => {
      menu.close();
      rig.pan(dx, dy);
    },
    zoom: (sx, sy, f) => {
      menu.close();
      rig.zoom(sx, sy, f, playerIso(loop.alpha), app.screen.width, app.screen.height);
    },
    click: (sx, sy) => {
      // A press outside an open menu only closes it.
      if (menu.dismissed) {
        menu.dismissed = false;
        return;
      }
      const t = tileAt(sx, sy);
      world.queueIntent(clickIntent(world, t.x, t.y));
    },
    longPress: openMenu,
    menu: openMenu,
    captureKey: (code) => menu.key(code),
    key: (code) => {
      if (code === 'KeyH') hud.toggle();
      if (code === 'Space') rig.recenter();
      if (code === 'KeyI' || code === 'Tab') panels.toggleInventory();
      if (code === 'KeyE') {
        const iso = playerIso(loop.alpha);
        const p = isoToScreen(iso.x, iso.y, rig.cam);
        menu.open(world.player.x, world.player.y, p.x, p.y);
      }
    },
  });

  let last = performance.now();
  let lastGoto: GotoRecord | null = null;
  const frame = (now: number) => {
    input.frame(now);
    loop.advance(Math.min(now - last, 1000));
    last = now;
    if (world.ended) menu.close();
    if (world.lastGoto !== lastGoto) {
      lastGoto = world.lastGoto;
      if (lastGoto && !lastGoto.ok) scene.flashUnreachable(lastGoto.x, lastGoto.y, now);
    }
    const { width, height } = app.screen;
    const cam = rig.update(playerIso(loop.alpha), width, height);
    scene.markMenuTarget(menu.target);
    scene.update(cam, width, height, loop.alpha, now);
    hud.update(world);
    panels.update();
    app.renderer.render(app.stage);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame((now) => {
    last = now;
    frame(now);
    window.__iso = {
      ready: true,
      packs: params.packs,
      distinctColors: () => {
        const { pixels } = app.renderer.extract.pixels({ target: app.stage, frame: app.screen });
        const seen = new Set<number>();
        for (let i = 0; i < pixels.length; i += 4 * 97) seen.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
        return seen.size;
      },
    };
  });
}

main().catch((err) => {
  console.error(err);
  showErrors([`failed to start: ${err instanceof Error ? err.message : String(err)}`]);
});
