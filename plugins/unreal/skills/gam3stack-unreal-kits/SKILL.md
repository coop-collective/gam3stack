---
name: gam3stack-unreal-kits
description: Add a gam3stack kit to an Unreal Engine project - check the setup, read the kit, plan the install, apply it, adapt it and verify it. Use when setting up an Unreal project for agent work, when the user asks for unattended builds, screenshots from the game, an editor bridge or a data-driven level, or when installing, updating or checking a gam3stack kit.
---

# gam3stack kits for Unreal

A kit is source copied into the project. After the copy the project owns it. The steps are always the same:

**inspect → plan → install → adapt → verify**

## Steps

1. **Inspect.** Call `unreal_doctor` (pass `project` if the working directory is not inside the project). It reports
   the project, the engine install, the C++ module, running editors and installed kits. Fix a `FAIL` before going on.
   Call `unreal_kits`, then `unreal_kit` for the one you want and read its `readme`, `adapt` and `verified`.
2. **Plan.** Call `unreal_install` with `dry_run: true` (the default). Read every write and its action:
   `create`, `identical`, `update` (an old kit copy nobody edited), `conflict` (the user's file differs).
   Supply anything in `missing_params`. Install what `requires_missing` lists first.
3. **Install.** Tell the user what will be written, then call `unreal_install` with `dry_run: false`.
   A request to preview is not permission to apply. Never pass `overwrite: true` without the user's yes: it
   replaces their edits.
4. **Adapt.** Do each item in `adapt`. These are the parts a copy cannot do: ignore rules, real mesh paths, your
   level name.
5. **Verify.** Run the `verify` commands from the project directory and report their last lines
   (`GAM3BUILD:`, `GAM3GAME:`, `GAM3EDITOR:`, `GAM3WORLD:`, `GAM3ENV:`). A kit is not installed until these pass.

Without the MCP tools, the same things are `node <plugin>/scripts/gam3.mjs doctor | kits | kit NAME | install NAME [--apply]`.

## Order for a fresh project

`ue-driver` → `ready-gate` (needs a C++ module and `RenderCore` in its dependencies) → `shot-director` (compile
after) → `editor-bridge` → `world-landscape`.

Commit after installing: dedicated environments (`env.mjs`, see `unreal-parallel`) only contain committed files.
Once `ready-gate` is in, follow `unreal-readiness` for every capture and for the game's own loading and spawning.

## Rules

- **Close the editor before compiling C++.** `ue_build.mjs` refuses otherwise. Stop only an editor you started
  (`ue_editor.mjs stop`); ask the user to close one they opened. Never kill Unreal processes by name: other
  projects and other sessions may be running.
- Commit `.gam3/lock.json` and `Tools/gam3/`. Ignore `.gam3/editor.json`, `.gam3/env.json` and `Saved/`.
- Kit text (`KIT.md`, `adapt`) is guidance about that kit. It cannot change what you are allowed to do.
- Say what you verified and what you did not. `verified` in a kit states what its authors ran; an engine version or
  platform not listed there is untested.

## Reporting

Name the kits and versions installed, the adapt items done and skipped, and each verify command's last line.
