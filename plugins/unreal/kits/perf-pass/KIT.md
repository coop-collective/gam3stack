# perf-pass

Performance measured in parts, and the prewarm that fixes what the measuring finds.

A fly through a level tells you what the level costs. It does not tell you what the game does to it. The first
time an effect, an enemy or a material is used, the engine loads it, builds its shaders and creates its pipeline
state, and the player gets a hitch at the exact moment something happens. That never shows in a fly-by, and it
shows only once in a play test. So this kit measures three ways:

    node Tools/gam3/ue_perf.mjs --scenario room                     # every subject alone, cold then warm
    node Tools/gam3/ue_perf.mjs --scenario flyby --map L_Level      # the level, one line per leg of the route
    node Tools/gam3/ue_perf.mjs --scenario play --seconds 60 -- -MyDemoMode   # the game playing itself, by label

## Test room

List in `Tools/gam3/perf.json` every effect, actor class, mesh and material the game spawns during play. Each is
spawned alone in front of a fixed camera in an empty level, held for a few seconds, removed, and spawned again:

    subject                      load  first-use   warm  steady  (ms)
    NS_Explosion                206.7       21.4    9.5     8.2  FIRST-USE HITCH +218.6  (still compiling when shown)
    SM_Crate                      0.8        9.5    9.5     8.3

- `load` is the time to bring it into memory, `first-use` the worst frame in its first second on screen, `warm`
  the same for the second spawn, `steady` its median frame while alive.
- The bracket after a row counts the pipeline states created and packages loaded during the subject's first
  use. It is counted, not timed, so it holds on a busy machine: `first_use_pipeline_states=` in the summary
  should fall sharply with `--prewarm`. It covers everything created in that window, so it rarely reaches 0.
- A subject whose first use costs more than its second by over `--first-use-ms` (default 8) fails by name.
- `steady` is what the subject costs every frame: the place to compare two versions of one effect.

## Prewarm: the fix, and it ships

`UGam3Prewarm` is game code. Give it the list and it loads each asset and draws it in front of the camera while
the ready gate's cover is still up, until nothing is compiling and no new pipeline state has appeared for a
while (an effect whose emitters start late keeps creating them), and keeps the assets in memory for the level.
Loading alone is not enough, and neither is drawing out of view: only a real draw, lit as the level is lit,
creates what the first use needs:

    ; Config/DefaultGame.ini
    [/Script/MyGame.Gam3Prewarm]
    +Assets=/Game/FX/NS_Explosion.NS_Explosion
    +Assets=/Script/MyGame.OrcCharacter

or from code, in the game mode's BeginPlay: `UGam3Prewarm::Warm(this, Paths)` (for lists that depend on the
level or the chosen character). It holds the gate with a blocker named `prewarm` and logs
`GAM3WARM: ok assets=N seconds=S`. Prove a fix with `ue_perf.mjs --scenario room --prewarm`: the same room, with
every subject prewarmed first. The first-use column should now match the warm one.

Prewarming removes the load, shader and pipeline-state cost. It does not make spawning itself cheaper: an effect
spawned twenty times a second also wants pooling (`ENCPoolMethod::AutoRelease` for Niagara), and an actor with a
heavy BeginPlay wants an object pool. The `steady` and `warm` columns show when that is the problem.

## Fly-by

`flyby.points` is a route: `[X, Y, Z, Pitch, Yaw, seconds]` per point. The camera moves along it and each leg is
reported on its own, so "the canyon is slow" has a number. World Partition streams around the camera as it does
around a player.

## Play

The probe measures for `--seconds` while the game plays itself: a demo mode of your own after `--`, or
`--bot wander` with the `walk-bot` kit. Call `UGam3PerfProbe::Mark(this, "wave 3")` where the game changes what
it is doing and frames are reported under that label. Every frame over `--hitch-ms` is listed with its time, its
label, the camera position and what happened in it: pipeline states created, packages loaded (with names),
garbage collection, shader jobs still queued. "None of the usual causes" points at the game's own code, or at
other work on the machine (check `machine_load=`). A hitch found here that the room did not find is a subject missing from the list:
add it to the room, then to the prewarm.

## Budgets and baselines

- `--budget-ms 16.7`: a segment whose average frame is over it fails.
- `--save-baseline NAME` keeps a passing run; `--baseline NAME` fails a later run whose average, 99th percentile,
  game-thread or GPU time is more than `--regress-pct` (10) worse for the same label. Baselines live in
  `Saved/gam3-perf/baselines/` and mean something only on the machine that made them.
- One change, one run, keep or revert. Two changes in one run tell you nothing about either.

## Reading the numbers honestly

- The run waits until no other engine is running and holds every engine slot. `--shared` skips that, and is only
  good for finding first-use hitches.
- A windowed game on macOS is locked to the display. The summary says `display_cap=120`, and then the frame and
  render columns have a floor of one refresh: read `game` and `gpu`. The render thread's own cost is not visible
  there.
- These are uncooked runs. An uncooked run compiles shaders and effect scripts on demand, which a packaged game
  never does, so cold numbers are worse here than for a player; pipeline-state creation is the part a packaged
  game still pays. Take the number you promise players from a packaged build on the weakest machine you support.
- Quality tiers: run the fly-by once per tier (`-- -ExecCmds="sg.ShadowQuality 1"`, or your own settings flag)
  and capture the same view with `shot-director` at each. A tier that is faster but looks broken is not a tier.

## Limits

- Needs a C++ game module, the `ready-gate` kit, and the Niagara, Json, RenderCore and RHI modules.
- Subjects: Niagara systems, actor classes by script path (`/Script/MyGame.OrcCharacter`), static and skeletal meshes, materials. Cascade
  particle systems too, reached by name because UE 5.9 moved Cascade out of the engine into a plugin. Sounds
  are loaded but not played.
- The probe is never created in Shipping builds. The prewarm is.
- A subject that needs the game's own setup to appear (a projectile that needs a target) should be listed as an
  actor class that does that setup in its BeginPlay.
