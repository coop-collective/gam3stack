#!/usr/bin/env node
// Measure the game in parts, at full quality and in real time, and compare with a budget and a saved baseline.
//   node Tools/gam3/ue_perf.mjs --scenario room|flyby|play [--data Tools/gam3/perf.json] [--map /Game/Maps/L_Level]
//        [--name NAME] [--prewarm] [--seconds 30] [--bot wander] [--budget-ms 16.7] [--first-use-ms 8]
//        [--hitch-ms 50] [--max-hitches N] [--save-baseline NAME] [--baseline NAME] [--regress-pct 10]
//        [--res 1920x1080] [--shared] [--timeout 900] [-- extra engine args]
// Scenarios (needs the perf-pass source in the game module):
//   room    every subject in the data file's "room" list is spawned alone in front of a fixed camera, cold and then
//           warm. A subject whose first use (loading it, plus its first second on screen) costs more than its second
//           by over --first-use-ms FAILS by name: that is the hitch a player gets the first time it appears. --prewarm runs the same test with the game's
//           prewarm applied, which is how a fix is proved.
//   flyby   the camera moves through the data file's "flyby" points; one line per leg.
//   play    the game plays itself for --seconds (your demo mode after `--`, or --bot with the walk-bot kit);
//           frames are grouped by the labels the game sets with UGam3PerfProbe::Mark.
// A performance run must be alone on the machine: it waits until no other engine is running and holds every engine
// slot while it runs. --shared skips that; the numbers are then only good for finding hitches, and the line says so.
// Vsync is off where the platform allows it; a windowed game on macOS is still locked to the display, and the
// summary says so (display_cap=). These are uncooked-run numbers: compare them with each other, and take the
// number you promise players from a packaged build.
// Reports: Saved/gam3-perf/<name>.json. Baselines: Saved/gam3-perf/baselines/<NAME>.json (this machine only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireSlot, enginesRunning, slotsInUse } from './slots.mjs';
import { gameArgs, logProblems, normalizeMap, parseArgs, readiness, readLog, runMain, runUnreal, sleep, ueConfig } from './ue_env.mjs';

const num = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');

/** Wait until no engine runs and nobody holds a slot, then hold all slots but one (the run itself takes the last). */
async function alone() {
  const cap = Math.max(1, Number(process.env.GAM3_MAX_ENGINES) || 3);
  const deadline = Date.now() + (Number(process.env.GAM3_SLOT_WAIT) || 1800) * 1000;
  let told = 0;
  for (;;) {
    const busy = Math.max(slotsInUse().length, enginesRunning().length);
    if (!busy) break;
    if (Date.now() > deadline) throw new Error(`still ${busy} other engine(s) running: a performance run must be alone. Stop them, or pass --shared for hitch-finding only.`);
    if (Date.now() - told > 60000) { told = Date.now(); console.error(`ue_perf: waiting to be alone on the machine (${busy} engine(s) running)`); }
    await sleep(2000);
  }
  const held = [];
  for (let i = 0; i < cap - 1; i++) held.push(await acquireSlot({ label: 'ue_perf (keeping the machine quiet)', max: cap, quiet: true, countEngines: false }));
  return () => held.forEach((s) => s.release());
}

/** Compare a report with a baseline by label. Returns the lines that regressed. */
export function regressions(report, base, pct) {
  const out = [];
  const old = new Map((base.segments || []).map((s) => [s.label, s]));
  for (const s of report.segments || []) {
    const b = old.get(s.label);
    if (!b) continue;
    for (const [key, floor] of [['avg_ms', 0.5], ['p99_ms', 1], ['game_ms', 0.5], ['gpu_ms', 0.5]]) {
      if (s[key] > b[key] * (1 + pct / 100) && s[key] - b[key] > floor) out.push(`${s.label}: ${key} ${num(b[key])} -> ${num(s[key])}`);
    }
  }
  return out;
}

/**
 * The display rate the run was locked to, or 0. A windowed game on macOS always presents in step with the display,
 * so its frame time never drops below one refresh however little work a frame is. The frame time and the render
 * thread's time then say nothing below that; the game thread's and the GPU's times still do.
 */
export function displayCap(report) {
  const all = (report.segments || []).filter((s) => s.frames >= 30);
  if (!all.length) return 0;
  const p50 = all.map((s) => s.p50_ms).sort((x, y) => x - y)[Math.floor(all.length / 2)];
  return [240, 165, 144, 120, 90, 75, 60, 30].find((hz) => Math.abs(p50 - 1000 / hz) < 0.035 * (1000 / hz)) || 0;
}

/** What the first use of a subject costs over a later use: loading it, plus the extra in its first second on screen. */
export const firstUseCost = (s) => s.load_ms + Math.max(0, s.first_use_ms - s.warm_ms);

