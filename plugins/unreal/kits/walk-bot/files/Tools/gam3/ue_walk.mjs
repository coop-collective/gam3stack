#!/usr/bin/env node
// Let a bot play the player's pawn, and report what a tester walking around would have found.
//   node Tools/gam3/ue_walk.mjs [--map L_Level] [--mode wander|route] [--seed 1] [--seconds 60]
//                               [--route "x,y,z;x,y,z" | --route FILE] [--profile blind|agent|human]
//                               [--replay] [--shots-at-incidents] [--prefix walk] [--input movement]
//                               [--floor-z Z] [--timeout 600] [--log FILE] [-- extra engine args]
// The default profile is blind: no renderer, a fixed time step, game time as fast as the machine computes it.
// That is what makes minutes of walking cost seconds. Runs on a fixed step repeat exactly: the same seed walks
// the same path. So when a blind run reports an incident, run it again with --replay (the same options plus
// --replay): the agent profile and a picture at each incident, Saved/Screenshots/<prefix>_NN_<kind>.png.
// --seconds are game seconds after the level is ready. --route takes waypoints inline or a file with one
// "x,y,z" per line; a route that is not walked to its end fails the run.
// Exit status is 0 only when the bot finished and nothing was found.
import fs from 'node:fs';
import path from 'node:path';
import { gameArgs, grepLines, logProblems, normalizeMap, parseArgs, profile, readiness, readLog, runMain, runUnreal, ueConfig } from './ue_env.mjs';

const KINDS = ['stuck', 'fell', 'slide', 'speed', 'nan', 'camera_inside'];

/** The bot's own result line as a map of its key=value fields, or null when the bot never finished. */
export function parseDone(text) {
  const line = grepLines(text, /GAM3WALK: done /).pop();
  if (!line) return null;
  const out = {};
  for (const m of line.replace(/^.*GAM3WALK: done /, '').matchAll(/([A-Za-z_-]+)=(\([^)]*\)|\S+)/g)) out[m[1]] = m[2];
  return out;
}

