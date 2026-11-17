#!/usr/bin/env node
// Run the Unity editor unattended (batch mode) and report what happened in a form a script or an agent can read.
//
//   node Tools/gam3/unity_run.mjs compile [--nographics]
//       Open the project, let it import and compile, quit. Prints every "error CS####" line. Exit 1 on any.
//   node Tools/gam3/unity_run.mjs exec Namespace.Class.Method [--grep REGEX] [--nographics] [-- args for the method]
//       Run a public static method from an Editor script (-executeMethod), then quit. The method reads its
//       arguments from System.Environment.GetCommandLineArgs(). Prints log lines that start with "GAM3" or match
//       --grep, plus errors and exceptions. The method sets the exit code with EditorApplication.Exit(n);
//       an exception that escapes it makes Unity exit non-zero.
//   node Tools/gam3/unity_run.mjs test [--mode EditMode|PlayMode] [--filter NAME]
//       Run the Unity Test Framework (-runTests) and summarise the results file.
//
// Common options: --project DIR (default: the project this file is in), --timeout SECONDS (default 1800),
//                 --log FILE (default <project>/Logs/gam3/<command>.log)
// Last line: "GAM3UNITY: ok ..." or "GAM3UNITY: FAILED ...". Exit code 0 only on ok.
//
// One editor per project: this refuses to start while an editor has the project open. It never closes that editor.
import fs from 'node:fs';
import path from 'node:path';
import { batchArgs, compileErrors, fatalReasons, grepLines, parseArgs, projectBusy, readLog, runUnity, testSummary, unityConfig } from './unity_env.mjs';

const USAGE = 'usage: unity_run.mjs compile | exec Class.Method [-- args] | test [--mode EditMode|PlayMode]   [--project DIR] [--timeout S] [--log FILE] [--nographics]';

function finish(ok, parts) {
  console.log(`GAM3UNITY: ${ok ? 'ok' : 'FAILED'} ${parts.filter(Boolean).join(' ')}`);
  return ok ? 0 : 1;
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ['nographics'], options: ['project', 'timeout', 'log', 'grep', 'mode', 'filter'] });
  const cmd = a._[0];
  if (!['compile', 'exec', 'test'].includes(cmd)) { console.error(USAGE); return 2; }
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
    args = batchArgs(cfg, { logFile, nographics: !!a.nographics });
  } else if (cmd === 'exec') {
    const method = a._[1];
    if (!method || !/^[A-Za-z_][A-Za-z0-9_.]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(method)) { console.error('exec needs Namespace.Class.Method'); return 2; }
    args = batchArgs(cfg, { logFile, nographics: !!a.nographics, extra: ['-executeMethod', method, ...a.rest] });
  } else {
    const mode = a.mode || 'EditMode';
    if (!['EditMode', 'PlayMode'].includes(mode)) { console.error('--mode must be EditMode or PlayMode'); return 2; }
    resultsFile = path.join(cfg.logDir, `test-${mode}.xml`);
    fs.rmSync(resultsFile, { force: true });
    // -runTests quits by itself when the run ends; -quit would end the editor before the tests start.
    args = batchArgs(cfg, { logFile, nographics: !!a.nographics, quit: false, extra: ['-runTests', '-testPlatform', mode, '-testResults', resultsFile, ...(a.filter ? ['-testFilter', a.filter] : [])] });
  }

  const r = await runUnity(cfg, args, { timeoutSec });
  const text = readLog(logFile);
  const errors = compileErrors(text);
  const reasons = fatalReasons(text);
  const tail = [`exit=${r.code}`, `${r.seconds.toFixed(1)}s`, `log=${logFile}`];
  if (r.timedOut) console.error(`timed out after ${timeoutSec}s; the editor this script started (pid ${r.pid}) was stopped`);
  for (const line of errors) console.log(line);
  for (const reason of reasons) console.log(`reason: ${reason}`);

  if (cmd === 'compile') {
    return finish(r.code === 0 && !errors.length && !r.timedOut, [`compile errors=${errors.length}`, ...tail]);
  }
  if (cmd === 'exec') {
    const want = new RegExp(`^GAM3|^\\S*Exception: ${a.grep ? `|${a.grep}` : ''}`);
    for (const line of grepLines(text, want, { max: 200 })) console.log(line);
    return finish(r.code === 0 && !errors.length && !r.timedOut, [`exec ${a._[1]}`, `errors=${errors.length}`, ...tail]);
  }
  const xml = readLog(resultsFile);
  const s = testSummary(xml);
  if (!s) {
    console.log('no test results were written. Is com.unity.test-framework in Packages/manifest.json, and do the scripts compile?');
    return finish(false, ['test results=none', ...tail]);
  }
  for (const n of s.failedNames) console.log(`failed: ${n}`);
  return finish(s.failed === 0 && s.total > 0 && !r.timedOut, [`test total=${s.total} passed=${s.passed} failed=${s.failed} skipped=${s.skipped}`, `results=${resultsFile}`, ...tail]);
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e?.message || String(e)); console.log('GAM3UNITY: FAILED reason=setup'); process.exitCode = 2; });
