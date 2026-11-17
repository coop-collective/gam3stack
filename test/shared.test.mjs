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
  // Engines really running on this machine count against the cap, so leave room for them.
  const max = enginesRunning().length + 2;
  const a = await acquireSlot({ label: 'a', max, quiet: true });
  const b = await acquireSlot({ label: 'b', max, quiet: true });
  assert.equal(slotsInUse().length, 2);
  await assert.rejects(acquireSlot({ label: 'c', max, waitSec: 0.1, quiet: true }), /no free engine slot/);
  a.release();
  assert.equal(slotsInUse().length, 1);
  // Handing a slot to a process that has already exited: the slot must not stay taken.
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  b.handOver(gone);
  assert.equal(slotsInUse().length, 0);
  const c = await acquireSlot({ label: 'c', max, waitSec: 1, quiet: true });
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
  assert.match(env('list').stdout, /GAM3ENV: ok 0 environment/);
  assert.ok(!fs.existsSync(there));
});
