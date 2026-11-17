---
name: unity-batch-loop
description: Work on a Unity project without a person at the editor - check that scripts compile, run an editor method, run tests, and read the result from one line. Use when changing C# in a Unity project, when a Unity build or import fails, when asked to run Unity tests, or before saying a Unity change works.
---

# Unity batch loop

Unity can run with no window: it opens the project, does one job and exits. That is the feedback loop for an
agent. The `unity-driver` kit wraps it; install it first if `Tools/gam3/unity_run.mjs` is missing (see the
`gam3stack-unity-kits` skill, or call `unity_doctor`).

## The loop

1. Edit C#.
2. `node Tools/gam3/unity_run.mjs compile --profile blind`. Read the last line.
   - `GAM3UNITY: ok compile errors=0 ...`: go on.
   - `FAILED`: the lines above it are the compiler errors, as `Assets/Path/File.cs(line,col): error CS####: ...`.
     Fix those and run again. Do not run anything else until this passes: with compile errors Unity loads none
     of the project's scripts, so every later failure is noise.
3. Run the thing you changed:
   - an editor method: `node Tools/gam3/unity_run.mjs exec Namespace.Class.Method -- -arg value`
   - tests: `node Tools/gam3/unity_run.mjs test --profile blind` (EditMode), or `--platform PlayMode`
   - a picture: `node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture --profile agent -- ...` (kit `shot-capture`)
4. Say what ran and paste the `GAM3UNITY:` line. If you did not run it, say that instead.

Typical times on a small project: 5 to 7 seconds for a compile check, a test run or a capture.
The first open of a project (no `Library/` folder yet) imports everything and can take minutes.

## Use the cheapest profile that can see enough

`--profile blind` has no graphics device: right for compiling, for EditMode tests and for PlayMode tests of
logic, which then run on a fixed time step far faster than real time. `--profile agent` renders small and at
the lowest quality: right for "is it there and where". `--profile human` (the default) is the project's real
quality in real time: the only one that can judge the look or the feel. The `unity-parallel` skill has the
full table, and the way to run several agents at once, each in its own environment.

## Never judge a picture that was not ready

A capture's result line says `ready=ok` or `ready=timeout`. With `ready=timeout` the run is `FAILED` and the
picture shows a half-loaded scene: diagnose it, do not describe it. The same care applies to the game you are
building: a loading cover until the world is ready, and no character drawn in bind pose. The `unity-readiness`
skill has both sets of rules; follow it whenever you capture, or touch a load, a spawn or a pool.

## Rules

- **One editor per project.** If a person has the project open, the driver stops with `reason=project-open`.
  Do not close their editor and do not kill Unity processes you did not start. Ask them to close it, or have
  them run the menu item instead.
- **Do not hand-copy the project to get around the lock.** Untracked copies drift apart. When several agents need
  their own editor, give each a workspace on its own branch and merge them back; see the `unity-parallel` skill.
- **The machine has a cap.** Every run takes a slot and waits while `GAM3_MAX_ENGINES` (default 3) engines are
  running. A run that prints `slots: waiting ...` is queued, not stuck. Do not raise the cap yourself.
- **Never pick a different editor version on your own.** Opening a project with a newer editor upgrades it,
  and that is hard to undo. If the matching version is missing, say so.
- **`.meta` files are source.** Unity creates one per asset. When you add, move or delete an asset from the
  shell, the matching `.meta` must be added, moved or deleted with it. Moving a file without its `.meta` breaks
  every reference to it. The safe way to move assets is `AssetDatabase.MoveAsset` from an `exec` method.
- **Do not edit `Library/`, `Temp/` or `Logs/`**, and do not commit them.

## Writing a method for `exec`

```csharp
using UnityEditor;
using UnityEngine;

public static class BuildTools            // in a folder named Editor
{
    public static void Report()
    {
        try
        {
            string[] args = System.Environment.GetCommandLineArgs();   // everything after "--" is in here
            Debug.Log("GAM3REPORT: scenes in build " + EditorBuildSettings.scenes.Length);
        }
        catch (System.Exception e)
        {
            Debug.LogError("GAM3REPORT: FAILED " + e.Message);
            EditorApplication.Exit(1);
        }
    }
}
```

- Public, static, no parameters.
- The driver prints log lines that start with `GAM3`. Put results there, not in a long dump.
- The run fails when the method throws or calls `EditorApplication.Exit` with a non-zero code.
- The job must finish inside the method. Batch mode with `-quit` exits when the method returns, so a
  coroutine or `EditorApplication.update` callback started there never runs. A method that has to wait for
  editor updates (shaders, imports) runs with `exec --stay` and ends the run itself with
  `EditorApplication.Exit(n)`. Work that needs game frames belongs in a PlayMode test.

## Reading a failure

The full editor log is at the path after `log=`. It is long; search it, do not read it top to bottom.

| In the log | Meaning |
| --- | --- |
| `error CS####` | a compile error; the driver already printed it |
| `executeMethod ... could not be found` | wrong name, not public static, not under `Editor`, or the scripts did not compile |
| `executeMethod method X threw exception` | the exception is named on the line above it |
| `another Unity instance is running with this project open` | an editor holds the project |
| licence lines near the top | no licence on this machine; a person must sign in with Unity Hub |
| `GAM3READY: TIMEOUT waiting=...` | the scene was not ready when captured; see the `unity-readiness` skill |
| `reason=blind-cannot-capture` | a capture was asked for under `--profile blind`; use `agent` or `human` |

## Not verified here

Windows, Linux, URP and HDRP were not run when this kit was made (see `verified` in the kit). Treat the first
run on those as a test of the driver itself.
