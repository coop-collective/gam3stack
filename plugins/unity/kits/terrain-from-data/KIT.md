# terrain-from-data

Two Editor scripts. `Gam3Layout.cs` is the world written as data. `Gam3Terrain.cs` turns it into a Terrain.

    node Tools/gam3/unity_run.mjs exec Gam3.TerrainBuilder.Build
    node Tools/gam3/unity_run.mjs exec Gam3.TerrainBuilder.Build -- -gam3Scene Assets/Levels/Plains/Plains.unity

The build writes a scene (default `Assets/Gam3World/World.unity`) and, next to it, a `TerrainData` asset, three
`TerrainLayer` assets and three small colour textures. Running it again rebuilds the same files in place.
The driver prints `GAM3TERRAIN: <scene> 513x513 vertices, 256 m across, y <low>..<high> m, markers <n>`.

## The idea

The layout has three plain functions: `Height(x, z)`, `RoadWeight(x, z)` and `ClearWeight(x, z)`. Roads are
lists of points, clearings are circles, markers are named points. The builder samples the functions at every
terrain vertex and paint texel. Change one road point and the worn track, the dirt paint and the marker heights
all follow, because they all ask the same functions. Nothing is hand-painted, so nothing is lost on a rebuild.

What the sample layout makes: rolling ground 256 m across, hills rising at the edges, a dirt road with a fork,
a flat-topped knoll for a landmark, four trodden clearings and four markers.

## Adapting it

- Edit `Gam3Layout.cs` only. Units are metres, the origin is the middle of the terrain.
- Scatter (trees, rocks, grass) is not included. Add it in the builder by asking the layout, for example
  "no trees where `RoadWeight` is above 0.3". Keep the rule in data, not in a painted mask.
- The paint layers are plain colours with a little grain, so the kit needs no downloads. Swap in real textures
  by changing `Layer()` in the builder; it re-assigns its layers on every run.
- The builder also aims the scene's sun and main camera. Delete that block when you have your own.

## Limits

- Tested on macOS with Unity 6000.6.5f1 and the built-in render pipeline. Under URP or HDRP the builder asks the
  pipeline for its default terrain material; that path was not run here.
- One terrain tile. A world larger than about 1 km wants several tiles, which this does not do.
- The whole scene is rebuilt: objects placed by hand in that scene are gone after a rebuild. Put hand-placed
  work in a second scene loaded additively, or add it to the builder.
- Unity creates the `.meta` files on the next open or compile. Commit them with the scripts.