/** What a report says, against the limits. Pure, so it can be tested without an engine. */
export function judge(report, { budgetMs = 16.7, firstUseMs = 8, maxHitches = Infinity } = {}) {
  const segments = report.segments || [];
  const frames = segments.reduce((n, s) => n + s.frames, 0);
  const avg = frames ? segments.reduce((n, s) => n + s.avg_ms * s.frames, 0) / frames : NaN;
  const p99 = segments.length ? Math.max(...segments.map((s) => s.p99_ms)) : NaN;
  const subjects = report.subjects || [];
  const firstUse = subjects.filter((s) => s.missing || firstUseCost(s) > firstUseMs).map((s) => s.label);
  const overBudget = segments.filter((s) => s.avg_ms > budgetMs).map((s) => s.label);
  const hitches = (report.hitches || []).length;
  return {
    frames, avg, p99, firstUse, overBudget, hitches,
    lateCompile: subjects.filter((s) => s.late_compile).map((s) => s.label),
    // Counted, not timed: the one first-use measure a busy machine cannot spoil.
    coldStates: subjects.reduce((n, s) => n + (s.pipeline_states || 0), 0),
    ok: frames > 0 && !firstUse.length && !overBudget.length && hitches <= maxHitches,
  };
}

async function main(argv) {
  const a = parseArgs(argv, {
    flags: ['prewarm', 'shared'],
    options: ['scenario', 'data', 'map', 'name', 'res', 'budget-ms', 'first-use-ms', 'seconds', 'bot', 'seed', 'hitch-ms', 'max-hitches', 'save-baseline', 'baseline', 'regress-pct', 'timeout'],
  });
  const cfg = ueConfig();
  const scenario = a.scenario || 'room';
  if (!['room', 'flyby', 'play'].includes(scenario)) throw new Error(`unknown --scenario ${scenario} (room, flyby or play)`);
  const name = a.name || scenario;
  for (const [flag, v] of [['--name', name], ['--save-baseline', a['save-baseline']], ['--baseline', a.baseline]]) {
    if (v !== undefined && !/^[A-Za-z0-9_-]+$/.test(v)) throw new Error(`invalid ${flag}: ${v}`);
  }
  const budgetMs = Number(a['budget-ms'] ?? 16.7);
  const firstUseMs = Number(a['first-use-ms'] ?? 8);
  const hitchMs = Number(a['hitch-ms'] ?? Math.max(50, budgetMs * 3));
  const seconds = Number(a.seconds ?? 30);
  const outDir = path.join(cfg.proj, 'Saved', 'gam3-perf');
  const baseDir = path.join(outDir, 'baselines');
  fs.mkdirSync(baseDir, { recursive: true });

  let data = {};
  const dataPath = a.data ? path.resolve(a.data) : path.join(cfg.proj, 'Tools', 'gam3', 'perf.json');
  if (scenario !== 'play' || a.data) {
    if (!fs.existsSync(dataPath)) throw new Error(`no data file at ${dataPath}: copy Tools/gam3/perf.example.json to perf.json and list your subjects and points`);
    data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (scenario === 'room' && !data.room?.subjects?.length) throw new Error(`${dataPath} has no room.subjects`);
    if (scenario === 'flyby' && !(data.flyby?.points?.length >= 2)) throw new Error(`${dataPath} needs at least two flyby.points`);
  }
  // The engine reads the data from inside the project, by a relative path: no spaces or quoting to get wrong.
  const dataRel = `Saved/gam3-perf/_data_${name}.json`;
  fs.writeFileSync(path.join(cfg.proj, dataRel), JSON.stringify(data));
  const map = a.map || data[scenario]?.map || (scenario === 'room' ? '/Engine/Maps/Entry' : undefined);
  const [resx, resy] = a.res ? String(a.res).split('x').map(Number) : [1920, 1080];

  const args = ['-Gam3ReadyTimeout=600', `-Gam3Perf=${scenario}`, `-Gam3PerfData=${dataRel}`, `-Gam3PerfName=${name}`, `-Gam3PerfSeconds=${seconds}`, `-Gam3PerfHitchMs=${hitchMs}`];
  if (a.prewarm) args.push('-Gam3PerfPrewarm');
  if (a.bot) {
    if (!/^[a-z]+$/.test(a.bot)) throw new Error(`invalid --bot: ${a.bot}`);
    args.push(`-Gam3Bot=${a.bot}`, `-Gam3BotSeed=${Number(a.seed ?? 1)}`);   // no bot time limit: the probe ends the run
  }
  args.push(...a.rest);

  const report = path.join(outDir, `${name}.json`);
  fs.rmSync(report, { force: true });
  const log = path.join(cfg.logDir, `perf_${name}.log`);
  const release = a.shared ? () => {} : await alone();
  // Other work on the machine (a build, another program) skews every number, and no engine slot can see it.
  const load = () => (process.platform === 'win32' ? NaN : os.loadavg()[0] / os.cpus().length);
  const loadBefore = load();
  let r;
  try {
    r = await runUnreal(cfg, cfg.editor, gameArgs(cfg, { map: map && normalizeMap(map), resx, resy, args, execCmds: ['r.VSync 0', 't.MaxFPS 0'], logFile: log }),
      { logFile: log, timeoutSec: Number(a.timeout ?? 900), exitGraceSec: 30, label: 'ue_perf' });
  } finally { release(); }

  const text = readLog(log);
  const problems = logProblems(text);
  const rd = readiness(text);
  for (const [kind, lines] of Object.entries(problems)) for (const l of lines) console.log(`${kind}: ${l}`);
  for (const l of text.split(/\r?\n/).filter((x) => /GAM3WARM: |GAM3PERF: (missing|cannot|WRITE)|GAM3WALK: /.test(x))) console.log(l.replace(/^.*(GAM3(WARM|PERF|WALK): )/, '$1'));
  if (rd.ready !== 'ok' && rd.line) console.log(rd.line);
  if (!fs.existsSync(report)) {
    console.log(`GAM3PERF: FAILED scenario=${scenario} no report was written (is the perf-pass source compiled into the game? did the level become ready?) ready=${rd.ready}${r.killedBy ? ` stopped=${r.killedBy}` : ''} log=${log}`);
    return 1;
  }
  const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
  const j = judge(rep, { budgetMs, firstUseMs, maxHitches: a['max-hitches'] === undefined ? Infinity : Number(a['max-hitches']) });

  console.log('segment                      frames   avg    p50    p99    max   game  render   gpu  (ms)');
  for (const s of rep.segments) {
    console.log(`${s.label.padEnd(28).slice(0, 28)} ${String(s.frames).padStart(6)} ${[s.avg_ms, s.p50_ms, s.p99_ms, s.max_ms, s.game_ms, s.render_ms, s.gpu_ms].map((v) => num(v).padStart(6)).join(' ')}${s.avg_ms > budgetMs ? '  OVER BUDGET' : ''}`);
  }
  if (rep.subjects?.length) {
    console.log('subject                      load  first-use   warm  steady  (ms)');
    for (const s of rep.subjects) {
      const verdict = s.missing ? '  MISSING' : firstUseCost(s) > firstUseMs ? `  FIRST-USE HITCH +${num(firstUseCost(s))}` : '';
      console.log(`${s.label.padEnd(28).slice(0, 28)} ${num(s.load_ms).padStart(5)} ${num(s.first_use_ms).padStart(10)} ${num(s.warm_ms).padStart(6)} ${num(s.steady_ms).padStart(7)}${verdict}${s.late_compile ? '  (still compiling when shown)' : ''}${s.pipeline_states || s.packages ? `  [first use: ${s.pipeline_states || 0} pipeline states, ${s.packages || 0} packages]` : ''}`);
    }
  }
  for (const h of (rep.hitches || []).slice(0, 20)) console.log(`hitch: ${num(h.ms)} ms at ${num(h.at_s)}s during "${h.label}" camera=(${h.where})${h.cause ? ` cause: ${h.cause}` : ''}`);

  let baseline = 'none';
  if (a.baseline) {
    const file = path.join(baseDir, `${a.baseline}.json`);
    if (!fs.existsSync(file)) throw new Error(`no baseline ${a.baseline}: save one first with --save-baseline ${a.baseline}`);
    const worse = regressions(rep, JSON.parse(fs.readFileSync(file, 'utf8')), Number(a['regress-pct'] ?? 10));
    for (const l of worse) console.log(`regressed: ${l}`);
    baseline = worse.length ? 'regressed' : 'ok';
  }
  const busy = Math.max(loadBefore, load());
  if (busy > 0.7) console.log(`note: the machine was busy with other work during this run (load ${busy.toFixed(1)} per core). Frame times and first-use numbers are not trustworthy; run again when it is quiet.`);
  const cap = displayCap(rep);
  if (cap) console.log(`note: frames were locked to the display (${cap} Hz), so frame time and render-thread time have a floor of ${num(1000 / cap)} ms. Below that, read the game and gpu columns; baselines compare those too.`);
  const ok = j.ok && baseline !== 'regressed' && rd.ready !== 'timeout' && !problems.fatal.length && r.killedBy !== 'timeout';
  if (a['save-baseline'] && ok) fs.copyFileSync(report, path.join(baseDir, `${a['save-baseline']}.json`));
  if (a['save-baseline'] && !ok) console.log('baseline not saved: the run failed');
  const list = (v) => (v.length ? v.join(',').replace(/\s+/g, '_') : '0');
  console.log(`GAM3PERF: ${ok ? 'ok' : 'FAILED'} scenario=${scenario} frames=${j.frames} avg_ms=${num(j.avg)} p99_ms=${num(j.p99)} fps=${num(1000 / j.avg)} hitches=${j.hitches} subjects=${rep.subjects?.length || 0} first_use_fail=${list(j.firstUse)} over_budget=${list(j.overBudget)} late_compile=${list(j.lateCompile)} first_use_pipeline_states=${j.coldStates} baseline=${baseline} display_cap=${cap || 'none'} machine_load=${Number.isFinite(busy) ? busy.toFixed(1) : '?'} exclusive=${a.shared ? 'no' : 'yes'} ready=${rd.ready} res=${rep.resolution || '?'}${r.killedBy ? ` stopped=${r.killedBy}` : ''}${r.slept ? ` slept=${r.slept}s` : ''} report=${report}`);
  return ok ? 0 : 1;
}

runMain(import.meta.url, main);
