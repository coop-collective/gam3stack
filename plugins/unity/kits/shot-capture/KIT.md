# shot-capture

One Editor script, `Assets/Editor/Gam3/Gam3Shot.cs`. It opens a scene, renders a camera to a PNG and exits, so an
agent can look at what it just built instead of guessing.

    node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture -- -gam3Scene Assets/Scenes/Main.unity -gam3Out Shots/main.png

    # a free camera: position x,y,z and rotation pitch,yaw,roll in degrees
    node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture -- -gam3Scene Assets/Scenes/Main.unity \
        -gam3Out Shots/overview.png -gam3Pos -95,45,-95 -gam3Rot 22,45,0 -gam3Fov 55 -gam3Size 1280x720

Without `-gam3Pos` it uses the scene's main camera. The driver prints `GAM3SHOT: <absolute path> <width>x<height>`.
Inside the editor the same capture is in the menu: Tools > Gam3 > Capture Main Camera.

## When not to use it

- To judge gameplay, animation, particles or anything that needs time to pass. This is an edit-mode render of
  the scene as saved: nothing has been simulated. Use a play-mode test or a player build with its own capture.
- To judge UI drawn in screen space. Overlay canvases are not part of a camera render.

## Limits

- Needs a graphics device, so do not pass `--nographics`.
- Tested with the built-in render pipeline on macOS (Metal), Unity 6000.6.5f1. `Camera.Render()` is also the
  documented path under URP and HDRP, but that was not run here. Check the first capture by eye.
- The scene file is not modified. The temporary camera is destroyed after the render.
- Unity creates `Gam3Shot.cs.meta` on the next open or compile. Commit it with the script.
