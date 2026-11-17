#!/usr/bin/env node
// Run the game unattended (`-game`, no editor UI), then report what the log says went wrong.
//   node Tools/gam3/ue_game.mjs [--profile blind|agent|human] [--map /Game/Maps/L_Level] [--res 1920x1080]
//                               [--shots 0,5] [--quit 8] [--prefix name] [--cam "X,Y,Z,Pitch,Yaw[,FOV]"]
//                               [--ready-timeout 600] [--timeout 300] [--log FILE] [-- extra engine args]
// --profile is how much of the engine the run needs (see PROFILES in ue_env.mjs): blind has no renderer and cannot
// capture, agent is a small cheap picture on a fixed time step, human (the default) is what a player gets.
// --shots, --quit, --prefix and --cam need the shot-director kit in the project: they become -Gam3Shots=,
// -Gam3Quit=, -Gam3ShotPrefix= and -Gam3Cam=, and screenshots land in Saved/Screenshots/<prefix>_NN.png.
// Times count from the moment the level is READY (ready-gate kit), in game seconds: 0 is the first frame a player
// sees. A run whose level never became ready, or that showed a character in its bind pose, is reported FAILED:
// its captures are pictures of a level that was still loading. Late compiles and hitches after ready are printed.
// Without --quit (or code of your own that exits) the game runs until --timeout stops it.
// Lighting and materials can only be judged here: editor viewport captures render differently from the game, and a
// material that failed to compile draws flat grey with the only notice in this log.
import fs from 'node:fs';
import path from 'node:path';
import { gameArgs, grepLines, logProblems, normalizeMap, parseArgs, profile, readiness, readLog, runMain, runUnreal, ueConfig } from './ue_env.mjs';

async function main(argv) {
  const a = parseArgs(argv, { options: ['map', 'res', 'timeout', 'log', 'shots', 'quit', 'prefix', 'cam', 'grep', 'profile', 'ready-timeout'] });
  const cfg = ueConfig();
  const prof = profile(a.profile);
  if (a.shots && !prof.captures) throw new Error('--profile blind has no renderer, so it cannot take --shots. Use --profile agent.');
  const [resx, resy] = a.res ? String(a.res).split('x').map(Number) : prof.res;
  const prefix = a.prefix || 'shot';
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error(`invalid --prefix: ${prefix}`);
  // Wait for a first run's shader compile instead of capturing through it; watch for what a player would have seen.
  const args = [...prof.args, `-Gam3ReadyTimeout=${Number(a['ready-timeout'] ?? 600)}`, '-Gam3Watch', ...a.rest];
  if (a.shots) args.push(`-Gam3Shots=${a.shots}`, `-Gam3ShotPrefix=${prefix}`);
  if (a.quit) args.push(`-Gam3Quit=${Number(a.quit)}`);
  if (a.cam) args.push(`-Gam3Cam=${a.cam}`);
  const log = a.log ? path.resolve(a.log) : path.join(cfg.logDir, `game_${prefix}.log`);
  const shotsDir = path.join(cfg.proj, 'Saved', 'Screenshots');
  const mine = (n) => n.startsWith(`${prefix}_`) && n.endsWith('.png');
  if (a.shots) {
    try { for (const n of fs.readdirSync(shotsDir).filter(mine)) fs.rmSync(path.join(shotsDir, n)); } catch { /* none yet */ }
  }
  const timeoutSec = Number(a.timeout ?? (a.quit ? Number(a.quit) + 240 : 300) + Number(a['ready-timeout'] ?? 0));
  const r = await runUnreal(cfg, cfg.editor, gameArgs(cfg, { map: a.map && normalizeMap(a.map), resx, resy, args, execCmds: prof.cmds, logFile: log }), { logFile: log, timeoutSec, exitGraceSec: 30, label: 'ue_game' });
  const text = readLog(log);
  const problems = logProblems(text);
  if (a.grep) console.log(grepLines(text, new RegExp(a.grep), { max: 80 }).join('\n'));
  for (const [kind, lines] of Object.entries(problems)) for (const l of lines) console.log(`${kind}: ${l}`);
  let shots = [];
  if (a.shots) { try { shots = fs.readdirSync(shotsDir).filter(mine).sort().map((n) => path.join(shotsDir, n)); } catch { /* none */ } }
  for (const s of shots) console.log(s);
  const wanted = a.shots ? String(a.shots).split(',').length : 0;
  const rd = readiness(text);
  for (const l of rd.bindPose) console.log(`bind-pose: ${l}`);
  for (const l of rd.hitches) console.log(`after-ready: ${l}`);
  if (rd.lateCompile) console.log(`after-ready: something was still compiling after the level was declared ready (${rd.lateCompile} log lines). In an uncooked run this is usually a material first seen late; a player of a packaged build would see a hitch or a default-grey surface.`);
  if (rd.ready !== 'ok' && rd.line) console.log(rd.line);
  // Captures only count when the level was ready. Without the ready-gate kit there is no way to know: say so.
  const readyOk = rd.ready === 'ok' || (rd.ready === 'none' && !wanted);
  const ok = !problems.material.length && !problems.fatal.length && shots.length >= wanted && r.killedBy !== 'timeout' && readyOk && !rd.bindPose.length;
  console.log(`GAM3GAME: ${ok ? 'ok' : 'FAILED'} ${r.seconds.toFixed(1)}s profile=${prof.name} ready=${rd.ready} shots=${shots.length}/${wanted} bind_pose=${rd.bindPose.length} hitches=${rd.hitches.length} late_compile=${rd.lateCompile} material_errors=${problems.material.length} fatal=${problems.fatal.length}${r.killedBy ? ` stopped=${r.killedBy}` : ''}${r.slept ? ` slept=${r.slept}s` : ''} log=${log}`);
  return ok ? 0 : 1;
}

runMain(import.meta.url, main);
