# unity-driver

Run the Unity editor unattended and get an answer a script can read. Plain Node in `Tools/gam3/`, no packages
to install, plus one small editor script.

    node Tools/gam3/unity_run.mjs compile --profile blind
    node Tools/gam3/unity_run.mjs exec Namespace.Class.Method -- -myArg value
    node Tools/gam3/unity_run.mjs test --platform PlayMode --profile blind

Each run ends with one line: `GAM3UNITY: ok ...` or `GAM3UNITY: FAILED ...`, and exits 0 only on ok. The line
carries `profile=`, `ready=` (for `compile` and `exec`), `exit=`, the seconds the editor ran and `rss=`, the peak
memory of the editor process.

| File | What it is |
| --- | --- |
| `Tools/gam3/unity_run.mjs`, `unity_env.mjs` | the driver |
| `Tools/gam3/slots.mjs` | the machine-wide cap on engine processes (shared with other gam3stack drivers) |
| `Assets/Editor/Gam3/Gam3Profile.cs` | applies the profile inside the editor (quality level, fixed time step) |

| Command | What it does | Fails when |
| --- | --- | --- |
| `compile` | Opens the project in batch mode, lets it import and compile, quits | any `error CS####` line, or a non-zero exit |
| `exec` | Runs a public static method of an Editor script (`-executeMethod`), then quits | the method throws, calls `EditorApplication.Exit(n)` with n > 0, or is not found |
| `test` | Runs the Unity Test Framework (`-runTests`) and reads the results file | a test fails, no tests ran, or no results file was written |

Options: `--profile`, `--project DIR`, `--timeout SECONDS` (default 1800), `--log FILE`, and for `exec`
`--grep REGEX` to print more log lines and `--stay` (below). `test` takes `--platform EditMode|PlayMode` and
`--filter NAME`. Logs and test results go to `Logs/gam3/`.

## Profiles: how much the run needs to see

| `--profile` | What runs | Use it for |
| --- | --- | --- |
| `blind` | no graphics device (`-nographics`); play mode on a fixed time step | compile, EditMode tests, PlayMode tests of logic, data and asset work |
| `agent` | graphics, lowest quality level, 640x360 captures, play mode on a fixed time step | "is it there, is it in the right place, is the layout right" |
| `human` (default) | the project's quality, real time | the final look, feel, smoothness, frame rate |

`human` is the default so that a run without the option behaves as it did before profiles existed. Pass
`--profile blind` for every compile and test that does not render: that is the cheap path. `--nographics` is the
old spelling of `--profile blind`.

- Under `blind` nothing can be rendered. A capture (`Gam3.Shot.*`) is refused before the editor starts.
- Under `blind` and `agent`, play mode uses `Time.captureDeltaTime`: every frame advances game time by exactly
  1/30 s (`-- -gam3Fps 60` to change it), however long the frame took. A loaded machine changes how long a test
  takes, not what happens in it, and a test with nothing to draw runs far faster than real time. Code that reads
  the real clock (`Time.realtimeSinceStartup`, `Time.unscaledDeltaTime`, `Stopwatch`) still sees real time, so a
  test that waits on real seconds does not speed up.
- The quality level and time step are put back when play mode ends. Nothing is saved to `ProjectSettings/`.

Measured on a small built-in-pipeline project (one terrain scene, 13 play-mode tests), Unity 6000.6.5f1, Apple
M5 Max, warm `Library/`. Startup is nearly all of the time at this size, so the profiles differ in memory and
GPU use more than in seconds:

| Run | Seconds | Peak editor memory |
| --- | --- | --- |
| `compile --profile blind` | 5.5 to 6.9 | 510 to 545 MB |
| `compile --profile human` | 4.7 to 5.1 | 575 to 577 MB |
| `test --platform EditMode --profile blind` | 5.0 to 6.0 | 524 to 543 MB |
| `test --platform EditMode --profile human` | 4.5 to 5.2 | 572 to 585 MB |
| `test --platform PlayMode --profile blind` | 5.6 to 7.7 | 540 to 571 MB |
| `test --platform PlayMode --profile agent` | 6.0 to 7.8 | 587 to 609 MB |
| capture, `--profile agent` (640x360) | 4.5 to 6.6 | 586 to 590 MB |
| capture, `--profile human` (1600x900) | 4.6 to 5.3 | 622 to 625 MB |

The fixed time step is where the large gain is: 300 play-mode frames covered 10.000 s of game time in 0.006 s
of real time under `blind` and 0.033 s under `agent`. Under `human` the same 300 frames covered 0.031 s of game
time, because there game time is real time. Two editors on two environments ran side by side: two play-mode
test runs finished in 8 s together (6.2 s and 7.6 s each), two captures in 10 s. A bigger project will show
bigger differences between the profiles than this one does; measure yours with the `rss=` and seconds on the
result line.

