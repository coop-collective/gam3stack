#!/usr/bin/env node
// Local environments: a second copy of the project on this machine where one agent can run its own editor and game
// without touching anyone else's. OPTIONAL. If something else already hands each agent its own workspace (separate
// machines, virtual machines, containers), use that and skip this tool.
//   node Tools/gam3/env.mjs create NAME      a copy of this checkout, as it is now, on new branch gam3/NAME
//   node Tools/gam3/env.mjs list
//   node Tools/gam3/env.mjs status NAME      what it changed, and which of those files will not merge
//   node Tools/gam3/env.mjs remove NAME [--force]
//   create also takes --full-copy (see below).
// Works on macOS, Linux and Windows. How cheap a copy is depends on the file system, and create checks first:
//   clones files (APFS; Btrfs and XFS with reflinks; ReFS and Dev Drive volumes on Windows 11 24H2 or later)
//       nothing is duplicated until a file changes: the cost follows the number of files, not their size.
//   does not (NTFS, ext4, exFAT, network shares)
//       every byte is copied. Up to GAM3_ENV_COPY_LIMIT_GB (default 2) that is done; above it create refuses
//       unless --full-copy is given, because a silent copy of a large project takes minutes and its size in disk.
// Everything comes along: assets git does not track, the engine's caches, uncommitted work. When a full copy would
// be too slow, the answer is a cloning volume (a Dev Drive on Windows, an XFS or Btrfs volume on Linux) or
// workspaces from elsewhere instead. Each environment is a git worktree, so merging is plain git from the main
// checkout: `git merge gam3/NAME`. Read `status` first: engine assets are binary, and a file changed on both sides
// cannot be merged, only chosen.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// State that belongs to one running checkout and must not follow the copy.
const STALE = [path.join('.gam3', 'editor.json'), path.join('.gam3', 'env.json'), path.join('Temp', 'UnityLockfile')];
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

/**
 * Can files be cloned from `from` to a new sibling of `destParent` without copying their bytes?
 * 'yes' was proven by cloning a probe file. 'expected' is Windows on ReFS, where the system clones on copy from
 * Windows 11 24H2 on but offers no way to ask for a clone and fail otherwise. 'no' means a real copy.
 */
