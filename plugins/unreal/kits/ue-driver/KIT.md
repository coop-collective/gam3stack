# ue-driver

Shell commands for the three things an agent needs before it can check its own Unreal work. Node 20+, no packages.

| Command | What it does | Last line |
| --- | --- | --- |
| `node Tools/gam3/ue_build.mjs` | Compiles the project's C++ (editor target) with the engine's build tool | `GAM3BUILD: ok` / `FAILED` |
| `node Tools/gam3/ue_python.mjs script.py --marker "DONE"` | Runs an editor Python script in an editor that then quits | `GAM3PY: ok` / `FAILED` |
| `node Tools/gam3/ue_game.mjs --map L_Level --timeout 60` | Runs the real game with no editor UI, then reads its log | `GAM3GAME: ok` / `FAILED` |

Each takes `--log FILE`; by default logs go to `Saved/Logs/gam3/`. Each exits non-zero on failure.

## Rules these scripts enforce

- **No compile while an editor has the project open.** The build refuses and names the PID. Close that editor
  yourself (or `ue_editor.mjs stop` from the editor-bridge kit). `--force` skips the check. On Windows the check
  is not done.
- **Only processes these scripts started are ever stopped** (on a timeout, or a hang during engine shutdown).
- **The editor's exit code proves nothing.** `ue_python.mjs` passes when a marker line you choose shows up in the
  log; have the script log it as its last act.
- **Judge looks in the game, not the editor.** `ue_game.mjs` reports materials that failed to compile. Such a
  material draws flat grey in the game, and the log is the only place that says so.

## Settings

`UE_ROOT` (engine root) when the engine is not in the launcher's default folder. Otherwise the install matching the
project's `EngineAssociation` is used, else the newest one found. `GAM3_RENDER_OFFSCREEN=1` on machines with no
desktop session.

## Limits

- Windows and Linux paths and quoting are carried over from scripts that ran on those platforms, but this kit as
  packaged was only run on macOS. See `verified` in `kit.json`.
- `ue_game.mjs --shots/--quit/--cam` need the `shot-director` kit. Without it the game runs until `--timeout`.
