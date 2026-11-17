// Kit catalog and installer, shared by every gam3stack plugin. No dependencies.
//
// A kit is a directory: kit.json (manifest), KIT.md (what it is, how to adapt it), files/ (the source that gets copied).
// Every file under files/ lands at the same relative path under the project root. Tokens of the form __GAM3_NAME__ in
// paths and in file text are replaced by the kit's params (for example the C++ module a source file joins).
// Installing is a plan first: nothing is written until the plan is applied, and a file the user changed is never
// overwritten unless they ask for it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PARAM = /^[A-Z][A-Z0-9_]{0,40}$/;
const TOKEN = /__GAM3_([A-Z][A-Z0-9_]*)__/g;
export const LOCK = path.join('.gam3', 'lock.json');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__pycache__') out.push(...walk(p, base)); }
    else if (e.isFile() && e.name !== '.DS_Store' && !e.name.endsWith('.pyc')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** Read and check one kit. Throws with a message that names the problem. */
export function loadKit(kitsDir, name) {
  if (!NAME.test(String(name))) throw new Error(`invalid kit name: ${name}`);
  const dir = path.join(kitsDir, name);
  const manifestPath = path.join(dir, 'kit.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`no such kit: ${name}`);
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = [];
  if (m.name !== name) problems.push(`kit.json name "${m.name}" does not match its directory "${name}"`);
  for (const k of ['engine', 'version', 'summary']) if (typeof m[k] !== 'string' || !m[k]) problems.push(`kit.json needs "${k}"`);
  for (const k of ['requires', 'adapt', 'verify']) if (m[k] !== undefined && !Array.isArray(m[k])) problems.push(`"${k}" must be a list`);
  for (const p of Object.keys(m.params || {})) if (!PARAM.test(p)) problems.push(`param "${p}" must be UPPER_SNAKE`);
  const filesDir = path.join(dir, 'files');
  const files = fs.existsSync(filesDir) ? walk(filesDir) : [];
  if (!files.length) problems.push('files/ is empty');
  const readmePath = path.join(dir, 'KIT.md');
  if (!fs.existsSync(readmePath)) problems.push('KIT.md is missing');
  if (problems.length) throw new Error(`kit ${name}: ${problems.join('; ')}`);
  return {
    name, engine: m.engine, version: m.version, summary: m.summary, requires: m.requires || [], params: m.params || {},
    adapt: m.adapt || [], verify: m.verify || [], verified: m.verified || null, dir, filesDir, files,
    readme: fs.readFileSync(readmePath, 'utf8'),
  };
}

export function listKits(kitsDir) {
  if (!fs.existsSync(kitsDir)) return [];
  return fs.readdirSync(kitsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && NAME.test(e.name) && fs.existsSync(path.join(kitsDir, e.name, 'kit.json')))
    .map((e) => loadKit(kitsDir, e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readLock(project) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(project, LOCK), 'utf8'));
    return lock && typeof lock.kits === 'object' ? lock : { kits: {} };
  } catch {
    return { kits: {} };
  }
}

function fill(text, params, missing) {
  return text.replace(TOKEN, (whole, key) => {
    if (params[key] === undefined) { missing.add(key); return whole; }
    return params[key];
  });
}

/** Resolve a kit-relative path inside the project; refuses anything that would land outside it. */
function inside(project, rel) {
  const dest = path.resolve(project, rel);
  const root = path.resolve(project);
  if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error(`path leaves the project: ${rel}`);
  return dest;
}

/**
 * Work out what installing `name` into `project` would do. Pure apart from reading files.
 * `detected` are params the engine adapter found in the project; `params` are the caller's and win.
 * Each write has an action: create, identical (already there), update (an older copy the user never edited),
 * conflict (the user's file differs: refused unless `overwrite`), overwrite.
 */
export function planInstall({ kitsDir, name, project, params = {}, detected = {}, overwrite = false }) {
  const kit = loadKit(kitsDir, name);
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new Error(`project directory not found: ${project}`);
  const values = {};
  for (const [key, spec] of Object.entries(kit.params)) {
    const v = params[key] ?? detected[key] ?? spec.default;
    if (v !== undefined) values[key] = String(v);
  }
  for (const [key, v] of Object.entries(values)) {
    if (!/^[A-Za-z0-9_./-]{1,120}$/.test(v) || v.includes('..')) throw new Error(`param ${key} has an unsafe value: ${v}`);
  }
  const lock = readLock(project);
  const prior = lock.kits[kit.name]?.files || {};
  const missing = new Set();
  const writes = [];
  for (const rel of kit.files) {
    const text = fill(fs.readFileSync(path.join(kit.filesDir, rel), 'utf8'), values, missing);
    const to = fill(rel, values, missing);
    const dest = inside(project, to);
    let action = 'create';
    if (fs.existsSync(dest)) {
      const have = sha(fs.readFileSync(dest, 'utf8'));
      if (have === sha(text)) action = 'identical';
      else if (prior[to] === have) action = 'update';
      else action = overwrite ? 'overwrite' : 'conflict';
    }
    writes.push({ path: to, action, bytes: Buffer.byteLength(text), text });
  }
  const installed = Object.keys(lock.kits);
  return {
    kit: kit.name, version: kit.version, engine: kit.engine, project: path.resolve(project), params: values,
    missing_params: [...missing].sort().map((key) => ({ key, description: kit.params[key]?.description || '' })),
    requires_missing: kit.requires.filter((r) => !installed.includes(r)),
    conflicts: writes.filter((w) => w.action === 'conflict').map((w) => w.path),
    writes, adapt: kit.adapt, verify: kit.verify,
  };
}

/** Write a plan made by planInstall. Refuses while it has missing params or conflicts. */
export function applyPlan(plan) {
  if (plan.missing_params.length) throw new Error(`missing params: ${plan.missing_params.map((p) => p.key).join(', ')}`);
  if (plan.conflicts.length) throw new Error(`conflicts (your files differ from the kit): ${plan.conflicts.join(', ')}`);
  const lock = readLock(plan.project);
  const files = {};
  const written = [];
  for (const w of plan.writes) {
    const dest = inside(plan.project, w.path);
    if (w.action !== 'identical') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, w.text);
      written.push(w.path);
    }
    files[w.path] = sha(w.text);
  }
  lock.kits[plan.kit] = { version: plan.version, engine: plan.engine, params: plan.params, files };
  const lockPath = path.join(plan.project, LOCK);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  return { written, lock: LOCK.split(path.sep).join('/') };
}

/** A plan without the file bodies: what a person or an agent reads before agreeing to it. */
export function summarize(plan) {
  return { ...plan, writes: plan.writes.map(({ text, ...w }) => w) };
}
