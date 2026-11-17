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
2. `node Tools/gam3/unity_run.mjs compile`. Read the last line.
   - `GAM3UNITY: ok compile errors=0 ...`: go on.
   - `FAILED`: the lines above it are the compiler errors, as `Assets/Path/File.cs(line,col): error CS####: ...`.
     Fix those and run again. Do not run anything else until this passes: with compile errors Unity loads none
     of the project's scripts, so every later failure is noise.
3. Run the thing you changed:
   - an editor method: `node Tools/gam3/unity_run.mjs exec Namespace.Class.Method -- -arg value`
   - tests: `node Tools/gam3/unity_run.mjs test` (EditMode), or `--mode PlayMode`
4. Say what ran and paste the `GAM3UNITY:` line. If you did not run it, say that instead.

Typical times on a small project: 5 seconds for a compile check, 5 to 8 for a method or an EditMode test run.
The first open of a project (no `Library/` folder yet) imports everything and can take minutes.

## Rules

- **One editor per project.** If a person has the project open, the driver stops with `reason=project-open`.
  Do not close their editor and do not kill Unity processes you did not start. Ask them to close it, or have
  them run the menu item instead.
- **Do not copy the project to get around the lock** unless asked. Two copies drift apart.
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
  coroutine or `EditorApplication.update` callback started there never runs. Work that needs frames belongs in
  a PlayMode test.

## Reading a failure

The full editor log is at the path after `log=`. It is long; search it, do not read it top to bottom.

| In the log | Meaning |
| --- | --- |
| `error CS####` | a compile error; the driver already printed it |
| `executeMethod ... could not be found` | wrong name, not public static, not under `Editor`, or the scripts did not compile |
| `executeMethod method X threw exception` | the exception is named on the line above it |
| `another Unity instance is running with this project open` | an editor holds the project |
| licence lines near the top | no licence on this machine; a person must sign in with Unity Hub |

## Not verified here

PlayMode test runs, Windows and Linux were not run when this kit was made (see `verified` in the kit).
Treat the first run on those as a test of the driver itself.
