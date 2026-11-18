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

## What prewarming has to be

- **A load is not a warm-up.** An asset that is in memory but has never been drawn still creates its pipeline
  states on first use. A game that only preloads has the hitch.
- **Drawn in view, lit as the level is lit.** Something drawn under the map or behind a wall is culled and
  creates nothing; something warmed before the level's lights exist is drawn differently once they do.
- **Long enough.** An effect whose emitters start late keeps creating pipeline states for a second or more.
- **Held by hard reference.** A cache of weak pointers is collected and the asset loads again mid-fight.
- **Keep a switch that turns the prewarm off** (a command-line flag), so its gain can be measured again later.
- Check by count as well as by time: `first_use_pipeline_states=` in the room summary is not affected by a
  busy machine.

## Reading results

- `hitch:` lines end with a cause: pipeline states created (prewarm it), packages loaded with names (reference
  or prewarm them), garbage collection (something is churning objects), shader jobs queued. "None of the usual
  causes" with a high `machine_load=` is the machine, not the game.
- `machine_load=` above about 0.7, or a `note:` saying the machine is busy: the timings are not results. Run
  again when it is quiet. Compare pairs of runs taken together, never a number from yesterday.
- `exclusive=no` (the `--shared` flag): good for first-use hitches, worthless for frame rate.
- `display_cap=120`: the frame was locked to the display. Frame and render columns have a floor; use `game` and
  `gpu`.
- `late_compile=<names>`: the subject was shown while its shaders were still compiling. In a packaged game that
  is a pipeline-state hitch; prewarm it.
- Numbers are from an uncooked run on this machine. They rank changes against each other. The frame rate you
  promise comes from a packaged build on the weakest machine you support, measured alone.

## Lights: count them first

With fully dynamic lighting (Lumen, virtual shadow maps, nothing baked) every lit light is paid for every frame,
on every platform. Know which you have: a project with no built lighting data and no static-lighting setting is
fully dynamic. Each segment of a run reports `lights/shadowed`: the most lights lit at once and how many cast
shadows. They are counts, so they hold on a busy machine. Set `--max-lights` and `--max-shadowed` once a level
is right, so an effect that brings twenty lights with it fails the run.

Rules that came from one shipped project (UE 5.8 and 5.9; treat the numbers as starting points, not limits):

- **Shadow-casting local lights are the expensive ones.** One shadowed point light on the local player and none
  on other characters was affordable; four was not.
- **Small moving lights are direct-only.** A light on an effect or a character that also feeds global
  illumination or volumetric fog blinks and smears as it moves: set its indirect and volumetric contribution
  to zero and leave translucency lighting off.
- **A light that must stay on never comes from a shared pool.** A pool of effect lights hands its few lights to
  whatever is brightest; a character's own light borrowed from it goes dark whenever something explodes. Give
  persistent lights their own component and keep the pool for flashes.
- **Create pooled lights up front and light them once during the prewarm**, or the first flash pays for them.
- **Do not flip a mesh's visibility to make it blink.** Each flip rebuilds its render state; blink through a
  material parameter.
- **The mobile renderer draws one directional light.** A second one (lightning, a moon) is ignored: add its
  colour onto the sun.
- **A low tier still needs light.** Removing local lights without a fallback leaves a level where only explosions
  light anything. Keep a capped number of cheap unshadowed lights; on the mobile renderer a few dozen measured
  close to free.
- **Fog without volumetrics goes grey in the dark.** Where volumetric fog is off, height-fog inscatter turns a
  lights-out scene into haze: lower fog opacity for those scenes.
- **The largest desktop savings were in global illumination and volumetric fog resolution**, not in light counts:
  measure those two first on a slow level.

## Effects

- Prewarm every effect in view (see above). Preloading alone left 145 to 214 ms on the first large explosion
  in an uncooked run and about 180 ms in a packaged one; drawing it behind the cover brought that to about
  20 ms.
- Turn occlusion queries off while prewarming, or a covered effect is skipped and creates nothing.
- Never warm with a "tiny" copy near the camera: world-space smoke ignores scale and fills the screen.
- On mobile, particle pipeline states are only created at first spawn: the prewarm is not optional there.
- Ship a pipeline-state cache on platforms that support one, and check the platform's rule for it (Metal turns
  the file cache off while precaching is active unless told otherwise).
- A quality-tier switch creates dozens of pipeline states in one frame. Do it behind a cover, never mid-fight,
  and restart any automatic tier check afterwards so it does not time its own switch.
- Give hand-made particle systems a hard cap, and scale decorative effects (embers, dust, shafts) by tier.
- Translucent cards cost by overdraw: a few large mist cards cost about what a water pass did.

## Platforms

- **High-DPI displays:** check the resolution the game really renders at. One engine version rendered the full
  backbuffer on a Retina display and tripled GPU time until the secondary screen percentage was set.
- **Apple GPUs slow their clock to just meet the display rate**, so a low GPU time is not spare capacity. Judge
  by whether frame time holds the target.
- **On a phone, heat sets the budget.** A tier that holds 60 for a minute can fall under 50 after five. Measure
  for ten minutes, and lock 60 rather than 120.
- **A packaged game keeps its saved files elsewhere** (on macOS, in the app's sandbox container), and a Shipping
  build writes no log: diagnostics go to a plain file.
- **Packaged cold numbers differ from uncooked ones.** In the test project an effect that took 210 ms to load
  uncooked took 2 ms packaged; what remained was pipeline-state creation, and the prewarm removed that too.

## Every platform build is looked at, not only booted

A build for another renderer (mobile, web, a low tier) can pass every boot, input and error check and still look
wrong: flat, hazy, blown out, with shadows that crawl. Those checks do not look at the picture. For each platform
build, before it is published:

1. Capture the same views as the full-quality reference (title, each level in play, the tutorial).
2. `look.mjs compare reference.png platform.png` for each. A lifted black level or lost contrast fails.
3. Take a ten-frame burst of each view and run `look.mjs blink`; with a still camera, `look.mjs shimmer`.
   Flicker never shows in one frame.
4. Read the heat pictures. A line that crawls along a wall the sun only grazes is a shadow map too coarse for
   that surface: shorten the shadow distance, raise the resolution or the slope bias, or stop that surface
   receiving the sun's shadow.

A level lit for one lighting path (global illumination, volumetric fog, auto exposure) is not lit for another.
Fog and exposure tuned for the full path are the usual cause of a washed-out platform build: check fog
inscattering, exposure limits and any black-lift in post-processing on the path that lacks the rest.

## Quality tiers

A tier is a set of settings that is faster and still looks right. Set every setting in every tier, from code, so
switching up and down lands on exactly the same state; and never take shadows or view distance to their lowest
step without looking (the lowest shadow step removes every dynamic shadow). For each tier: run the fly-by and the play
scenario with the tier applied, and capture the same views as the full-quality run. Reject a tier that removes
something the player needs to see (an enemy's telegraph effect, a pickup's glow) however fast it is. Changing
global illumination or post-process quality changes colour across the whole picture: check those by eye first.

## What this does not judge

How the game feels at a given frame rate, input latency, and whether an effect is worth what it costs. Those are
a person's call; give them the numbers.
