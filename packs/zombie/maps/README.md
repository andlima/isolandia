# Zombie maps

The start map `city` (`city.yaml`) is a 256×256 **composite** of the part
maps in `parts/` (Tiled, isometric 64×32, one tileset per part). See
[docs/packs.md](../../../docs/packs.md#composite-maps) for composites and
`populate`, and [Tiled maps](../../../docs/packs.md#tiled-maps) for the
conventions. Edit a part in Tiled and every placement changes.

## Layout of the city

A 5×5 grid of 44×44 blocks between 3-wide roads (`road_h`, `road_v`,
`crossing`), with 9 tiles of grass (`fill`) around the edge:

- **Centre block:** `town_center` at [106, 117], four houses above and
  below it. The player starts on its road, at [132, 127].
- **Downtown** (the 8 blocks around the centre): four commercial blocks
  (two `store`s, four `garage`s, eight houses) and four residential blocks.
- **Outskirts:** parks (two `park`s and eight houses) in the four corner
  blocks, residential blocks (16 houses each) elsewhere.
- **Population:** 50 shamblers and 6 crawlers per downtown block, 22
  shamblers per outer block, 12 in each strip of fields around the town,
  plus one crawler upstairs in every `house_c`. Nothing is populated in the
  centre block, so the start is clear for a while. About 960 entities.

## Parts

- **`town_center`** (44×21, 2 floors): the old town block. Four houses,
  two either side of a road that runs east–west through the middle; each
  has a kitchen, bathroom, bedroom and a hallway along the road side. The
  north-east house has stairs up to a second-floor bedroom with one
  shambler. Its player marker is ignored in the city.
- **`house_a`**, **`house_b`** (11×11): one-floor houses with a kitchen,
  bedroom and bathroom; `house_b` has broken glass at its front door.
- **`house_c`** (11×11, 2 floors): kitchen and hallway with stairs, a
  bedroom upstairs (`populate`: one crawler there per placement).
- **`store`** (22×11): room `store`, rows of shelves (cupboards) filled by
  the `store_shelf` loot table.
- **`garage`** (11×11): room `garage`, crates and a car whose glovebox
  holds garage loot.
- **`park`** (22×22): grass with road paths, hedges and a wreck.
- **`road_h`** (44×3), **`road_v`** (3×44), **`crossing`** (3×3).

Rooms (`room` objects named after their tags) drive which loot table fills
each container. Fridges facing `s` stand against a north wall, facing `n`
against a south wall.
