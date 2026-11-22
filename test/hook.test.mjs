// The SessionStart hook each plugin ships: the core rules as session context, in the shape Claude Code and Codex read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const plugins = path.join(root, 'plugins');
const rule = fs.readFileSync(path.join(root, 'core', 'rules', 'deterministic-tests.md'), 'utf8').replace(/\r\n/g, '\n').trim();
const run = (hook, cwd) => spawnSync(process.execPath, [hook], { cwd, encoding: 'utf8' });
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gam3-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

for (const engine of fs.readdirSync(plugins)) {
  test(`${engine}: hooks.json runs session-start.mjs at SessionStart, and it prints the core rules as additionalContext`, (t) => {
    const dir = path.join(plugins, engine);
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks), ['SessionStart']);
    assert.equal(hooks.SessionStart[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/hooks/session-start.mjs"');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf8')).hooks, './hooks/hooks.json');

    // An installed plugin is this directory alone, and the session's working directory is some other project.
    const installed = path.join(tmp(t), engine);
    fs.cpSync(dir, installed, { recursive: true });
    const r = run(path.join(installed, 'hooks', 'session-start.mjs'), tmp(t));
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    const context = out.hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith('gam3stack core rules. Follow them in every task in this session.\n\n# Tests must be deterministic\n'));
    assert.ok(context.includes(rule), 'the whole shared rule is in the context');
    for (const must of ['## Engine tests (Unreal, Unity)', 'Fixed timestep and fixed seeds.', 'Wait on ready signals, never on fixed frame counts or delays.', 'No dependence on frame rate or machine speed.', `${engine}-deterministic-tests`]) {
      assert.ok(context.includes(must), must);
    }
    assert.ok(context.length < 10000, 'the context stays small enough for every session');
  });

  test(`${engine}: the skill that carries the rule without the hook states it in its description`, () => {
    const text = fs.readFileSync(path.join(plugins, engine, 'skills', `${engine}-deterministic-tests`, 'SKILL.md'), 'utf8');
    const description = /^description: (.*)$/m.exec(text)[1];
    for (const must of ['Tests must be deterministic', 'wall clock', 'sleep or count frames', 'order', 'seed', 'retry until green', 'fixed time step', 'ready signals', 'frame rate or machine speed', 'Use when']) {
      assert.ok(description.includes(must), must);
    }
  });
}

test('the hook stays silent and exits 0 when the rules are missing or empty', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'hooks'));
  const hook = path.join(dir, 'hooks', 'session-start.mjs');
  fs.copyFileSync(path.join(root, 'core', 'hooks', 'session-start.mjs'), hook);
  const missing = run(hook, dir);
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout + missing.stderr, '');
  fs.mkdirSync(path.join(dir, 'rules'));
  fs.writeFileSync(path.join(dir, 'rules', 'empty.md'), '\n');
  const empty = run(hook, dir);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout + empty.stderr, '');
});
