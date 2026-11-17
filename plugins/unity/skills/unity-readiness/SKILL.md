---
name: unity-readiness
description: Rules for never looking at, or showing a player, a Unity scene that is not ready - wait on a readiness signal before every capture, keep a loading cover up until the world is complete, and never let a spawned character be drawn in bind pose (T-pose). Use when capturing or judging a Unity scene, when building a loading screen, level load, spawn, respawn or object pool, or when a game shows pop-in, a broken world for the first seconds, or a T-pose.
---

# Readiness in Unity

A scene that has "loaded" is not a scene that is ready to be seen. Between the two, shaders compile, textures
sharpen, parts of the world arrive, the game's own setup runs, and characters wait for their first animation
frame. An agent that captures in that window judges a broken picture. A game that drops its loading cover in
that window shows a player a broken world. Both are the same mistake, and both have the same fix: **wait for a
signal, never for a number of seconds.**

There are two halves. Do both.

## Half 1: when you are developing

1. **Never capture on a timer.** No "wait 5 seconds then screenshot". A timer is too short on a cold cache and
   wasted time on a warm one. `Gam3.Shot.Capture` (kit `shot-capture`) waits by itself and reports it.
2. **Read the readiness line before you look at a picture.**
   - `GAM3READY: ok frames=3 waited=0.17s` and `ready=ok` on the `GAM3UNITY:` line: the picture can be judged.
   - `GAM3READY: TIMEOUT waiting=shaders,unsettled` and `ready=timeout`: the run is `FAILED`. The picture was
     still written, but only to help find out what is wrong. Do not describe the scene from it, and do not
     report the change as checked.
3. **Treat a timeout as a bug to diagnose**, not as flakiness to retry until it passes.

   | `waiting=` | What it means | Look at |
   | --- | --- | --- |
   | `scene` | a scene in the hierarchy is not loaded | the scene path; additive scenes left unloaded |
   | `import` | the asset database is still importing | a first open of the project; run `compile` first |
   | `compile` | scripts are compiling | run `compile` first and fix its errors |
   | `shaders` | shader variants are still compiling | a huge or broken shader; the editor log names it |
   | `unsettled` | two renders in a row still differ | something animates in edit mode (a `_Time` shader, a script with `[ExecuteAlways]`), or a probe or terrain is still building |

4. **A capture shows one moment.** The edit-mode capture shows the scene as saved. It cannot show the first
   seconds of play. For those, use `FirstFrames` from the `ready-gate` kit (Half 2, rule 5).
5. **Say which tier you looked with.** A capture made with `--profile agent` proves that things are there and
   where. It does not prove the final look. See the `unity-parallel` skill.

## Half 2: when you are building the game

These are requirements of any game you build or change, whether or not anyone asked for them. A loading flow
or a spawn is not finished until they hold.

1. **A cover stays up until the world is ready.** Use `ReadyGate` (kit `ready-gate`): start it before the load,
   put every load and every piece of setup behind it, drop the cover when it opens. "Ready" for the player
   means at least:
   - every scene that makes up the level is loaded, additive ones included;
   - the player exists, stands on ground that has its collider, and is posed;
   - the camera is where it will be on the first frame (no cut or glide from the origin);
   - generated content (terrain, navmesh, procedural placement) is generated;
   - the first screen of UI is built;
   - the hitches are over: several short frames in a row.
2. **Nothing compiles or streams in front of the player.** The causes of pop-in, and what removes each:

   | What the player sees | Cause | Fix |
   | --- | --- | --- |
   | a freeze the first time a material or effect appears | shader variant compiled on first use | a `ShaderVariantCollection` for the level, warmed behind the cover (`gate.shaderWarmUp`); or the pipeline's own shader prewarming |
   | blurry surfaces that sharpen | texture mip streaming | wait for streaming behind the cover (the gate does when streaming is on), or raise the streaming budget, or turn streaming off for hero textures |
   | objects appearing, holes in the map | assets or scenes loaded asynchronously after the cover dropped | `gate.Track(operation)` for every async load; a hold for anything else |
   | a dark or wrongly lit first second | reflection probes, light probes or ambient light still being set up; a realtime probe not yet rendered | bake them, or render the realtime probe behind the cover and add it as a condition |
   | a freeze when the first enemy, effect or sound appears | its prefab, clip or particle system loaded on first use | load and instantiate one of each behind the cover (a pool does this for free) |
   | physics objects dropping or popping on the first frame | bodies start interpenetrating or asleep in the air | let physics settle behind the cover, or save the scene settled |

3. **No character is ever drawn in bind pose.** Unity evaluates Animators once a frame, after `Update`, before
   `LateUpdate`. Whatever becomes visible later in the frame is drawn as stored. Use `Spawn.Posed` instead of
   `Instantiate` for every animated character, and `Spawn.ShowWhenPosed` when taking one from a pool. The
   causes it removes:
   - spawned or activated in `LateUpdate`, at the end of the frame, or from a late callback;
   - Animator culled where it spawned (`Cull Completely`), then the camera cuts to it;
   - controller assigned later, because it loads asynchronously (hidden until it can be posed);
   - pooled object still holding the pose it died in.

   Also check by hand: the controller has a real entry state (a blend from an empty default state is a blend
   from bind pose), and a ragdoll or IK rig is switched on only after the first evaluation.
4. **The same rules hold for every later load and spawn**: respawn, fast travel, opening a streamed area, a
   cutscene start, a wave of enemies. Each is a small loading flow.
5. **Prove it by looking at the first frames, not a late one.** A screenshot five seconds in shows none of
   these faults. Capture the frames right after the cover drops:

   ```csharp
   FirstFrames.AfterGate(gate, Camera.main, 5, "Shots/first");
   ```

   and the first frame a spawned character is visible (`yield return FirstFrames.Capture(cam, 3, "Shots/spawn")`
   from the spawn code, in a development build or the editor). Open the files. Frame 0 must already look like
   the last one. For a spawn, measure as well: the tests in the `ready-gate` kit read the bones on the first
   visible frame, and you can add your own prefab to them.
6. **A gate timeout is a bug.** The gate opens after its timeout so the game cannot hang, and logs
   `GAM3READY: TIMEOUT waiting=<names>`. Fix what it names. Do not raise the timeout to make the line go away.

## What to report

For a capture: the `GAM3UNITY:` line with `ready=ok`, and the profile. For a loading flow or a spawn: that the
first-frame captures were looked at and what frame 0 showed, and the play-mode test line. If you could not run
them, say so. "It loads" is not a result.
