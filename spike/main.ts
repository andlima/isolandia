import { Application, type WebGLRenderer } from 'pixi.js';
import { BenchRunner } from './bench.ts';
import { Hud } from './render/hud.ts';
import { CameraController } from './render/input.ts';
import { screenToTile, worldToIso, type CameraState } from './render/iso.ts';
import { WorldView } from './render/scene.ts';
import { makeTextures } from './render/textures.ts';
import { isWalkable } from './sim/grid.ts';
import { FixedTickLoop } from './sim/loop.ts';
import { Sim } from './sim/sim.ts';
import { RollingStats } from './sim/stats.ts';
import { DEFAULT_SEED, generateWorld } from './sim/world.ts';

declare global {
  interface Window {
    __benchResult?: unknown;
  }
}

function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const v = Number.parseInt(params.get(name) ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const seed = intParam(params, 'seed', DEFAULT_SEED);
  const entityCount = Math.max(0, intParam(params, 'n', 500));
  const benchSeconds = intParam(params, 'bench', 0);
  const preference = params.get('renderer') === 'webgpu' ? 'webgpu' : 'webgl';
  const resolution = Math.min(window.devicePixelRatio || 1, 2);

  const app = new Application();
  await app.init({
    resizeTo: window,
    background: 0x1b1d22,
    antialias: false,
    autoStart: false, // we drive frames ourselves to time update + render
    resolution,
    autoDensity: true,
    preference,
  });
  document.body.appendChild(app.canvas);

  const world = generateWorld({ seed });
  const sim = new Sim(world, { entityCount, seed });
  const view = new WorldView(world, sim, makeTextures(app.renderer));
  app.stage.addChild(view.root);

  const tickStats = new RollingStats(100);
  const frameStats = new RollingStats(60);
  const cpuStats = new RollingStats(60);
  const bench = benchSeconds > 0 ? new BenchRunner(benchSeconds, world) : null;

  const loop = new FixedTickLoop(
    () => {
      const t0 = performance.now();
      sim.step();
      const t1 = performance.now();
      tickStats.push(t1 - t0);
      bench?.recordTick(t1, t1 - t0);
    },
    { ticksPerSecond: 10, maxTicksPerFrame: 5 },
  );

  const centerOn = (wx: number, wy: number, zoom: number): CameraState => {
    const p = worldToIso(wx, wy);
    return { zoom, offsetX: app.screen.width / 2 - p.x * zoom, offsetY: app.screen.height / 2 - p.y * zoom };
  };

  const hud = new Hud();
  const controller = new CameraController(
    app.canvas,
    centerOn(sim.posX[0]!, sim.posY[0]!, 1),
    (sx, sy) => {
      const tile = screenToTile(sx, sy, controller.cam);
      const ok = isWalkable(world, tile.x, tile.y) && sim.movePlayerTo(tile.x, tile.y);
      view.showTarget(tile.x, tile.y, ok, performance.now());
    },
    (key) => {
      if (key === 'h') hud.toggle();
      if (key === ' ') controller.cam = centerOn(sim.posX[0]!, sim.posY[0]!, controller.cam.zoom);
    },
  );
  controller.enabled = !bench;

  const rendererName = app.renderer.name;
  const gpu = gpuInfo(app);
  let last = performance.now();
  let lastHud = 0;
  let stats = { visibleChunks: 0, visibleEntities: 0 };

  const frame = (now: number) => {
    const dt = Math.min(now - last, 1000);
    last = now;
    const t0 = performance.now();

    loop.advance(dt);
    if (bench) {
      controller.cam = bench.camera(now, app.screen.width, app.screen.height);
    } else {
      controller.update(dt);
    }
    stats = view.update(controller.cam, app.screen.width, app.screen.height, loop.alpha, now);
    app.renderer.render(app.stage);

    const cpu = performance.now() - t0;
    frameStats.push(dt);
    cpuStats.push(cpu);
    bench?.recordFrame(now, dt, cpu, stats.visibleEntities);

    if (now - lastHud > 250) {
      lastHud = now;
      const frameMs = frameStats.avg();
      hud.update({
        fps: frameMs > 0 ? 1000 / frameMs : 0,
        frameMs,
        cpuMs: cpuStats.avg(),
        tickAvgMs: tickStats.avg(),
        tickP95Ms: tickStats.percentile(95),
        entities: entityCount,
        visibleEntities: stats.visibleEntities,
        visibleChunks: stats.visibleChunks,
        totalChunks: world.chunksX * world.chunksY,
        pathQueue: sim.queueLength,
        zoom: controller.cam.zoom,
        renderer: rendererName,
        bench: bench ? (bench.done ? 'done' : `${Math.max(0, bench.elapsed(now)).toFixed(1)}/${benchSeconds}s`) : '',
      });
    }

    if (bench && !bench.done && bench.finished(now)) {
      const result = bench.result({
        entities: entityCount,
        seed,
        pathRequests: sim.pathsTotal,
        renderer: rendererName,
        gpu,
        userAgent: navigator.userAgent,
        viewport: {
          width: app.screen.width,
          height: app.screen.height,
          devicePixelRatio: window.devicePixelRatio,
          resolution,
        },
      });
      window.__benchResult = result;
      console.log('BENCH_RESULT ' + JSON.stringify(result));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Unmasked GPU string (tells hardware GPU apart from SwiftShader/llvmpipe). */
function gpuInfo(app: Application): string {
  if (app.renderer.name !== 'webgl') return app.renderer.name;
  const gl = (app.renderer as WebGLRenderer).gl;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return String(r);
}

main().catch((err) => {
  console.error(err);
  document.body.textContent = `Failed to start: ${err}`;
});
