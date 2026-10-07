/**
 * Browser entry: resolve `?packs=` into a stack over the bundled pack
 * catalog (or show the title screen without it), load the packs from the
 * Vite glob, build the World, and run the iso view at 10 ticks/s with
 * per-frame interpolation.
 */

import { Application, type Container } from 'pixi.js';
import { loadPacks, renderPosition, resolveStack, World, type GotoRecord } from '../core/index.ts';
import { CameraRig } from '../iso/camera.ts';
import { FLOOR_H, groundCentreIso, isoToScreen } from '../iso/projection.ts';
import { IsoScene } from '../iso/scene.ts';
import { loadAssetTextures, TextureBank } from '../iso/textures.ts';
import { showErrors } from './errors.ts';
import { GamePanel } from './game-panel.ts';
import { Hud } from './hud.ts';
import { Hover } from './hover-dom.ts';
import { Input } from './input.ts';
import { FixedTickLoop } from './loop.ts';
import { PerfMeter } from './perf.ts';
import { clickPlan } from './menu.ts';
import { ContextMenu } from './menu-dom.ts';
import { assetUrls, buildPackSources, webCatalog } from './packs.ts';
import { clickIntent, Panels } from './panels.ts';
import { parseParams } from './params.ts';
import { showPicker } from './picker-dom.ts';
import { exportFile, gameView, loadResult, restoreText, SaveSlots, storageStore, type LoadResult } from './saves.ts';

declare global {
  interface Window {
    /** Set once the first frame is drawn; used by `npm run smoke`. */
    __iso?: { ready: boolean; packs: string[]; distinctColors(): number; maskMs: number };
  }
}

const TEXT = import.meta.glob<string>('/packs/**/*.{yaml,yml,tmj,tsj}', { query: '?raw', import: 'default', eager: true });
const FILES = import.meta.glob<string>(['/packs/**/*', '!/packs/**/*.{yaml,yml,tmj,tsj}'], { query: '?url', import: 'default', eager: true });

/**
 * Everything bound to one running world: the scene, HUD, panels and context
 * menu. Loading a save disposes the session and builds a new one; the Pixi
 * application, textures, camera rig, input and Game panel are kept.
 */
class GameSession {
  readonly scene: IsoScene;
  readonly hud: Hud;
  readonly panels: Panels;
  readonly menu: ContextMenu;
  /** The last goto shown (to flash unreachable targets once). */
  lastGoto: GotoRecord | null;

  constructor(
    readonly world: World,
    stage: Container,
    textures: TextureBank,
  ) {
    this.scene = new IsoScene(world, textures);
    stage.addChild(this.scene.root);
    this.hud = new Hud(document.body);
    this.panels = new Panels(document.body, world);
    this.menu = new ContextMenu(document.body, world, (id) => this.panels.openLoot(id));
    this.lastGoto = world.lastGoto;
  }

  dispose(): void {
    this.menu.dispose();
    this.panels.dispose();
    this.hud.dispose();
    this.scene.destroy();
  }
}

