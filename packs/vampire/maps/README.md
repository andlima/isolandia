# Vampire maps

`mansion.tmj` (Tiled, isometric 64×32) with its tileset `mansion.tsj`. See
[docs/packs.md](../../../docs/packs.md#tiled-maps) for the conventions.

- **Layout:** the great hall (carpet, crypts, font and coffins) in the
  middle of the upper floor plan, with side rooms to the west and east.
  Below the great hall: a library to the west, the wine cellar to the east.
- **Rooms:** `room` objects tag the `hall`, `library` and `cellar`.
- **Bookshelves** face `s`, against the north wall.
- **Sunbeams** fall through the windows; the player starts in the great
  hall.
- **Floors:** two `floor N` groups. A ladder in the library's south-east
  corner climbs to the attic study above it (room `study`): an oak chest
  and a bat.
- **Door:** a door in the great hall's north wall leads out to the grounds.

# The estate

The start map `estate` (`estate.yaml`) is a 96×96 composite: the mansion
at [37, 41] (the player starts in the great hall, [48, 45]), four
`graveyard` plots (walled crypt floor and coffins, 8 bats each) and six
village `cottage`s (a chest of heirlooms, empty bookshelves, one bat each),
both ASCII part maps. Outside is open, sunlit ground (`fill: sunbeam`), and
another 110 bats are populated over the grounds, away from the mansion.
About 150 entities.
