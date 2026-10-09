/**
 * Browser entry: resolve `?packs=` into a stack over the bundled pack
 * catalog (or show the title screen without it), load the packs from the
 * Vite glob, build the World, and run the iso view at 10 ticks/s with
 * per-frame interpolation.
 */

import { Application, type Container } from 'pixi.js';
import { journalToast, loadedNote, loadPacks, logLines, MessageLog, noteLine, Pace, renderPosition, resolveStack, World, type GotoRecord } from '../core/index.ts';
import { CameraRig } from '../iso/camera.ts';
import { FLOOR_H, groundCentreIso, isoToScreen } from '../iso/projection.ts';
import { IsoScene } from '../iso/scene.ts';
import { loadAssetTextures, TextureBank } from '../iso/textures.ts';
import { bindingFor } from './bindings.ts';
import { showErrors } from './errors.ts';
import { GamePanel } from './game-panel.ts';
import { escapeTarget, hintText, readHelpSeen, trackWindows, writeHelpSeen, type InputKind, type WindowId } from './help.ts';
import { FirstRunHint, HelpOverlay, PauseMenu } from './help-dom.ts';
import { Hud, hudTimeView, type HudTimeHandlers } from './hud.ts';
import { Hover } from './hover-dom.ts';
import { Input } from './input.ts';
import { LogView } from './log-dom.ts';
import { FixedTickLoop } from './loop.ts';
import { PerfMeter } from './perf.ts';
import { clickPlan, edgeWalkIntent } from './menu.ts';
import { ContextMenu } from './menu-dom.ts';
import { DialogueBox } from './dialogue-dom.ts';
import { assetUrls, buildPackSources, webCatalog } from './packs.ts';
import { clickIntent, Panels } from './panels.ts';
import { parseParams } from './params.ts';
import { showPicker } from './picker-dom.ts';
import { itemIconUrls, type ItemIconUrls } from './transfer.ts';
import { exportFile, gameView, loadResult, readAutoPause, restoreText, SaveSlots, storageStore, writeAutoPause, type LoadResult } from './saves.ts';

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
  readonly dialogue: DialogueBox;
  /** The last goto shown (to flash unreachable targets once). */
  lastGoto: GotoRecord | null;

  constructor(
    readonly world: World,
    stage: Container,
    textures: TextureBank,
    icons: ItemIconUrls,
    log: MessageLog,
    time: HudTimeHandlers,
  ) {
    this.scene = new IsoScene(world, textures);
    stage.addChild(this.scene.root);
    this.hud = new Hud(document.body, time);
    this.panels = new Panels(document.body, world, icons);
    this.menu = new ContextMenu(document.body, world, (id) => this.panels.openLoot(id));
    // While a conversation is open, map clicks, movement, the context menu and the transfer window are off.
    this.dialogue = new DialogueBox(document.body, world, {
      opened: () => {
        this.menu.close();
        this.panels.closeTransfer();
      },
      input: () => {
        log.push(logLines(world), performance.now());
        const toast = world.journalEvents.length ? journalToast(world.journalEvents, world) : null;
        if (toast) this.hud.toast(toast);
      },
    });
    this.lastGoto = world.lastGoto;
  }

  dispose(): void {
    this.dialogue.dispose();
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
  const icons = itemIconUrls(def, urls);
  // The message log outlives sessions: a load clears it and leaves a note.
  const log = new MessageLog();
  // Pause and speed belong to the shell: never saved, and kept across loads.
  const pace = new Pace();
  const time: HudTimeHandlers = { togglePause: () => pace.togglePause(), cycleSpeed: () => pace.cycleSpeed() };
  let session = new GameSession(World.create(def, params.seed), app.stage, textures, icons, log, time);

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
    if (session.world.conversation) return;
    const t = targetAt(sx, sy);
    session.menu.open(t.x, t.y, t.z, sx, sy, 'context', t.kind === 'edge' ? t.side : null);
  };
  const hover = new Hover(document.body, app.canvas);

  const perf = new PerfMeter();
  const loop = new FixedTickLoop(
    () => {
      input.beforeTick();
      const t0 = performance.now();
      const world = session.world;
      const tick = world.tick;
      world.step();
      perf.tick(performance.now() - t0);
      // A step that did nothing (game over, conversation open) leaves last tick's events in place.
      if (world.tick !== tick) log.push(logLines(world), performance.now());
      // `journalEvents` holds only the last tick's events: read them right after each step.
      const toast = world.journalEvents.length ? journalToast(world.journalEvents, world) : null;
      if (toast) session.hud.toast(toast);
    },
    // At speed s the cap is 5 × s (FixedTickLoop.setPace).
    { ticksPerSecond: def.ticksPerSecond, maxTicksPerFrame: 5 },
  );

  // ── Saves ────────────────────────────────────────────────────────────────
  const store = storageStore(() => window.localStorage);
  const slots = new SaveSlots(store, packs);
  let autoPause = readAutoPause(store);
  let message: string | null = null;
  let errors: readonly string[] = [];
  const refreshGame = () => {
    if (game.open) game.render(gameView(slots.metas(), message, errors));
  };
  const report = (text: string, list: readonly string[] = [], tone: 'info' | 'bad' = list.length ? 'bad' : 'info') => {
    message = text;
    errors = list;
    log.push([noteLine(session.world, text, tone)], performance.now());
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
    session = new GameSession(r.world, app.stage, textures, icons, log, time);
    log.clear();
    log.push([loadedNote(r.world)], performance.now());
    logView.setHudVisible(true);
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
      report(r.message, [], r.ok ? 'info' : 'bad');
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
    opened: () => session.panels.closeTransfer(),
    autoPause: (on) => {
      autoPause = on;
      writeAutoPause(store, on);
    },
  });
  game.setAutoPause(autoPause);
  const logView = new LogView(document.body, log, { opened: () => session.panels.closeTransfer() });

  // ── Controls overlay, pause menu, first-run hint ─────────────────────────
  // The overlay's gesture column follows the last pointer used; a coarse pointer is the first guess.
  let inputKind: InputKind = window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
  window.addEventListener('pointerdown', (ev) => (inputKind = ev.pointerType === 'touch' ? 'touch' : 'mouse'), true);
  const hint = new FirstRunHint(document.body);
  const help = new HelpOverlay(document.body, () => inputKind, {
    opened: () => {
      hint.dismiss();
      writeHelpSeen(store);
    },
  });
  const helpToggle = document.createElement('button');
  helpToggle.id = 'help-toggle';
  helpToggle.textContent = 'Help [?]';
  helpToggle.title = 'Controls (?)';
  helpToggle.addEventListener('click', () => help.toggle());
  document.body.append(helpToggle);
  const pauseMenu = new PauseMenu(document.body, {
    controls: () => help.show(),
    game: () => {
      game.show();
      refreshGame();
    },
    titleScreen: () => location.assign(location.pathname),
  });
  // The first game start in this browser: the hint shows once (again when storage is blocked) and lands in the log.
  if (!readHelpSeen(store)) {
    const text = hintText(inputKind);
    hint.show(text);
    log.push([noteLine(session.world, text)], performance.now());
    writeHelpSeen(store);
  }
  /** The open windows in opening order (`Escape` closes the last one). */
  let windowOrder: WindowId[] = [];
  const windows = () =>
    (windowOrder = trackWindows(windowOrder, {
      transfer: session.panels.transferOpen,
      crafting: session.panels.craftingOpen,
      journal: session.panels.journalOpen,
      log: logView.open,
      game: game.open,
    }));
  const closeWindow = (w: WindowId) => {
    const { panels } = session;
    if (w === 'transfer') panels.closeTransfer();
    else if (w === 'crafting') panels.closeCrafting();
    else if (w === 'journal') panels.closeJournal();
    else if (w === 'log') logView.close();
    else game.close();
  };
  /** `Escape`: the priority is `escapeTarget` (the overlay, menu and dialogue normally take the key before it gets here). */
  const escape = () => {
    const { menu, dialogue, world } = session;
    const t = escapeTarget({ help: help.open, menu: menu.isOpen, dialogue: dialogue.isOpen, windows: windows() });
    switch (t.kind) {
      case 'help':
        help.close();
        break;
      case 'menu':
        menu.close();
        break;
      case 'dialogue':
        dialogue.key('Escape');
        break;
      case 'window':
        closeWindow(t.window);
        break;
      case 'pause':
        pauseMenu.toggle(world.ended);
        break;
    }
  };

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
      if (world.conversation) return;
      const t = targetAt(sx, sy);
      // Shift-click always walks; otherwise the click plan runs the safe default or opens the menu.
      if (shift) return world.queueIntent(t.kind === 'edge' ? edgeWalkIntent(world, t.x, t.y, t.z, t.side) : clickIntent(world, t.x, t.y, t.z));
      const plan = clickPlan(world, t);
      if (plan.kind === 'run') menu.run(plan.item);
      else if (plan.kind === 'menu') menu.open(t.x, t.y, t.z, sx, sy, 'click', t.kind === 'edge' ? t.side : null);
      else if (plan.kind === 'walk') world.queueIntent(plan.intent);
    },
    hover: (p) => hover.move(p),
    longPress: openMenu,
    menu: openMenu,
    // The overlay and the pause menu take every key while open; `?` always reaches the shell, even over a menu or a conversation.
    captureKey: (code, key) => help.key(code, key) || pauseMenu.key(code, key) || (bindingFor(code, key) !== 'help' && (session.menu.key(code) || session.dialogue.key(code))),
    paused: () => pace.paused,
    // One case per binding id of `BINDINGS` (a test checks the table against these cases).
    key: (id) => {
      const { hud, panels, menu, world } = session;
      switch (id) {
        case 'pause':
          pace.togglePause();
          break;
        case 'faster':
          pace.faster();
          break;
        case 'slower':
          pace.slower();
          break;
        case 'hud':
          hud.toggle();
          logView.setHudVisible(hud.visible);
          break;
        case 'perf':
          hud.togglePerf();
          break;
        case 'recenter':
          rig.recenter();
          break;
        case 'inventory':
          panels.toggleInventory();
          break;
        case 'crafting':
          panels.toggleCrafting();
          break;
        case 'journal':
          panels.toggleJournal();
          break;
        case 'log':
          logView.toggle();
          break;
        case 'game':
          game.toggle();
          refreshGame();
          break;
        case 'quicksave':
          game.command('save', 'quick');
          break;
        case 'quickload':
          game.command('load', 'quick');
          break;
        case 'help':
          help.toggle();
          break;
        case 'escape':
          escape();
          break;
        case 'menu': {
          const iso = playerIso(loop.alpha);
          const p = isoToScreen(iso.x, iso.y, rig.cam);
          menu.open(world.player.x, world.player.y, world.player.z, p.x, p.y);
          break;
        }
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
  let wasPaused = false;
  const frame = (now: number) => {
    input.frame(now);
    pace.windows(session.panels.windowOpen || game.open || logView.open, autoPause);
    // The overlay and the pause menu pause the world (nothing is left to pause after defeat or victory).
    pace.modal((help.open || pauseMenu.open) && !session.world.ended);
    windows();
    const paused = pace.paused;
    // A movement key held into the pause must be pressed again afterwards.
    if (paused && !wasPaused) input.clearMoves();
    wasPaused = paused;
    loop.setPace(paused, pace.speed);
    const elapsed = Math.min(now - last, 1000);
    loop.advance(elapsed);
    last = now;
    const s = session;
    const { world, scene } = s;
    const timeView = hudTimeView(pace, world.ended);
    app.canvas.classList.toggle('paused', timeView.paused);
    if (world.ended) s.menu.close();
    s.dialogue.update();
    if (world.lastGoto !== s.lastGoto) {
      s.lastGoto = world.lastGoto;
      if (s.lastGoto && !s.lastGoto.ok) scene.flashUnreachable(s.lastGoto.x, s.lastGoto.y, s.lastGoto.z, now);
    }
    const { width, height } = app.screen;
    const cam = rig.update(playerIso(loop.alpha), width, height);
    scene.markMenuTarget(s.menu.target);
    const stats = scene.update(cam, width, height, loop.alpha, now);
    // Hover picks against the camera just applied; its outline shows from this frame on.
    scene.markHover(hover.update(world, targetAt, now, !s.menu.isOpen && !world.ended && !world.conversation, s.hud.visible));
    s.hud.update(world, timeView, paused ? 0 : elapsed);
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
    logView.update(now);
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
