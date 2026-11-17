---
name: unity-parallel
description: Split Unity work across several agents on one machine - choose how much each task needs to see (blind, agent or human profile), give each subagent its own environment with its own Library, cap the number of running editors, and merge the results back. Use when a Unity task is large enough to split, when running subagents or several Unity editors at once, when deciding whether a job needs graphics, or when merging Unity work from another branch or worktree.
---

# Parallel Unity work

Most of what an agent does in Unity does not need a picture a person would enjoy, and a lot of it needs no
picture at all. Run each job with the least it needs, in its own environment, and many jobs fit on one machine.

Needs the `unity-driver` kit (`Tools/gam3/unity_run.mjs`, `slots.mjs`, `env.mjs`).

## 1. Pick the tier of eyes for each job

| Job | Profile | Why |
| --- | --- | --- |
| compile check, EditMode tests | `blind` | nothing is drawn |
| PlayMode tests of logic: movement, combat rules, AI, save and load, spawning, readiness gates | `blind` | fixed time step: seconds of game time per millisecond |
| importing assets, generating terrain or data, editing prefabs or scenes from a script | `blind` | asset work, not rendering |
| "is it there, is it in the right place, is the layout right, did the road get painted" | `agent` | 640x360 at the lowest quality is enough to see it |
| first frames after a load, first frame of a spawn | `agent` to find faults, `human` to confirm | see the `unity-readiness` skill |
| lighting, shadows, materials, post-processing, anti-aliasing, anything about how it *looks* | `human` | the lowest quality level turns these off |
| feel, animation smoothness, frame rate, anything timed against the real clock | `human` | the fixed time step hides exactly this |

Rules that follow from the table:

- Never judge the look from an `agent` capture, and never report frame rate from a `blind` or `agent` run.
- A PlayMode test that reads pixels must skip itself under `blind` (`SystemInfo.graphicsDeviceType ==
  GraphicsDeviceType.Null`), not fail.
- Under the fixed time step, wait on game events or `Time.time`, not on `Time.realtimeSinceStartup`: waiting on
  the real clock makes a fast run slow again.
- Finish with one `human` pass in the main checkout before saying the work is done.

## 2. One environment per subagent

A Unity project directory can have exactly one editor. Two agents in one directory block each other, and two
editors writing one `Library/` corrupt it. So each subagent that needs to run Unity gets its own checkout:

```sh
git add -A && git commit -m "..."         # uncommitted work does not travel to a new environment
node Tools/gam3/env.mjs create terrain    # ../<repo>-env-terrain, branch gam3/terrain, Library/ cloned
node Tools/gam3/env.mjs list
```

`create` makes a git worktree and clones `Library/` copy-on-write where the file system supports it (APFS,
Btrfs, XFS), so the new environment opens without a re-import. Measured: 0.4 s to create with an 84 MB
`Library/` on APFS, and the first run in it took the same 6 to 8 s as in the main checkout. On a file system
without cloning the copy is a real copy: slower and as large as `Library/`.

Tell each subagent, in its brief:

- its environment path, and that it works **only** there;
- which files and folders it owns (see section 4);
- the profile to use for each kind of check;
- that it commits its work on its branch and does not merge;
- that it stops only Unity processes it started, and never copies or deletes another environment.

A subagent that only edits C# and never runs Unity does not need an environment. It needs a file list.

## 3. The machine has a budget

Every `unity_run.mjs` run takes a slot and waits while `GAM3_MAX_ENGINES` (default 3) engine processes are
running on the machine, whoever started them. `node Tools/gam3/slots.mjs` shows the holders. So:

- do not start more subagents that run Unity than the cap and expect them all to make progress at once: the
  extra ones wait in line;
- set the cap from memory, not from cores. Read `rss=` on a result line of your own project at each profile
  and leave room for the import and shader worker processes, which are not counted in it;
- a subagent must not raise `GAM3_MAX_ENGINES` for itself. The cap belongs to whoever owns the machine.

## 4. Split so that it merges

Git merges text. Unity writes much of a project as files it cannot merge in practice.

| Merges cleanly | Does not merge: one owner per file |
| --- | --- |
| C# scripts | scenes (`.unity`) |
| layout and data files read by a builder script (JSON, C# data classes) | prefabs (`.prefab`) and their variants |
| `.asmdef`, package manifest (when different lines change) | `ScriptableObject` and other `.asset` files, materials, animation controllers |
| new files nobody else touches, with their `.meta` | terrain data, lighting data, baked navmesh |
| | textures, models, audio |
| | `ProjectSettings/*.asset` when two agents change the same file |

- **Give every unmergeable file exactly one owner** for the length of the split. Two agents never edit the same
  scene or prefab. If two jobs both need a scene, split the scene (additive scenes, or prefabs placed by one
  owner), or run the jobs one after the other.
- **Prefer data that rebuilds.** When a level is generated from a data file (the `terrain-from-data` kit), the
  subagent changes the data and the builder, which merge. The generated scene and terrain assets are rebuilt in
  the main checkout after the merge, not merged.
- **`.meta` files travel with their asset.** A subagent that adds a file commits the `.meta` Unity made for it.
  Two environments must not each create the same new asset path: the GUIDs differ and every reference to one of
  them breaks.
- `ProjectSettings/`, `Packages/manifest.json` and tags or layers belong to the main agent unless a subagent is
  given one of them by name.

## 5. Merge, then verify in the main checkout

From the main checkout, one environment at a time:

```sh
node Tools/gam3/env.mjs status terrain    # what it changed; binary files; CLASH = binary changed on both sides
git merge gam3/terrain
node Tools/gam3/unity_run.mjs compile --profile blind
node Tools/gam3/env.mjs remove terrain    # refuses while it has unmerged or uncommitted work
```

1. Read `status` first. `CLASH` means a file git cannot merge changed on both sides. Do not let git pick: decide
   which side wins, or rebuild the file from its data after merging.
2. Merge code-only environments first, then the ones that own assets.
3. After each merge: `compile --profile blind`. After all of them: rebuild anything generated from data, run the
   tests, then look. The look happens here, in the merged project, at `--profile human`, with `ready=ok`.
4. What a subagent verified in its environment is evidence about its branch. It is not evidence about the merged
   project. Say what was run after the merge.

## Not verified

Measured on one machine (Apple M5 Max, macOS, Unity 6000.6.5f1, a small built-in-pipeline project): two editors
side by side on two environments, the cap making a run wait for a free slot (tested with a cap of 1), and the
create, status, merge and remove round. More than two Unity editors at once, large projects, Windows and Linux were not run.
