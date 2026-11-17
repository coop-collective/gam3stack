# unity-driver

Run the Unity editor unattended and get an answer a script can read. Two files in `Tools/gam3/`, plain Node, no
packages to install.

    node Tools/gam3/unity_run.mjs compile
    node Tools/gam3/unity_run.mjs exec Namespace.Class.Method -- -myArg value
    node Tools/gam3/unity_run.mjs test --mode EditMode

Each run ends with one line: `GAM3UNITY: ok ...` or `GAM3UNITY: FAILED ...`, and exits 0 only on ok.

| Command | What it does | Fails when |
| --- | --- | --- |
| `compile` | Opens the project in batch mode, lets it import and compile, quits | any `error CS####` line, or a non-zero exit |
| `exec` | Runs a public static method of an Editor script (`-executeMethod`), then quits | the method throws, calls `EditorApplication.Exit(n)` with n > 0, or is not found |
| `test` | Runs the Unity Test Framework (`-runTests`) and reads the results file | a test fails, no tests ran, or no results file was written |

Options: `--project DIR`, `--timeout SECONDS` (default 1800), `--log FILE`, `--nographics`, and for `exec`
`--grep REGEX` to print more log lines. Logs and test results go to `Logs/gam3/`.

## How `exec` methods should behave

- Public, static, no parameters, in a script under an `Editor` folder.
- Read arguments from `System.Environment.GetCommandLineArgs()`. Everything after `--` is passed through as is.
- Log lines that start with `GAM3` are printed by the driver. Use them for results.
- Catch your own errors, log them and call `EditorApplication.Exit(1)`. An escaped exception also fails the run.

## Rules it follows

- One editor per project. If an editor already has the project open, the driver stops with
  `reason=project-open`. It never closes that editor. Close it yourself or do the work inside it.
- A leftover `Temp/UnityLockfile` with no editor behind it (after a crash) is ignored.
- It stops only the editor it started, and only on timeout or Ctrl-C.
- The editor is chosen by the version in `ProjectSettings/ProjectVersion.txt` from the Unity Hub install
  directory. `UNITY_EDITOR` overrides it. Opening a project with a different version re-imports it and can
  upgrade it, so the driver will not pick another version by itself.

## Limits

- Tested on macOS with Unity 6000.6.5f1 and the built-in render pipeline. The Windows and Linux paths follow
  Unity Hub's documented layout but were not run.
- `test --mode PlayMode` passes the right arguments but was not run.
- A licence is needed. On a machine where Unity Hub is signed in, batch mode just works. On a build machine with
  no sign-in the run fails and the driver says so.
- `--nographics` is fine for `compile` and edit-mode tests. Anything that renders (screenshots) needs graphics.
- For a few seconds after a run, asset import worker processes of the finished editor are still visible in the
  process list. They are not editors and the next run starts fine.