/** Offer `text` as a file download. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function main(): Promise<void> {
  const params = parseParams(location.search);
  if (params.errors.length) return showErrors(params.errors);
  const catalog = webCatalog(TEXT);
  if (params.packs === null) return showPicker(catalog, (query) => location.assign(`${location.pathname}${query}`));
  if (catalog.errors.length) return showErrors(catalog.errors);
  const stack = resolveStack(catalog, params.packs);
  if (!stack.ok) return showErrors(stack.errors);
  /** The resolved pack directories: the key of saves, exports and imports. */
  const packs = stack.packs.map((p) => p.dir);

  const web = buildPackSources(TEXT, FILES, packs);
  if (web.errors.length) return showErrors(web.errors);
  const loaded = loadPacks(web.sources);
  if (!loaded.ok) return showErrors(loaded.errors);
  const def = loaded.definition;

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
  let session = new GameSession(World.create(def, params.seed), app.stage, textures);

  const rig = new CameraRig();
  const playerIso = (alpha: number) => {
    const w = session.world;
    const r = renderPosition(w.player, w.tick, alpha);
    const p = groundCentreIso(r.x, r.y);
    return { x: p.x, y: p.y - r.z * FLOOR_H };
  };
  /**
   * What is drawn under a screen point: the frontmost block, pile or entity
   * sprite, else the ground cell (view floor, falling through empty cells).
   * Only its cell is used; the player's own sprite gives the player's cell.
   */
  const targetAt = (sx: number, sy: number) => session.scene.pickTarget(sx, sy);
  /** Right-click, long-press: the menu with `Walk here`. */
  const openMenu = (sx: number, sy: number) => {
    const t = targetAt(sx, sy);
    session.menu.open(t.x, t.y, t.z, sx, sy);
  };
  const hover = new Hover(document.body, app.canvas);

  const perf = new PerfMeter();
  const loop = new FixedTickLoop(
    () => {
      input.beforeTick();
      const t0 = performance.now();
      session.world.step();
      perf.tick(performance.now() - t0);
    },
    { ticksPerSecond: def.ticksPerSecond, maxTicksPerFrame: 5 },
  );

  // ── Saves ────────────────────────────────────────────────────────────────
  const slots = new SaveSlots(
    storageStore(() => window.localStorage),
    packs,
  );
  let message: string | null = null;
  let errors: readonly string[] = [];
  const refreshGame = () => {
    if (game.open) game.render(gameView(slots.metas(), message, errors));
  };
  const report = (text: string, list: readonly string[] = []) => {
    message = text;
    errors = list;
    if (!game.open) game.note(text);
    refreshGame();
  };
  /** Swap in a loaded world, or list why it cannot be loaded (the current game keeps running). */
  const replace = (r: LoadResult) => {
    if (!r.ok) {
      if (r.errors.length && !game.open) game.toggle();
      return report(r.message, r.errors);
    }
    session.dispose();
    session = new GameSession(r.world, app.stage, textures);
    loop.reset();
    rig.recenter();
    message = r.message;
    errors = [];
    game.note(r.message, r.warnings);
    refreshGame();
  };
  const game = new GamePanel(document.body, {
    command: (command, slot) => {
      if (command === 'load') return replace(slots.load(slot, def));
      const r = command === 'save' ? slots.save(slot, session.world, new Date()) : slots.remove(slot);
      report(r.message);
    },
    exportFile: () => {
      const f = exportFile(session.world, packs, new Date());
      download(f.name, f.text);
      report(`Exported ${f.name}.`);
    },
    importFile: (file) => {
      file.text().then(
        (text) => replace(loadResult(restoreText(def, text), `Imported ${file.name}.`, `Cannot import ${file.name}.`)),
        (e: unknown) => report(`Cannot read ${file.name}.`, [String(e)]),
      );
    },
    titleScreen: () => location.assign(location.pathname),
  });

  const input = new Input(app.canvas, () => session.world, {
    pan: (dx, dy) => {
      session.menu.close();
      rig.pan(dx, dy);
    },
    zoom: (sx, sy, f) => {
      session.menu.close();
      rig.zoom(sx, sy, f, playerIso(loop.alpha), app.screen.width, app.screen.height);
    },
    click: (sx, sy, shift) => {
      // A press outside an open menu only closes it.
      const { menu, world } = session;
      if (menu.dismissed) {
        menu.dismissed = false;
        return;
      }
      const t = targetAt(sx, sy);
      // Shift-click always walks; otherwise the click plan runs the safe default or opens the menu.
      if (shift) return world.queueIntent(clickIntent(world, t.x, t.y, t.z));
      const plan = clickPlan(world, t);
      if (plan.kind === 'run') menu.run(plan.item);
      else if (plan.kind === 'menu') menu.open(t.x, t.y, t.z, sx, sy, 'click');
      else if (plan.kind === 'walk') world.queueIntent(plan.intent);
    },
    hover: (p) => hover.move(p),
    longPress: openMenu,
    menu: openMenu,
    captureKey: (code) => session.menu.key(code),
    key: (code) => {
      const { hud, panels, menu, world } = session;
      if (code === 'KeyH') hud.toggle();
      if (code === 'F3') hud.togglePerf();
      if (code === 'Space') rig.recenter();
      if (code === 'KeyI' || code === 'Tab') panels.toggleInventory();
      if (code === 'KeyC') panels.toggleCrafting();
      if (code === 'KeyO') {
        game.toggle();
        refreshGame();
      }
      if (code === 'F5') game.command('save', 'quick');
      if (code === 'F9') game.command('load', 'quick');
      if (code === 'KeyE') {
        const iso = playerIso(loop.alpha);
        const p = isoToScreen(iso.x, iso.y, rig.cam);
        menu.open(world.player.x, world.player.y, world.player.z, p.x, p.y);
      }
    },
    climb: (dz) => {
      const { world, menu } = session;
      menu.close();
      const intent = world.climbIntent(dz);
      if (intent) world.queueIntent(intent);
    },
  });

  let last = performance.now();
  const frame = (now: number) => {
    input.frame(now);
    loop.advance(Math.min(now - last, 1000));
    last = now;
    const s = session;
    const { world, scene } = s;
    if (world.ended) s.menu.close();
    if (world.lastGoto !== s.lastGoto) {
      s.lastGoto = world.lastGoto;
      if (s.lastGoto && !s.lastGoto.ok) scene.flashUnreachable(s.lastGoto.x, s.lastGoto.y, s.lastGoto.z, now);
    }
    const { width, height } = app.screen;
    const cam = rig.update(playerIso(loop.alpha), width, height);
    scene.markMenuTarget(s.menu.target);
    const stats = scene.update(cam, width, height, loop.alpha, now);
    // Hover picks against the camera just applied; its outline shows from this frame on.
    scene.markHover(hover.update(world, targetAt, now, !s.menu.isOpen && !world.ended, s.hud.visible));
    s.hud.update(world);
    perf.frame(now);
    if (s.hud.perfVisible) {
      const active = world.activeCount;
      s.hud.updatePerf(
        {
          tickAvg: perf.ticks.avg(),
          tickP95: perf.ticks.percentile(95),
          fps: perf.fps,
          active,
          dormant: world.entities.length - active,
          builtChunks: stats.builtChunks,
          visibleChunks: stats.visibleChunks,
        },
        now,
      );
    }
    s.panels.update();
    app.renderer.render(app.stage);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame((now) => {
    last = now;
    frame(now);
    window.__iso = {
      ready: true,
      packs,
      maskMs: textures.maskMs,
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
