// The command line and the MCP tools of one engine plugin. Both call the same functions.
//
//   gam3 doctor  [--project DIR] [--json]            what is installed, what is running, what is missing
//   gam3 kits    [--json]                            the kits this plugin ships
//   gam3 kit NAME                                    one kit's manifest and KIT.md
//   gam3 install NAME [--project DIR] [--param KEY=VALUE]... [--apply] [--overwrite] [--json]
//   gam3 mcp                                         serve the same four things as MCP tools on stdio
//
// `install` only prints its plan unless --apply is given.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPlan, listKits, loadKit, planInstall, readLock, summarize } from './kits.mjs';
import { serve } from './mcp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function pluginVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { return '0.0.0'; }
}

function resolveProject(engine, given) {
  const start = path.resolve(given || process.cwd());
  const found = engine.findProject(start);
  if (!found) throw new Error(`no ${engine.label} project found at or near ${start} (${engine.projectHint}). Pass the project directory.`);
  return found;
}

function api(engine, kitsDir) {
  const card = (k) => ({ name: k.name, version: k.version, summary: k.summary, requires: k.requires, params: Object.keys(k.params), verified: k.verified });
  return {
    doctor({ project } = {}) {
      const root = engine.findProject(path.resolve(project || process.cwd()));
      const report = engine.doctor(root);
      report.kits_installed = root ? Object.fromEntries(Object.entries(readLock(root).kits).map(([k, v]) => [k, v.version])) : {};
      report.kits_available = listKits(kitsDir).map((k) => k.name);
      return report;
    },
    kits() { return listKits(kitsDir).map(card); },
    kit({ name }) {
      const k = loadKit(kitsDir, name);
      return { ...card(k), params: k.params, files: k.files, adapt: k.adapt, verify: k.verify, readme: k.readme };
    },
    install({ name, project, params = {}, dry_run = true, overwrite = false }) {
      const root = resolveProject(engine, project);
      const plan = planInstall({ kitsDir, name, project: root, params, detected: engine.detectParams(root), overwrite });
      const out = summarize(plan);
      if (dry_run) return { applied: false, ...out, next: plan.missing_params.length || plan.conflicts.length ? 'Resolve missing_params and conflicts, then plan again.' : 'Review the writes, then call again with dry_run false.' };
      return { applied: true, ...applyPlan(plan), ...out, next: 'Work through adapt, then run the verify commands from the project directory.' };
    },
  };
}

function parse(argv) {
  const out = { _: [], params: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--apply' || a === '--overwrite') out[a.slice(2)] = true;
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--param') {
      const [k, ...v] = String(argv[++i] || '').split('=');
      if (!k || !v.length) throw new Error('--param needs KEY=VALUE');
      out.params[k] = v.join('=');
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

function printPlan(r) {
  console.log(`${r.kit} ${r.version} -> ${r.project}${r.applied ? '' : '   (plan only; add --apply to write)'}`);
  for (const w of r.writes) console.log(`  ${w.action.padEnd(9)} ${w.path}`);
  for (const p of r.missing_params) console.log(`  missing param ${p.key}: ${p.description}   (--param ${p.key}=...)`);
  if (r.requires_missing.length) console.log(`  install first: ${r.requires_missing.join(', ')}`);
  if (r.conflicts.length) console.log(`  conflicts: your copy differs. Merge by hand, or pass --overwrite to replace it.`);
  if (r.adapt.length) console.log(`adapt:\n${r.adapt.map((a) => `  - ${a}`).join('\n')}`);
  if (r.verify.length) console.log(`verify:\n${r.verify.map((a) => `  $ ${a}`).join('\n')}`);
}

export async function runCli({ engine, kitsDir, argv = process.argv.slice(2) }) {
  const a = parse(argv);
  const [cmd, name] = a._;
  const f = api(engine, kitsDir);
  const e = engine.name;
  if (cmd === 'mcp') {
    const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
    const project = { type: 'string', description: `Directory of the ${engine.label} project, or one inside or just above it. Default: the working directory.` };
    await serve({
      name: `gam3stack-${e}`, version: pluginVersion(),
      instructions: `gam3stack ${engine.label} kits: source you copy into a game project and then own. Call ${e}_doctor first. Plan an install (dry_run true), read the plan, then apply it.`,
      tools: [
        { name: `${e}_doctor`, description: `Check the ${engine.label} setup: project, engine install, running editors, installed kits. Read-only.`, inputSchema: obj({ project }), handler: f.doctor },
        { name: `${e}_kits`, description: `List the ${engine.label} kits this plugin ships (name, summary, what each was verified on).`, inputSchema: obj({}), handler: f.kits },
        { name: `${e}_kit`, description: 'One kit: params, files, adaptation steps, verify commands and its KIT.md.', inputSchema: obj({ name: { type: 'string' } }, ['name']), handler: f.kit },
        {
          name: `${e}_install`,
          description: 'Copy a kit into the project. dry_run (default true) returns the plan and writes nothing. A file the user changed is a conflict, never overwritten unless overwrite is true.',
          inputSchema: obj({ name: { type: 'string' }, project, params: { type: 'object', additionalProperties: { type: 'string' } }, dry_run: { type: 'boolean' }, overwrite: { type: 'boolean' } }, ['name']),
          handler: f.install,
        },
      ],
    });
    return 0;
  }
  if (cmd === 'doctor') {
    const r = f.doctor({ project: a.project });
    if (a.json) console.log(JSON.stringify(r, null, 2));
    else {
      for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : c.warn ? 'warn' : 'FAIL'}  ${c.name}: ${c.detail}`);
      console.log(`kits installed: ${Object.keys(r.kits_installed).join(', ') || 'none'}   available: ${r.kits_available.join(', ')}`);
    }
    return r.checks.some((c) => !c.ok && !c.warn) ? 1 : 0;
  }
  if (cmd === 'kits') {
    const r = f.kits();
    if (a.json) console.log(JSON.stringify(r, null, 2));
    else for (const k of r) console.log(`${k.name.padEnd(18)} ${k.version.padEnd(7)} ${k.summary}`);
    return 0;
  }
  if (cmd === 'kit' && name) {
    const r = f.kit({ name });
    if (a.json) console.log(JSON.stringify(r, null, 2));
    else console.log(r.readme);
    return 0;
  }
  if (cmd === 'install' && name) {
    const r = f.install({ name, project: a.project, params: a.params, dry_run: !a.apply, overwrite: !!a.overwrite });
    if (a.json) console.log(JSON.stringify(r, null, 2));
    else printPlan(r);
    return r.applied || (!r.conflicts.length && !r.missing_params.length) ? 0 : 1;
  }
  console.error('usage: gam3 doctor | kits | kit NAME | install NAME [--project DIR] [--param K=V] [--apply] [--overwrite] | mcp   (add --json for JSON)');
  return 2;
}

export function main(opts) {
  runCli(opts).then((code) => { process.exitCode = code; }, (e) => { console.error(`gam3: ${e?.message || e}`); process.exitCode = 1; });
}
