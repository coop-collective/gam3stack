#!/usr/bin/env node
// Copy core/*.mjs into each plugin's scripts/lib/, and core/kit-shared/*.mjs into each plugin's driver kit. A plugin is installed on its own (the agent copies just its
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
// Tools every engine's driver kit ships unchanged: the engine-slot cap and dedicated environments.
const shared = fs.readdirSync(path.join(root, 'core', 'kit-shared')).filter((f) => f.endsWith('.mjs')).sort();
for (const plugin of plugins) {
  const kits = path.join(root, 'plugins', plugin, 'kits');
  const driver = fs.readdirSync(kits).find((k) => k.endsWith('-driver'));
  if (!driver) continue;
  for (const f of shared) {
    const want = fs.readFileSync(path.join(root, 'core', 'kit-shared', f), 'utf8');
    const dest = path.join(kits, driver, 'files', 'Tools', 'gam3', f);
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === want) continue;
    stale++;
    if (check) console.error(`stale: plugins/${plugin}/kits/${driver}/files/Tools/gam3/${f} (run: npm run sync)`);
    else fs.writeFileSync(dest, want);
  }
}
if (check && stale) process.exit(1);
console.log(check ? `sync: ${plugins.length} plugins up to date` : `sync: ${stale} file(s) written across ${plugins.length} plugins`);
