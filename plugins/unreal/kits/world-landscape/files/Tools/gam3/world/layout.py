"""The world as data. Pure Python (no `unreal` import), so it can be read, tested and previewed outside the editor.

build_world.py samples these functions at every landscape vertex and writes the heights and one paint layer per
entry in LAYERS. Change a road point here and the ground, the paint and the scatter all move with it.

This file is the example: a rolling plain, a dirt road, two trodden clearings. Replace it with your world.
Units are centimetres. The landscape is centred on the origin.
"""
import math

MAP = "/Game/Maps/L_Gam3World"      # the level this builds (created if missing)
ROOT = "/Game/Gam3World"            # where its material, layer infos and scatter graph are saved

# ---------------------------------------------------------------- terrain grid
QUAD = 100.0           # cm per landscape quad
COMPONENTS = 4         # x 63 quads per side: 253 vertices per axis, 252 m across at QUAD 100
RES = COMPONENTS * 63 + 1
HALF = (RES - 1) * QUAD * 0.5

ROAD = [(-12000, -6000), (-6000, -3500), (-1500, -500), (2500, 1200), (7000, 2000), (12000, 4500)]
ROAD_HALF = 220.0      # full-strength half width
ROAD_FADE = 260.0      # the verge fades back to grass over this distance
CLEARINGS = [(-1500, -500, 900.0), (5200, 4200, 1100.0)]      # (x, y, radius)


def _smooth(a, b, v):
    t = min(1.0, max(0.0, (v - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = min(1.0, max(0.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - dx * t, py - ay - dy * t)


def road_w(x, y):
    """1 on the road, 0 in the grass. The edge wanders so the verge is not a ruled line."""
    d = min(_seg_dist(x, y, a[0], a[1], b[0], b[1]) for a, b in zip(ROAD, ROAD[1:]))
    wobble = 60.0 * math.sin(x / 310.0 + 1.3) * math.sin(y / 270.0 + 0.4)
    return 1.0 - _smooth(ROAD_HALF, ROAD_HALF + ROAD_FADE, d + wobble)


def clear_w(x, y):
    """1 in the middle of a clearing, 0 in standing grass."""
    w = 0.0
    for (cx, cy, r) in CLEARINGS:
        w = max(w, 1.0 - _smooth(r * 0.55, r, math.hypot(x - cx, y - cy)))
    return w


def height(x, y):
    """Ground height in cm."""
    h = 420.0 * math.sin(x / 4100.0 + 0.7) * math.cos(y / 3300.0 - 0.3)
    h += 160.0 * math.sin((x + y) / 1700.0 + 0.4)
    h += 60.0 * math.sin(x / 700.0 + 1.3) * math.sin(y / 830.0 + 0.2)
    edge = max(abs(x), abs(y)) / HALF                       # hills rise toward the border, so the world has an edge
    if edge > 0.7:
        h += ((edge - 0.7) / 0.3) ** 2 * 2600.0
    return h - 25.0 * road_w(x, y)                          # the road is worn a little into the ground


# ---------------------------------------------------------------- paint layers
# name -> (weight function, colour). The ground material blends these colours over BASE_COLOR in this order.
# The same names arrive on every scatter point as attributes, which is what the "where" filters below read.
BASE_COLOR = (0.19, 0.24, 0.07)
LAYERS = {
    "Clear": (clear_w, (0.27, 0.25, 0.11)),
    "Road": (road_w, (0.36, 0.27, 0.17)),
}

# ---------------------------------------------------------------- scatter (needs the PCG plugin; leave empty to skip)
# The meshes here are engine placeholders so the example runs in an empty project. Point them at your own grass,
# rocks and trees. "where" keeps a point only when the layer weight is inside (low, high).
SCATTER_HALF = 9000.0   # the scatter volume covers +-this around the origin
SCATTER = [
    {
        "name": "Tufts",
        "meshes": [("/Engine/BasicShapes/Cone", 1.0)],
        "per_m2": 0.12,
        "extents": 40.0,                     # point size in cm: bigger keeps instances apart
        "scale": (0.35, 0.7),
        "where": {"Road": (-1.0, 0.25), "Clear": (-1.0, 0.5)},
        "material": None,                    # an asset path to override the mesh's materials
        "shadows": False,
        "cull": 20000.0,                     # cm; instances beyond it are not drawn
    },
]

# ---------------------------------------------------------------- look: one sun, sky, fog, locked exposure
LOOK = {
    "sun": {"yaw": 160.0, "pitch": -32.0, "intensity": 6.0, "color": (255, 236, 208), "source_angle": 2.0},
    "skylight": {"intensity": 1.5},
    "fog": {"density": 0.012, "falloff": 0.15, "start": 1500.0, "volumetric": True},
    # Manual exposure: the picture does not pump when the camera moves. Raise the bias if the game looks dark.
    "exposure_bias": 0.0,
}
