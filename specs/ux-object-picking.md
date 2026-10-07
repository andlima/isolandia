---
id: ux-object-picking
area: iso
priority: 40
depends_on: []
description: UX — pick what is drawn under the pointer, not the floor diamond under it — per-texture alpha hit masks, a pure frontmost-sprite hit test over raised tiles, ground piles and entities (cutaway-faded blocks click through), falling back to today's pickCell; used by left click, right-click and long-press
---

# UX — Pick the object under the pointer

## Goal

Today the browser turns a pointer position into a cell with `pickCell`
(`src/iso/projection.ts`): the ground diamond under the point, or the top
face of a raised block. A tall sprite (fridge, wall, car, character) covers the cells *behind* it on screen, so clicking the upper
half of a fridge's front picks the floor behind the fridge. The player
aims at what they see, and the game answers about something else. Every
interaction goes through this, so it is the first thing to fix.

This spec makes picking **sprite-accurate**: the target is the frontmost
drawn sprite whose opaque pixels contain the point, and only when no
sprite is hit does it fall back to today's ground pick. It changes no
simulation code.

Playable result: in `zombie`, right-click the top half of a fridge and the
menu is for that fridge; left-click the head
of a zombie standing in front of a wall and the survivor walks toward the
zombie's cell, not the wall's. Clicking through a wall that the cutaway
has faded in front of the player picks the room behind it.

## Acceptance Criteria

### Hit masks

1. **One mask per texture.** Every texture the renderer draws for a tile,
   archetype or item (loaded SVG/PNG assets, each direction of a
   directional asset, and generated placeholders) gets a **hit mask** built
   once, when the `TextureBank` is created: a bitmap of which pixels are
   opaque (alpha ≥ 0.5), sampled on the texture's **art-pixel grid** (2×2
   screen px at zoom 1, see `docs/art.md`; PNGs at their own pixel size).
   Drop shadows and glass (low `fill-opacity`) are therefore not hits.
   - Masks are computed from the texture's pixels (e.g. via a canvas or
     the renderer's extract), not from the SVG source, so PNG and
     placeholder textures work the same way.
   - A mirrored facing (see `iso-directional-sprites`) uses its partner's
     mask flipped around the anchor spot.
   - Memory: a mask is at most one bit or byte per art pixel; building all
     masks for the largest shipped stack adds no more than ~50 ms to
     startup on the dev machine (note the measurement in the PR).
2. The mask type and its lookups live in a pure module (e.g.
   `src/iso/hit.ts`) with no Pixi or DOM types, so it is unit-tested with
   hand-made masks.

### Hit test

3. **`hitTest(point, candidates)`** (pure) returns the frontmost candidate
   whose mask contains the point, or null. A candidate is `{ bounds,
   mask, mirrored, order, target }`, where `bounds` is the sprite's screen
   (or iso) rectangle, `order` is its draw order and `target` is what it
   stands for:
   - `{ kind: 'tile', x, y, z }` for a raised tile sprite;
   - `{ kind: 'pile', x, y, z, container }` for a ground pile;
   - `{ kind: 'entity', x, y, z, entity }` for an entity (its simulation
     cell, even while its sprite is interpolated between cells).

   "Frontmost" uses the scene's existing draw order: floor, then the
   diagonal bucket, then `depthKey` within it (see `src/iso/depth.ts`).
4. **`scene.pickTarget(sx, sy)`** (or an equivalent on the scene/session)
   gathers candidates from the sprites that are actually drawn:
   - only floors that are visible (the view floor and the floors below it;
     floors above are cut away and never hit);
   - only sprites in built, visible chunks; entity and pile sprites at
     their **rendered** position (`renderPosition`);
   - **blocks faded by the cutaway** (`fadeCells`) are skipped, so the
     pointer reaches what is behind them;
   - the search is bounded: only cells whose sprites could reach the
     point (the diagonals below the point within the tallest texture's
     height), not the whole chunk.

   If no candidate is hit, it returns `{ kind: 'ground', x, y, z }` from
   today's `pickCell` (floor fall-through included), unchanged.
5. A `PickTarget` always carries a cell `(x, y, z)`. Callers that only need
   a cell use that, so existing code paths keep their shape.

### Wiring

6. **Left click**, **right-click** and **touch long-press** in
   `src/web/main.ts` use `pickTarget` instead of `tileAt`/`pickCell`:
   - left click walks to the target's cell with `clickIntent`, exactly as
     today (a raised or container cell still uses `adjacent: true`);
   - the context menu opens for the target's cell;
   - picking the **player's own sprite** targets the player's cell (same
     as pressing `E`).
7. A pick costs little enough to run on every pointer move (a later spec
   uses it for hover): no per-call allocation proportional to the number
   of sprites, and a microbenchmark or test asserts a pick on the 256×256
   `zombie` city stays well under 1 ms in Node with synthetic masks.

### Tests and docs

8. Headless tests (no Pixi needed, synthetic masks and candidates) cover:
   - the upper part of a 64×64 block's front face hits that block, not the
     cell behind it;
   - a character's head in front of a wall hits the entity;
   - a transparent pixel inside a sprite's bounds falls through to the
     next candidate, and a drop-shadow pixel (alpha < 0.5) is not a hit;
   - a mirrored mask;
   - a faded block is skipped;
   - floors above the view floor are ignored and the ground fallback
     still falls through empty cells to lower floors (existing
     `pickCell` tests keep passing).
9. **Docs.** `docs/iso.md` describes picking (masks, frontmost sprite,
   cutaway click-through, ground fallback). `docs/ui.md` says that clicks
   target the object drawn under the pointer.

## Out of Scope

- Hover highlight, cursor changes and tooltips (`ux-smart-click`).
- Changing what a click *does* (still: left walks, right opens the menu).
- Entity interactions (talking, attacking): an entity target only
  resolves to its cell here.
- Picking in the ASCII shell.

## Design Notes

- Today's code: `pickTile`/`pickCell` in `src/iso/projection.ts`, `tileAt`
  in `src/web/main.ts`, sprite creation in `src/iso/scene.ts`, textures in
  `src/iso/textures.ts` (`SVG_RESOLUTION`, placeholders, mirroring).
- Masks at art-pixel resolution keep them small and make the hit test
  independent of `SVG_RESOLUTION` and zoom: convert the point into the
  sprite's local art-pixel coordinates with the camera zoom and the
  sprite's anchor.
- The candidate search can walk diagonals: the point's ground diamond row
  and the next few rows *in front of* it (higher `x + y`), since only
  sprites rooted in front of or at a cell can rise over it on screen.

## Agent Notes

- Read `docs/iso.md` (projection, depth, cutaway) and `docs/art.md`
  (sizes and anchors) first.
- Keep `pickCell` and its tests: it is the fallback.
- `npm run smoke` is not a verify gate but is worth running to see that
  clicks still work on every shipped stack.
