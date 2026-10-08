# Town maps

The start map `city` (`city.yaml`) is a 343×343 **composite** of the part
maps in `parts/` (Tiled, isometric 64×32, one tileset per part). See
[docs/packs.md](../../../docs/packs.md#composite-maps) for composites and
`populate`, and [Tiled maps](../../../docs/packs.md#tiled-maps) for the
conventions. Edit a part in Tiled and every placement changes.

Walls, doors, windows and the park hedges are [edge walls](../../../docs/packs.md#edge-walls):
each part has its cells on a `ground` layer (one per `floor N` group on
the two-floor parts) and its walls on an `edges n` and an `edges w` layer
(tile layers with the property `edge` = `n` / `w`): the tile on the north
or west side of each cell. Paint walls on those layers, never on
`ground`. The parts were converted from wall cells with `npm run
map:edges`, which kept each part's size and the coordinates of its
furniture, so rooms gained the row and column the walls used to take.

The base town has **no inhabitants**: no `spawn` objects in the parts and no
`populate` entries. Mods add them with map overrides (`spawns` on a part,
`populate` on a part or the city; see
[docs/packs.md](../../../docs/packs.md#mods-and-overrides)).

## Layout of the city

A 5×5 grid of 59×59 blocks between 5-wide roads (`road_h`, `road_v`,
`crossing`), with 9 tiles of grass (`fill`) around the edge. Block *i*
(0–4, on either axis) starts at 14 + 64·*i*; the roads run at 9 + 64·*k*.
Inside a block, buildings stand on **lots** at 2, 22 and 42 from the
block's corner, so there are at least 2 tiles of grass yard between any
two buildings and at least 1 between a building and a road.
Blocks are 59 wide (not 52, which three 15-wide lots alone would need)
so the centre block fits the 29-row `town_center` with a 15-row house lot
above and below it:

- **Centre block** ([142, 142]): `town_center` across the middle at
  [142, 157], its road joining the roads either side, and three houses
  above and three below it. The player starts on its road, at [171, 171].
- **Downtown** (the 8 blocks around the centre): four commercial blocks
  (two `store`s and two `garage`s on the first two rows, then a garage, a
  house and a garage) and four residential blocks.
- **Outskirts:** a `park` and five houses in each of the four corner
  blocks, residential blocks (nine houses, 3×3) elsewhere.

House variants cycle `house_a`, `house_b`, `house_c` in placement order.

## Parts

Every building follows the same interior rules: rooms at least 3 wide
(bathrooms 2), halls at least 2 wide, furniture against the walls, and
2×2 cells of walkable floor inside and outside each entrance.

- **`town_center`** (59×29, 2 floors): the old town block. Four houses,
  two either side of a 5-wide road that runs east–west through the middle
  (rows 12–16); each has a kitchen, bathroom and bedroom at the back and a
  3-wide hallway along the road side, with its front door onto the road.
  The north-east house has stairs at the east end of its hallway, up to a
  second-floor bedroom. Wrecked cars stand on the road, crates in the
  yards between the houses. Its player marker ([29, 14], on the road) is
  ignored in the city.
- **`house_a`** (15×15): kitchen and bedroom at the back, an entry hall
  and a bathroom at the front.
- **`house_b`** (15×15): bedroom and bathroom at the back, a kitchen
  across the front; broken glass at its front door.
- **`house_c`** (15×15, 2 floors): kitchen and a hallway with stairs, a
  bedroom upstairs; two front doors.
- **`store`** (30×15): room `store`, shelves (cupboards) along the back
  wall and two back-to-back rows in the middle with 2-wide aisles, filled
  by the `store_shelf` loot table; a double front door.
- **`garage`** (15×15): room `garage`, crates in the corners and a car
  whose glovebox and boot hold garage loot; a double door for the car.
- **`park`** (30×30): grass with a cross of 5-wide road paths, hedges and
  a wreck.
- **`road_h`** (59×5), **`road_v`** (5×59), **`crossing`** (5×5).

Each house part has one tile of grass on three sides and a front yard of
three or more rows on the door side; `town_center` has one tile of grass
around its houses.

Rooms (`room` objects named after their tags) drive which loot table fills
each container. Fridges facing `s` stand against a north wall, facing `n`
against a south wall.
