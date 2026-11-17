# walk-bot

A bot that plays the player's pawn while nobody watches, and reports what a tester walking around would have
found. Two C++ files that join your game module, and one runner.

    node Tools/gam3/ue_walk.mjs --map L_Level --seconds 600 --seed 1
    # -> GAM3WALK: ok mode=wander seed=1 game_s=600.0 wall_s=9.7 distance_m=2886.33 stuck=0 fell=0 slide=0
    #    speed=0 nan=0 camera_inside=0 other=0 input=movement ... rate=235x profile=blind ready=ok

The default profile is `blind`: no renderer and a fixed time step, so game time runs as fast as the machine can
compute it. In the small test level ten minutes of walking took 2.6 seconds once the engine had started, and an
hour took 13. Start-up is the rest of the wall time (6 to 10 seconds there). A heavy level computes more slowly;
the `rate=` field says what you got.

## Two ways to walk

- **`--mode wander`** (default): seeded random headings, short pauses, jumps. Walking into something for half a
  second makes it turn, as a player would. Run several seeds: each one walks a different path.
- **`--mode route --route "x,y,z;x,y,z"`** or `--route FILE` (one `x,y,z` per line, `#` comments): walk the
  waypoints in straight lines. A route says "a player must be able to walk this": blocked or unfinished fails
  the run. Keep one file per path that matters (spawn to the first objective, through every door).

## What it reports

Each incident is one line with the place and the game time, and the run exits non-zero:

| Incident | Meaning | Tuning (`[/Script/YourModule.Gam3WalkBot]` in `Config/DefaultGame.ini`) |
| --- | --- | --- |
| `stuck` | Input held and the pawn did not leave a 50 cm circle for 3 s; or, wandering, a 3 m circle for 20 s (a pocket with room to pace in) | `StuckSeconds`, `StuckRadius`, `TrapSeconds`, `TrapRadius` |
| `fell` | Below the level's KillZ or `--floor-z`, falling for more than 3 s, or the pawn destroyed and not replaced | `FallSeconds` |
| `slide` | Moving over the ground above 100 cm/s for 0.75 s while no bone of its mesh moved more than 5 cm: an idle or frozen pose, or the bind pose | `SlideSeconds`, `SlideSpeed`, `SlideBoneCm` |
| `speed` | Ground speed over 1.5 times what its movement component allows, or a jump in position its velocity does not explain | `SpeedMargin` |
| `nan` | A position or velocity that is not a number | |
| `camera-inside` | The view point is inside geometry that blocks the camera channel, for 3 frames | `CameraRadius` |
| anything else | A rule of your game, reported from your code (below); counted as `other=` | |

A run ends early when the pawn fell or a route is blocked: there is nothing more to learn from it.

## Seeing it: replay

Runs on a fixed step repeat exactly: the same seed gives the same path, to the centimetre, with or without a
renderer. So find problems blind, then repeat the failing command with `--replay`:

    node Tools/gam3/ue_walk.mjs --map L_Level --seconds 600 --seed 4 --replay
    # the agent profile, and Saved/Screenshots/walk_00_stuck.png ... one picture per incident

The picture is the player's own view, a frame or two after the incident began. Replays with a renderer ran at
about 4 times real time in the test level, so replay the shortest run that shows the problem.

## How it moves the pawn

The way a player does, where it can. It looks through the pawn's and the controller's Enhanced Input bindings for
a 2D action with "Move" in its name (and one with "Jump") and injects values into them, so the game's own input
handlers run. With no such action it calls `AddMovementInput` and `ACharacter::Jump`. The first note line of every
run says which: `input=enhanced` or `input=movement`.

- Action not found by name: `--move-action IA_Walk --jump-action IA_Hop` (asset names).
- A game that maps its move axes to something other than the controller's view: in route mode the bot measures
  which way the pawn actually goes and turns its input to match (a note line says by how much).
- `--input movement` skips Enhanced Input.

## Making it play your game

Walking finds walking bugs. To make the bot fight, interact or die, bind its tick. It fires every frame the bot
is driving:

    if (UGam3WalkBot* Bot = UGam3WalkBot::Get(this))
    {
        Bot->OnBotTickNative.AddWeakLambda(this, [this](UGam3WalkBot& B, APawn* Pawn, float Dt)
        {
            if (B.Random().FRand() < 0.02f) TryAttack();                       // seeded: the run still replays
            if (Health < 0) B.ReportIncident(TEXT("negative-health"), TEXT("health went below zero"));
        });
    }

`OnBotTick` is the same for Blueprint. `ReportIncident` logs `GAM3WALK: negative-health at=... t=...`, counts it
in `other=` and fails the run. Where the game moves the player on purpose (respawn, door, cutscene) call
`NoteTeleport()` first, or the jump is reported as `speed`.

This is also how a game plays itself for other runs. Without `-Gam3BotSeconds` the bot never quits, so any run can
carry it: `ue_game.mjs --profile human --quit 60 -- -Gam3Bot=wander -Gam3BotSeed=1`. The bot's result line is
written to the log when the game exits.

## Adapting

- Add `"EnhancedInput"` to the module's `PublicDependencyModuleNames`.
- Give every level a floor to fall to: set the level's KillZ just under the lowest walkable ground, or pass
  `--floor-z`. With neither, a fall is only seen after 3 s of falling.
- A level of rooms smaller than 3 m across trips the pacing rule: raise `TrapRadius` or set `TrapSeconds=0`.
- An idle animation with large motion, or a mesh that floats by design, trips `slide`: tune or set
  `SlideSeconds` very high.
- If the game shows a menu first, start on the level (`--map`) or skip the menu when `-Gam3Bot=` is present.

## Limits

- The bot holds input and watches the pawn. It does not judge feel: acceleration, camera lag, whether a jump is
  fun. A person at the `human` profile does that.
- Wandering is random, not exhaustive. A hole one metre wide in a large level may take many seeds to find. Routes
  are how you make sure a known path is walked.
- `slide` asks the pawn's mesh to refresh its bones every frame even when not rendered (the bot sets this on the
  mesh it watches), so bot runs evaluate slightly more animation than normal play.
- `camera-inside` tests the camera collision channel only. A camera that clips through a mesh with no collision
  is not seen.
- One local player. Needs a C++ game module. Never created in Shipping builds.
