# Textures

The material textures in this directory come from
**[Pixel-Furnace](https://textures.pixel-furnace.com)** by Chris Ebbinger, which
offers them free for use in games, commercially or otherwise, in modified or
unmodified form. Credit is not required. This file is here anyway, because
knowing where an asset came from is worth more than the line it costs.

| file | source pack |
|---|---|
| `brick-*` | Old Red Brick |
| `concrete-*` | Dirty Concrete |
| `timber-*` | Old Wood |
| `metal-*` | Diamond Plate |
| `tile-*` | Red Tiles |
| `shingle-*` | Wooden Shingles |

These are **modified versions**: the originals are full PBR sets of up to 54 MB
each, and what is here is the albedo and normal maps only, resized to 512 and
re-encoded as JPEG — about 500 kB for the set. The game is played with a hundred
and seventy metres of ground on screen, where a fifteen-metre wall is roughly a
hundred pixels wide; nothing finer than this could ever reach the screen, and
the displacement, occlusion, specular and roughness maps have nowhere to go in a
Lambert renderer.

`npm run textures` regenerates all of it from source. The recipe, including which
maps are kept and at what scale, is `tools/textures.mjs`.

Pixel-Furnace's terms permit bundling these with a game and forbid redistributing
them as a texture collection in their own right. This directory is the former:
game-specific derivatives cut down to what this renderer loads. Anyone wanting
the textures themselves should go to the source above, where they are free.
