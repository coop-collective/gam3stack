"""Build the level described by layout.py with the engine's own tools. Runs inside an open editor.

Do not run this file directly: `node Tools/gam3/world/build.mjs` runs it stage by stage, waits for the scatter to
finish generating, saves, and reports. Stages (comma separated in the environment variable GAM3_WORLD_STAGES):

  terrain  Landscape actor: heights and one paint layer per LAYERS entry, plus a colour-blend ground material
  look     sun, sky atmosphere, sky light, height fog, a post process volume with locked exposure
  scatter  one PCG graph with a chain per SCATTER entry, on a volume over the landscape (generation continues on
           later editor frames after this script returns)
  status   counts only: actors, scatter instances. Used to tell when generation has finished.
  save     save the level and everything under ROOT. Refuses unless the level open in the editor is MAP.

The result is the JSON string RESULT on the last line. Errors come back in it as a traceback: a script run
through the editor's MCP tool otherwise fails without saying why.
"""
import importlib
import json
import os
import sys
import traceback

import unreal

HERE = os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()), "Tools", "gam3", "world")
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import layout as L  # noqa: E402

importlib.reload(L)   # the editor keeps modules loaded between calls: pick up edits to the layout

STAGES = [s for s in os.environ.get("GAM3_WORLD_STAGES", "terrain,look,scatter").split(",") if s]
MAP_NAME = L.MAP.rsplit("/", 1)[-1]
MATS = L.ROOT + "/Materials"

eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
ues = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
mel = unreal.MaterialEditingLibrary
STATS = {"stages": STAGES, "notes": []}


def note(msg):
    STATS["notes"].append(str(msg))


def setp(obj, name, value):
    """Property names differ a little between engine versions: report a miss, do not stop the build."""
    try:
        obj.set_editor_property(name, value)
    except Exception as e:  # noqa: BLE001
        note(f"could not set {obj.get_class().get_name()}.{name}: {e}")


def current_map():
    return ues.get_editor_world().get_name()


def open_level():
    if current_map() == MAP_NAME:
        return
    if unreal.EditorAssetLibrary.does_asset_exist(L.MAP):
        les.load_level(L.MAP)
    else:
        les.new_level(L.MAP)


def clear(folder=None, labels=()):
    n = 0
    for a in list(eas.get_all_level_actors()):
        if (folder and str(a.get_folder_path()).startswith(folder)) or a.get_actor_label() in labels:
            eas.destroy_actor(a)
            n += 1
    return n


def asset(name, folder, cls, factory):
    path = f"{folder}/{name}"
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        return unreal.load_asset(path)
    return unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, cls, factory)


