# perf-pass

Measure the game in parts, and prove that nothing hitches the first time it is used. Flying a camera through a
level measures the level. It says nothing about the frame an effect first fires, the frame the first enemy
spawns, or what the game costs while it is being played. This kit measures each of those on its own:

    node Tools/gam3/unity_perf.mjs --scenario room  --data Gam3Perf/fx-room.json
    node Tools/gam3/unity_perf.mjs --scenario room  --data Gam3Perf/fx-room.json --prewarm
    node Tools/gam3/unity_perf.mjs --scenario flyby --data Gam3Perf/level1-flyby.json --baseline level1
    node Tools/gam3/unity_perf.mjs --scenario play  --data Gam3Perf/level1-play.json

| Scenario | What runs | What it answers |
| --- | --- | --- |
| `room` | Each subject (a prefab: an effect, a character, a projectile) alone in front of a fixed camera in an empty scene. Spawned cold and left alive, destroyed, spawned again warm. | What does the first use cost, and what does it cost while alive? |
| `flyby` | The camera moves through a list of points in a scene. One segment per leg. | What does the world cost, by area, with nothing happening in it? |
| `play` | The scene runs for a set time while the game plays itself. The game's own `Perf.Mark` calls name the parts. | What does the game cost while played, and which part is slow? |

| File | What it is |
| --- | --- |
| `Tools/gam3/unity_perf.mjs` | the runner: starts the editor or a built player, reads the report, gives the verdict |
| `Assets/Gam3/Runtime/Perf/Gam3Perf.cs` | `Perf.Begin`, `Perf.Mark(label)`, `Perf.End`: frame times split into labelled segments |
| `Assets/Gam3/Runtime/Perf/Gam3Prewarm.cs` | `Prewarm.Run`: game code that pays first-use costs behind the loading cover |
| `Assets/Gam3/Runtime/Perf/Gam3PerfRunner.cs` | runs a scenario inside the game and writes the report |
| `Assets/Editor/Gam3/Gam3PerfPass.cs` | sets the scenario up in a scene; builds the player for `--player` |

Every run ends with one line and exits 0 only on ok:

    GAM3PERF: ok|FAILED scenario= frames= avg_ms= p99_ms= fps= hitches= subjects= first_use_fail=<names or 0>
              baseline=<ok|regressed|none> over_budget=<labels or 0> ambient_ms= prewarm= player= alone= ...

The full report is `Logs/gam3-perf/<name>.json`: every segment with `frames`, `avg_ms`, `p50_ms`, `p99_ms`,
`max_ms`, `first_ms`, `hitches`, and `main_ms`, `render_ms`, `gpu_ms` where the engine reports them; for a
room, `subjects` with `first_use_ms`, `warm_ms` and `steady_ms`; the verdict and its reasons.

## What fails a run

| Rule | Applies to | Option |
| --- | --- | --- |
| A subject's first use is more than 8 ms slower than its warm spawn. The subject is named. | `room` | `--first-use-ms N` |
| A segment is over the frame budget of 16.7 ms (a room: its steady cost; otherwise its average). | all | `--budget-ms N` |
| A frame longer than twice the budget: a hitch. The segment is named. | `flyby`, `play` | `--budget-ms N` |
| The average or the 99th percentile frame is more than 10% and more than 1 ms slower than a saved baseline. | all | `--baseline NAME`, `--tolerance PERCENT`, `--floor-ms N` |
| The ready gate timed out, the scenario threw, or no report was written. | all | |

`first_use_ms` is the worst frame in the first 0.1 s after the cold spawn, `warm_ms` the same for the second
spawn, `steady_ms` the median frame while the cold spawn was alive. `ambient_ms` is the worst frame while
nothing was being spawned; when it is larger than the first-use allowance the run prints a warning, because
first-use results below it cannot be told from noise.

`--save-baseline NAME` writes the totals to `Gam3Perf/baselines/NAME.json`. Commit baselines; keep one per
scenario and data file, and make them alone on the machine.

## The data file

    room    { "distance": 6, "subjects": [
                { "name": "Fireball", "prefab": "Assets/FX/Fireball.prefab", "seconds": 2 } ] }
    flyby   { "scene": "Assets/Scenes/Level1.unity", "points": [
                { "pos": [0, 5, -20], "look": [0, 1, 0], "seconds": 0 },
                { "pos": [30, 5, 0],  "look": [0, 1, 0], "seconds": 4 } ] }
    play    { "scene": "Assets/Scenes/Level1.unity", "seconds": 30 }

`seconds` of a subject is how long the cold spawn stays alive; of a point, the time to travel there from the
point before. Keep the data files in `Gam3Perf/` and commit them: they are the list of what the game is made of.

