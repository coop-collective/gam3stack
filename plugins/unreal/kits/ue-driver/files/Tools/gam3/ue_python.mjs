#!/usr/bin/env node
// Run an editor Python script in a full editor session that then quits. For unattended asset and level builds.
//   node Tools/gam3/ue_python.mjs path/to/script.py [--log FILE] [--marker REGEX] [--retries N] [--timeout SEC] [-- script args]
// The script must end with unreal.SystemLibrary.quit_editor(); a failed script that never reaches it would leave
// the editor open, so pass --timeout as a backstop. With --marker the exit code is 0 only when a log line matches:
// have the script log a line such as "BUILD: done" as its last act. The editor's exit code alone proves nothing.
// For work in an editor that stays open, use the editor-bridge kit instead: no start-up cost per call.
import path from 'node:path';
import { editorPythonArgs, grepLines, logProblems, parseArgs, readLog, runMain, runUnreal, ueConfig } from './ue_env.mjs';

export async function runEditorPython(cfg, script, { logFile, scriptArgs = [], marker, retries = 0, timeoutSec = 0 } = {}) {
  const abs = path.resolve(script);
  const log = logFile ? path.resolve(logFile) : path.join(cfg.logDir, `python_${path.basename(abs, '.py')}.log`);
  const markerRe = marker ? new RegExp(marker) : null;
  const attempts = 1 + Math.min(Math.max(0, retries | 0), 3);
  let result;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result = await runUnreal(cfg, cfg.editor, editorPythonArgs(cfg, abs, log, scriptArgs), { logFile: log, exitGraceSec: 45, timeoutSec, label: 'ue_python' });
    Object.assign(result, { attempts: attempt, log, markerFound: markerRe ? markerRe.test(readLog(log)) : undefined });
    if (!markerRe || result.markerFound) break;
  }
  return result;
}

async function main(argv) {
  const a = parseArgs(argv, { options: ['log', 'marker', 'retries', 'timeout'] });
  if (!a._[0]) {
    console.error('usage: ue_python.mjs <script.py> [--log FILE] [--marker REGEX] [--retries N] [--timeout SEC] [-- script args]');
    return 2;
  }
  const cfg = ueConfig();
  const r = await runEditorPython(cfg, a._[0], { logFile: a.log, marker: a.marker, retries: Number(a.retries ?? 0), timeoutSec: Number(a.timeout ?? 0), scriptArgs: a.rest });
  const text = readLog(r.log);
  const problems = logProblems(text);
  const lines = [...grepLines(text, /LogPython: (Warning|Error)|  File "/, { max: 40 }), ...problems.material, ...problems.fatal];
  if (lines.length) console.log(lines.join('\n'));
  const ok = a.marker ? r.markerFound : !problems.script.length && !problems.fatal.length && !r.killedBy;
  console.log(`GAM3PY: ${ok ? 'ok' : 'FAILED'} ${r.seconds.toFixed(1)}s attempts=${r.attempts}${r.killedBy ? ` stopped=${r.killedBy}` : ''} log=${r.log}`);
  return ok ? 0 : 1;
}

runMain(import.meta.url, main);
