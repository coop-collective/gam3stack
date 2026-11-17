# ue-driver

Shell commands for the things an agent needs before it can check its own Unreal work. Node 20+, no packages.

| Command | What it does | Last line |
| --- | --- | --- |
| `node Tools/gam3/ue_build.mjs` | Compiles the project's C++ (editor target) with the engine's build tool | `GAM3BUILD: ok` / `FAILED` |
| `node Tools/gam3/ue_python.mjs script.py --marker "DONE"` | Runs an editor Python script in an editor that then quits | `GAM3PY: ok` / `FAILED` |
| `node Tools/gam3/ue_game.mjs --profile agent --map L_Level --quit 5` | Runs the real game with no editor UI, then reads its log | `GAM3GAME: ok` / `FAILED` |
| `node Tools/gam3/env.mjs create NAME` | Makes a dedicated environment: a second checkout with its own caches and port | `GAM3ENV: ok` / `FAILED` |
| `node Tools/gam3/slots.mjs` | Shows which engine processes are running and who holds a slot | JSON |

Each takes `--log FILE`; by default logs go to `Saved/Logs/gam3/`. Each exits non-zero on failure.

## Profiles: how much engine a run needs

`ue_game.mjs --profile` picks one. Use the cheapest that can answer the question.

| Profile | What runs | Answers | Cannot answer |
| --- | --- | --- | --- |
| `blind` | No renderer (`-nullrhi`), fixed time step | Does it load, does the logic run, what does the log say | Anything visual. `--shots` is refused |
| `agent` | 640x360, lighting quality lowered, fixed time step | Is it there, where, what shape, roughly what colour, first frame after ready | Lighting, shadows, anti-aliasing, frame rate |
| `human` (default) | Full quality, real time | Look, feel, speed: the sign-off | |

Under a fixed time step each frame advances the game by exactly 1/30 s however long it took to compute. A slow or
busy machine changes how long the run takes, never what happens in it, and a run with no renderer goes as fast as
the machine allows. Measured on an Apple silicon laptop, UE 5.9, a small landscape level, 10 seconds of game time,
second run onwards: `blind` 6.4 s (the 10 game seconds took 0.03 s; the rest is start-up), `agent` 10.3 s, `human`
18.2 s. Peak memory 2.0, 2.5 and 2.5 GB. A heavier level changes these; measure your own.

`agent` does not lower view distance, foliage or texture quality: a profile that hides things would turn "is it
there" into a wrong no.

## Rules these scripts enforce

- **A capture counts only when the level was ready.** With the `ready-gate` kit, `ue_game.mjs` reports `ready=ok`,
  `timeout` or `none`, counts screenshot times from that moment, and fails a run whose level never became ready or
  that drew a character in its bind pose.
- **At most `GAM3_MAX_ENGINES` engine processes at once on the machine** (default 3). Every editor and game started
  here takes a slot first and waits when none is free. Engines started by hand or by other tools count too.
- **The machine stays awake while a slot is held** (macOS: `caffeinate`). A laptop that idles to sleep freezes the
  run and its timeouts with it.

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

## Dedicated environments

`env.mjs create NAME` adds a git worktree next to the repository on branch `gam3/NAME`, clones the per-checkout
caches (`Binaries`, `Intermediate`, `DerivedDataCache`) copy-on-write, and gives the environment its own editor
port. Measured: 0.1 s to create with 665 MB of caches, no extra disk; the game then ran there with no rebuild, and
a C++ build there took 22 s against 73 s for a first build. `env.mjs status NAME` lists what the environment
changed and marks binary files that also changed on the base branch (`CLASH`): git cannot merge those. Merging is
plain `git merge gam3/NAME` from the main checkout. Work that is not committed is not in a new environment, and
that includes these tools: commit `Tools/gam3` first.

## Limits

- Windows and Linux paths and quoting are carried over from scripts that ran on those platforms, but this kit as
  packaged was only run on macOS. See `verified` in `kit.json`.
- `ue_game.mjs --shots/--quit/--cam` need the `shot-director` kit. Without it the game runs until `--timeout`.
- Without the `ready-gate` kit there is no readiness signal: runs report `ready=none`, and a run that asked for
  screenshots is reported `FAILED` because nothing says the level was ready when they were taken.
- Copy-on-write cloning was run on APFS only. Elsewhere `env.mjs` falls back to a full copy.
- Two engines starting in the same second race over a build tool trace file; the resulting exception in the log
  is ignored.
