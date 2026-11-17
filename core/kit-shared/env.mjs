#!/usr/bin/env node
// Dedicated environments: a second checkout of the project where one agent can run its own editor and game without
// touching anyone else's. No dependencies beyond git.
//   node Tools/gam3/env.mjs create NAME [--base REF]   new branch gam3/NAME in a git worktree next to the repository
//   node Tools/gam3/env.mjs list
//   node Tools/gam3/env.mjs status NAME                what it changed, and which of those files will not merge
//   node Tools/gam3/env.mjs remove NAME [--force]
// An engine keeps per-checkout caches (compiled binaries, imported assets) that git does not carry. create clones
// them copy-on-write where the file system can (APFS, Btrfs, XFS), so a new environment costs seconds and almost no
// disk instead of a full rebuild or re-import. Each environment gets its own port for an editor's MCP server.
// Merging is plain git, run from the main checkout: `git merge gam3/NAME`. Read `status` first: engine assets are
// binary, and a file changed on both sides cannot be merged, only chosen.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Per-checkout engine caches, relative to the project directory. Only those that exist and are not tracked are cloned.
const CACHES = ['Binaries', 'Intermediate', 'DerivedDataCache', 'Library'];
// Files git cannot merge: one side has to win.
const UNMERGEABLE = /\.(uasset|umap|ubulk|uexp|unity|prefab|asset|mat|anim|controller|fbx|glb|gltf|obj|png|jpg|jpeg|tga|exr|hdr|psd|wav|ogg|mp3|mp4|ttf|otf|bank)$/i;
const BASE_PORT = 8123;

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\s+$/, '') };
}
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

function repo() {
  const top = git(PROJ, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top.ok) throw new Error('this project is not in a git repository: environments are git worktrees');
  // The main checkout, even when this script runs inside an environment.
  const common = path.resolve(top.out, git(top.out, ['rev-parse', '--git-common-dir']).out);
  const main = path.basename(common) === '.git' ? path.dirname(common) : top.out;
  return { top: fs.realpathSync(top.out), main: fs.realpathSync(main), rel: path.relative(fs.realpathSync(top.out), fs.realpathSync(PROJ)) };
}

function checkName(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(String(name))) throw new Error(`environment name must be lower-case letters, digits and dashes (got ${name})`);
  return name;
}
const envPath = (r, name) => path.join(path.dirname(r.main), `${path.basename(r.main)}-env-${name}`);
const envFile = (proj) => path.join(proj, '.gam3', 'env.json');
function readEnv(proj) {
  try { return JSON.parse(fs.readFileSync(envFile(proj), 'utf8')); } catch { return null; }
}

function environments(r) {
  const out = [];
  let cur = null;
  for (const l of lines(git(r.main, ['worktree', 'list', '--porcelain']).out)) {
    if (l.startsWith('worktree ')) cur = { path: l.slice(9) };
    else if (l.startsWith('branch ') && cur) {
      const m = /^refs\/heads\/gam3\/(.+)$/.exec(l.slice(7));
      if (m) out.push({ name: m[1], branch: `gam3/${m[1]}`, path: cur.path, proj: path.join(cur.path, r.rel), ...(readEnv(path.join(cur.path, r.rel)) || {}) });
    }
  }
  return out;
}

/** Copy a directory without copying its bytes where the file system allows it. Returns 'clone' or 'copy'. */
function cloneDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (process.platform === 'darwin' && spawnSync('cp', ['-cR', from, to], { stdio: 'ignore' }).status === 0) return 'clone';
  if (process.platform === 'linux' && spawnSync('cp', ['-R', '--reflink=auto', from, to], { stdio: 'ignore' }).status === 0) return 'clone';
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  return 'copy';
}

function enginesOn(dir) {
  if (process.platform === 'win32') return [];
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return lines(r.stdout || '').filter((l) => /UnrealEditor|Unity/.test(l) && l.includes(dir) && !/CrashReportClient/.test(l)).map((l) => Number(l.split(/\s+/)[0]));
}

