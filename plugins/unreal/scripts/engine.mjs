// Unreal Engine adapter: find the project, report on the setup, detect kit params. Read-only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'unreal';
export const label = 'Unreal Engine';
export const projectHint = 'a directory with a .uproject file';

const SKIP = new Set(['node_modules', 'Saved', 'Intermediate', 'Binaries', 'DerivedDataCache', 'Content', '.git']);

function uprojectIn(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.uproject')).sort()[0] || null; } catch { return null; }
}

/** The project directory: walk up from `start`, then look one level down (a repo that keeps it in unreal/). */
export function findProject(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (uprojectIn(dir)) return dir;
    if (dir === path.dirname(dir)) break;
  }
  try {
    for (const e of fs.readdirSync(start, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.') && uprojectIn(path.join(start, e.name))) return path.join(start, e.name);
    }
  } catch { /* unreadable */ }
  return null;
}

function readUproject(project) {
  const file = uprojectIn(project);
  try { return { file, data: JSON.parse(fs.readFileSync(path.join(project, file), 'utf8')) }; } catch { return { file, data: {} }; }
}

const INSTALL_ROOTS = {
  darwin: ['/Users/Shared/Epic Games'],
  win32: ['C:\\Program Files\\Epic Games'],
  linux: ['/opt/UnrealEngine', path.join(process.env.HOME || '', 'UnrealEngine')],
};

/** Engine root for the project: UE_ROOT, else the launcher install matching EngineAssociation, else the newest one. */
export function engineRoot(association, env = process.env, platform = process.platform) {
  if (env.UE_ROOT) return { root: env.UE_ROOT, from: 'UE_ROOT' };
  const found = [];
  for (const base of INSTALL_ROOTS[platform] || []) {
    try {
      for (const d of fs.readdirSync(base)) if (/^UE_\d+\.\d+/.test(d)) found.push(path.join(base, d));
    } catch { /* not installed here */ }
  }
  const exact = found.find((d) => path.basename(d) === `UE_${association}`);
  if (exact) return { root: exact, from: `EngineAssociation ${association}` };
  const version = (d) => path.basename(d).slice(3).split('.').map(Number);
  found.sort((a, b) => version(b)[0] - version(a)[0] || version(b)[1] - version(a)[1]);
  return found.length ? { root: found[0], from: 'newest installed' } : { root: null, from: 'not found' };
}

export function editorBinary(root, platform = process.platform) {
  if (!root) return null;
  const bin = path.join(root, 'Engine', 'Binaries');
  if (platform === 'win32') return path.join(bin, 'Win64', 'UnrealEditor.exe');
  if (platform === 'darwin') return path.join(bin, 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor');
  return path.join(bin, 'Linux', 'UnrealEditor');
}

function editorsOnProject(project) {
  if (process.platform === 'win32') return null;   // command lines need a slower query on Windows; not checked here
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((l) => /UnrealEditor/.test(l) && l.includes(project) && !/CrashReportClient/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

export function detectParams(project) {
  const { file, data } = readUproject(project);
  const out = {};
  if (file) out.PROJECT = path.basename(file, '.uproject');
  const module = (data.Modules || []).find((m) => m.Type === 'Runtime') || (data.Modules || [])[0];
  if (module?.Name) {
    out.MODULE = module.Name;
    out.MODULE_API = `${module.Name.toUpperCase()}_API`;
  }
  return out;
}

export function doctor(project) {
  const checks = [];
  const add = (n, ok, detail, warn = false) => checks.push({ name: n, ok, detail, ...(warn ? { warn: true } : {}) });
  if (!project) {
    add('project', false, `no .uproject found (${projectHint})`);
    return { project: null, checks };
  }
  const { file, data } = readUproject(project);
  add('project', true, path.join(project, file));
  const association = String(data.EngineAssociation || '');
  const engine = engineRoot(association);
  const editor = editorBinary(engine.root);
  add('engine', !!engine.root && fs.existsSync(editor), engine.root ? `${engine.root} (${engine.from})` : 'no engine install found; set UE_ROOT');
  const params = detectParams(project);
  add('c++ module', !!params.MODULE, params.MODULE ? `${params.MODULE} (kits with C++ source join it)` : 'none: a project without C++ project cannot take C++ kits until a module is added', !params.MODULE);
  if (engine.root) {
    const mcp = path.join(engine.root, 'Engine', 'Plugins', 'Experimental', 'ModelContextProtocol', 'ModelContextProtocol.uplugin');
    add('editor MCP plugin', fs.existsSync(mcp), fs.existsSync(mcp) ? 'ships with this engine (experimental); the editor-bridge kit uses it' : 'not in this engine: the editor-bridge kit needs UE 5.8 or newer', !fs.existsSync(mcp));
  }
  const enabled = (data.Plugins || []).filter((p) => p.Enabled).map((p) => p.Name);
  const world = ['PCG', 'ProceduralVegetationEditor', 'Landmass', 'LandscapePatch', 'Water'];
  add('world plugins', true, `enabled: ${world.filter((p) => enabled.includes(p)).join(', ') || 'none'}; not enabled: ${world.filter((p) => !enabled.includes(p)).join(', ') || 'none'}`);
  const pids = editorsOnProject(project);
  if (pids) add('editor running', true, pids.length ? `pid ${pids.join(', ')} has this project open: do not compile C++ until it is closed` : 'no editor has this project open', pids.length > 0);
  return { project, uproject: file, engine_association: association, engine_root: engine.root, params, checks };
}
