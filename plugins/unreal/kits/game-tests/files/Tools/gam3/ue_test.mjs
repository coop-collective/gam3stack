#!/usr/bin/env node
// Run the game's own scripted tests (classes derived from UGam3GameTest) and turn their log into a verdict.
//   node Tools/gam3/ue_test.mjs --tests WalkForwardTest,PauseMenuTest | --tests all
//                               [--map L_Level] [--profile blind|agent|human] [--shots-on-fail] [--expect-fail]
//                               [--timeout 600] [--ready-timeout 600] [--res 1280x720] [--log FILE] [-- extra engine args]
// The default profile is blind: no renderer, so a test costs little more than starting the engine. Every profile
// runs on a fixed time step here, human included: a stall must not drop simulation ticks or turn a tap into a
// hold, and the same test must do the same thing on a busy machine.
// --shots-on-fail   a picture at each failing check (Saved/Screenshots/test_<Test>_<check>.png). From a blind run
//                   the failing tests are run again at the agent profile for it; runs repeat exactly, so the
//                   picture is of the same failure.
// --expect-fail     the run is ok only if a check FAILS. Use it once for every new test, against the code before
//                   the fix: a test that has never failed has not been shown to test anything.
// The verdict comes from this run's log and nothing else. No SUMMARY line (a crash, a hang, a missing kit, a level
// that never started) is FAILED with no_verdict=1, never a pass. Exit status is 0 only for ok.
import fs from 'node:fs';
import path from 'node:path';
import { gameArgs, grepLines, logProblems, normalizeMap, parseArgs, profile, readiness, readLog, runMain, runUnreal, ueConfig } from './ue_env.mjs';

/** What the game's test runner logged: every PASS and FAIL, and the SUMMARY if it got that far. */
export function parseTests(text) {
  const clean = (l) => l.replace(/^.*GAM3TEST: /, '').trim();
  const passes = grepLines(text, /GAM3TEST: PASS /).map((l) => clean(l).slice(5));
  const fails = grepLines(text, /GAM3TEST: FAIL /).map((l) => {
    const [name, ...why] = clean(l).slice(5).split(' ');
    return { name, why: why.join(' ') };
  });
  const line = grepLines(text, /GAM3TEST: SUMMARY /).pop();
  let summary = null;
  if (line) {
    summary = {};
    for (const m of clean(line).matchAll(/([a-z_]+)=(\d+)/g)) summary[m[1]] = Number(m[2]);
  }
  return { passes, fails, summary };
}

/** A failure of the test itself (not found, checked nothing) proves nothing about the game. */
const isSetupFailure = (f) => /\.(found|no_checks)$/.test(f.name);

/** Pure verdict, so it can be tested without an engine. */
export function verdict(t, { expectFail = false, ready = 'ok', fatal = 0, timedOut = false } = {}) {
  const noVerdict = !t.summary;
  const real = t.fails.filter((f) => !isSetupFailure(f));
  if (noVerdict || timedOut) return { ok: false, noVerdict, real };
  if (expectFail) return { ok: real.length > 0 && !fatal, noVerdict, real };
  return { ok: t.fails.length === 0 && t.passes.length > 0 && ready === 'ok' && !fatal, noVerdict, real };
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ['shots-on-fail', 'expect-fail'], options: ['tests', 'map', 'profile', 'timeout', 'ready-timeout', 'res', 'log'] });
  if (!a.tests || !/^[A-Za-z0-9_,]+$/.test(a.tests)) throw new Error('--tests needs a comma-separated list of test names, or all');
  const cfg = ueConfig();
  const shotsDir = path.join(cfg.proj, 'Saved', 'Screenshots');

  async function once(tests, profName, shots, tag) {
    const prof = profile(profName);
    const [resx, resy] = a.res ? String(a.res).split('x').map(Number) : prof.res;
    const args = [...prof.args, `-Gam3ReadyTimeout=${Number(a['ready-timeout'] ?? 600)}`, `-Gam3Test=${tests}`];
    if (!args.includes('-UseFixedTimeStep')) args.push('-UseFixedTimeStep', '-fps=30');
    if (shots) args.push('-Gam3TestShotOnFail');
    args.push(...a.rest);
    const log = a.log ? path.resolve(a.log).replace(/(\.log)?$/, `${tag}.log`) : path.join(cfg.logDir, `test${tag}.log`);
    fs.rmSync(log, { force: true });   // an old log must never be read as this run's result
    const r = await runUnreal(cfg, cfg.editor, gameArgs(cfg, { map: a.map && normalizeMap(a.map), resx, resy, args, execCmds: prof.cmds, logFile: log }),
      { logFile: log, timeoutSec: Number(a.timeout ?? 600), exitGraceSec: 30, label: 'ue_test' });
    const text = readLog(log);
    return { prof, log, r, text, t: parseTests(text), rd: readiness(text), problems: logProblems(text) };
  }

  const first = profile(a.profile || 'blind');
  const wantShots = !!a['shots-on-fail'];
  const t0 = Date.now();
  const run = await once(a.tests, first.name, wantShots && first.captures, '');
  const v = verdict(run.t, { expectFail: !!a['expect-fail'], ready: run.rd.ready, fatal: run.problems.fatal.length, timedOut: run.r.killedBy === 'timeout' });
  for (const l of run.problems.fatal) console.log(`fatal: ${l}`);
  for (const f of run.t.fails) console.log(`GAM3TEST: FAIL ${f.name} ${f.why}`);
  if (run.rd.ready !== 'ok' && run.rd.line) console.log(run.rd.line);
  if (v.noVerdict) console.log('no verdict: the game never logged GAM3TEST: SUMMARY. It crashed, hung, never became ready, or the game-tests source is not compiled in. Read the log.');

  if (wantShots && !first.captures && v.real.length) {
    const names = [...new Set(v.real.map((f) => f.name.split('.')[0]))].join(',');
    console.log(`running ${names} again at the agent profile for pictures`);
    await once(names, 'agent', true, '_shots');
  }
  let pictures = [];
  if (wantShots) {
    try {
      pictures = fs.readdirSync(shotsDir).filter((n) => n.startsWith('test_') && n.endsWith('.png'))
        .map((n) => path.join(shotsDir, n)).filter((f) => fs.statSync(f).mtimeMs >= t0).sort();
    } catch { /* none */ }
    for (const p of pictures) console.log(p);
  }
  if (a['expect-fail']) console.log(v.ok ? 'expected failure seen: the test can fail.' : 'expected a failing check and none failed: this test does not detect the bug it was written for.');
  const s = run.t.summary || {};
  console.log(`GAM3TEST: ${v.ok ? 'ok' : 'FAILED'} tests=${s.tests ?? '?'} passed=${run.t.passes.length} failed=${run.t.fails.length} no_verdict=${v.noVerdict ? 1 : 0} profile=${first.name} ready=${run.rd.ready}${a['expect-fail'] ? ' expect_fail=1' : ''}${wantShots ? ` pictures=${pictures.length}` : ''}${run.r.killedBy ? ` stopped=${run.r.killedBy}` : ''}${run.r.slept ? ` slept=${run.r.slept}s` : ''} log=${run.log}`);
  return v.ok ? 0 : 1;
}

runMain(import.meta.url, main);