function create(r, name, base) {
  const dest = envPath(r, name);
  if (fs.existsSync(dest)) throw new Error(`already exists: ${dest}`);
  const baseRef = base || 'HEAD';
  const baseSha = git(r.top, ['rev-parse', baseRef]).out;
  const baseBranch = base || git(r.top, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const t0 = Date.now();
  git(r.main, ['worktree', 'add', '-b', `gam3/${name}`, dest, baseSha]);
  const proj = path.join(dest, r.rel);
  const cloned = [];
  for (const c of CACHES) {
    const from = path.join(PROJ, c);
    if (!fs.existsSync(from) || fs.existsSync(path.join(proj, c))) continue;
    if (lines(git(PROJ, ['ls-files', '--', c]).out).length) continue;   // tracked: the worktree already has it
    cloned.push(`${c} (${cloneDir(from, path.join(proj, c))})`);
  }
  const used = new Set(environments(r).map((e) => e.port).filter(Boolean));
  let port = BASE_PORT + 1;
  while (used.has(port)) port++;
  fs.mkdirSync(path.join(proj, '.gam3'), { recursive: true });
  const ignore = path.join(proj, '.gam3', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'env.json\neditor.json\n.gitignore\n');
  fs.writeFileSync(envFile(proj), JSON.stringify({ name, port, base: baseBranch, base_sha: baseSha, created: new Date().toISOString() }, null, 2) + '\n');
  // Work that is not committed does not travel: say so, because a missing tool or asset there is a confusing failure.
  const dirty = lines(git(r.top, ['status', '--porcelain']).out);
  console.log(`GAM3ENV: ok created ${name} path=${proj} branch=gam3/${name} port=${port} caches=${cloned.join(', ') || 'none'} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (dirty.length) console.log(`note: ${dirty.length} uncommitted change(s) in the checkout you ran this from are NOT in the environment (first: ${dirty[0]}). Commit what the environment needs, then create it.`);
  return 0;
}

function describe(r, e) {
  const baseNow = git(r.main, ['rev-parse', e.base || 'HEAD'], { allowFail: true }).out || e.base_sha;
  const fork = git(r.main, ['merge-base', baseNow, e.branch], { allowFail: true }).out || e.base_sha;
  const committed = lines(git(r.main, ['diff', '--name-only', `${fork}..${e.branch}`]).out);
  const uncommitted = fs.existsSync(e.path) ? git(e.path, ['status', '--porcelain']).out.split('\n').filter(Boolean).map((l) => l.slice(3)) : [];
  const theirs = new Set(lines(git(r.main, ['diff', '--name-only', `${fork}..${baseNow}`]).out));
  const mine = [...new Set([...committed, ...uncommitted])];
  return {
    ahead: Number(git(r.main, ['rev-list', '--count', `${fork}..${e.branch}`]).out), behind: Number(git(r.main, ['rev-list', '--count', `${fork}..${baseNow}`]).out),
    changed: mine, uncommitted, unmergeable: mine.filter((f) => UNMERGEABLE.test(f)),
    overlap: mine.filter((f) => theirs.has(f)), clash: mine.filter((f) => theirs.has(f) && UNMERGEABLE.test(f)),
  };
}

function find(r, name) {
  const e = environments(r).find((x) => x.name === name);
  if (!e) throw new Error(`no environment named ${name} (see: env.mjs list)`);
  return e;
}

function status(r, name) {
  const e = find(r, name);
  const d = describe(r, e);
  for (const f of d.changed) console.log(`${d.clash.includes(f) ? 'CLASH   ' : d.overlap.includes(f) ? 'overlap ' : d.unmergeable.includes(f) ? 'binary  ' : '        '}${f}${d.uncommitted.includes(f) ? '  (uncommitted)' : ''}`);
  if (d.clash.length) console.log(`CLASH: ${d.clash.length} binary file(s) changed here AND on ${e.base}. Git cannot merge them: decide which side wins, or rebuild them from their source data after merging.`);
  console.log(`GAM3ENV: ${d.clash.length ? 'CLASH' : 'ok'} name=${name} ahead=${d.ahead} behind=${d.behind} changed=${d.changed.length} uncommitted=${d.uncommitted.length} binary=${d.unmergeable.length} overlap=${d.overlap.length} clash=${d.clash.length} base=${e.base} path=${e.proj}`);
  return d.clash.length ? 1 : 0;
}

function remove(r, name, force) {
  const e = find(r, name);
  const running = enginesOn(e.path);
  if (running.length) throw new Error(`an engine (pid ${running.join(', ')}) is running in ${e.path}: stop it first`);
  const d = describe(r, e);
  const merged = git(r.main, ['merge-base', '--is-ancestor', e.branch, e.base || 'HEAD'], { allowFail: true }).ok;
  if (!force && (d.uncommitted.length || (!merged && d.ahead))) {
    throw new Error(`${name} has ${d.uncommitted.length} uncommitted change(s) and ${merged ? 0 : d.ahead} unmerged commit(s). Merge or commit them, or pass --force to discard.`);
  }
  git(r.main, ['worktree', 'remove', '--force', e.path]);
  const del = git(r.main, ['branch', force ? '-D' : '-d', e.branch], { allowFail: true });
  console.log(`GAM3ENV: ok removed ${name}${del.ok ? '' : ` (branch ${e.branch} kept)`}`);
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n) => rest.includes(`--${n}`);
  const opt = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const name = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--base');
  const r = repo();
  if (cmd === 'create') return create(r, checkName(name), opt('base'));
  if (cmd === 'status') return status(r, checkName(name));
  if (cmd === 'remove') return remove(r, checkName(name), flag('force'));
  if (cmd === 'list') {
    const envs = environments(r);
    for (const e of envs) {
      const d = describe(r, e);
      console.log(`${e.name}  port=${e.port ?? '-'}  ahead=${d.ahead} uncommitted=${d.uncommitted.length} clash=${d.clash.length}  ${e.proj}`);
    }
    console.log(`GAM3ENV: ok ${envs.length} environment(s)`);
    return 0;
  }
  console.error('usage: env.mjs create NAME [--base REF] | list | status NAME | remove NAME [--force]');
  return 2;
}

try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(`GAM3ENV: FAILED ${e.message}`); process.exit(1); }
