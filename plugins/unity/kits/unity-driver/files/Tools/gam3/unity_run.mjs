#!/usr/bin/env node
// Run the Unity editor unattended (batch mode) and report what happened in a form a script or an agent can read.
//
//   node Tools/gam3/unity_run.mjs compile
//       Open the project, let it import and compile, quit. Prints every "error CS####" line. Exit 1 on any.
//   node Tools/gam3/unity_run.mjs exec Namespace.Class.Method [--grep REGEX] [--stay] [-- args for the method]
//       Run a public static method from an Editor script (-executeMethod), then quit. The method reads its
//       arguments from System.Environment.GetCommandLineArgs(). Prints log lines that start with "GAM3" or match
//       --grep, plus errors and exceptions. The method sets the exit code with EditorApplication.Exit(n);
//       an exception that escapes it makes Unity exit non-zero.
//       --stay: do not pass -quit. For a method that needs editor updates to finish (anything that waits for
//       shaders, imports or frames) and ends the run itself with EditorApplication.Exit(n). If it never does,
//       --timeout stops it. Capture methods (Gam3.Shot.*) always run this way.
//   node Tools/gam3/unity_run.mjs test [--platform EditMode|PlayMode] [--filter NAME]
//       Run the Unity Test Framework (-runTests) and summarise the results file. (--mode is the old name.)
//
// --profile blind|agent|human   how much the run needs to see (default human, as before this option existed):
//       blind  no graphics device. Fastest to start and lightest; right for compile, tests and data work.
//              Nothing can be rendered: a capture under blind is refused.
//       agent  graphics on but cheap: lowest quality level, 640x360 captures, fixed time step in play mode.
//       human  the project's own quality in real time. The only tier that can judge the final look.
//       --nographics is the old spelling of --profile blind.
// Common options: --project DIR (default: the project this file is in), --timeout SECONDS (default 1800),
//                 --log FILE (default <project>/Logs/gam3/<command>.log)
// Last line: "GAM3UNITY: ok ..." or "GAM3UNITY: FAILED ...". Exit code 0 only on ok.
// It carries profile=, ready= (ok, timeout, or none when nothing in the run waited for readiness: a run with
// ready=timeout is FAILED, because what it captured may be a half-loaded scene) and rss= (peak memory of the editor).
//
// One editor per project: this refuses to start while an editor has the project open. It never closes that editor.
// At most GAM3_MAX_ENGINES (default 3) engine processes run on the machine at once: a run waits for a free slot.
import fs from 'node:fs';
import path from 'node:path';
import { acquireSlot } from './slots.mjs';
import { PROFILES, batchArgs, compileErrors, fatalReasons, grepLines, parseArgs, projectBusy, readLog, readiness, runUnity, testSummary, unityConfig } from './unity_env.mjs';

const USAGE = 'usage: unity_run.mjs compile | exec Class.Method [--stay] [-- args] | test [--platform EditMode|PlayMode]   [--profile blind|agent|human] [--project DIR] [--timeout S] [--log FILE]';
// Methods that render. Under blind there is no graphics device, so these are refused before the editor starts.
const CAPTURES = /^Gam3\.Shot\./;

