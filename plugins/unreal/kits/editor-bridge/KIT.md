# editor-bridge

Recent engine versions ship an experimental plugin, "Unreal MCP", that lets the editor answer tool calls on a local
port. This kit starts an editor with that port open and gives the shell a client for it, so work happens in an
editor that stays open: no start-up cost per step, and results come back as JSON.

    node Tools/gam3/ue_editor.mjs start                 # returns when the editor answers (minutes on a first run)
    node Tools/gam3/ue_mcp.mjs toolsets                 # what this engine version offers
    node Tools/gam3/ue_mcp.mjs describe EditorToolset.LevelToolset
    node Tools/gam3/ue_mcp.mjs py @Tools/my_script.py   # last expression is the result
    node Tools/gam3/ue_mcp.mjs shot out.png --world /Game/Maps/L_Level.L_Level --at 0,0,100
    node Tools/gam3/ue_editor.mjs stop                  # before any C++ compile

## Turning the editor's tools on

`ue_editor.mjs start` needs no set-up: it passes the port, the server switch and the tool plugins on the command
line. Set-up is only needed for an editor **opened by hand** (or by a person on the team), and it has three parts
that are easy to miss because the engine does none of them by default:

    node Tools/gam3/ue_editor.mjs setup            # shows what is on, and prints the steps below for this project
    node Tools/gam3/ue_editor.mjs setup --write    # adds the plugin entries to the .uproject

1. **Plugins, per project (commit this).** `ModelContextProtocol` ("Unreal MCP") is the server. Each group of
   tools is its own plugin under `Engine/Plugins/Experimental/Toolsets`, and none is on by default. Without any,
   the server answers with nothing useful. `--write` adds them to the `.uproject`; by hand it is Edit > Plugins,
   search "MCP" and "Toolset", restart.
2. **Start the server, per person (not committed).** Edit > Editor Preferences > "Model Context Protocol" >
   Auto Start Server, and set Server Port Number (the engine's default is 8000; these tools use 8123). The
   setting is stored in `Saved/Config/<Platform>Editor/EditorPerProjectUserSettings.ini`, so every person and
   every fresh checkout does it once. For one session: `-ModelContextProtocolStartServer` on the command line.
3. **Point the agent at it (optional).** `ue_mcp.mjs` already calls it from the shell. To give an agent the
   tools directly: `claude mcp add --transport http unreal-editor http://127.0.0.1:8123/mcp`, or let the
   preferences page write the config for your client.

Which tool plugins to enable (`--toolsets A,B`; the default is the first five):

| Plugin | For | Run here |
| --- | --- | --- |
| `EditorToolset` | Python in the editor, actors, assets, levels. The one everything else leans on | yes |
| `SceneCaptureToolset` | Viewport and camera captures (`ue_mcp.mjs shot`) | yes |
| `PCGToolset` | Procedural content graphs (`world-landscape`) | yes |
| `ConsoleToolset` | Console variables and commands | yes |
| `GeometryToolset` | Mesh building and editing | yes |
| `NiagaraToolsets`, `PerfToolset`, `AutomationTestToolset`, `LiveCodingToolset`, `InputToolset`, `StateTreeToolset`, `NavMeshToolset`, `PhysicsToolsets`, `GameplayTagsToolset`, `ConfigSettingsToolset` | Add one when the work needs it; read it with `ue_mcp.mjs describe` first | no |
| `AllToolsets` | Everything at once: dozens of plugins, slower start, a tool list too long to be useful | no |
| `BlueprintToolsets` | Leave off: these projects are code only (see `unreal-code-first`) | no |

The server lists four meta-tools (`list_toolsets`, `describe_toolsets`, `describe_tools`, `call_tool`) rather
than every tool, so an agent discovers tools on demand; `ue_mcp.mjs toolsets` and `describe` are the same calls.

## Things that cost time when not known

- **Python: imports go at the top level of the script.** An import inside a function is rejected.
- **Python: the result is the script's last expression.** Output from a nested `exec()` is lost; errors inside one
  vanish. Wrap the work in `try/except`, put the traceback in a variable and name that variable on the last line.
- **The editor keeps Python modules loaded.** After editing a module, `importlib.reload` it.
- **Long jobs finish on later frames.** PCG generation and asset exports return at once and complete while the
  editor ticks. Poll for the result, then save.
- **The first calls after start can take minutes** while shaders compile. `start` waits for a real answer.
- **A killed editor can leave its crash reporter holding the port.** The next editor cannot listen and calls hang
  with no error. `ue_editor.mjs status` shows who holds the port; `stop` ends the reporter of the editor it started.
- **Save by name.** Right after a start the "current level" is the project's startup map, not yours. Check which
  level is open before saving.
- **Viewport captures (`shot`) are for layout, not lighting.** They render darker than the game. Use
  `ue_game.mjs` with the shot-director kit to judge the look.

## Limits

- Tool and toolset names are the engine's and can change between versions. The Python tool defaults to
  `editor_toolset.toolsets.python_scripting.PythonScriptingTools` / `execute_python`; override with
  `UE_MCP_PY_TOOLSET` and `UE_MCP_PY_TOOL` if `toolsets` shows something else. Verified on UE 5.9 only; the plugin
  also ships with 5.8 but was not run there.
- One editor per project. `start` does nothing if the one it started is still alive.
- The port check and the crash-reporter cleanup use `lsof` and `ps`: Mac and Linux. On Windows they are skipped.
- The port defaults to the one in `.gam3/env.json` when the project is a local environment (the optional `local-envs` kit), so
  two environments never share one. The editor holds an engine slot (`slots.mjs`) while it runs.
- An idle editor in the background measured about 6% of one processor core and 3.5 GB of memory; turning realtime
  viewports off did not change that. Its cost is memory: stop it when the work is done.
