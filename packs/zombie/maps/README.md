# Zombie maps

`town.tmj` (Tiled, isometric 64×32) with its tileset `town.tsj`. See
[docs/packs.md](../../../docs/packs.md#tiled-maps) for the conventions.

- **Layout:** four houses, two either side of a road that runs east–west
  through the middle. Each house has a kitchen, bathroom, bedroom and a
  hallway along the road side; doors lead from the hallway to the street.
- **Rooms:** `room` objects (named after their tags) tag the kitchens,
  bathrooms, bedrooms and hallways. Room tags drive which loot table fills
  each container.
- **Fridges:** the `fridge` tile facing `s` stands against a north wall,
  facing `n` against a south wall.
- **Spawns:** shamblers on the road and in the yards, crawlers inside two
  of the houses; the player starts on the road.
