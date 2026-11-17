#!/usr/bin/env node
// Compile the project's C++ with the engine's build tool.
//   node Tools/gam3/ue_build.mjs [--target <Project>Editor] [--configuration Development] [--max-parallel N] [--log FILE] [--force]
// Refuses while an editor has this project open (close it first; --force skips the check). Prints the error lines
// and one summary line, `GAM3BUILD: ok ...` or `GAM3BUILD: FAILED ...`, and exits with the build tool's code.
import path from 'node:path';
import { buildArgs, editorsOnProject, grepLines, parseArgs, readLog, runMain, start, ueConfig } from './ue_env.mjs';

export async function buildEditor(cfg, { target, configuration, maxParallelActions, logFile } = {}) {
  const log = logFile ? path.resolve(logFile) : path.join(cfg.logDir, `build_${target || cfg.editorTarget}.log`);
  const r = await start(cfg.build, buildArgs(cfg, { target, configuration, maxParallelActions }), { cwd: cfg.proj, logFile: log }).done;
  const text = readLog(log);
  const errors = grepLines(text, /\berror\b|: Error:|Fatal/i, { exclude: /0 error|warning/i, max: 40 });
  const warnings = grepLines(text, /\bwarning\b/i).length;
  return { ...r, errors, warnings, log };
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ['force'], options: ['target', 'configuration', 'max-parallel', 'log'] });
  const cfg = ueConfig();
  const open = editorsOnProject(cfg);
  if (open?.length && !a.force) {
    console.log(`GAM3BUILD: FAILED editor pid ${open.join(', ')} has this project open. Close it, then build (or --force).`);
    return 3;
  }
  const r = await buildEditor(cfg, { target: a.target, configuration: a.configuration, maxParallelActions: a['max-parallel'], logFile: a.log });
  if (r.errors.length) console.log(r.errors.join('\n'));
  console.log(`GAM3BUILD: ${r.code === 0 ? 'ok' : 'FAILED'} exit=${r.code} ${r.seconds.toFixed(1)}s warnings=${r.warnings} log=${r.log}`);
  return r.code ?? 1;
}

runMain(import.meta.url, main);
