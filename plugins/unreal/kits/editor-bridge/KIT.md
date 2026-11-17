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