## Prewarm: the cure for a first-use hitch

    var gate = ReadyGate.Begin(cover);
    Prewarm.Run(this, prefabsSpawnedDuringPlay, gate, shaderCollections);   // holds the gate as "prewarm"
    yield return gate.WaitUntilReady();

Each prefab is instantiated once, far from the level, in front of a small camera of its own, drawn for a few
frames and destroyed, all while the cover is up. It must be drawn, not only instantiated: an object that is
never drawn never compiles its shaders. One line reports it: `GAM3PREWARM: ok items=3 seconds=0.23`.

The prefab's scripts run during this, which is the point (their one-time set-up is part of the cost), but a
prefab that plays a sound, deals damage or reports an event when it spawns will do so during loading.
`Prewarm.Running` is true meanwhile; check it in such scripts, or keep those prefabs out of the list.

`--prewarm` on a room run sends the subjects through `Prewarm.Run` before measuring. A subject that fails
without it and passes with it is cured by prewarming; then add it to the list the game prewarms. A subject that
still fails with it costs that much on every spawn: pool it or make it cheaper.

## The play scenario

The kit does not play the game. `play` loads the scene and measures for `seconds`; something in the game must
play it: a bot, a demo mode, a recorded input. Put marks where the game changes what it is doing:

    Gam3.Perf.Mark("wave/3");        // free when nothing is recording
    Gam3.Perf.Mark("boss/phase2");

Every frame belongs to the latest mark, so the report says which wave or which ability was slow. If the game
has its own `ReadyGate`, recording starts when that gate opens.

## Editor numbers and player numbers

Without `--player` the scenario runs in the editor's play mode, in batch mode, at the project's own quality
level, with cameras drawing into a 1920x1080 texture (`--size WxH`). Editor numbers include editor overhead and
uncompiled-shader paths a player does not have. They are good for comparing one editor run with another on the
same machine: before and after a change, cold against warm. They are not what a player gets.

`--player` builds a player that starts in the scenario (the project's build settings are left alone; the scene
is saved as `Assets/Gam3PerfGenerated/Gam3Perf.unity` and the build goes to `Builds/gam3-perf/`), runs it in a
window and reads the same report. That is the number to quote. It opens a window on the desktop for the length
of the run.

Vertical sync and the frame cap are turned off during a run so the frame is measured, not the display. On a
small scene that gives frames well under 1 ms, where a difference of a fraction of a millisecond is noise: hence
the 1 ms floor on baseline comparisons.

## Alone on the machine

A performance run that shares the machine measures the other programs. Unless `--shared` is given, the runner
waits until no engine process is running and then holds every engine slot (`GAM3_MAX_ENGINES`) until it is
done, so other gam3stack runs queue behind it. `--shared` takes one slot like any other run and marks the
result `alone=no`: use it to check that a scenario works, never for a number you keep.

## Measured

Unity 6000.6.5f1, built-in pipeline, Apple M5 Max, a room with three subjects: a cube, a particle burst with
its own shader, and the same burst with a script that builds a 4-million-entry table the first time it wakes
(a stand-in for a lazily built pool or lookup).

| Run | Cube | Burst | Burst with one-time set-up | Result |
| --- | --- | --- | --- | --- |
| editor, cold | 1.6 / 0.5 | 2.4 / 1.2 | 115.2 / 1.0 | FAILED, names the third |
| editor, `--prewarm` | 0.9 / 0.9 | 1.0 / 0.8 | 0.7 / 0.8 | ok |
| player, cold | 11.5 / 9.7 | 0.9 / 0.9 | 102.4 / 0.8 | FAILED, names the third |
| player, `--prewarm` | 0.8 / 8.2 | 1.1 / 0.9 | 0.9 / 0.9 | ok |

Each cell is `first_use_ms / warm_ms`. On the very first run after the shader was written, the plain burst cost
21.4 ms on first use against 0.9 warm and failed too; after that the editor had the compiled shader cached and
it no longer did. The windowed player showed frames of 8 to 17 ms now and then with nothing spawning (multiples
of the display's refresh interval), which is where the 9.7 and 8.2 come from; the run warns about it.

## Limits

- The room is an empty scene with one directional light. A subject that depends on the level (lighting
  volumes, a manager object, a pipeline volume) needs those in the prefab or will not look or cost the same.
- A subject is a prefab asset. Things made in code need a prefab wrapper to be measured here.
- `gpu_ms`, `main_ms` and `render_ms` come from `FrameTimingManager` and are averages per segment that lag by a
  few frames. The pass/fail rules use whole-frame time only.
- In a player, `play` can load other scenes only if they are in the project's build settings.
- Built-in pipeline, macOS only was run. URP, HDRP, VFX Graph, Windows and Linux were not.
