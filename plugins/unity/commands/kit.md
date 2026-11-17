---
description: Install a gam3stack Unity kit into this project - plan first, then apply, adapt and verify.
argument-hint: "<unity-driver | shot-capture | terrain-from-data | ready-gate>"
---

Load the `gam3stack-unity-kits` skill and follow it for the kit `$ARGUMENTS`. With no argument, call
`unity_kits`, list the kits in one line each and ask which one. Always show the plan (`unity_install` with
`dry_run: true`) before applying it, and never pass `overwrite` without the user's yes.