## Readiness

`ready=ok` means a capture in this run waited until the scene was ready (see the `shot-capture` kit and the
`unity-readiness` skill). `ready=timeout` makes an `exec` run `FAILED`: the picture exists but shows a
half-loaded scene. `ready=none` means nothing in the run waited; for a capture method that is also a failure.

## Many agents on one machine

- `slots.mjs`: every run takes a slot first and waits when `GAM3_MAX_ENGINES` (default 3) engine processes are
  already running on the machine, whoever started them. `node Tools/gam3/slots.mjs` shows who holds what.
- One project directory can only ever have one editor. To run several at once each needs its own workspace: see
  the `unity-parallel` skill (and the optional `local-envs` kit when nothing else provides them).

## How `exec` methods should behave

- Public, static, no parameters, in a script under an `Editor` folder.
- Read arguments from `System.Environment.GetCommandLineArgs()`. Everything after `--` is passed through as is.
- Log lines that start with `GAM3` are printed by the driver. Use them for results.
- Catch your own errors, log them and call `EditorApplication.Exit(1)`. An escaped exception also fails the run.
- The editor quits when the method returns. A method that has to wait for editor updates (for shaders, imports
  or frames) must be run with `--stay`: `-quit` is then left out and the method ends the run itself with
  `EditorApplication.Exit(n)` from an `EditorApplication.update` callback. `--timeout` stops one that never does.

## Rules it follows

- One editor per project. If an editor already has the project open, the driver stops with
  `reason=project-open`. It never closes that editor. Close it yourself or do the work inside it.
- A leftover `Temp/UnityLockfile` with no editor behind it (after a crash) is ignored.
- It stops only the editor it started, and only on timeout or Ctrl-C.
- The editor is chosen by the version in `ProjectSettings/ProjectVersion.txt` from the Unity Hub install
  directory. `UNITY_EDITOR` overrides it. Opening a project with a different version re-imports it and can
  upgrade it, so the driver will not pick another version by itself.

## Looking at more than one frame: `look.mjs`

A single screenshot cannot show a fault that happens over time, or tell you a platform build looks wrong. Three
checks, on PNG files from any source (the game's own captures, a browser's, a phone's):

    node Tools/gam3/look.mjs blink   f00.png f01.png f02.png ...   # changes and changes back: lights, z-fighting
    node Tools/gam3/look.mjs shimmer f00.png f01.png f02.png ...   # still camera: anything that will not hold still
    node Tools/gam3/look.mjs compare reference.png other.png       # same view on two renderers or platforms

- **blink** ignores steady motion, so the burst may be taken during play. `--out heat.png` marks the pixels.
- **shimmer** needs the camera and the scene still (a fixed camera, nothing moving): a crawling shadow edge or
  boiling noise shows as a percentage and a heat picture.
- **compare** reports brightness, contrast, black level and saturation, and fails when the other picture has
  lost contrast, shifted in brightness or lifted its blacks: the washed-out look a mobile or web build gets when
  its lighting path differs from the one the level was lit for. In one real case the web build of a game
  passed every boot and input check while its black level was 11 to 12 points above the desktop build's.

Take bursts a tenth of a second apart, ten frames. Summary lines start `GAM3LOOK:`; the exit code is 1 on a fail.

## Limits

- Tested on macOS with Unity 6000.6.5f1 and the built-in render pipeline. The Windows and Linux paths follow
  Unity Hub's documented layout but were not run. `rss=` is not reported on Windows.
- `agent` lowers the quality level of the built-in pipeline's Quality settings. Under URP or HDRP that selects
  the pipeline asset of the lowest quality level, if the project has one per level. Not run there.
- A licence is needed. On a machine where Unity Hub is signed in, batch mode just works. On a build machine with
  no sign-in the run fails and the driver says so.
- `--profile blind` is fine for `compile` and tests. Anything that renders (screenshots) needs graphics, and a
  play-mode test that reads pixels must skip itself when `SystemInfo.graphicsDeviceType` is `Null`.
- Two runs out of about sixty during testing took far longer than the rest (79 s and 468 s where 5 s is normal).
  They passed. The 468 s one coincided with the laptop idling to sleep for six and a half minutes (the system
  power log shows it); a held slot now keeps macOS awake. The 79 s one was not explained; `--timeout` bounds it.
- For a few seconds after a run, asset import worker processes of the finished editor are still visible in the
  process list. They are not editors and the next run starts fine.
