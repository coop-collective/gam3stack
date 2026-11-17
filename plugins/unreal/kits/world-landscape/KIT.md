# world-landscape

A level built from one data file with the engine's own tools: Landscape for the ground, paint layers for roads
and clearings, PCG for everything scattered on it.

    node Tools/gam3/ue_editor.mjs start
    node Tools/gam3/world/build.mjs              # build, wait for the scatter, save
    # -> GAM3WORLD: ok map=L_Gam3World actors=... scatter_instances=... saved=true

## The idea

`Tools/gam3/world/layout.py` holds the world as plain Python: `height(x, y)` and one weight function per paint
layer (`road_w`, `clear_w`), plus lists for scatter and lighting. It imports nothing from the engine, so it can be
read and tested anywhere. `build_world.py` samples those functions at every landscape vertex.

Because everything reads the same functions, moving a road point moves the worn ground, the paint, and the gap in
the grass together. The paint layers arrive on every PCG point as attributes with the layer's name, so "no grass on
the road" is one filter on `Road`, not custom code.

## Adapting

1. Set `MAP` and `ROOT`, then replace the example functions with your world.
2. Put real meshes in `SCATTER`. The example uses an engine cone so it runs in an empty project. Scanned grass
   is small (clumps around 30 cm): scale it up 2.5 to 4 times and expect to narrow it.
3. Swap the plain-colour ground material for textures. Set each texture sampler's type to match its texture, or the
   material fails to compile and the ground draws flat grey in the game.
4. Look at the result in the game (`ue_game.mjs` with the shot-director kit). Editor captures are darker.
5. Trees: the engine's Procedural Vegetation Editor plugin can generate them and export static meshes; add the
   exported mesh to `SCATTER` or place it from a list of points. That step is not part of this kit.

## Limits

- `terrain` deletes every Landscape in the level and builds a new one. It is meant for a level this kit owns.
- Heights are computed in Python for every vertex: 253 x 253 is quick, 1009 x 1009 takes a while.
- Scatter generation is asynchronous; `build.mjs` waits until the instance count stops changing. Hundreds of
  thousands of instances are possible, but frame rate is yours to measure.
- No roads as splines, no water, no biomes: one landscape, painted from functions.
