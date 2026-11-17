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

## What it costs, by file system

`create` checks whether the volume can clone files before it copies anything.

| Volume | What happens | Cost |
| --- | --- | --- |
| macOS, APFS | Files are cloned | Follows the number of files, not their size; no disk used until files change |
| Linux, Btrfs or XFS with reflinks | Files are cloned | The same |
| Windows 11 24H2 or later, ReFS or a Dev Drive | Windows clones on copy; reported as `copy=copy-on-write-expected` | The same, if the Windows version does it: the time printed tells you |
| Windows NTFS, Linux ext4, exFAT, network shares | Every byte is copied (`copy=full`) | Minutes and the project's size in disk for a large project |

Measured on APFS: a
small project in 0.1 s; the content and caches of a 7.7 GB project (1,222 content files) in 0.3 s with no change
in free disk. The game ran in a copy with no rebuild.

Where files cannot be cloned, a project up to `GAM3_ENV_COPY_LIMIT_GB` (default 2) is copied. Above that `create`
refuses and says why, so a large project is never copied by surprise; `--full-copy` copies it anyway. The better
answers for a large project there are workspaces from your platform, or moving the project to a cloning volume
(on Windows 11: Settings > System > Storage > Disks & volumes > Create Dev Drive).

## Several copies being edited at once

Copies are independent. A change in one is not seen by another, and each has its own caches, logs and editor.
The risk is at merge time: engine assets are binary, so a file changed in two copies cannot be merged, only
chosen. Give each agent its own files, and run `status` before merging: it marks those files `CLASH`.

## Limits

- Cloning was run on APFS only. The full-copy path and its size guard are covered by the repository's tests on
  macOS, Linux and Windows runners. Cloning on Linux reflink volumes and on Windows ReFS was not run.
- On Windows the tool cannot ask for a clone and fail otherwise, so on ReFS it reports what it expects, not what
  happened. It also does not check for a running engine before `remove` there.
- The first `git status` in a new copy re-reads every tracked file once.
- An environment made from inside another environment is based on that environment's commit.
