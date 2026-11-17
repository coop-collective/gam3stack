# ready-gate

Two C++ files that join your game module. They fix two things players notice in the first seconds and that are easy
to miss while building a game: a level shown before it has finished arriving, and a character shown in its bind pose
(the T or A pose) before it animates.

A level that has begun play is not ready to look at. Shaders and textures are still compiling or streaming in,
streamed levels are still loading, and the player's pawn may not exist yet. A skeletal mesh draws in its bind pose
until its animation has been evaluated once, which is late whenever the animation is assigned or loaded after the
mesh is shown.

## What you get with no code of your own

`UGam3ReadyGate` is a world subsystem; it exists in every game world.

- A black cover from the first frame, over everything: the scene, the HUD and UI widgets (a full-screen layer on
  the viewport, above the game's own). Audio is muted with it.
- The gate opens when all of this has held for `SettleFrames` frames in a row: nothing compiling, no pipeline
  states still precompiling, no async loading, no level streaming pending, World Partition streaming complete, the
  player has a pawn, and every blocker you added has been removed. Texture streaming and characters waiting for
  their pose also hold it, but only for `SoftSeconds`.
- A `TimeoutSeconds` limit in real time. A stuck condition opens the gate anyway and is logged with its reason:
  `GAM3READY: TIMEOUT waiting=blocker:save-file,player-pawn`.
- Then a short fade in, and `OnReady` fires.

## What you add

| Where | Call | Why |
| --- | --- | --- |
| After spawning or re-dressing a character | `UGam3ReadyGate::ShowActorWhenPosed(Character)` | It is drawn only once it has left its bind pose. If the pose can be evaluated at once the mesh is never hidden |
| Around your own loading (save file, procedural level, server handshake) | `AddBlocker("save-file")` ... `RemoveBlocker("save-file")` | The cover stays up until your loading is done |
| Match clock, music, intro, enemy spawns | Bind `OnReady` (Blueprint) or `OnReadyNative` (C++) | Time must not pass behind the cover |

Settings go in `Config/DefaultGame.ini`:

    [/Script/YourModule.Gam3ReadyGate]
    bCoverWithFade=True
    FadeInSeconds=0.35
    SettleFrames=10
    TimeoutSeconds=30
    SoftSeconds=4
    bWaitForPlayerPawn=True

With your own loading screen, set `bCoverWithFade=False` and remove the screen in `OnReady`.

## How unattended runs use it

`ue_game.mjs` (ue-driver) and the shot-director kit take the same gate as their definition of "ready":

- Screenshot times count from the moment the gate opens. `--shots 0` is the first frame a player sees.
- The run is `FAILED` when the gate timed out (`ready=timeout`) or a mesh was drawn in its bind pose
  (`bind_pose=1`). Both come with the reason.
- With `-Gam3Watch` (passed for you) the gate keeps watching after it opens and logs what a player would have
  noticed: a mesh in its bind pose, something still compiling, a frame over a quarter of a second in the first ten
  seconds. Never in Shipping builds.
- Unattended runs pass `-Gam3ReadyTimeout=600` so a first run's shader compile is waited for, not captured.

## Limits

- The gate opens once per world. Loading a new level makes a new world and a new gate. A teleport across a
  streaming world is not covered again: cover it yourself and wait on your own condition.
- The bind-pose watch needs a picture. Under `--profile blind` (no renderer) nothing is drawn, so nothing is checked.
- A mesh whose animation's first frame equals its bind pose exactly cannot be told apart from one that has not
  animated. `ShowWhenPosed` shows it after its timeout and logs `GAM3POSE: TIMEOUT`.
- `ShowWhenPosed` hides the mesh and everything attached to it, then shows all of it. A child you had hidden on
  purpose is shown too: hide it again after.
- An uncooked run compiles shaders on demand; a packaged build precompiles pipeline states instead. The gate waits
  for both, but only uncooked runs were tested. Check a packaged build before release.
- Needs a C++ game module with `RenderCore`, `Slate` and `SlateCore` in its dependencies.
- The engine's own debug text (`stat` commands) draws above the cover. Players never see that.
