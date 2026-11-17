---
name: unity-performance
description: How to do a performance pass on a Unity game - break it into test rooms (each effect, character or spawned thing alone), fly-bys (the world) and a self-playing run split by the game's own marks; measure, change one thing, measure again; and make sure nothing hitches the first time it is used by prewarming it behind the loading cover. Use when asked about frame rate, fps, hitches, stutter, a freeze when an effect or enemy first appears, quality tiers, or before calling any game or level done.
---

# A performance pass in Unity

A camera flying through a level measures the level. A game is slow in other places: the frame an effect fires
for the first time, the frame a wave spawns, the tenth minute of play. A performance pass that only flies
through the world finds none of them. So the game is **broken into parts and each part is measured alone**,
with the `perf-pass` kit (`node Tools/gam3/unity_perf.mjs`, see its `KIT.md`).

| Part | Scenario | Finds |
| --- | --- | --- |
| Every thing the game spawns during play | `room` | first-use hitches, and things that cost too much while alive |
| Every level | `flyby` | areas of the world that are over budget |
| The game being played | `play` | which wave, ability or section is slow, and hitches no room predicted |

Both halves below are requirements, whether or not anyone asked for them.

## Half 1: when you are measuring

1. **Set the budget first.** 16.7 ms for 60 fps, 33.3 ms for 30. Pass it as `--budget-ms`. A frame over twice
   the budget is a hitch. Without a budget a number means nothing.
2. **Measure alone on the machine.** The runner waits for other engines to finish and holds the machine. Do
   not use `--shared` for any number you keep or compare. Do not run other agents' engine work during a pass.
3. **Never measure under `blind` or `agent`.** Those profiles run a fixed time step and lowered quality; they
   answer other questions. A performance run is always full quality in real time; the runner sees to it.
4. **Editor numbers compare, player numbers count.** Use the editor run for the loop below, because it is fast
   to start. Quote and sign off on a `--player` run. Never report an editor frame rate as the game's.
5. **The loop is: measure, change one thing, measure again, keep or revert.**
   - Save a baseline before the first change (`--save-baseline NAME`), compare every run after
     (`--baseline NAME`).
   - One change per measurement. Two changes at once cannot be told apart.
   - A change that does not move the number is reverted, however sensible it looked.
   - Run it twice when the difference is small. Differences under about 1 ms on sub-millisecond frames are noise.
6. **Start with the test room, and put everything in it.** List every prefab the game instantiates during
   play: effects, projectiles, enemies, pickups, hit numbers, UI pop-ups. One data file per family is fine.
   Read each subject's three numbers:

   | Number | Meaning | If it is bad |
   | --- | --- | --- |
   | `first_use_ms` far above `warm_ms` | a hitch the first time a player sees it | prewarm it (Half 2); rerun with `--prewarm` to prove the cure |
   | `warm_ms` high | it costs that much on every spawn | pool it; make its `Awake`/`Start` cheaper; fewer child objects |
   | `steady_ms` high | it costs that much while alive | fewer particles, less overdraw, cheaper shader, lower emission |

7. **Then the fly-bys.** One per level, with legs that match its areas, so an over-budget leg names an area.
   Nothing should be playing during a fly-by.
8. **Then play.** The game must play itself (a bot, a demo mode); put `Gam3.Perf.Mark("wave/3")` where the game
   changes what it is doing so that slow frames have a name.
9. **Every hitch found in play becomes a room subject.** Find what spawned on that frame, add it to the room
   data file, see it fail there, fix it there. The room is the regression test; play is where new cases are
   found.
10. **Read the reasons, report the line.** Report the `GAM3PERF:` line and whether it was an editor or a player
    run. A FAILED run is not "mostly fine": each reason names a subject or a segment.

## Half 2: when you are building the game

1. **Anything spawned during play is prewarmed behind the loading cover.** The first use of a prefab compiles
   and uploads its shader variants, uploads meshes and textures, runs one-time set-up in its scripts and
   compiles code paths for the first time. Do it while the cover is up:

       var gate = ReadyGate.Begin(cover);
       Prewarm.Run(this, level.prefabsSpawnedDuringPlay, gate, level.shaderCollections);
       yield return gate.WaitUntilReady();

   Keep the list next to the level's data and add to it whenever a new effect or enemy is added. A pool that
   is filled behind the cover and whose objects are drawn once does the same job.
2. **Instantiated is not prewarmed; drawn is.** A shader is compiled when something is first drawn with it.
   An object created inactive, or out of view, has paid for its scripts and not for its rendering.
   `Prewarm.Run` draws each prefab with its own camera for that reason.
3. **Prewarmed prefabs must be silent.** Their scripts run during loading. A sound, a damage event or an
   analytics call on spawn must check `Prewarm.Running`.
4. **Pool what spawns often.** Prewarming removes the first-use cost, not the per-spawn cost. If `warm_ms` is
   visible against the budget, the thing needs a pool.
5. **A new effect, enemy or level is not done until it is in a data file and passes.** Add the subject to the
   room file or the level to a fly-by file in the same change that adds it to the game.
6. **Quality tiers are measured and looked at.** For each quality level the game ships, run the fly-by and the
   play scenario at that level and keep a baseline per level. Then capture the same view at that level and at
   the highest one and compare the pictures: a tier may be cheaper, it may not look broken (missing shadows
   that carried the scene, a washed-out sky, effects gone). Drop what costs frames and changes the picture
   least.

## What this does not replace

The Unity Profiler says why a part is slow; this says which part is slow and whether a change helped. When a
subject or a segment fails and the cause is not obvious, open the Profiler on that room or that leg, which is
now a small, repeatable case.
