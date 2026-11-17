---
name: unreal-editor-loop
description: The working loop for changing an Unreal Engine project as an agent - run Python in an open editor, compile C++, run the real game unattended and read screenshots and logs to check the result. Use when editing levels, materials, assets or C++ in an Unreal project, when a change needs to be seen or proven, or when editor calls hang, a build is refused, or the game looks wrong (grey materials, dark captures).
---

# The Unreal loop: change, build, look

Needs the `ue-driver`, `editor-bridge` and `shot-director` kits in the project (see `gam3stack-unreal-kits`).
All commands run from the project directory.

## Two ways to run things, and when

| Work | Use | Why |
| --- | --- | --- |
| Levels, assets, materials, anything scripted in the editor | `ue_editor.mjs start` once, then `ue_mcp.mjs py @script.py` | The editor stays open: each step takes seconds, results come back as JSON |
| C++ changes | `ue_editor.mjs stop`, then `ue_build.mjs` | The compile fails or loads stale code while an editor has the project open |
| Seeing the result | `ue_game.mjs --map ... --shots 5,9 --quit 11` | Only the game shows the true lighting and broken materials |
| A one-off scripted job with no editor open | `ue_python.mjs script.py --marker DONE` | Starts an editor, runs, quits |

A normal cycle: edit by script in the open editor → save → run the game with shots → read the PNGs and the
`GAM3GAME:` line → adjust. For C++: stop the editor → build → run the game.

## Editor Python through the bridge

- Explore first: `ue_mcp.mjs toolsets`, `describe <Toolset>`, `schema <Toolset.Tool>`. The engine documents its own
  tools; read them instead of guessing names. Inside Python, `help(unreal.SomeClass)` works the same way.
- Imports at the top level of the script only.
- The last expression is the result. To return data, end the script with a variable name.
- Errors inside a nested `exec()` vanish. Wrap work in `try/except` and return `traceback.format_exc()`.
- `importlib.reload(module)` after editing a module: the editor keeps it loaded.
- Many jobs finish on later frames (PCG generation, exports, shader compiles). Start the job, return, poll in
  another call, then save.
- Save by name. Check `get_editor_world().get_name()` first: after a restart the open level is the startup map.

## Checking the result

- **Read the screenshots.** `ue_game.mjs` prints their paths. Look at them; do not report success from an exit code.
- **Read the last line.** `GAM3GAME: ok shots=2/2 material_errors=0 fatal=0`. Any material error means something
  on screen is flat grey even if the screenshot was not pointed at it.
- **Editor captures are for layout only.** `ue_mcp.mjs shot` renders much darker than the game; do not tune
  lighting from it.
- Give the first shot a few seconds so textures and lighting settle.

## When it goes wrong

| Symptom | Cause | Do |
| --- | --- | --- |
| MCP calls hang, no error | A stale process holds the port (often the crash reporter of a killed editor) | `ue_editor.mjs status`, then `stop`; start again |
| First calls take minutes | Shaders compiling after a start or after enabling plugins | Wait; `start` already waits for a real answer |
| `GAM3BUILD: FAILED editor pid ...` | An editor has the project open | Stop it (yours) or ask the user to close it (theirs) |
| Surfaces draw flat grey in the game | The material failed to compile | Read the `material:` lines; common cause is a texture sampler type that does not match its texture |
| The game never exits | No `--quit` and no code that quits | Pass `--quit`, or rely on `--timeout` |
| A saved level is not the one you edited | Saved "the current level" after a restart | Check the open level's name before saving |

## Machine manners

- Never kill Unreal by name. Stop only what you started, by PID; the scripts do this for you.
- One editor per project. On a shared machine keep the number of running engine instances small: each one takes
  several GB of memory and most of the GPU.
