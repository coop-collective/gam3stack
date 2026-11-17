---
name: unreal-performance
description: How to do a performance and quality pass on an Unreal Engine game as measured parts - test rooms that catch first-use hitches per effect or actor, fly-bys for what each level costs, labelled runs of the game playing itself, prewarming so nothing hitches the first time it appears, budgets and baselines. Use when asked about frame rate, fps, hitches, stutter, an effect or enemy that freezes the game the first time it appears, quality settings or tiers, optimisation, or before calling a level or feature finished.
---

# Performance is measured in parts

Flying a camera through a level measures the level. Players do not fly through an empty level: they fight in it.
The costs that hurt arrive with the game: the first explosion, the first enemy of a new kind, forty effects at
once. A first pass that only looks at the level misses all of them. Measure three things, separately, with the
`perf-pass` kit:

| Scenario | Question it answers | Command |
| --- | --- | --- |
| Test room | What does each thing cost, and does it hitch the first time? | `ue_perf.mjs --scenario room` |
| Fly-by | What does each part of each level cost with nothing happening? | `ue_perf.mjs --scenario flyby --map L_X` |
| Play | What does the game cost while it plays, and when? | `ue_perf.mjs --scenario play --seconds 60 --bot wander` |

## Rules while building the game

1. **Everything spawned during play goes on the prewarm list** the day it is added: effects, projectiles, enemies,
   pickups, decals, UI materials. `UGam3Prewarm` loads and draws them behind the loading cover. An asset that is
   first drawn in front of the player is a hitch you chose to ship.
2. **The same list is the test room's subject list.** Adding a thing to the game means adding it to
   `Tools/gam3/perf.json`. If a thing is not in the room, nobody knows what it costs.
3. **Label the game.** Call `UGam3PerfProbe::Mark` at every change of activity (wave start, boss intro, level
   section). An unlabelled play run can only say "somewhere".
4. **Spawned often means pooled.** Prewarming removes first-use cost, not spawn cost. Effects fired many times a
   second use Niagara pooling; actors with heavy setup use an object pool.
5. **The game must be able to play itself.** A demo mode, or the `walk-bot` kit with the game's own actions hooked
   in. Without it there is no repeatable play run and performance is only ever checked by hand.

## The pass

1. `--scenario room`. Fix every `FIRST-USE HITCH` by adding the subject to the prewarm, then run again with
   `--prewarm` until none is left. Look at `steady` for subjects that are simply expensive.
2. `--scenario flyby` on each level. A slow leg is a place: capture it with `shot-director` and look at what is
   in view.
3. `--scenario play`. Read the hitch lines: each has a time, a label and a camera position. **A hitch here that
   the room did not show is a missing subject.** Find what first appeared at that moment, add it to the room, and
   go back to step 1.
4. When all three pass, `--save-baseline NAME` for each. From then on run with `--baseline NAME` after any change
   that could cost frames.

## The loop for making something faster

One change, one run, keep or revert.

- Change one thing. Run the scenario that covers it, against the baseline.
- Better and it looks the same (capture the same view before and after at the `human` profile): keep it, save the
  new baseline.
- Not better, or it looks worse: revert it. Do not stack a second change on an unproven first.
- Read which column moved. `game` is the game thread (logic, animation, spawning), `gpu` is the graphics card
  (resolution, lighting, overdraw from effects), `render` is the render thread (how many things are drawn).
  The fix is different for each.

## Reading results

- `exclusive=no` (the `--shared` flag): good for first-use hitches, worthless for frame rate.
- `display_cap=120`: the frame was locked to the display. Frame and render columns have a floor; use `game` and
  `gpu`.
- `late_compile=<names>`: the subject was shown while its shaders were still compiling. In a packaged game that
  is a pipeline-state hitch; prewarm it.
- Numbers are from an uncooked run on this machine. They rank changes against each other. The frame rate you
  promise comes from a packaged build on the weakest machine you support, measured alone.

## Quality tiers

A tier is a set of settings that is faster and still looks right. For each tier: run the fly-by and the play
scenario with the tier applied, and capture the same views as the full-quality run. Reject a tier that removes
something the player needs to see (an enemy's telegraph effect, a pickup's glow) however fast it is. Changing
global illumination or post-process quality changes colour across the whole picture: check those by eye first.

## What this does not judge

How the game feels at a given frame rate, input latency, and whether an effect is worth what it costs. Those are
a person's call; give them the numbers.
