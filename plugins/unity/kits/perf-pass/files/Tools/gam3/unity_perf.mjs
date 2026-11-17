#!/usr/bin/env node
// Measure frame times of one part of the game and say whether it is fast enough. Always full quality, real time.
//
//   node Tools/gam3/unity_perf.mjs --scenario room  --data Gam3Perf/fx-room.json [--prewarm]
//       Test room: each subject (a prefab) alone in front of a fixed camera, spawned cold, then again warm.
//       A subject whose first use costs more than --first-use-ms over its warm spawn FAILS by name: that is the
//       hitch a player sees the first time the effect fires. --prewarm sends the subjects through Gam3.Prewarm
//       behind the ready gate first, to prove that prewarming cures it.
//   node Tools/gam3/unity_perf.mjs --scenario flyby --data Gam3Perf/level1-flyby.json
//       The camera moves through points in a scene: one segment per leg. The cost of the world itself.
//   node Tools/gam3/unity_perf.mjs --scenario play  --data Gam3Perf/level1-play.json
//       The game plays itself for "seconds". Its own Gam3.Perf.Mark("label") calls split the run into parts.
//
// Options:
//   --budget-ms N        frame budget (default 16.7 = 60 fps). A segment whose average is over it fails; a frame
//                        over twice the budget is a hitch, and a hitch fails a fly-by or a play run.
//   --first-use-ms N     how much slower than the warm spawn a first use may be (default 8).
//   --save-baseline NAME write this run's totals to Gam3Perf/baselines/NAME.json (commit it).
//   --baseline NAME      fail when the average or the 99th percentile frame is more than --tolerance percent
//                        (default 10) and more than --floor-ms (default 1) slower than that baseline. The floor
//                        keeps run-to-run noise on very short frames from being called a regression.
//   --player             build a player that starts in the scenario and measure that instead of the editor.
//                        Editor numbers are only good for comparing one editor run with another; what a player
//                        gets is measured in a player.
//   --shared             do not wait to be alone on the machine. For checking that a scenario works; the numbers
//                        of a shared run are marked alone=no and should not be kept as a baseline.
//   --name NAME          report name (default: the scenario). Report: Logs/gam3-perf/NAME.json
//   --size WxH           size of the picture being measured in the editor (default 1920x1080).
//   --project DIR  --timeout SECONDS (default 1800)
//
// A performance run must be the only engine on the machine, or it measures the other engines. Unless --shared is
// given, this waits until no engine is running and then holds every engine slot until it is done.
//
// Last line:
//   GAM3PERF: ok|FAILED scenario= frames= avg_ms= p99_ms= fps= hitches= subjects= first_use_fail=<names or 0> baseline=<ok|regressed|none> ...
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSlot } from './slots.mjs';
import { batchArgs, compileErrors, fatalReasons, grepLines, parseArgs, projectBusy, readLog, runUnity, unityConfig } from './unity_env.mjs';

