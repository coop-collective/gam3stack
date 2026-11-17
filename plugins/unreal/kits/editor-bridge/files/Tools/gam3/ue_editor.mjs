#!/usr/bin/env node
// Start, check and stop an editor that listens for MCP calls (see ue_mcp.mjs). One editor per project.
//   node Tools/gam3/ue_editor.mjs start [--port 8123] [--map /Game/Maps/L_Level] [--toolsets A,B] [--wait 900] [-- extra engine args]
//   node Tools/gam3/ue_editor.mjs status [--port 8123]
//   node Tools/gam3/ue_editor.mjs stop
// The port defaults to the one in .gam3/env.json (a dedicated environment made by env.mjs), else UE_MCP_PORT, else 8123.
// The editor takes an engine slot (slots.mjs) for as long as it runs. An editor left in the background costs little
// processor time (it throttles itself) but keeps its memory, so stop it when the work is done.
// start returns when the editor answers a tool call, which can take minutes on a first run (shader compiles).
// stop ends only the editor this script started (its PID is in .gam3/editor.json), never another editor.
// Then it checks the port: a crash reporter left behind by a killed editor can keep holding it, and the next
// editor then cannot listen; calls hang with no error. stop ends that reporter too when it belongs to our editor.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkMap, killTree, parseArgs, runMain, sleep, start, ueConfig } from './ue_env.mjs';
import { acquireSlot } from './slots.mjs';
import { tool } from './ue_mcp.mjs';

const DEFAULT_TOOLSETS = 'EditorToolset,SceneCaptureToolset,PCGToolset,ConsoleToolset,GeometryToolset';

const stateFile = (cfg) => path.join(cfg.proj, '.gam3', 'editor.json');
function readState(cfg) {
  try { return JSON.parse(fs.readFileSync(stateFile(cfg), 'utf8')); } catch { return null; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Who listens on the port: [{pid, command}] (Mac and Linux; empty on Windows, where it is not checked). */
export function portHolders(port) {
  if (process.platform === 'win32') return [];
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
  const pids = [...new Set((r.stdout || '').split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))))];
  return pids.map((pid) => ({ pid, command: (spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '').trim() }));
}

async function answers(port) {
  try {
    const r = await tool('list_toolsets', {}, { port, timeoutMs: 20000 });
    return !r.isError;
  } catch { return false; }
}

function defaultPort(cfg) {
  try { return JSON.parse(fs.readFileSync(path.join(cfg.proj, '.gam3', 'env.json'), 'utf8')).port; } catch { return undefined; }
}

async function cmdStart(cfg, a) {
  const port = Number(a.port || defaultPort(cfg) || process.env.UE_MCP_PORT || 8123);
  const prev = readState(cfg);
  if (prev && alive(prev.pid)) {
    console.log(`GAM3EDITOR: already running pid=${prev.pid} port=${prev.port}`);
    return 0;
  }
  const holders = portHolders(port);
  if (holders.length) {
    console.log(`GAM3EDITOR: FAILED port ${port} is held by pid ${holders.map((h) => `${h.pid} (${h.command.slice(0, 80)})`).join(', ')}. Pick another --port, or end that process if it is a leftover of yours.`);
    return 1;
  }
  const log = path.join(cfg.logDir, 'editor.log');
  const args = [cfg.uproject];
  if (a.map) args.push(checkMap(a.map));
  args.push(`-ModelContextProtocolPort=${port}`, `-EnablePlugins=${a.toolsets || DEFAULT_TOOLSETS}`, `-abslog=${log}`, ...a.rest);
  const slot = await acquireSlot({ label: 'ue_editor' });
  const { child } = start(cfg.editor, args, { cwd: cfg.proj, logFile: path.join(cfg.logDir, 'editor.stdout.log'), detached: true });
  child.unref();
  slot.handOver(child.pid);   // the slot is the editor's for as long as it lives
  fs.mkdirSync(path.dirname(stateFile(cfg)), { recursive: true });
  fs.writeFileSync(stateFile(cfg), JSON.stringify({ pid: child.pid, port, log, started: new Date().toISOString() }, null, 2) + '\n');
  const deadline = Date.now() + Number(a.wait ?? 900) * 1000;
  while (Date.now() < deadline) {
    if (!alive(child.pid)) {
      console.log(`GAM3EDITOR: FAILED the editor exited during start-up. Read ${log}`);
      return 1;
    }
    if (await answers(port)) {
      console.log(`GAM3EDITOR: ready pid=${child.pid} port=${port} log=${log}`);
      return 0;
    }
    await sleep(5000);
  }
  console.log(`GAM3EDITOR: FAILED no answer on port ${port} after ${a.wait ?? 900}s; the editor (pid ${child.pid}) is still starting or stuck. Read ${log}`);
  return 1;
}

async function cmdStatus(cfg, a) {
  const st = readState(cfg);
  const port = Number(a.port || st?.port || defaultPort(cfg) || process.env.UE_MCP_PORT || 8123);
  const running = !!st && alive(st.pid);
  const holders = portHolders(port);
  const ok = await answers(port);
  console.log(JSON.stringify({ started_by_this_tool: running ? st.pid : null, port, port_held_by: holders, answers: ok, log: st?.log || null }, null, 1));
  if (!running && holders.length) console.log(`A process this tool did not start holds port ${port}. If it is a crash reporter left by a dead editor, end it; otherwise use another --port.`);
  return ok ? 0 : 1;
}

async function cmdStop(cfg) {
  const st = readState(cfg);
  if (!st) {
    console.log('GAM3EDITOR: nothing to stop (no editor was started by this tool)');
    return 0;
  }
  if (alive(st.pid)) killTree(st.pid);
  await sleep(1500);
  // The reporter an editor leaves behind names that editor's PID on its command line.
  for (const h of portHolders(st.port)) {
    if (/CrashReportClient/.test(h.command) && h.command.includes(`pid-${st.pid}`)) {
      killTree(h.pid);
      console.log(`ended the crash reporter (pid ${h.pid}) that kept port ${st.port}`);
    }
  }
  fs.rmSync(stateFile(cfg), { force: true });
  const left = portHolders(st.port);
  console.log(`GAM3EDITOR: stopped pid=${st.pid}${left.length ? ` (port ${st.port} is still held by pid ${left.map((h) => h.pid).join(', ')}: not ours, left alone)` : ''}`);
  return 0;
}

async function main(argv) {
  const a = parseArgs(argv, { options: ['port', 'map', 'toolsets', 'wait'] });
  const cfg = ueConfig();
  if (a._[0] === 'start') return cmdStart(cfg, a);
  if (a._[0] === 'status') return cmdStatus(cfg, a);
  if (a._[0] === 'stop') return cmdStop(cfg);
  console.error('usage: ue_editor.mjs start [--port N] [--map /Game/...] [--toolsets A,B] [--wait SEC] [-- engine args] | status | stop');
  return 2;
}

runMain(import.meta.url, main);
