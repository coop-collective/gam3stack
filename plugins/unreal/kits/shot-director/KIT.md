# shot-director

Two C++ files that join your game module. With them, a game run can take screenshots at set times and quit, so a
change can be looked at without anyone at the machine:

    node Tools/gam3/ue_game.mjs --map L_Level --shots 5,9 --quit 11 --prefix after
    # -> Saved/Screenshots/after_00.png, after_01.png, then `GAM3GAME: ok ...`

Add `--cam X,Y,Z,Pitch,Yaw[,FOV]` to look through a fixed camera instead of the player's view: useful for a level
that has no player camera yet, or to frame one place.

## How it works

`UGam3ShotDirector` is a game instance subsystem. It is created only when `-Gam3Shots=`, `-Gam3Quit=` or
`-Gam3Cam=` is on the command line, and never in Shipping builds, so it costs nothing in normal play. Time counts
from when the level begins play. No registration and no level actor are needed.

## Adapting

- Shots too early show a scene still loading (textures, lighting settling). Give the first shot a few seconds.
- If your game draws a menu before the level, start it on the level directly (`--map`), or add a flag of your own
  that skips the menu when `-Gam3Shots` is present.
- To capture gameplay rather than an idle scene, add your own scripted input behind a command-line flag and pass it
  after `--`: `ue_game.mjs --shots 6 --quit 8 -- -MyDemoInput`.

## Limits

- Needs a C++ game module. A Blueprint-only project must add one first (File > New C++ Class in the editor).
- Close the editor before compiling.
