# shot-capture

One Editor script, `Assets/Editor/Gam3/Gam3Shot.cs`. It opens a scene, renders a camera to a PNG and exits, so an
agent can look at what it just built instead of guessing.

    node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture -- -gam3Scene Assets/Scenes/Main.unity -gam3Out Shots/main.png

    # a free camera: position x,y,z and rotation pitch,yaw,roll in degrees
    node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture -- -gam3Scene Assets/Scenes/Main.unity \
        -gam3Out Shots/overview.png -gam3Pos -95,45,-95 -gam3Rot 22,45,0 -gam3Fov 55 -gam3Size 1280x720

Without `-gam3Pos` it uses the scene's main camera. The driver prints `GAM3SHOT: <absolute path> <width>x<height>`.
Inside the editor the same capture is in the menu: Tools > Gam3 > Capture Main Camera.

## It waits until the scene is ready

Nothing is captured on a timer. The script renders once per editor update and takes the picture only when:
the scene is loaded, nothing is importing or compiling, no shader is still compiling, and two renders in a row
are the same picture (at least three renders). Then it logs one of:

    GAM3READY: ok frames=3 waited=0.17s
    GAM3READY: TIMEOUT waiting=shaders,unsettled frames=412 waited=60.02s

and the driver's last line says `ready=ok` or `ready=timeout`. On a timeout (default 60 s, `-gam3ReadyTimeout N`)
the picture is still written, marked `GAM3SHOT: UNREADY`, and the run is `FAILED`: use that picture to find out
what the scene was waiting for, never to judge the scene. Shaders are compiled on demand during the capture, so
a material is never drawn as the cyan "still compiling" placeholder.

## Profiles

| `--profile` | Capture |
| --- | --- |
| `human` (default) | 1600x900, the project's quality level, 4x anti-aliasing |
| `agent` | 640x360, lowest quality level (no shadows in the default settings), no anti-aliasing |
| `blind` | refused: there is no graphics device |

`-gam3Size` overrides the size under either. Use `agent` to check that things are there and where; use `human`
before saying how something looks. An agent's picture is scaled down before it is read, so more than about
1500 pixels wide is wasted on it.

## When not to use it

- To judge gameplay, animation, particles or anything that needs time to pass. This is an edit-mode render of
  the scene as saved: nothing has been simulated. Use a play-mode test with the `ready-gate` kit's `FirstFrames`,
  or a player build with its own capture.
- To judge UI drawn in screen space. Overlay canvases are not part of a camera render.

## Limits

- Needs a graphics device, so not `--profile blind`.
- The capture finishes on editor updates, not inside `Capture()`. The driver starts `Gam3.Shot.*` without
  `-quit` for that reason; if you call it some other way, do not pass `-quit`.
- "Two renders match" cannot become true for a scene that animates in edit mode (a shader driven by time, an
  `[ExecuteAlways]` script that moves things). That scene times out with `waiting=unsettled`; capture it from
  play mode with the `ready-gate` kit's `FirstFrames` instead.
- Tested with the built-in render pipeline on macOS (Metal), Unity 6000.6.5f1. `Camera.Render()` is also the
  documented path under URP and HDRP, but that was not run here. Check the first capture by eye.
- The scene file is not modified. The temporary camera is destroyed after the render.
- Unity creates `Gam3Shot.cs.meta` on the next open or compile. Commit it with the script.
