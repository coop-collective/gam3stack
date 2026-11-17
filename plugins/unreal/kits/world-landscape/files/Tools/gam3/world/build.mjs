#!/usr/bin/env node
// One command to build the world in layout.py inside the open editor: build, wait for the scatter, save, report.
//   node Tools/gam3/ue_editor.mjs start            (once)
//   node Tools/gam3/world/build.mjs [--stages terrain,look,scatter] [--no-save] [--port 8123]
// Then look at it in the game, not the editor (editor captures render darker than the game):
//   node Tools/gam3/ue_game.mjs --map <MAP> --shots 6 --quit 8 --cam X,Y,Z,Pitch,Yaw      (needs the shot-director kit)
// Prints `GAM3WORLD: ok ...` or `GAM3WORLD: FAILED ...`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPython } from '../ue_mcp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stage(stages, port) {
  // The MCP Python tool wants imports at the top level of the script it is given, and returns the value of the
  // last expression. A file run through exec() cannot return anything, so it leaves RESULT in the globals.
  const code = [
    'import os',
    `os.environ["GAM3_WORLD_STAGES"] = ${JSON.stringify(stages)}`,
    `exec(compile(open(${JSON.stringify(path.join(here, 'build_world.py'))}, encoding="utf-8").read(), "build_world.py", "exec"))`,
    'RESULT',
  ].join('\n');
  const r = await runPython(code, { port });
  let out = r.out;
  if (out && typeof out === 'object' && 'result' in out && Object.keys(out).length <= 3) out = out.result;
  if (typeof out === 'string') { try { out = JSON.parse(out); } catch { /* leave as text */ } }
  if (r.isError || !out || typeof out !== 'object' || out.error) {
    throw new Error(out?.error || (typeof out === 'string' ? out : JSON.stringify(r.out)));
  }
  return out;
}

async function main(argv) {
  const opt = { stages: 'terrain,look,scatter', save: true, port: process.env.UE_MCP_PORT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stages') opt.stages = argv[++i];
    else if (argv[i] === '--port') opt.port = argv[++i];
    else if (argv[i] === '--no-save') opt.save = false;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  const t0 = Date.now();
  const built = await stage(opt.stages, opt.port);
  for (const n of built.notes || []) console.log(`note: ${n}`);
  for (const k of ['terrain', 'look', 'scatter']) if (built[k]) console.log(`${k}: ${JSON.stringify(built[k])}`);
  let st = built.status;
  if (built.scatter?.generating) {
    // Scatter generation runs on later editor frames. It is done when the instance count stops changing.
    let same = 0;
    for (let i = 0; i < 120 && same < 2; i++) {
      await sleep(5000);
      const next = (await stage('status', opt.port)).status;
      same = next.scatter_instances === st.scatter_instances && next.scatter_instances > 0 ? same + 1 : 0;
      st = next;
    }
    if (!st.scatter_instances) console.log('note: the scatter made no instances. Check the "where" ranges and the mesh paths in layout.py.');
  }
  let saved = 'skipped';
  if (opt.save) saved = String((await stage('save', opt.port)).saved);
  const ok = !opt.save || saved === 'true';
  console.log(`GAM3WORLD: ${ok ? 'ok' : 'FAILED'} map=${st.map} actors=${st.actors} scatter_instances=${st.scatter_instances} saved=${saved} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return ok ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.log(`GAM3WORLD: FAILED ${String(e?.message || e).trim()}`);
  process.exit(1);
});
