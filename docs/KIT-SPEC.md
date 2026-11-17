# Kit format

A kit is source that gets copied into a game project. After that the project owns it: edit it, rename it, delete it.
Nothing in a kit calls back to gam3stack.

    plugins/<engine>/kits/<kit-name>/
      kit.json     the manifest
      KIT.md       what the kit is, when not to use it, how to adapt it, known limits
      files/       copied to the project root, same relative paths

## kit.json

```json
{
  "name": "shot-director",
  "engine": "unreal",
  "version": "0.1.0",
  "summary": "One line: what the project can do after installing this.",
  "requires": ["ue-driver"],
  "params": {
    "MODULE": { "description": "C++ game module the source joins", "default": "MyGame" }
  },
  "adapt": ["Steps a person or agent must do by hand after the copy."],
  "verify": ["Commands that prove it works, run from the project directory."],
  "verified": { "engine": "UE 5.9", "os": "macOS 26", "date": "2026-11-17", "how": "What was actually run." }
}
```

- `name` matches the directory: lowercase letters, digits, dashes.
- `requires` lists kits that must already be in the project. The plan reports the ones that are missing.
- `params` are UPPER_SNAKE. The token `__GAM3_<PARAM>__` is replaced in file paths and file text. The engine
  adapter detects common ones from the project (see each plugin's `scripts/engine.mjs`); a caller's value wins.
- `verified` says what the kit was tested on. Leave it out, or say so in `how`, when something was not run.
  Do not claim an engine version or platform nobody tried.

## Install rules

1. A plan comes first (`dry_run`, the default). It lists every file with one action:
   `create`, `identical`, `update` (an older kit copy the user never edited), `conflict` (the user's file differs).
2. A plan with a conflict or a missing param cannot be applied. `overwrite` turns conflicts into `overwrite`,
   and needs the user's yes.
3. Applying writes the files and records their hashes in `.gam3/lock.json` in the project. Commit that file: it
   is how a later install tells "the user edited this" from "this is an old copy".
4. Paths that would leave the project are refused. Kit files are text.

## Writing a kit

- Take it from code that already works in a real project. Generalise names, keep the lessons as comments.
- Scripts take the project from their own location or from arguments, never from a hard-coded path.
- Processes are started with argument lists, not shell strings.
- A kit never kills a process it did not start.
- `KIT.md` states limits plainly: what is slow, what is untested, what breaks on which platform.
- After changing `core/`, run `npm run sync`. Run `npm run check` before a commit.
