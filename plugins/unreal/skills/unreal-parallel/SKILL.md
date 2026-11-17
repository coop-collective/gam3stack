---
name: unreal-parallel
description: Split Unreal Engine work across subagents safely - choose how much engine each task needs (blind, agent or human profile), give each subagent its own workspace (from your platform, or a local copy-on-write clone), keep the machine within its engine limit, and merge the results back without losing binary assets. Use when a task can be split into independent parts, when planning or briefing subagents for Unreal work, when several engines or editors would run at once, when runs are slow and you want cheaper ones, or when merging branches that changed .uasset or .umap files.
---

# Parallel Unreal work: cheap eyes, separate rooms, one merge

Three ideas, in the order they pay off.

## 1. Use the cheapest eyes that answer the question

`ue_game.mjs --profile` (ue-driver kit):

| Question | Profile |
| --- | --- |
| Does it compile, load, run without errors? Does the logic do the right thing? Does the gate open? | `blind`: no renderer, game time as fast as the machine goes |
| Is the thing there? Right place, shape, rough colour? What is on screen at frame 0? Is a character in its bind pose? | `agent`: 640x360, cheap lighting, fixed time step |
| Does it look right? Lighting, shadows, materials up close, motion, frame rate | `human`: full quality, real time |

- Start at `blind` and move up only when the question needs a picture. Most iterations on logic and loading need
  none.
- Ask for data before pixels where you can: an actor count, a bounds box, a trace, a log line is exact and cheap.
- A screenshot above about 1500 pixels wide is scaled down before a model sees it. Large captures buy nothing.
- `agent` pictures are wrong about lighting by design. Never tune or approve look from them.
- Final check of anything a player sees: `human`, in the main checkout, after merging.

Under `blind` and `agent` the game runs on a fixed time step: results do not depend on how busy the machine is,
which is what makes running several at once safe.

## 2. One subagent, one workspace

Two agents in one checkout break each other: one compiles while the other's editor has the project open, both
write `Saved/`, both want the same editor port. So each subagent that runs the
engine needs a workspace of its own. Where that workspace comes from is not this plugin's business:

- **Your platform provides them** (separate machines, virtual machines, containers, an orchestrator that
  distributes the project): use that. Nothing below about `env.mjs` applies; the profiles, the readiness rules
  and the merge rules still do.
- **One machine, nothing else available:** the optional `local-envs` kit.

      node Tools/gam3/env.mjs create terrain     # -> GAM3ENV: ok created terrain path=... branch=gam3/terrain port=8124 copy=copy-on-write

  It copies the whole checkout as it is now (untracked assets, engine caches and uncommitted work included) onto
  a new branch, and checks the file system first. Where files can be cloned (APFS; Btrfs or XFS with reflinks; a
  Dev Drive on Windows 11) nothing is duplicated until a file changes: a 7.7 GB project (content and caches) cloned in 0.3 s and used no disk, and the game ran in
  the clone with no rebuild. Elsewhere (NTFS, ext4) a large project
  would be copied byte for byte, so `create` refuses and says so: get workspaces from elsewhere, or move the
  project to a cloning volume.

Brief each subagent with all of this, because it knows nothing else:

- its workspace (it must work there and nowhere else) and the branch it commits to;
- the task and what "done" means, including the exact check to run and the profile to run it at;
- **which files it owns** (see merging, below) and that it must not touch others;
- to commit its work on its branch and report the last lines of its checks (`GAM3BUILD:`, `GAM3GAME:`);
- the machine rules: start engines only through `Tools/gam3` (they take a slot), stop only what it started, never
  kill Unreal by name.

The machine limit is enforced, not requested: every tool that starts an engine waits for a slot
(`GAM3_MAX_ENGINES`, default 3, counting engines started by anyone). A subagent that seems stuck may be queued:
`node Tools/gam3/slots.mjs` shows who holds what. An open editor holds a slot until it is stopped, so subagents
should stop theirs when done. Each engine takes 2 GB of memory or more; raise the limit only on a machine that has it.

## 3. Merge on purpose

Text merges; engine assets do not. `.uasset` and `.umap` files are binary: when two branches change one, git can
only keep one side.

| Kind of change | Merges? | Rule |
| --- | --- | --- |
| C++, config, Python, data files | Yes | Normal git |
| An asset or level changed in one branch only | Yes | It is simply taken |
| An asset or level changed in two branches | No | Prevent it: one owner per file. Split work by folder or by level, and say so in each brief |
| Content generated from data (a level built by `world-landscape`) | Do not merge the result | Merge the data file, then rebuild the level in the main checkout |

Split work so the binary files do not overlap: one subagent per level, per character, per system. If two tasks
must touch one level, they are one task, or the level should be built from data.

Before merging each branch, find the binary files changed on both sides. With `local-envs`:

    node Tools/gam3/env.mjs status terrain      # CLASH lines are binary files changed on both sides

With workspaces from elsewhere, compare `git diff --name-only <fork>..<branch>` for each side yourself.

Then, from the main checkout, with no editor open on it:

1. Merge each branch, code-only branches first.
2. `ue_build.mjs` once, after the code is in.
3. Rebuild anything generated from data.
4. Verify at `--profile human`: the parts were only ever checked alone and at lower quality.
5. Release the workspaces (`env.mjs remove <name>` refuses while there is unmerged or uncommitted work).

## Limits to plan around

- `local-envs` was run on APFS only. Reflink cloning on Linux and the full-copy fallback were not run.
- Start-up is the fixed cost of every run, whatever the profile. For many small editor steps keep one editor open
  in the workspace (`ue_editor.mjs start`) instead of starting one per step.