function cloneSupport(from, destParent) {
  if (process.env.GAM3_ENV_FORCE_COPY === '1') return 'no';   // for tests of the copy path
  if (process.platform === 'win32') {
    const q = (p) => (spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Volume -FilePath '${p.replace(/'/g, "''")}').FileSystemType`], { encoding: 'utf8' }).stdout || '').trim();
    const a = q(from);
    return a === 'ReFS' && q(destParent) === 'ReFS' && path.parse(from).root === path.parse(destParent).root ? 'expected' : 'no';
  }
  if (process.platform === 'darwin') {
    // Node's "clone or fail" copy is not implemented on every macOS build of Node (it answers ENOSYS on a volume
    // that clones), and `cp -c` copies silently when it cannot clone. So ask what the volume is: APFS clones
    // within one volume.
    const APFS = 26;   // statfs f_type on macOS
    try {
      return fs.statfsSync(from).type === APFS && fs.statSync(from).dev === fs.statSync(destParent).dev ? 'yes' : 'no';
    } catch { return 'no'; }
  }
  const probe = path.join(from, `.gam3-probe-${process.pid}`);
  const copy = path.join(destParent, `.gam3-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'probe');
    try {
      fs.copyFileSync(probe, copy, fs.constants.COPYFILE_FICLONE_FORCE);
      return 'yes';
    } catch { /* not implemented in this Node, or the volume cannot clone: let cp say which */ }
    return spawnSync('cp', ['--reflink=always', probe, copy], { stdio: 'ignore' }).status === 0 ? 'yes' : 'no';
  } catch {
    return 'no';
  } finally {
    fs.rmSync(probe, { force: true });
    fs.rmSync(copy, { force: true });
  }
}

/** Bytes under `dir`, stopping early once `limit` is passed (the exact size of a huge tree is not worth the walk). */
function sizeUpTo(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length && total <= limit) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  }
  return total;
}

/** Copy one file or directory, cloning where the file system can. The system tools are the fastest way to clone a tree. */
function cloneInto(from, to, support) {
  if (support === 'yes' && process.platform === 'darwin' && spawnSync('cp', ['-cR', from, to], { stdio: 'ignore' }).status === 0) return;
  if (support === 'yes' && process.platform === 'linux' && spawnSync('cp', ['-R', '--reflink=always', from, to], { stdio: 'ignore' }).status === 0) return;
  fs.rmSync(to, { recursive: true, force: true });
  // COPYFILE_FICLONE: clone when the system can, copy when it cannot. On Windows this is CopyFile, which clones on ReFS.
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
}

function enginesOn(dir) {
  if (process.platform === 'win32') return [];   // not checked on Windows; an engine with files open there makes the removal itself fail
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return lines(r.stdout || '').filter((l) => /UnrealEditor|Unity/.test(l) && l.includes(dir) && !/CrashReportClient/.test(l)).map((l) => Number(l.split(/\s+/)[0]));
}

function create(r, name, fullCopy) {
  const dest = envPath(r, name);
  if (fs.existsSync(dest) || fs.existsSync(`${dest}.wt`)) throw new Error(`already exists: ${dest}`);
  const baseSha = git(r.top, ['rev-parse', 'HEAD']).out;
  const baseBranch = git(r.top, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const support = cloneSupport(r.top, path.dirname(dest));
  if (support === 'no' && !fullCopy) {
    const limit = (Number(process.env.GAM3_ENV_COPY_LIMIT_GB) || 2) * 1024 ** 3;
    if (sizeUpTo(r.top, limit) > limit) {
      throw new Error(`this file system cannot clone files, and the project is over ${limit / 1024 ** 3} GB, so an environment would be a full copy: slow, and as large as the project. `
        + 'Use workspaces from your platform, or put the project on a cloning volume (a Dev Drive on Windows 11, APFS on macOS, XFS or Btrfs with reflinks on Linux). To copy anyway: --full-copy.');
    }
  }
  const t0 = Date.now();
  // The branch and git's record of the checkout, with no files written; the files come from the copy below.
  git(r.main, ['worktree', 'add', '--no-checkout', '-b', `gam3/${name}`, `${dest}.wt`, baseSha]);
  fs.mkdirSync(dest);
  for (const entry of fs.readdirSync(r.top)) {
    if (entry !== '.git') cloneInto(path.join(r.top, entry), path.join(dest, entry), support);
  }
  fs.renameSync(path.join(`${dest}.wt`, '.git'), path.join(dest, '.git'));
  fs.rmSync(`${dest}.wt`, { recursive: true, force: true });
  git(r.main, ['worktree', 'repair', dest]);
  git(dest, ['reset', '-q']);   // index from the commit; files that differ show as the uncommitted work they are
  const proj = path.join(dest, r.rel);
  for (const f of STALE) fs.rmSync(path.join(proj, f), { force: true });
  const used = new Set(environments(r).map((e) => e.port).filter(Boolean));
  let port = BASE_PORT + 1;
  while (used.has(port)) port++;
  fs.mkdirSync(path.join(proj, '.gam3'), { recursive: true });
  const ignore = path.join(proj, '.gam3', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'env.json\neditor.json\n.gitignore\n');
  fs.writeFileSync(envFile(proj), JSON.stringify({ name, port, base: baseBranch, base_sha: baseSha, created: new Date().toISOString() }, null, 2) + '\n');
  const kind = { yes: 'copy-on-write', expected: 'copy-on-write-expected', no: 'full' }[support];
  console.log(`GAM3ENV: ok created ${name} path=${proj} branch=gam3/${name} port=${port} copy=${kind} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (support === 'expected') console.log('note: this is a ReFS volume. Windows 11 24H2 and later clone files on copy there; older versions copy every byte. The time above tells you which happened.');
  if (support === 'no') console.log('note: this file system cannot clone files, so the project was copied in full.');
  return 0;
}

function describe(r, e) {
  // The base branch may be gone (an environment made from another environment that was since removed).
  const base = git(r.main, ['rev-parse', '--verify', '--quiet', `${e.base || 'HEAD'}^{commit}`], { allowFail: true });
  const baseNow = base.ok ? base.out : e.base_sha;
  const mb = git(r.main, ['merge-base', baseNow, e.branch], { allowFail: true });
  const fork = mb.ok ? mb.out : e.base_sha;
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
  const merged = git(r.main, ['merge-base', '--is-ancestor', e.branch, 'HEAD'], { allowFail: true }).ok;
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
  const name = rest.find((a) => !a.startsWith('--'));
  const r = repo();
  if (cmd === 'create') return create(r, checkName(name), flag('full-copy'));
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
  console.error('usage: env.mjs create NAME [--full-copy] | list | status NAME | remove NAME [--force]');
  return 2;
}

try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(`GAM3ENV: FAILED ${e.message}`); process.exit(1); }
