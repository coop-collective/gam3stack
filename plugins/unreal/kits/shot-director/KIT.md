# shot-director

Two C++ files that join your game module. With them, a game run can take screenshots at set times and quit, so a
change can be looked at without anyone at the machine:

    node Tools/gam3/ue_game.mjs --profile agent --map L_Level --shots 0,5 --quit 6 --prefix after
    # -> Saved/Screenshots/after_00.png, after_01.png, then `GAM3GAME: ok ... ready=ok shots=2/2 ...`

Times are game seconds after the level is ready (the `ready-gate` kit, which this kit requires). `0` is the first
frame a player sees. Capture it whenever a level or its loading changed: it is the frame that shows a level that
was not ready.

Add `--cam X,Y,Z,Pitch,Yaw[,FOV]` to look through a fixed camera instead of the player's view: useful for a level
that has no player camera yet, or to frame one place.

## How it works

`UGam3ShotDirector` is a game instance subsystem. It is created only when `-Gam3Shots=`, `-Gam3Quit=` or
`-Gam3Cam=` is on the command line, and never in Shipping builds, so it costs nothing in normal play. Time counts
from when the ready gate opens, in game time, so a run on a fixed time step captures the same moment however fast
or slow the machine is. No registration and no level actor are needed.

## Adapting

- A shot at 0 that shows missing or grey content means the gate opened too early for your game: add a blocker
  around the loading it does not know about (see `ready-gate`). Do not move the shot later to hide it.
- Lighting that needs time to settle (exposure, global illumination) is still settling at 0. Raise `SettleFrames`
  if players should not see that either.
- If your game draws a menu before the level, start it on the level directly (`--map`), or add a flag of your own
  that skips the menu when `-Gam3Shots` is present.
- To capture gameplay rather than an idle scene, add your own scripted input behind a command-line flag and pass it
  after `--`: `ue_game.mjs --shots 6 --quit 8 -- -MyDemoInput`.

## Limits

- Needs a C++ game module. A project without one must add one first (File > New C++ Class in the editor).
- Close the editor before compiling.
