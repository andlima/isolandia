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
