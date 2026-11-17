import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPlan, listKits, planInstall, readLock } from '../core/kits.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gam3-'));
  const kits = path.join(dir, 'kits');
  const kit = path.join(kits, 'demo');
  fs.mkdirSync(path.join(kit, 'files', 'Source', '__GAM3_MODULE__'), { recursive: true });
  fs.writeFileSync(path.join(kit, 'kit.json'), JSON.stringify({
    name: 'demo', engine: 'unreal', version: '1.0.0', summary: 'demo', requires: ['base'],
    params: { MODULE: { description: 'game module' } }, adapt: ['do a thing'], verify: ['true'],
  }));
  fs.writeFileSync(path.join(kit, 'KIT.md'), '# demo\n');
  fs.writeFileSync(path.join(kit, 'files', 'Source', '__GAM3_MODULE__', 'A.h'), 'class __GAM3_MODULE__Thing {};\n');
  fs.writeFileSync(path.join(kit, 'files', 'tool.mjs'), 'export const v = 1;\n');
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  return { dir, kits, kit, project };
}

test('a plan fills tokens in paths and text and writes nothing', () => {
  const f = fixture();
  const plan = planInstall({ kitsDir: f.kits, name: 'demo', project: f.project, detected: { MODULE: 'MyGame' } });
  assert.deepEqual(plan.writes.map((w) => [w.path, w.action]), [['Source/MyGame/A.h', 'create'], ['tool.mjs', 'create']]);
  assert.match(plan.writes[0].text, /class MyGameThing/);
  assert.deepEqual(plan.requires_missing, ['base']);
  assert.deepEqual(fs.readdirSync(f.project), []);
});

test('a missing param blocks the install and is named', () => {
  const f = fixture();
  const plan = planInstall({ kitsDir: f.kits, name: 'demo', project: f.project });
  assert.deepEqual(plan.missing_params.map((p) => p.key), ['MODULE']);
  assert.throws(() => applyPlan(plan), /missing params: MODULE/);
});

test('apply writes files and a lock; a second plan is all identical', () => {
  const f = fixture();
  const args = { kitsDir: f.kits, name: 'demo', project: f.project, params: { MODULE: 'MyGame' } };
  const done = applyPlan(planInstall(args));
  assert.deepEqual(done.written, ['Source/MyGame/A.h', 'tool.mjs']);
  assert.equal(readLock(f.project).kits.demo.version, '1.0.0');
  assert.deepEqual(planInstall(args).writes.map((w) => w.action), ['identical', 'identical']);
});

test('an edited file is a conflict; an untouched old copy is an update', () => {
  const f = fixture();
  const args = { kitsDir: f.kits, name: 'demo', project: f.project, params: { MODULE: 'MyGame' } };
  applyPlan(planInstall(args));
  fs.writeFileSync(path.join(f.kit, 'files', 'tool.mjs'), 'export const v = 2;\n');          // the kit moved on
  assert.equal(planInstall(args).writes[1].action, 'update');
  fs.writeFileSync(path.join(f.project, 'tool.mjs'), 'export const v = 99; // mine\n');      // the user edited theirs
  const plan = planInstall(args);
  assert.deepEqual(plan.conflicts, ['tool.mjs']);
  assert.throws(() => applyPlan(plan), /conflicts/);
  assert.match(fs.readFileSync(path.join(f.project, 'tool.mjs'), 'utf8'), /mine/);
  applyPlan(planInstall({ ...args, overwrite: true }));
  assert.match(fs.readFileSync(path.join(f.project, 'tool.mjs'), 'utf8'), /v = 2/);
});

test('unsafe param values and unknown kits are refused', () => {
  const f = fixture();
  assert.throws(() => planInstall({ kitsDir: f.kits, name: 'demo', project: f.project, params: { MODULE: '../../etc' } }), /unsafe value/);
  assert.throws(() => planInstall({ kitsDir: f.kits, name: '../demo', project: f.project }), /invalid kit name/);
  assert.throws(() => planInstall({ kitsDir: f.kits, name: 'nope', project: f.project }), /no such kit/);
});

test('every shipped kit loads', () => {
  const plugins = path.resolve(import.meta.dirname, '..', 'plugins');
  for (const p of fs.readdirSync(plugins)) {
    const kits = listKits(path.join(plugins, p, 'kits'));
    assert.ok(kits.length > 0, `${p} ships kits`);
    for (const k of kits) assert.equal(k.engine, p);
  }
});