# ---------------------------------------------------------------------------------------------------- terrain
def ground_material():
    """M_Ground: BASE_COLOR with each layer's colour blended over it by that layer's painted weight.

    Plain colours on purpose, so it works in an empty project. To use textures, sample them with
    MaterialExpressionLandscapeLayerCoords as UVs and set each sampler's type to match its texture (colour,
    normal, virtual texture variants): a wrong sampler type fails the compile and the ground draws flat grey.
    """
    mat = asset("M_Ground", MATS, unreal.Material, unreal.MaterialFactoryNew())
    mel.delete_all_material_expressions(mat)

    def node(cls, x, y, **props):
        n = mel.create_material_expression(mat, cls, x, y)
        for k, v in props.items():
            n.set_editor_property(k, v)
        return n

    def colour(c, y):
        return node(unreal.MaterialExpressionConstant3Vector, -900, y, constant=unreal.LinearColor(c[0], c[1], c[2], 1.0))

    out = colour(L.BASE_COLOR, 0)
    for i, (name, (_fn, c)) in enumerate(L.LAYERS.items()):
        y = 220 * (i + 1)
        weight = node(unreal.MaterialExpressionLandscapeLayerSample, -900, y + 110, parameter_name=name)
        lerp = node(unreal.MaterialExpressionLinearInterpolate, -500 + 200 * i, y)
        mel.connect_material_expressions(out, "", lerp, "A")
        mel.connect_material_expressions(colour(c, y), "", lerp, "B")
        mel.connect_material_expressions(weight, "", lerp, "Alpha")
        out = lerp
    rough = node(unreal.MaterialExpressionConstant, -300, -150, r=0.92)
    mel.connect_material_property(out, "", unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(mat)
    unreal.EditorAssetLibrary.save_asset(f"{MATS}/M_Ground")
    return mat


def build_terrain():
    lsub = unreal.get_editor_subsystem(unreal.LandscapeEditorSubsystem)
    for land in list(lsub.get_landscapes()):
        lsub.delete_landscape(land)
    mat = ground_material()
    n = L.RES
    land = lsub.create_landscape(unreal.Vector(0, 0, 0), unreal.Rotator(), unreal.Vector(L.QUAD, L.QUAD, 100.0),
                                 unreal.IntPoint(L.COMPONENTS, L.COMPONENTS), 1, 63, mat)
    land.set_actor_label("Landscape")
    heights = []
    weights = {name: [] for name in L.LAYERS}
    for iy in range(n):
        y = -L.HALF + iy * L.QUAD
        for ix in range(n):
            x = -L.HALF + ix * L.QUAD
            heights.append(L.height(x, y))
            for name, (fn, _c) in L.LAYERS.items():
                weights[name].append(min(1.0, max(0.0, fn(x, y))))
    lsub.set_heightmap_data(land, "Layer", heights)
    have = [str(x) for x in lsub.get_target_layer_names(land)]
    for name, data in weights.items():
        info_path = f"{L.ROOT}/Landscape/{name}_LayerInfo"
        info = unreal.load_asset(info_path) if unreal.EditorAssetLibrary.does_asset_exist(info_path) else \
            lsub.create_target_layer_info(name, f"{L.ROOT}/Landscape")
        if name in have:
            lsub.set_target_layer_info(land, name, info)
        else:
            lsub.add_target_layer(land, name, info)
        lsub.set_weightmap_data(land, "Layer", name, data)
        unreal.EditorAssetLibrary.save_asset(info_path)
    STATS["terrain"] = {"vertices": f"{n}x{n}", "quad_cm": L.QUAD, "z_min": round(min(heights)), "z_max": round(max(heights)),
                        "layers": list(weights)}


# ---------------------------------------------------------------------------------------------------- look
def build_look():
    clear(folder="Lighting")
    cfg = L.LOOK
    sun_cfg = cfg["sun"]
    sun = eas.spawn_actor_from_class(unreal.DirectionalLight, unreal.Vector(0, 0, 3000),
                                     unreal.Rotator(roll=0.0, pitch=sun_cfg["pitch"], yaw=sun_cfg["yaw"]))
    sun.set_actor_label("Sun")
    sun.set_folder_path("Lighting")
    c = sun.light_component
    setp(c, "mobility", unreal.ComponentMobility.MOVABLE)
    setp(c, "intensity", sun_cfg["intensity"])
    col = sun_cfg.get("color", (255, 255, 255))
    setp(c, "light_color", unreal.Color(r=int(col[0]), g=int(col[1]), b=int(col[2]), a=255))
    setp(c, "light_source_angle", sun_cfg.get("source_angle", 1.0))
    setp(c, "atmosphere_sun_light", True)

    sky = eas.spawn_actor_from_class(unreal.SkyAtmosphere, unreal.Vector(0, 0, 0), unreal.Rotator())
    sky.set_actor_label("SkyAtmosphere")
    sky.set_folder_path("Lighting")

    sl = eas.spawn_actor_from_class(unreal.SkyLight, unreal.Vector(0, 0, 2000), unreal.Rotator())
    sl.set_actor_label("SkyLight")
    sl.set_folder_path("Lighting")
    c = sl.light_component
    setp(c, "mobility", unreal.ComponentMobility.MOVABLE)
    setp(c, "real_time_capture", True)
    setp(c, "intensity", cfg.get("skylight", {}).get("intensity", 1.0))

    fc = cfg.get("fog", {})
    fog = eas.spawn_actor_from_class(unreal.ExponentialHeightFog, unreal.Vector(0, 0, 0), unreal.Rotator())
    fog.set_actor_label("HeightFog")
    fog.set_folder_path("Lighting")
    f = fog.get_component_by_class(unreal.ExponentialHeightFogComponent)
    setp(f, "fog_density", fc.get("density", 0.02))
    setp(f, "fog_height_falloff", fc.get("falloff", 0.2))
    setp(f, "start_distance", fc.get("start", 0.0))
    setp(f, "enable_volumetric_fog", bool(fc.get("volumetric", False)))

    ppv = eas.spawn_actor_from_class(unreal.PostProcessVolume, unreal.Vector(0, 0, 0), unreal.Rotator())
    ppv.set_actor_label("PostProcess")
    ppv.set_folder_path("Lighting")
    ppv.set_editor_property("unbound", True)
    s = ppv.settings
    for k, v in {
        "auto_exposure_method": unreal.AutoExposureMethod.AEM_MANUAL,
        "auto_exposure_apply_physical_camera_exposure": False,
        "auto_exposure_bias": cfg.get("exposure_bias", 0.0),
    }.items():
        setp(s, "override_" + k, True)
        setp(s, k, v)
    ppv.set_editor_property("settings", s)
    STATS["look"] = {"sun": [sun_cfg["yaw"], sun_cfg["pitch"], sun_cfg["intensity"]], "exposure_bias": cfg.get("exposure_bias", 0.0)}


# ---------------------------------------------------------------------------------------------------- scatter
def _threshold(settings, prop, value):
    th = settings.get_editor_property(prop)
    th.set_editor_property("use_constant_threshold", True)
    c = th.get_editor_property("attribute_types")
    c.set_editor_property("type", unreal.PCGMetadataTypes.DOUBLE)
    c.set_editor_property("double_value", float(value))
    th.set_editor_property("attribute_types", c)
    settings.set_editor_property(prop, th)


def build_scatter():
    clear(folder="Scatter")
    if not L.SCATTER:
        STATS["scatter"] = "none in the layout"
        return
    pcg = unreal.get_editor_subsystem(unreal.PCGEditorSubsystem) if hasattr(unreal, "PCGEditorSubsystem") else None
    if pcg is None:
        STATS["scatter"] = "skipped: enable the PCG plugin in the .uproject and restart the editor"
        return
    folder, name = L.ROOT + "/PCG", "PCG_World"
    if unreal.EditorAssetLibrary.does_asset_exist(f"{folder}/{name}"):
        unreal.EditorAssetLibrary.delete_asset(f"{folder}/{name}")
    g = pcg.create_graph(name, folder)

    def add(kind, label, params, x, y):
        return pcg.add_node(g, kind, label, json.dumps(params), "", "", x, y)

    land = add("Get Landscape Data", "Land", {}, 0, 0)
    for row, entry in enumerate(L.SCATTER):
        tag, y = entry["name"], 300 * row
        e = float(entry.get("extents", 25.0))
        last = add("Surface Sampler", f"Sample{tag}", {"pointsPerSquaredMeter": entry["per_m2"],
                                                       "pointExtents": {"x": e, "y": e, "z": e}, "looseness": 1.0}, 300, y)
        pcg.connect_node_pins(land, "Out", last, "Surface")
        pin, x = "Out", 600
        for layer, (lo, hi) in entry.get("where", {}).items():
            if layer not in L.LAYERS:
                raise ValueError(f"scatter {tag}: no paint layer named {layer}")
            flt = add("Filter Attribute Elements by Range", f"{tag}_{layer}", {"targetAttribute": layer}, x, y)
            pcg.connect_node_pins(last, pin, flt, "In")
            st = flt.get_settings()
            _threshold(st, "min_threshold", lo)
            _threshold(st, "max_threshold", hi)
            last, pin, x = flt, "InsideFilter", x + 300
        s0, s1 = entry.get("scale", (1.0, 1.0))
        xf = add("Transform Points", f"Vary{tag}", {
            "rotationMin": {"pitch": 0.0, "yaw": 0.0, "roll": 0.0}, "rotationMax": {"pitch": 0.0, "yaw": 360.0, "roll": 0.0},
            "scaleMin": {"x": s0, "y": s0, "z": s0}, "scaleMax": {"x": s1, "y": s1, "z": s1}, "bUniformScale": True}, x, y)
        pcg.connect_node_pins(last, pin, xf, "In")
        sp = add("Static Mesh Spawner", f"Spawn{tag}", {}, x + 300, y)
        pcg.connect_node_pins(xf, "Out", sp, "In")
        st = sp.get_settings()
        st.set_mesh_selector_type(unreal.PCGMeshSelectorWeighted)
        sel = st.get_editor_property("mesh_selector_parameters")
        entries = []
        for (mesh_path, weight) in entry["meshes"]:
            mesh = unreal.load_asset(mesh_path)
            if mesh is None:
                raise ValueError(f"scatter {tag}: mesh not found: {mesh_path}")
            me = unreal.PCGMeshSelectorWeightedEntry()
            d = me.get_editor_property("descriptor")
            d.set_editor_property("static_mesh", mesh)
            if entry.get("material"):
                d.set_editor_property("override_materials", [unreal.load_asset(entry["material"])])
            d.set_editor_property("cast_shadow", bool(entry.get("shadows", False)))
            cull = int(entry.get("cull", 0))
            if cull:
                d.set_editor_property("instance_end_cull_distance", cull)
                d.set_editor_property("instance_start_cull_distance", int(cull * 0.8))
            me.set_editor_property("descriptor", d)
            me.set_editor_property("weight", int(max(1, round(weight))))
            entries.append(me)
        sel.set_editor_property("mesh_entries", entries)
    unreal.EditorAssetLibrary.save_asset(f"{folder}/{name}")
    half = float(L.SCATTER_HALF)
    tf = unreal.Transform(unreal.Vector(0, 0, 0), unreal.Rotator(), unreal.Vector(half / 100.0, half / 100.0, 80.0))
    info = pcg.spawn_graph_instance(g, "PCG_World", tf, "")
    info.actor.set_folder_path("Scatter")
    pcg.execute_graph_instance(info.actor.get_component_by_class(unreal.PCGComponent))
    STATS["scatter"] = {"graph": f"{folder}/{name}", "chains": [e["name"] for e in L.SCATTER], "generating": True}


def status():
    instances = 0
    actors = eas.get_all_level_actors()
    for a in actors:
        for c in a.get_components_by_class(unreal.InstancedStaticMeshComponent):
            instances += c.get_instance_count()
    STATS["status"] = {"map": current_map(), "actors": len(actors), "scatter_instances": instances}


def save():
    if current_map() != MAP_NAME:
        raise RuntimeError(f"not saving: the editor has {current_map()} open, not {MAP_NAME}")
    STATS["saved"] = bool(les.save_current_level()) and bool(unreal.EditorAssetLibrary.save_directory(L.ROOT))


def main():
    if any(s in STAGES for s in ("terrain", "look", "scatter")):
        open_level()
    if "terrain" in STAGES:
        build_terrain()
    if "look" in STAGES:
        build_look()
    if "scatter" in STAGES:
        build_scatter()
    if "save" in STAGES:
        save()
    status()
    return STATS


try:
    RESULT = json.dumps(main())
except Exception:  # noqa: BLE001
    RESULT = json.dumps({"error": traceback.format_exc(), "notes": STATS["notes"]})
