#!/usr/bin/env node
// A machine-wide cap on how many game engine processes run at once. No dependencies.
//   node Tools/gam3/slots.mjs            show who holds a slot and how many engines are running
// Several agents on one machine each start editors and games; without a cap they starve each other of memory and
// the whole machine stalls. Every tool in this directory that starts an engine takes a slot first and waits when
// none is free. GAM3_MAX_ENGINES sets the cap (default 3). GAM3_SLOT_WAIT is how long to wait, in seconds
// (default 1800). Engines started by hand or by other tools are counted too, so the cap holds for the machine.
// On macOS the slot also keeps the machine awake while its holder lives: a laptop that idles to sleep freezes the
// run and its timeouts with it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = () => process.env.GAM3_SLOT_DIR || path.join(os.tmpdir(), 'gam3-slots');
const cap = () => Math.max(1, Number(process.env.GAM3_MAX_ENGINES) || 3);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Slots held by a live process: [{file, pid, label, since}]. Slots whose holder died are removed. */
export function slotsInUse() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => /^slot-\d+\.json$/.test(n)).sort(); } catch { return out; }
  for (const n of names) {
    const file = path.join(dir(), n);
    let s = null;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* being written, or broken */ }
    if (s && alive(s.pid)) out.push({ file, ...s });
    else if (s || Date.now() - fs.statSync(file).mtimeMs > 5000) fs.rmSync(file, { force: true });
  }
  return out;
}

const ENGINE = /(^|[\\/])(UnrealEditor(-Cmd)?(\.exe)?|Unity(\.exe)?)(\s|$)/;
/** Engine processes on this machine, however they were started: [{pid, command}]. */
export function enginesRunning() {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return (r.stdout || '').split(/\r?\n/).map((l) => l.split('","').map((c) => c.replace(/"/g, '')))
      .filter((c) => /^(UnrealEditor(-Cmd)?|Unity)\.exe$/i.test(c[0] || '')).map((c) => ({ pid: Number(c[1]), command: c[0] }));
  }
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), command: m[2] }))
    // The program is the text before the first " -" flag or " /path" argument; helpers (shader workers, crash reporters) are not engines.
    .filter((p) => ENGINE.test(p.command.split(/\s+(?=-|\/|[A-Za-z]:\\)/)[0]) && !/CrashReportClient|ShaderCompileWorker|UnityShaderCompiler|AssetImportWorker/.test(p.command));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** macOS: keep the machine from idling to sleep while `pid` lives. A sleeping laptop freezes the run and its timeouts. */
function keepAwake(pid) {
  if (process.platform !== 'darwin') return;
  try { spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* optional */ }
}

/**
 * Take a slot, waiting while the machine is at its cap. `pid` is the process whose life the slot follows (default:
 * this one). Returns {release(), handOver(pid)}: release when the engine has exited; handOver gives the slot to a
 * process that outlives this script (an editor left running), and it frees itself when that process ends.
 */
export async function acquireSlot({ label = 'engine', pid = process.pid, max = cap(), waitSec = Number(process.env.GAM3_SLOT_WAIT) || 1800, quiet = false, countEngines = true } = {}) {
  fs.mkdirSync(dir(), { recursive: true });
  const deadline = Date.now() + waitSec * 1000;
  let told = 0;
  for (;;) {
    const held = slotsInUse();
    const engines = countEngines ? enginesRunning() : [];   // off only in tests, which must not depend on what else is running
    if (Math.max(held.length, engines.length) < max) {
      for (let i = 0; i < max; i++) {
        const file = path.join(dir(), `slot-${i}.json`);
        try {
          fs.writeFileSync(file, JSON.stringify({ pid, label, since: new Date().toISOString() }), { flag: 'wx' });
        } catch (e) {
          if (e.code === 'EEXIST') continue;
          throw e;
        }
        keepAwake(pid);
        let mine = true;
        const release = () => { if (mine) { mine = false; fs.rmSync(file, { force: true }); } };
        process.once('exit', release);
        return {
          file, release,
          handOver(newPid) {
            fs.writeFileSync(file, JSON.stringify({ pid: newPid, label, since: new Date().toISOString() }));
            mine = false;
            keepAwake(newPid);
          },
        };
      }
    }
    if (Date.now() > deadline) throw new Error(`no free engine slot after ${waitSec}s (cap ${max}; ${held.length} held, ${engines.length} engines running). Raise GAM3_MAX_ENGINES only if the machine has the memory.`);
    if (!quiet && Date.now() - told > 60000) {
      told = Date.now();
      console.error(`slots: waiting for a free engine slot (cap ${max}; held by ${held.map((s) => `${s.label} pid ${s.pid}`).join(', ') || 'none'}; ${engines.length} engine process(es) running)`);
    }
    await sleep(2000);
  }
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify({ cap: cap(), slots: slotsInUse().map(({ file, ...s }) => s), engines: enginesRunning() }, null, 1));
}