const SCENARIOS = ['room', 'flyby', 'play'];
const num = (v, name, fallback) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number (got ${v})`);
  return n;
};
const f = (n) => (Math.round(n * 100) / 100).toString();

/** Hold the whole machine: wait until nothing runs, then take every slot so nothing else starts. */
async function alone(label) {
  const cap = Math.max(1, Number(process.env.GAM3_MAX_ENGINES) || 3);
  const held = [await acquireSlot({ label, max: 1 })];
  for (let i = 1; i < cap; i++) {
    try { held.push(await acquireSlot({ label: `${label} (reserved)`, max: cap, waitSec: 1, quiet: true, countEngines: false })); } catch { break; }
  }
  return () => { for (const s of held) s.release(); };
}

/** Run a built player to completion; same result shape as runUnity for the fields used here. */
function runPlayer(bin, args, timeoutSec) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(bin, args, { stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutSec * 1000);
    const done = (code) => { clearTimeout(timer); resolve({ code: code ?? 1, timedOut, seconds: (Date.now() - t0) / 1000, pid: child.pid }); };
    child.on('error', (e) => { console.error(`could not start the player: ${e.message}`); done(127); });
    child.on('exit', done);
  });
}

function playerPaths(cfg) {
  const dir = path.join(cfg.project, 'Builds', 'gam3-perf');
  if (cfg.platform === 'darwin') return { to: path.join(dir, 'Gam3Perf.app'), bin: path.join(dir, 'Gam3Perf.app', 'Contents', 'MacOS') };
  if (cfg.platform === 'win32') return { to: path.join(dir, 'Gam3Perf.exe'), bin: path.join(dir, 'Gam3Perf.exe') };
  return { to: path.join(dir, 'Gam3Perf.x86_64'), bin: path.join(dir, 'Gam3Perf.x86_64') };
}

/** Turn the probe's report into verdicts. Pure: exported for tests. */
export function judge(report, { budgetMs, firstUseMs, baseline = null, tolerance = 10, floorMs = 1 }) {
  const seg = (report.segments || []).filter((s) => s.label !== 'gap' && s.label !== 'idle');
  const total = report.total || { frames: 0, avg_ms: 0, p99_ms: 0, hitches: 0 };
  const subjects = [];
  if (report.scenario === 'room') {
    for (const cold of seg.filter((s) => s.label.endsWith('/cold'))) {
      const name = cold.label.slice(0, -5);
      const warm = seg.find((s) => s.label === `${name}/warm`);
      if (!warm) continue;
      const s = { name, first_use_ms: cold.first_ms, warm_ms: warm.first_ms, steady_ms: cold.p50_ms };
      s.first_use_over_ms = Math.round((s.first_use_ms - s.warm_ms) * 100) / 100;
      s.ok = s.first_use_over_ms <= firstUseMs;
      Object.assign(cold, { first_use_ms: s.first_use_ms, warm_ms: s.warm_ms, steady_ms: s.steady_ms });
      subjects.push(s);
    }
  }
  // The worst frame while nothing was being spawned or moved. A first-use result smaller than this is inside the
  // noise of the run (display sync stalls in a windowed player, another program taking the machine).
  const ambient = Math.max(0, ...(report.segments || []).filter((s) => s.label === 'gap' || s.label === 'idle').map((s) => s.max_ms));
  const firstUseFail = subjects.filter((s) => !s.ok).map((s) => s.name);
  // In a room the steady cost is what the budget is about; the first frames are judged by the first-use rule.
  const cost = (s) => (report.scenario === 'room' ? s.p50_ms : s.avg_ms);
  const overBudget = seg.filter((s) => cost(s) > budgetMs && !(report.scenario === 'room' && s.label.endsWith('/warm'))).map((s) => s.label);
  const hitchIn = report.scenario === 'room' ? [] : seg.filter((s) => s.hitches > 0).map((s) => s.label);
  let base = 'none';
  const regressed = [];
  if (baseline) {
    for (const k of ['avg_ms', 'p99_ms']) {
      const was = baseline.total?.[k];
      const now = total[k];
      if (typeof was === 'number' && now > was * (1 + tolerance / 100) && now - was > floorMs) regressed.push(`${k} ${f(was)} -> ${f(now)}`);
    }
    base = regressed.length ? 'regressed' : 'ok';
  }
  const reasons = [];
  if (!total.frames) reasons.push('nothing was measured');
  for (const s of subjects.filter((x) => !x.ok)) reasons.push(`${s.name}: first use ${f(s.first_use_ms)} ms, warm ${f(s.warm_ms)} ms: ${f(s.first_use_over_ms)} ms over (allowed ${firstUseMs}). Prewarm it behind the loading cover.`);
  for (const l of overBudget) reasons.push(`${l}: over the ${budgetMs} ms frame budget`);
  for (const l of hitchIn) reasons.push(`${l}: ${seg.find((s) => s.label === l).hitches} frame(s) over ${f(budgetMs * 2)} ms (worst ${f(seg.find((s) => s.label === l).max_ms)} ms)`);
  for (const r of regressed) reasons.push(`slower than the baseline: ${r}`);
  return { ok: reasons.length === 0, total, ambient, subjects, firstUseFail, overBudget, hitchIn, baseline: base, reasons };
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ['prewarm', 'player', 'shared'], options: ['scenario', 'data', 'budget-ms', 'first-use-ms', 'save-baseline', 'baseline', 'tolerance', 'floor-ms', 'name', 'size', 'project', 'timeout', 'handicap-ms'] });
  const scenario = a.scenario;
  if (!SCENARIOS.includes(scenario)) { console.error(`--scenario must be one of ${SCENARIOS.join(', ')}`); return 2; }
  if (!a.data) { console.error('--data FILE is needed: the subjects, the fly-by points or the scene to play'); return 2; }
  const budgetMs = num(a['budget-ms'], 'budget-ms', 16.7);
  const firstUseMs = num(a['first-use-ms'], 'first-use-ms', 8);
  const tolerance = num(a.tolerance, 'tolerance', 10);
  const floorMs = num(a['floor-ms'], 'floor-ms', 1);
  const timeoutSec = num(a.timeout, 'timeout', 1800);
  const cfg = unityConfig(a.project ? { project: a.project } : {});
  const data = path.resolve(a.data);
  if (!fs.existsSync(data)) { console.error(`data file not found: ${data}`); return 2; }
  for (const n of [a.name, a.baseline, a['save-baseline']]) if (n !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(n)) { console.error(`not a usable name: ${n}`); return 2; }
  const name = a.name || scenario;
  const baseDir = path.join(cfg.project, 'Gam3Perf', 'baselines');
  let baseline = null;
  if (a.baseline) {
    const file = path.join(baseDir, `${a.baseline}.json`);
    if (!fs.existsSync(file)) { console.error(`no such baseline: ${file}`); return 2; }
    baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const busy = projectBusy(cfg);
  if (busy) { console.error(busy); console.log('GAM3PERF: FAILED reason=project-open'); return 1; }

  const outDir = path.join(cfg.project, 'Logs', 'gam3-perf');
  fs.mkdirSync(outDir, { recursive: true });
  const report = path.join(outDir, `${name}.json`);
  const logFile = path.join(outDir, `${name}.log`);
  fs.rmSync(report, { force: true });
  fs.rmSync(logFile, { force: true });
  const perfArgs = ['-gam3PerfScenario', scenario, '-gam3PerfData', data, '-gam3PerfOut', report, '-gam3PerfBudgetMs', String(budgetMs),
    ...(a.prewarm ? ['-gam3PerfPrewarm'] : []), ...(a.size ? ['-gam3PerfSize', a.size] : []), ...(a['handicap-ms'] ? ['-gam3PerfHandicapMs', String(a['handicap-ms'])] : [])];

  let release;
  if (a.shared) {
    const s = await acquireSlot({ label: `unity perf ${scenario}`, pid: process.pid });
    release = () => s.release();
    console.error('--shared: other engines may be running, so these numbers are not fit to keep or compare');
  } else {
    release = await alone(`unity perf ${scenario}`);
  }
  let r;
  let text = '';
  try {
    if (a.player) {
      const p = playerPaths(cfg);
      const buildLog = path.join(outDir, `${name}.build.log`);
      fs.rmSync(buildLog, { force: true });
      fs.rmSync(path.dirname(p.to), { recursive: true, force: true });
      const b = await runUnity(cfg, batchArgs(cfg, { logFile: buildLog, profile: 'human', quit: false, extra: ['-executeMethod', 'Gam3.PerfPass.Build', '-gam3PerfBuildTo', p.to, ...perfArgs] }), { timeoutSec });
      const btext = readLog(buildLog);
      for (const line of [...compileErrors(btext), ...grepLines(btext, /^GAM3PERF/, { max: 50 })]) console.log(line);
      if (b.code !== 0 || b.timedOut) { console.log(`GAM3PERF: FAILED scenario=${scenario} reason=player-build exit=${b.code} log=${buildLog}`); return 1; }
      let bin = p.bin;
      if (cfg.platform === 'darwin') bin = path.join(bin, fs.readdirSync(bin)[0]);
      const [w, h] = (a.size || '1920x1080').split('x');
      r = await runPlayer(bin, ['-logFile', logFile, '-screen-fullscreen', '0', '-screen-width', w, '-screen-height', h, '-gam3PerfOut', report,
        ...(a['handicap-ms'] ? ['-gam3PerfHandicapMs', String(a['handicap-ms'])] : [])], timeoutSec);
    } else {
      r = await runUnity(cfg, batchArgs(cfg, { logFile, profile: 'human', quit: false, extra: ['-executeMethod', 'Gam3.PerfPass.Run', ...perfArgs] }), { timeoutSec });
    }
    text = readLog(logFile);
  } finally {
    release();
  }

  for (const line of compileErrors(text)) console.log(line);
  for (const reason of fatalReasons(text)) console.log(`reason: ${reason}`);
  for (const line of grepLines(text, /^GAM3(PERF|READY|PREWARM)/, { max: 100 })) console.log(line);
  if (r.timedOut) console.error(`timed out after ${timeoutSec}s; the process this script started (pid ${r.pid}) was stopped`);
  if (!fs.existsSync(report)) {
    console.log(`GAM3PERF: FAILED scenario=${scenario} reason=no-report exit=${r.code} log=${logFile}`);
    return 1;
  }
  const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
  const v = judge(rep, { budgetMs, firstUseMs, baseline, tolerance, floorMs });
  Object.assign(rep, { name, alone: !a.shared, first_use_ms_allowed: firstUseMs, ambient_ms: v.ambient, subjects: v.subjects, verdict: { ok: v.ok, reasons: v.reasons, baseline: v.baseline, baseline_name: a.baseline || null } });
  fs.writeFileSync(report, JSON.stringify(rep, null, 1) + '\n');
  for (const s of v.subjects) console.log(`subject ${s.name}: first_use_ms=${f(s.first_use_ms)} warm_ms=${f(s.warm_ms)} steady_ms=${f(s.steady_ms)} ${s.ok ? 'ok' : 'FIRST-USE HITCH'}`);
  for (const s of rep.segments.filter((x) => x.label !== 'gap' && x.label !== 'idle' && rep.scenario !== 'room')) console.log(`segment ${s.label}: frames=${s.frames} avg_ms=${f(s.avg_ms)} p99_ms=${f(s.p99_ms)} max_ms=${f(s.max_ms)} hitches=${s.hitches}`);
  if (rep.scenario === 'room' && v.ambient > firstUseMs) console.log(`warning: frames of up to ${f(v.ambient)} ms happened while nothing was spawning. First-use results below that are inside the noise of this run (in a windowed player these are usually waits for the display).`);
  for (const reason of v.reasons) console.log(`reason: ${reason}`);
  if (a['save-baseline']) {
    if (!v.total.frames) console.error('nothing was measured, so no baseline was saved');
    else {
      fs.mkdirSync(baseDir, { recursive: true });
      const file = path.join(baseDir, `${a['save-baseline']}.json`);
      fs.writeFileSync(file, JSON.stringify({ scenario, player: rep.player, alone: !a.shared, unity: rep.unity, device: rep.device, quality: rep.quality, width: rep.width, height: rep.height, total: v.total, segments: rep.segments.map(({ label, frames, avg_ms, p99_ms }) => ({ label, frames, avg_ms, p99_ms })) }, null, 1) + '\n');
      console.log(`baseline saved: ${file}${a.shared ? ' (from a shared run: measure again alone before trusting it)' : ''}`);
    }
  }
  const ok = v.ok && r.code === 0 && !r.timedOut;
  console.log(`GAM3PERF: ${ok ? 'ok' : 'FAILED'} scenario=${scenario} frames=${v.total.frames} avg_ms=${f(v.total.avg_ms)} p99_ms=${f(v.total.p99_ms)} fps=${v.total.avg_ms > 0 ? f(1000 / v.total.avg_ms) : 0} hitches=${v.total.hitches} subjects=${v.subjects.length} first_use_fail=${v.firstUseFail.join(',') || 0} baseline=${v.baseline} over_budget=${v.overBudget.join(',') || 0} ambient_ms=${f(v.ambient)} prewarm=${rep.prewarm ? 'yes' : 'no'} player=${rep.player ? 'yes' : 'no'} alone=${a.shared ? 'no' : 'yes'} ${r.seconds.toFixed(1)}s report=${report}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e?.message || String(e)); console.log('GAM3PERF: FAILED reason=setup'); process.exitCode = 2; });
}
