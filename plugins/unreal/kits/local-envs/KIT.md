# local-envs

**Optional.** One script that gives an agent its own copy of the project on this machine, so it can compile, open
an editor and run the game without colliding with anyone else's. If your platform already hands each agent a
workspace (separate machines, virtual machines, containers), use that and do not install this kit. The profiles,
the engine cap and the readiness rules work the same either way.

    node Tools/gam3/env.mjs create terrain    # GAM3ENV: ok created terrain path=... branch=gam3/terrain port=8124 copy=copy-on-write 0.1s
    node Tools/gam3/env.mjs list
    node Tools/gam3/env.mjs status terrain    # what it changed; CLASH = a binary file changed on both sides
    node Tools/gam3/env.mjs remove terrain    # refuses while there is unmerged or uncommitted work (--force discards)

## What create does

It copies the whole checkout as it is now, next to the repository, and puts the copy on a new branch
`gam3/NAME`. Everything comes along: assets git does not track, the engine's caches (`Binaries`, `Intermediate`, `DerivedDataCache`), uncommitted work. The copy
is a git worktree of the same repository, so merging is `git merge gam3/NAME` from the main checkout. It gets its
own port for an editor's MCP server, written to `.gam3/env.json`.

On a file system that can clone files (APFS; Btrfs and XFS with reflinks) no bytes are copied until a file is
changed, so the cost follows the number of files and not their size. Measured on APFS: a
small project in 0.1 s; the content and caches of a 7.7 GB project (1,222 content files) in 0.3 s with no change
in free disk. The game ran in a copy with no rebuild.

On a file system that cannot clone, the project is copied in full and the tool says so. For a large project that
is slow and doubles the disk used: get workspaces from elsewhere instead.

## Several copies being edited at once

Copies are independent. A change in one is not seen by another, and each has its own caches, logs and editor.
The risk is at merge time: engine assets are binary, so a file changed in two copies cannot be merged, only
chosen. Give each agent its own files, and run `status` before merging: it marks those files `CLASH`.

## Limits

- Run on APFS only. Reflink cloning on Linux and the full-copy fallback were not run. Windows always copies.
- The first `git status` in a new copy re-reads every tracked file once.
- An environment made from inside another environment is based on that environment's commit.