async function main(argv) {
  const a = parseArgs(argv, {
    flags: ['replay', 'shots-at-incidents'],
    options: ['map', 'mode', 'seed', 'seconds', 'route', 'profile', 'prefix', 'input', 'floor-z', 'timeout', 'log', 'res', 'ready-timeout', 'move-action', 'jump-action'],
  });
  const cfg = ueConfig();
  const prof = profile(a.profile || (a.replay ? 'agent' : 'blind'));
  const pictures = !!(a.replay || a['shots-at-incidents']);
  if (pictures && !prof.captures) throw new Error('--profile blind has no renderer, so it cannot take pictures. Use --replay, or --profile agent.');
  const mode = a.mode || (a.route ? 'route' : 'wander');
  if (!['wander', 'route'].includes(mode)) throw new Error(`unknown --mode ${mode} (wander or route)`);
  if (mode === 'route' && !a.route) throw new Error('--mode route needs --route');
  const seed = Number(a.seed ?? 1);
  const seconds = Number(a.seconds ?? 60);
  if (!Number.isInteger(seed) || !(seconds > 0)) throw new Error('--seed must be a whole number and --seconds above 0');
  const prefix = a.prefix || 'walk';
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error(`invalid --prefix: ${prefix}`);
  for (const k of ['move-action', 'jump-action']) if (a[k] && !/^[A-Za-z0-9_]+$/.test(a[k])) throw new Error(`invalid --${k}: ${a[k]}`);

  const args = [...prof.args, `-Gam3ReadyTimeout=${Number(a['ready-timeout'] ?? 600)}`, `-Gam3Bot=${mode}`, `-Gam3BotSeed=${seed}`, `-Gam3BotSeconds=${seconds}`, ...a.rest];
  if (a.route) {
    if (fs.existsSync(a.route)) args.push(`-Gam3BotRouteFile=${path.resolve(a.route)}`);
    else if (/^[-0-9.,; ]+$/.test(a.route)) args.push(`-Gam3BotRoute=${a.route.replace(/\s+/g, '')}`);
    else throw new Error(`--route is neither a file nor waypoints "x,y,z;x,y,z": ${a.route}`);
  }
  if (a.input) {
    if (a.input !== 'movement') throw new Error('--input takes only "movement" (skip Enhanced Input)');
    args.push('-Gam3BotInput=movement');
  }
  if (a['move-action']) args.push(`-Gam3BotMoveAction=${a['move-action']}`);
  if (a['jump-action']) args.push(`-Gam3BotJumpAction=${a['jump-action']}`);
  if (a['floor-z'] !== undefined) args.push(`-Gam3BotFloorZ=${Number(a['floor-z'])}`);
  if (pictures) args.push(`-Gam3BotShots=${prefix}`);

  const [resx, resy] = a.res ? String(a.res).split('x').map(Number) : prof.res;
  const log = a.log ? path.resolve(a.log) : path.join(cfg.logDir, `walk_${prefix}_${mode}_${seed}.log`);
  const shotsDir = path.join(cfg.proj, 'Saved', 'Screenshots');
  const mine = (n) => n.startsWith(`${prefix}_`) && n.endsWith('.png');
  if (pictures) {
    try { for (const n of fs.readdirSync(shotsDir).filter(mine)) fs.rmSync(path.join(shotsDir, n)); } catch { /* none yet */ }
  }
  // Under blind the game outruns the clock; with a renderer on a fixed step it may run slower than real time.
  const timeoutSec = Number(a.timeout ?? seconds * (prof.captures ? 4 : 1) + 300) + Number(a['ready-timeout'] ?? 0);
  const r = await runUnreal(cfg, cfg.editor, gameArgs(cfg, { map: a.map && normalizeMap(a.map), resx, resy, args, execCmds: prof.cmds, logFile: log }), { logFile: log, timeoutSec, exitGraceSec: 30, label: 'ue_walk' });

  const text = readLog(log);
  const problems = logProblems(text);
  for (const l of problems.fatal) console.log(`fatal: ${l}`);
  for (const l of grepLines(text, /GAM3WALK: note /, { max: 40 })) console.log(l.replace(/^.*GAM3WALK: note /, 'note: '));
  const incidents = grepLines(text, /GAM3WALK: [a-z0-9_-]+ at=/, { max: 200 }).map((l) => l.replace(/^.*GAM3WALK: /, ''));
  for (const l of incidents) console.log(`incident: ${l}`);
  let shots = [];
  if (pictures) { try { shots = fs.readdirSync(shotsDir).filter(mine).sort().map((n) => path.join(shotsDir, n)); } catch { /* none */ } }
  for (const s of shots) console.log(s);

  const rd = readiness(text);
  if (rd.ready !== 'ok' && rd.line) console.log(rd.line);
  const done = parseDone(text);
  if (!done) console.log('the bot never finished: no "GAM3WALK: done" line. Is the walk-bot source compiled into the game, and did the level become ready?');
  const d = done || {};
  const count = (k) => Number(d[k] ?? 0);
  const found = KINDS.reduce((n, k) => n + count(k), 0) + count('other');
  const [walked, waypoints] = String(d.route || '0/0').split('/').map(Number);
  const routeOk = mode !== 'route' || (waypoints > 0 && walked === waypoints);
  if (done && !routeOk) console.log(`the route was not walked to its end: ${walked} of ${waypoints} waypoints`);
  const ok = !!done && !found && routeOk && rd.ready !== 'timeout' && !problems.fatal.length && r.killedBy !== 'timeout' && shots.length >= (pictures ? incidents.length : 0);
  const rate = done && Number(d.sim_wall_s) > 0 ? ` rate=${(Number(d.game_s) / Number(d.sim_wall_s)).toFixed(0)}x` : '';
  console.log(`GAM3WALK: ${ok ? 'ok' : 'FAILED'} mode=${mode} seed=${seed} game_s=${d.game_s ?? 0} wall_s=${r.seconds.toFixed(1)} distance_m=${d.distance_m ?? 0} ${KINDS.map((k) => `${k}=${count(k)}`).join(' ')} other=${count('other')} input=${d.input ?? 'unknown'}`
    + ` route=${d.route ?? '0/0'} end=${d.end ?? '?'} sim_wall_s=${d.sim_wall_s ?? '?'}${rate} profile=${prof.name} ready=${rd.ready} pictures=${shots.length} fatal=${problems.fatal.length}${r.killedBy ? ` stopped=${r.killedBy}` : ''}${r.slept ? ` slept=${r.slept}s` : ''} log=${log}`);
  return ok ? 0 : 1;
}

runMain(import.meta.url, main);
