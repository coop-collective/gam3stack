#!/usr/bin/env node
// Check the repository's shape: marketplaces, plugin manifests, skills, commands and every kit. Run by `npm run check`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listKits } from '../core/kits.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const bad = (msg) => problems.push(msg);
const json = (rel) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch (e) { bad(`${rel}: ${e.message}`); return {}; }
};
const frontmatter = (file) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  if (!m) return null;
  return Object.fromEntries(m[1].split('\n').map((l) => /^([A-Za-z-]+):\s*(.*)$/.exec(l)).filter(Boolean).map((x) => [x[1], x[2].replace(/^"|"$/g, '')]));
};

const market = json('.claude-plugin/marketplace.json');
const codexMarket = json('.agents/plugins/marketplace.json');
const names = (market.plugins || []).map((p) => p.name);
if (JSON.stringify(names) !== JSON.stringify((codexMarket.plugins || []).map((p) => p.name))) bad('the two marketplace files list different plugins');

for (const entry of market.plugins || []) {
  const dir = path.join(root, entry.source);
  const rel = (p) => path.relative(root, path.join(dir, p));
  const claude = json(rel('.claude-plugin/plugin.json'));
  const codex = json(rel('.codex-plugin/plugin.json'));
  for (const [where, m] of [['.claude-plugin', claude], ['.codex-plugin', codex]]) {
    if (m.name !== entry.name) bad(`${entry.name}: ${where}/plugin.json name is "${m.name}"`);
    if (m.version !== entry.version) bad(`${entry.name}: ${where}/plugin.json version ${m.version} differs from the marketplace's ${entry.version}`);
  }
  const mcp = json(rel('.mcp.json'));
  if (!mcp.mcpServers?.[`gam3stack-${entry.name}`]) bad(`${entry.name}: .mcp.json must define gam3stack-${entry.name}`);
  if (!codex.mcpServers?.[`gam3stack-${entry.name}`]) bad(`${entry.name}: .codex-plugin/plugin.json must define gam3stack-${entry.name}`);
  for (const f of ['scripts/gam3.mjs', 'scripts/engine.mjs']) if (!fs.existsSync(path.join(dir, f))) bad(`${entry.name}: ${f} is missing`);

  const skillsDir = path.join(dir, 'skills');
  const skills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((s) => fs.statSync(path.join(skillsDir, s)).isDirectory()) : [];
  if (!skills.length) bad(`${entry.name}: no skills`);
  for (const s of skills) {
    const file = path.join(skillsDir, s, 'SKILL.md');
    if (!fs.existsSync(file)) { bad(`${entry.name}/skills/${s}: SKILL.md is missing`); continue; }
    const fm = frontmatter(file);
    if (!fm) bad(`${entry.name}/skills/${s}: no frontmatter`);
    else {
      if (fm.name !== s) bad(`${entry.name}/skills/${s}: frontmatter name is "${fm.name}"`);
      if (!fm.description || fm.description.length < 60 || !/\bUse when\b/i.test(fm.description)) bad(`${entry.name}/skills/${s}: description must say what it does and "Use when ..."`);
    }
    if (!fs.existsSync(path.join(skillsDir, s, 'agents', 'openai.yaml'))) bad(`${entry.name}/skills/${s}: agents/openai.yaml is missing`);
  }
  const commandsDir = path.join(dir, 'commands');
  for (const c of fs.existsSync(commandsDir) ? fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md')) : []) {
    if (!frontmatter(path.join(commandsDir, c))?.description) bad(`${entry.name}/commands/${c}: frontmatter needs a description`);
  }

  let kits = [];
  try { kits = listKits(path.join(dir, 'kits')); } catch (e) { bad(`${entry.name}: ${e.message}`); }
  if (!kits.length) bad(`${entry.name}: no kits`);
  const kitNames = kits.map((k) => k.name);
  for (const k of kits) {
    const at = `${entry.name}/kits/${k.name}`;
    if (k.engine !== entry.name) bad(`${at}: engine is "${k.engine}"`);
    for (const r of k.requires) if (!kitNames.includes(r)) bad(`${at}: requires unknown kit ${r}`);
    if (!k.adapt.length) bad(`${at}: adapt is empty (say what must be done by hand, even if little)`);
    if (!k.verify.length) bad(`${at}: verify is empty`);
    if (!k.verified?.how || /PENDING|TODO/i.test(k.verified.how)) bad(`${at}: verified.how must say what was actually run (or that nothing was)`);
    const tokens = new Set();
    for (const f of k.files) {
      const text = fs.readFileSync(path.join(k.filesDir, f), 'utf8');
      if (text.includes('\u0000')) bad(`${at}: ${f} is not text`);
      // Kits are code only: nothing in Unreal kit source may be exposed to, or depend on, Blueprints.
      if (/\.(h|cpp)$/.test(f) && /Blueprint/.test(text)) bad(`${at}: ${f} mentions Blueprint; kit source is C++ only`);
      for (const m of `${f}\n${text}`.matchAll(/__GAM3_([A-Z][A-Z0-9_]*)__/g)) tokens.add(m[1]);
    }
    for (const t of tokens) if (!k.params[t]) bad(`${at}: token __GAM3_${t}__ has no entry in params`);
    for (const p of Object.keys(k.params)) if (!tokens.has(p)) bad(`${at}: param ${p} is never used`);
  }
}

// Nothing from a private machine belongs in a public repository.
const LEAKS = [/\/Users\/(?!Shared\/)[A-Za-z0-9_.-]+\//, /[A-Za-z0-9._%+-]+@(?!noreply\.|example\.)[A-Za-z0-9.-]+\.(com|io|dev|net|org)\b/, /\b(sk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/];
const scan = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (/\.(md|mjs|js|json|py|cs|cpp|h|yaml|yml|txt|sh)$/.test(e.name)) {
      const text = fs.readFileSync(p, 'utf8');
      for (const re of LEAKS) {
        const m = re.exec(text);
        if (m && path.relative(root, p) !== path.join('scripts', 'validate.mjs')) bad(`${path.relative(root, p)}: looks private: ${m[0]}`);
      }
    }
  }
};
scan(root);

if (problems.length) {
  console.error(problems.map((p) => `  - ${p}`).join('\n'));
  console.error(`validate: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`validate: ok (${names.join(', ')})`);
