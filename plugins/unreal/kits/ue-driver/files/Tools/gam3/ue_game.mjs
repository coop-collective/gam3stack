#!/usr/bin/env node
// Run the game unattended (`-game`, no editor UI), then report what the log says went wrong.
//   node Tools/gam3/ue_game.mjs [--map /Game/Maps/L_Level] [--res 1920x1080] [--timeout 120] [--log FILE]
//                               [--shots 5,9] [--quit 12] [--prefix name] [--cam "X Y Z Pitch Yaw [FOV]"] [-- extra engine args]
// --shots, --quit, --prefix and --cam need the shot-director kit in the project: they become -Gam3Shots=,
// -Gam3Quit=, -Gam3ShotPrefix= and -Gam3Cam=, and screenshots land in Saved/Screenshots/<prefix>_NN.png.
// Without --quit (or code of your own that exits) the game runs until --timeout stops it.
// Lighting and materials can only be judged here: editor viewport captures render differently from the game, and a
// material that failed to compile draws flat grey with the only notice in this log.
import fs from 'node:fs';
import path from 'node:path';
import { gameArgs, grepLines, logProblems, normalizeMap, parseArgs, readLog, runMain, runUnreal, ueConfig } from './ue_env.mjs';

async function main(argv) {
  const a = parseArgs(argv, { options: ['map', 'res', 'timeout', 'log', 'shots', 'quit', 'prefix', 'cam', 'grep'] });
  const cfg = ueConfig();
  const [resx, resy] = String(a.res || '1920x1080').split('x').map(Number);
  const prefix = a.prefix || 'shot';
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error(`invalid --prefix: ${prefix}`);
  const args = [...a.rest];
  if (a.shots) args.push(`-Gam3Shots=${a.shots}`, `-Gam3ShotPrefix=${prefix}`);
  if (a.quit) args.push(`-Gam3Quit=${Number(a.quit)}`);
  if (a.cam) args.push(`-Gam3Cam=${a.cam}`);
  const log = a.log ? path.resolve(a.log) : path.join(cfg.logDir, `game_${prefix}.log`);
  const shotsDir = path.join(cfg.proj, 'Saved', 'Screenshots');
  const mine = (n) => n.startsWith(`${prefix}_`) && n.endsWith('.png');
  if (a.shots) {
    try { for (const n of fs.readdirSync(shotsDir).filter(mine)) fs.rmSync(path.join(shotsDir, n)); } catch { /* none yet */ }
  }
  const timeoutSec = Number(a.timeout ?? (a.quit ? Number(a.quit) + 240 : 300));
  const r = await runUnreal(cfg, cfg.editor, gameArgs(cfg, { map: a.map && normalizeMap(a.map), resx, resy, args, logFile: log }), { logFile: log, timeoutSec, exitGraceSec: 30, label: 'ue_game' });
  const text = readLog(log);
  const problems = logProblems(text);
  if (a.grep) console.log(grepLines(text, new RegExp(a.grep), { max: 80 }).join('\n'));
  for (const [kind, lines] of Object.entries(problems)) for (const l of lines) console.log(`${kind}: ${l}`);
  let shots = [];
  try { shots = fs.readdirSync(shotsDir).filter(mine).sort().map((n) => path.join(shotsDir, n)); } catch { /* none */ }
  for (const s of shots) console.log(s);
  const wanted = a.shots ? String(a.shots).split(',').length : 0;
  const ok = !problems.material.length && !problems.fatal.length && shots.length >= wanted && r.killedBy !== 'timeout';
  console.log(`GAM3GAME: ${ok ? 'ok' : 'FAILED'} ${r.seconds.toFixed(1)}s shots=${shots.length}/${wanted} material_errors=${problems.material.length} fatal=${problems.fatal.length}${r.killedBy ? ` stopped=${r.killedBy}` : ''} log=${log}`);
  return ok ? 0 : 1;
}

runMain(import.meta.url, main);
