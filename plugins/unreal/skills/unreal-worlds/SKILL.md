---
name: unreal-worlds
description: Build an Unreal Engine level quickly from data with the engine's own procedural tools - Landscape for terrain, paint layers for roads and clearings, PCG for grass, rocks and trees, the Procedural Vegetation Editor for tree meshes. Use when asked to make or change an outdoor level, terrain, hills, roads, grass, forests or scattered props, or to speed up level building in an Unreal project.
---

# Worlds from data

Needs the `world-landscape` kit (see `gam3stack-unreal-kits`). The whole level is described in
`Tools/gam3/world/layout.py` and rebuilt with one command:

    node Tools/gam3/ue_editor.mjs start
    node Tools/gam3/world/build.mjs                     # -> GAM3WORLD: ok ... saved=true
    node Tools/gam3/ue_game.mjs --map <MAP> --shots 6 --quit 8 --cam X,Y,Z,Pitch,Yaw

## Method

1. **Write the layout as functions.** `height(x, y)`, and one weight function per paint layer (`road_w`,
   `clear_w`): 1 where the layer is, 0 where it is not, smooth in between. Keep them pure Python so they can be
   checked without the editor. Everything else reads these, so one edit moves terrain, paint and scatter together.
2. **Let the layers drive the scatter.** Landscape paint layers reach every PCG point as an attribute named after
   the layer. A `where` range on a layer is one filter node: grass where `Road` is under 0.25, short grass where
   `Clear` is high, nothing on the road.
3. **Build in stages.** `--stages terrain`, `look`, `scatter` can run alone. Lighting takes the most passes; do
   not rebuild the terrain to change the sun.
4. **Look in the game after every pass**, from the camera the game really uses. Read the screenshot. Then change
   numbers in the layout and rebuild.

## Engine tools worth knowing (all scriptable from editor Python)

| Tool | Plugin | Use |
| --- | --- | --- |
| `LandscapeEditorSubsystem` | built in | `create_landscape`, `set_heightmap_data`, `set_weightmap_data`, target layers |
| `PCGEditorSubsystem` | PCG | `create_graph`, `add_node` (by node title, settings as JSON), `connect_node_pins`, `spawn_graph_instance`, `execute_graph_instance` |
| `ProceduralVegetationEditorSubsystem` | ProceduralVegetationEditor | generate a tree from a graph and export a static mesh: `execute_graph`, `export_with_settings`, poll `get_execution_state` / `get_export_state` |
| Landmass, Landscape Patch, Water | same names | splines and patches that reshape terrain, rivers and lakes. Not used by the kit |

The names above were used on UE 5.9. Check them on your version with `help(unreal.<Class>)` through the bridge
before relying on one.

## Lessons that save hours

- **Scanned grass is small.** Clumps around 30 cm tall look like moss from a game camera. Scale 2.5 to 4 times
  and narrow them, or the blades look like corn leaves.
- **Density is a budget.** Start near 5 to 15 clumps per square metre in view, none beyond the cull distance, no
  shadows on grass. Measure frame rate before adding more.
- **Asynchronous steps.** PCG generation and tree export return at once and finish over later frames (a tree
  export can block the editor for minutes). `build.mjs` waits for the scatter; for anything else poll, then save.
- **Materials fail quietly.** A sampler type that does not match its texture stops the compile; the game then
  draws the surface grey and only the log says so. `ue_game.mjs` reports it.
- **Tall things hide the player.** With a fixed high camera, a tree between camera and player covers the action.
  Keep trees few and off the paths, or fade them.
- **The world needs an edge.** Raise hills toward the border and put invisible walls at the playable limit; the
  land should carry on past where the player can go.
- **Platform limits are real.** Check what the tree exporter supports on this machine
  (`get_export_support`): on some platforms the animated, wind-ready export is unavailable and trees are static.

## Not covered

Roads as splines, water, biomes, caves, interiors, and frame-rate tuning. The kit gives one landscape painted from
functions and a scatter graph; build on it in your project.
