---
name: unity-worlds
description: Build a Unity outdoor level from a layout written as data - hills, a road, clearings, markers - then render it and look at the picture. Use when asked to make or change terrain, a map, a level blockout or an outdoor scene in Unity, or to show what a Unity scene looks like.
---

# Unity worlds from data

Write the level as functions and lists, generate the Terrain from them, capture a picture, look at it, change
the data, repeat. One round takes about fifteen seconds. Hand-painting in the editor is slower, cannot be
reviewed in a diff and is lost on the next rebuild.

Kits: `unity-driver` (run the editor), `terrain-from-data` (the builder), `shot-capture` (the picture).
Install the ones that are missing with the `gam3stack-unity-kits` skill.

## The round

```sh
# 1. edit Assets/Editor/Gam3/Gam3Layout.cs
node Tools/gam3/unity_run.mjs exec Gam3.TerrainBuilder.Build
node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture -- -gam3Scene Assets/Gam3World/World.unity -gam3Out Shots/world.png
node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture -- -gam3Scene Assets/Gam3World/World.unity \
    -gam3Out Shots/overview.png -gam3Pos -95,45,-95 -gam3Rot 22,45,0 -gam3Fov 55
# 2. open both PNGs and look at them
```

Always look at the image before saying the level is right. Take two views: the game's own camera, and a high
overview that shows the whole map. Most layout mistakes (a road that runs off the map, a hill in the play
area) only show in the overview.

## Layout rules that hold up

- **One source.** Height, road and clearing weights are functions of `(x, z)`. Terrain, paint, markers and
  later scatter all call them. Do not store a second copy of the road anywhere.
- **Metres, origin in the middle.** The builder places the terrain so world `(0, 0)` is the centre and `y` is
  the real height.
- **Weights are 0 to 1 with a soft edge.** A wobble on the edge stops the road looking ruled.
- **The paint layers of one texel must sum to 1.** The builder writes grass as what is left over.
- **Markers are names plus points.** Game code finds `Spawn_Player` by name; it does not hard-code coordinates.
- **Keep fights and paths on flat ground.** The sample keeps the middle gently rolling and raises hills only
  past the playable square.

## Unity terrain facts worth knowing

- Heights are stored 0 to 1 and indexed `[z, x]`. The builder maps the layout's lowest and highest point onto
  that range and sets the terrain's height size to the difference.
- Set `heightmapResolution` before `size`. Changing the resolution resets the size.
- Heightmap resolution is a power of two plus one (513, 1025). Paint resolution is a power of two.
- In the built-in terrain shader a layer texture's alpha is smoothness. A plain opaque colour texture makes
  the whole terrain shine; the builder writes alpha 0.
- Far from the camera Unity draws a low-resolution composite of the paint (the basemap). The builder raises
  `basemapDistance` so captures stay sharp. Lower it again if the frame rate needs it.

## What a capture can and cannot tell you

`shot-capture` renders the saved scene in edit mode. It shows shape, paint, lighting direction and framing.
It does not show anything that needs the game to run: animation, particles, physics, spawned objects, UI.
Do not judge those from it.

## Not verified here

Built and captured with the built-in render pipeline on macOS, Unity 6000.6.5f1. URP and HDRP were not run:
expect to check the terrain material and the capture colours by eye the first time.
