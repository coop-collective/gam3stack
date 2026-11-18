// Tools shipped unchanged for every engine: the engine-slot cap (driver kits) and local environments (local-envs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = path.join(root, 'core', 'kit-shared');

test('slots: the cap is held, a dead holder frees its slot, release frees it', async () => {
  process.env.GAM3_SLOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gam3-slots-'));
  const { acquireSlot, slotsInUse, enginesRunning } = await import(path.join(shared, 'slots.mjs'));
  assert.ok(Array.isArray(enginesRunning()));
  // Engines really running on this machine count against the cap in real use; a test must not depend on them.
  const opt = { max: 2, quiet: true, countEngines: false };
  const a = await acquireSlot({ label: 'a', ...opt });
  const b = await acquireSlot({ label: 'b', ...opt });
  assert.equal(slotsInUse().length, 2);
  await assert.rejects(acquireSlot({ label: 'c', ...opt, waitSec: 0.1 }), /no free engine slot/);
  a.release();
  assert.equal(slotsInUse().length, 1);
  // Handing a slot to a process that has already exited: the slot must not stay taken.
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  b.handOver(gone);
  assert.equal(slotsInUse().length, 0);
  const c = await acquireSlot({ label: 'c', ...opt, waitSec: 1 });
  c.release();
  delete process.env.GAM3_SLOT_DIR;
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('env: create, status with a binary clash, guarded remove', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git not available');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gam3-env-')));
  const proj = path.join(base, 'game');
  fs.mkdirSync(path.join(proj, 'Tools', 'gam3'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'Content'));
  fs.mkdirSync(path.join(proj, 'Intermediate'));
  fs.copyFileSync(path.join(shared, 'env.mjs'), path.join(proj, 'Tools', 'gam3', 'env.mjs'));
  fs.writeFileSync(path.join(proj, 'Content', 'Level.umap'), 'v1');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'v1\n');
  fs.writeFileSync(path.join(proj, 'Intermediate', 'cache.bin'), 'cached');
  fs.writeFileSync(path.join(proj, '.gitignore'), 'Intermediate/\n');
  git(proj, 'init', '-q', '-b', 'main');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(proj, 'untracked.bin'), 'not in git');
  const env = (...args) => spawnSync(process.execPath, [path.join(proj, 'Tools', 'gam3', 'env.mjs'), ...args], { encoding: 'utf8' });

  const made = env('create', 'one');
  assert.match(made.stdout, /GAM3ENV: ok created one .*port=8124 copy=/);
  const there = path.join(base, 'game-env-one');
  assert.equal(fs.readFileSync(path.join(there, 'Intermediate', 'cache.bin'), 'utf8'), 'cached');   // the cache travelled
  assert.equal(git(there, 'status', '--porcelain'), '?? untracked.bin');                              // untracked work travels too
  assert.equal(git(there, 'rev-parse', '--abbrev-ref', 'HEAD'), 'gam3/one');
  assert.match(env('create', 'two').stdout, /port=8125/);

  fs.writeFileSync(path.join(there, 'Content', 'Level.umap'), 'theirs');
  fs.writeFileSync(path.join(there, 'notes.txt'), 'v1\nfrom the environment\n');
  git(there, 'commit', '-qam', 'env work');
  assert.match(env('status', 'one').stdout, /GAM3ENV: ok name=one ahead=1 .*binary=1 overlap=0 clash=0/);

  fs.writeFileSync(path.join(proj, 'Content', 'Level.umap'), 'ours');
  git(proj, 'commit', '-qam', 'main work');
  const clash = env('status', 'one');
  assert.equal(clash.status, 1);
  assert.match(clash.stdout, /CLASH {3}Content\/Level\.umap/);
  assert.match(clash.stdout, /GAM3ENV: CLASH name=one .*clash=1/);

  const refused = env('remove', 'one');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unmerged commit/);
  assert.match(env('remove', 'one', '--force').stdout, /GAM3ENV: ok removed one/);
  assert.match(env('remove', 'two').stderr, /1 uncommitted change/);   // the untracked file it carried over
  assert.match(env('remove', 'two', '--force').stdout, /GAM3ENV: ok removed two/);
  // A file system that cannot clone: small projects are copied, large ones are refused unless asked for.
  const copyEnv = (extra, ...args) => spawnSync(process.execPath, [path.join(proj, 'Tools', 'gam3', 'env.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, GAM3_ENV_FORCE_COPY: '1', ...extra } });
  const small = copyEnv({}, 'create', 'three');
  assert.match(small.stdout, /GAM3ENV: ok created three .*copy=full/);
  assert.equal(fs.readFileSync(path.join(base, 'game-env-three', 'Content', 'Level.umap'), 'utf8'), 'ours');
  assert.match(copyEnv({}, 'remove', 'three', '--force').stdout, /ok removed three/);
  const refusedCopy = copyEnv({ GAM3_ENV_COPY_LIMIT_GB: '0.000000001' }, 'create', 'four');
  assert.equal(refusedCopy.status, 1);
  assert.match(refusedCopy.stderr, /cannot clone files.*--full-copy/s);
  assert.ok(!fs.existsSync(path.join(base, 'game-env-four')));
  assert.match(copyEnv({ GAM3_ENV_COPY_LIMIT_GB: '0.000000001' }, 'create', 'four', '--full-copy').stdout, /copy=full/);
  assert.match(copyEnv({}, 'remove', 'four', '--force').stdout, /ok removed four/);
  assert.match(env('list').stdout, /GAM3ENV: ok 0 environment/);
  assert.ok(!fs.existsSync(there));
});

test('look: blink sees a change that comes back, shimmer sees wandering, compare sees lifted blacks', async () => {
  const { blink, lookOf, readPng, writePng } = await import('../core/kit-shared/look.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gam3-look-'));
  const make = (name, fn) => {
    const rgb = new Uint8Array(32 * 32 * 3);
    for (let p = 0; p < 32 * 32; p++) { const v = fn(p % 32, Math.floor(p / 32)); rgb[p * 3] = v; rgb[p * 3 + 1] = v; rgb[p * 3 + 2] = v; }
    const file = path.join(dir, name);
    writePng(file, 32, 32, rgb);
    return file;
  };
  const steady = (x) => (x < 16 ? 20 : 200);
  const a = make('a.png', steady), c = make('c.png', steady);
  const b = make('b.png', (x, y) => (x < 4 && y < 4 ? 255 : steady(x)));   // a 4x4 patch flashes for one frame
  const r = blink([a, b, c].map(readPng));
  assert.ok(Math.abs(r.worst - (100 * 16) / 1024) < 0.01, `blink share ${r.worst}`);
  // An edge that moves steadily is motion, not blinking.
  const m = [0, 1, 2].map((i) => make(`m${i}.png`, (x) => (x < 10 + i * 4 ? 20 : 200)));
  assert.equal(blink(m.map(readPng)).worst, 0);
  const dark = lookOf(readPng(a));
  const lifted = lookOf(readPng(make('l.png', (x) => (x < 16 ? 70 : 200))));
  assert.ok(lifted.black - dark.black > 15, 'the lifted picture has a higher black level');
  const run = spawnSync(process.execPath, [path.join(root, 'core', 'kit-shared', 'look.mjs'), 'compare', a, path.join(dir, 'l.png')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /GAM3LOOK: FAILED compare/);
  const still = spawnSync(process.execPath, [path.join(root, 'core', 'kit-shared', 'look.mjs'), 'shimmer', a, b, c], { encoding: 'utf8' });
  assert.match(still.stdout, /GAM3LOOK: ok shimmer frames=3 percent=1\.56/);
});