function finish(ok, parts) {
  console.log(`GAM3UNITY: ${ok ? 'ok' : 'FAILED'} ${parts.filter(Boolean).join(' ')}`);
  return ok ? 0 : 1;
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ['nographics', 'stay'], options: ['project', 'timeout', 'log', 'grep', 'mode', 'platform', 'filter', 'profile'] });
  const cmd = a._[0];
  if (!['compile', 'exec', 'test'].includes(cmd)) { console.error(USAGE); return 2; }
  const profile = a.profile || (a.nographics ? 'blind' : 'human');
  if (!PROFILES.includes(profile)) { console.error(`--profile must be one of ${PROFILES.join(', ')}`); return 2; }
  if (a.nographics && profile !== 'blind') { console.error(`--nographics means --profile blind; it cannot be combined with --profile ${profile}`); return 2; }
  const cfg = unityConfig(a.project ? { project: a.project } : {});
  const busy = projectBusy(cfg);
  if (busy) { console.error(busy); return finish(false, ['reason=project-open']); }
  fs.mkdirSync(cfg.logDir, { recursive: true });
  const logFile = a.log ? path.resolve(a.log) : path.join(cfg.logDir, `${cmd}.log`);
  fs.rmSync(logFile, { force: true });
  const timeoutSec = a.timeout === undefined ? 1800 : Number(a.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) throw new Error(`--timeout must be a number of seconds (got ${a.timeout})`);

  let args;
  let resultsFile = null;
  if (cmd === 'compile') {
    args = batchArgs(cfg, { logFile, profile });
  } else if (cmd === 'exec') {
    const method = a._[1];
    if (!method || !/^[A-Za-z_][A-Za-z0-9_.]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(method)) { console.error('exec needs Namespace.Class.Method'); return 2; }
    if (profile === 'blind' && CAPTURES.test(method)) {
      console.error(`${method} renders, and --profile blind has no graphics device. Use --profile agent (cheap) or --profile human (final look).`);
      return finish(false, [`exec ${method}`, 'reason=blind-cannot-capture', `profile=${profile}`]);
    }
    args = batchArgs(cfg, { logFile, profile, quit: !(a.stay || CAPTURES.test(method)), extra: ['-executeMethod', method, ...a.rest] });
  } else {
    const mode = a.platform || a.mode || 'EditMode';
    if (!['EditMode', 'PlayMode'].includes(mode)) { console.error('--platform must be EditMode or PlayMode'); return 2; }
    resultsFile = path.join(cfg.logDir, `test-${mode}.xml`);
    fs.rmSync(resultsFile, { force: true });
    // -runTests quits by itself when the run ends; -quit would end the editor before the tests start.
    args = batchArgs(cfg, { logFile, profile, quit: false, extra: ['-runTests', '-testPlatform', mode, '-testResults', resultsFile, ...(a.filter ? ['-testFilter', a.filter] : [])] });
  }

  const slot = await acquireSlot({ label: `unity ${cmd}`, pid: process.pid });
  let r;
  try {
    r = await runUnity(cfg, args, { timeoutSec });
  } finally {
    slot.release();
  }
  const text = readLog(logFile);
  const errors = compileErrors(text);
  const reasons = fatalReasons(text);
  const ready = readiness(text);
  const tail = [`profile=${profile}`, `ready=${ready}`, `exit=${r.code}`, `${r.seconds.toFixed(1)}s`, r.peakRssMb ? `rss=${r.peakRssMb}MB` : '', `log=${logFile}`];
  if (r.timedOut) console.error(`timed out after ${timeoutSec}s; the editor this script started (pid ${r.pid}) was stopped`);
  for (const line of errors) console.log(line);
  for (const reason of reasons) console.log(`reason: ${reason}`);
  if (ready === 'timeout' && cmd === 'exec') console.log('reason: the scene was not ready when it was captured (GAM3READY: TIMEOUT). Find out what it was waiting for; do not judge the picture.');
  const sound = r.code === 0 && !errors.length && !r.timedOut && !(ready === 'timeout' && cmd === 'exec');

  if (cmd === 'compile') {
    return finish(sound, [`compile errors=${errors.length}`, ...tail]);
  }
  if (cmd === 'exec') {
    const want = new RegExp(`^GAM3|^\\S*Exception: ${a.grep ? `|${a.grep}` : ''}`);
    for (const line of grepLines(text, want, { max: 200 })) console.log(line);
    // A capture that never said it was ready was made by an older script, or the wait was skipped: not trusted.
    const unproven = CAPTURES.test(a._[1]) && ready === 'none';
    if (unproven) console.log('reason: the capture did not report readiness (no GAM3READY line). Update the shot-capture kit.');
    return finish(sound && !unproven, [`exec ${a._[1]}`, `errors=${errors.length}`, ...tail]);
  }
  for (const line of grepLines(text, /^GAM3/, { max: 200 })) console.log(line);
  const xml = readLog(resultsFile);
  const s = testSummary(xml);
  if (!s) {
    console.log('no test results were written. Is com.unity.test-framework in Packages/manifest.json, and do the scripts compile?');
    return finish(false, ['test results=none', ...tail]);
  }
  for (const n of s.failedNames) console.log(`failed: ${n}`);
  // ready= is left out for tests: a test may time a gate out on purpose, and the tests themselves judge readiness.
  return finish(s.failed === 0 && s.total > 0 && !r.timedOut, [`test ${path.basename(resultsFile, '.xml').slice(5)} total=${s.total} passed=${s.passed} failed=${s.failed} skipped=${s.skipped}`, `results=${resultsFile}`, ...tail.filter((t) => !t.startsWith('ready='))]);
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e?.message || String(e)); console.log('GAM3UNITY: FAILED reason=setup'); process.exitCode = 2; });
