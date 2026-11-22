#!/usr/bin/env node
// Copy core/*.mjs into each plugin's scripts/lib/, core/rules/ and core/hooks/ into each plugin's rules/ and hooks/, and core/kit-shared/*.mjs into each plugin's driver kit. A plugin is installed on its own (the agent copies just its
// directory), so it cannot import from the repository root. `--check` fails when a copy is stale; CI runs that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const core = fs.readdirSync(path.join(root, 'core')).filter((f) => f.endsWith('.mjs')).sort();
const plugins = fs.readdirSync(path.join(root, 'plugins')).filter((p) => fs.existsSync(path.join(root, 'plugins', p, '.claude-plugin', 'plugin.json')));
let stale = 0;
for (const plugin of plugins) {
  const lib = path.join(root, 'plugins', plugin, 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of core) {
    const want = fs.readFileSync(path.join(root, 'core', f), 'utf8');
    const dest = path.join(lib, f);
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    if (have === want) continue;
    stale++;
    if (check) console.error(`stale: plugins/${plugin}/scripts/lib/${f} (run: npm run sync)`);
    else fs.writeFileSync(dest, want);
  }
  for (const f of fs.readdirSync(lib)) {
    if (core.includes(f)) continue;
    stale++;
    if (check) console.error(`unexpected: plugins/${plugin}/scripts/lib/${f}`);
    else fs.rmSync(path.join(lib, f));
  }
}
// Always-on session context: the core rules and the SessionStart hook that prints them are the same in every plugin.
for (const plugin of plugins) {
  for (const sub of ['rules', 'hooks']) {
    const from = path.join(root, 'core', sub);
    const to = path.join(root, 'plugins', plugin, sub);
    const names = fs.readdirSync(from).sort();
    fs.mkdirSync(to, { recursive: true });
    for (const f of names) {
      const want = fs.readFileSync(path.join(from, f), 'utf8');
      const dest = path.join(to, f);
      if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === want) continue;
      stale++;
      if (check) console.error(`stale: plugins/${plugin}/${sub}/${f} (run: npm run sync)`);
      else fs.writeFileSync(dest, want);
    }
    for (const f of fs.readdirSync(to)) {
      if (names.includes(f)) continue;
      stale++;
      if (check) console.error(`unexpected: plugins/${plugin}/${sub}/${f}`);
      else fs.rmSync(path.join(to, f));
    }
  }
}
// Tools shipped unchanged for every engine: the engine-slot cap and local environments.
const HOME = { 'env.mjs': 'local-envs' };
const shared = fs.readdirSync(path.join(root, 'core', 'kit-shared')).filter((f) => f.endsWith('.mjs')).sort();
for (const plugin of plugins) {
  const kits = path.join(root, 'plugins', plugin, 'kits');
  const driver = fs.readdirSync(kits).find((k) => k.endsWith('-driver'));
  if (!driver) continue;
  for (const f of shared) {
    // The engine cap ships with the driver, which needs it. Local environments are a kit of their own: optional.
    const kit = HOME[f] || driver;
    const want = fs.readFileSync(path.join(root, 'core', 'kit-shared', f), 'utf8');
    const dest = path.join(kits, kit, 'files', 'Tools', 'gam3', f);
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === want) continue;
    stale++;
    if (check) console.error(`stale: plugins/${plugin}/kits/${kit}/files/Tools/gam3/${f} (run: npm run sync)`);
    else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, want); }
  }
}
if (check && stale) process.exit(1);
console.log(check ? `sync: ${plugins.length} plugins up to date` : `sync: ${stale} file(s) written across ${plugins.length} plugins`);
