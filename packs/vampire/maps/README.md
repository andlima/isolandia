# Vampire maps

`mansion.tmj` (Tiled, isometric 64×32) with its tileset `mansion.tsj`. See
[docs/packs.md](../../../docs/packs.md#tiled-maps) for the conventions.
Walls, the door and the windows are [edge walls](../../../docs/packs.md#edge-walls)
on each floor's `edges n` and `edges w` layers (property `edge` = `n` /
`w`); the ground and furniture are on `ground`. The ASCII parts in
`estate.yaml` (graveyards, cottages) use the `edges: true` notation. All
were converted from wall cells with `npm run map:edges`.

- **Layout** (30×20): the great hall (carpet, a crypt-floored coffin, the
  font, two coffins by its south wall) in the middle of the upper floor
  plan, with two side rooms to the west and two to the east. Below the
  great hall, through a 4-wide corridor: a library to the west, the wine
  cellar to the east. Rooms are at least 3 wide and the furniture stands
  against the walls.
- **Rooms:** `room` objects tag the `hall`, `library` and `cellar`.
- **Bookshelves** face `s`, against the library's north wall; wine racks
  line the cellar's north and south walls.
- **Windows** are the town's `town:window` (the vampire mod depends on
  `town` and recolours it); `shutter` turns them into `shuttered_window`.
- **Sunbeams** fall through the windows; the player starts in the great
  hall, at [14, 6].
- **Floors:** two `floor N` groups. A ladder in the library's south-east
  corner climbs to the attic study above it (room `study`): an oak chest
  and a bat.
- **Door:** a door in the great hall's north wall leads out to the grounds.

# The estate

The start map `estate` (`estate.yaml`) is a 128×128 composite: the mansion
at [49, 54] (the player starts in the great hall, [63, 60]), four
`graveyard` plots (17×14: walled crypt floor, three rows of coffins with
2-wide aisles, a gate on the south side, 8 bats each) at [8, 8],
[103, 8], [8, 34] and [103, 34], and six village `cottage`s (14×10: a
chest of heirlooms and empty bookshelves against the north wall, one bat
each) along the south at y = 106, both ASCII part maps. At least 3 tiles
of open ground lie between any two parts. Outside is open, sunlit ground
(`fill: sunbeam`), and another 110 bats are populated over the grounds,
away from the mansion. About 150 entities.
