// Driver library for the Unreal tools in this directory (Mac, Windows, Linux). No dependencies.
//
// The project is found from this file's location: <project>/Tools/gam3/ue_env.mjs. Tool locations come from the
// environment, else from the launcher install that matches the project's EngineAssociation:
//   UE_ROOT        engine root, for example /Users/Shared/Epic Games/UE_5.9 or C:\Program Files\Epic Games\UE_5.9
//   UE_EDITOR      UnrealEditor binary (default under UE_ROOT)
//   UE_BUILD       Build.sh / Build.bat (default under UE_ROOT/Engine/Build/BatchFiles)
//   GAM3_LOG_DIR   where logs go (default <project>/Saved/Logs/gam3)
//   GAM3_MAX_ENGINES
//                  how many engine processes may run on this machine at once (default 3). Every editor and game
//                  started here takes a slot first and waits when none is free: see slots.mjs.
//   GAM3_RENDER_OFFSCREEN=1
//                  no interactive desktop (an SSH session, a Windows service): game and editor runs add
//                  -RenderOffscreen. Without it swapchain creation fails there and the engine exits.
//
// Game runs always pass -ForceRes with -ResX/-ResY: on Windows -game otherwise clamps the size to the desktop.
// Processes are started with argument lists, never a shell string. Windows needs one exception: .bat files only
// run under cmd.exe, so their command line is built here from validated, quoted arguments.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireSlot } from './slots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The Unreal project directory. */
export const PROJ = path.resolve(here, '..', '..');

const INSTALL_ROOTS = {
  darwin: ['/Users/Shared/Epic Games'],
  win32: ['C:\\Program Files\\Epic Games'],
  linux: ['/opt/UnrealEngine', path.join(os.homedir(), 'UnrealEngine')],
};

export function findUproject(proj = PROJ) {
  const names = fs.readdirSync(proj).filter((f) => f.endsWith('.uproject')).sort();
  if (!names.length) throw new Error(`no .uproject in ${proj}: these tools expect to live in <project>/Tools/gam3`);
  return path.join(proj, names[0]);
}

function findEngineRoot(association, platform) {
  const found = [];
  for (const base of INSTALL_ROOTS[platform] || []) {
    try {
      for (const d of fs.readdirSync(base)) if (/^UE_\d+\.\d+/.test(d)) found.push(path.join(base, d));
    } catch { /* not installed here */ }
  }
  const exact = found.find((d) => path.basename(d) === `UE_${association}`);
  if (exact) return exact;
  const version = (d) => path.basename(d).slice(3).split('.').map(Number);
  found.sort((a, b) => version(b)[0] - version(a)[0] || version(b)[1] - version(a)[1]);
  return found[0] || null;
}

/** Resolve every path the tools use. Pass env/platform/proj to test it. */
export function ueConfig({ env = process.env, platform = process.platform, proj = PROJ } = {}) {
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  const P = win ? path.win32 : path.posix;
  const ubtPlatform = win ? 'Win64' : mac ? 'Mac' : 'Linux';
  const uproject = findUproject(proj);
  const data = JSON.parse(fs.readFileSync(uproject, 'utf8'));
  const ueRoot = env.UE_ROOT || findEngineRoot(String(data.EngineAssociation || ''), platform);
  if (!ueRoot) throw new Error('no Unreal Engine install found: set UE_ROOT to the engine root');
  const bin = P.join(ueRoot, 'Engine', 'Binaries', ubtPlatform);
  const batch = P.join(ueRoot, 'Engine', 'Build', 'BatchFiles');
  const defaultEditor = win ? P.join(bin, 'UnrealEditor.exe')
    : mac ? P.join(bin, 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor') : P.join(bin, 'UnrealEditor');
  const name = path.basename(uproject, '.uproject');
  return {
    platform, ubtPlatform, ueRoot, proj, uproject, name,
    editorTarget: `${name}Editor`,
    editor: env.UE_EDITOR || defaultEditor,
    build: env.UE_BUILD || (win ? P.join(batch, 'Build.bat') : P.join(batch, ubtPlatform, 'Build.sh')),
    logDir: env.GAM3_LOG_DIR || path.join(proj, 'Saved', 'Logs', 'gam3'),
    renderOffscreen: env.GAM3_RENDER_OFFSCREEN === '1',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Argument construction (pure)

/** A Windows editor is a GUI program whose stdout is unreliable, so it also writes its log to a file we can read. */
export function ueLogArgs(cfg, logFile) {
  return cfg.platform === 'win32' ? [`-abslog=${absLogPath(logFile)}`] : [];
}
export function absLogPath(logFile) {
  return logFile.replace(/\.log$/i, '') + '.ue.log';
}

export function buildArgs(cfg, { target = cfg.editorTarget, configuration = 'Development', maxParallelActions } = {}) {
  if (!/^[A-Za-z0-9_]+$/.test(target)) throw new Error(`invalid target: ${target}`);
  const args = [target, cfg.ubtPlatform, configuration, `-Project=${cfg.uproject}`, '-WaitMutex', '-NoHotReloadFromIDE'];
  if (maxParallelActions) args.push(`-MaxParallelActions=${positiveInt(maxParallelActions, 'max-parallel')}`);
  return args;
}

export function offscreenArgs(cfg) {
  return cfg.renderOffscreen ? ['-RenderOffscreen'] : [];
}

/** A full editor that runs one Python script. The script must quit the editor itself when it is done. */
export function editorPythonArgs(cfg, script, logFile, scriptArgs = []) {
  return [
    cfg.uproject, `-ExecutePythonScript=${[script, ...scriptArgs].join(' ')}`,
    '-unattended', '-nosplash', '-NoLoadStartupPackages', ...offscreenArgs(cfg), '-stdout', '-FullStdOutLogOutput',
    ...ueLogArgs(cfg, logFile),
  ];
}

/**
 * How much of the engine a run needs: the three "eyes". Pick the cheapest one that can answer the question.
 *   blind  no renderer at all (-nullrhi). Game logic, physics, loading and the log still work; nothing can be
 *          captured. Game time runs on a fixed step, as fast as the machine allows.
 *   agent  a small, cheap picture: 640x360, fixed time step, reflections, shading, anti-aliasing and shadows at
 *          low quality. Enough to see whether a thing is there, where it is and what colour. Nothing is culled and
 *          the lighting model is not changed. Never judge shadows, reflections, edges or frame rate here.
 *   human  what a player gets: full quality, real time. The only profile for sign-off on look, feel and speed.
 * Under a fixed step every frame advances the game by exactly 1/fps seconds however long it took to compute, so a
 * slow machine changes how long a run takes, never what happens in it.
 */
// Only settings measured not to change what is on screen or its colour. Global illumination and post-process quality
// are left alone: lowering them washed a grass level out to near white. Effects, view distance, foliage and texture
// quality are left alone because they remove things, and "is it there" must not get a wrong no.
const AGENT_CMDS = ['sg.ReflectionQuality 0', 'sg.ShadingQuality 0', 'sg.AntiAliasingQuality 0', 'sg.ShadowQuality 1'];
export const PROFILES = {
  blind: { res: [320, 180], args: ['-nullrhi', '-nosound', '-UseFixedTimeStep', '-fps=30'], cmds: [], captures: false },
  agent: {
    res: [640, 360], args: ['-nosound', '-UseFixedTimeStep', '-fps=30'], captures: true,
    cmds: AGENT_CMDS,
  },
  human: { res: [1920, 1080], args: [], cmds: [], captures: true },
};
export function profile(name = 'human') {
  if (!PROFILES[name]) throw new Error(`unknown --profile ${name} (blind, agent or human)`);
  return { name, ...PROFILES[name] };
}

/** A `-game` run of one map at exactly resx x resy. */
export function gameArgs(cfg, { map, resx = 1920, resy = 1080, args = [], execCmds = [], logFile }) {
  const out = [cfg.uproject];
  if (map) out.push(checkMap(map));
  out.push('-game', '-windowed', `-ResX=${positiveInt(resx, 'ResX')}`, `-ResY=${positiveInt(resy, 'ResY')}`, '-ForceRes',
    ...offscreenArgs(cfg), '-nosplash', '-unattended', ...args);
  if (execCmds.length) out.push(`-ExecCmds=${execCmds.join(',')}`);
  out.push('-stdout', '-FullStdOutLogOutput', ...ueLogArgs(cfg, logFile));
  return out;
}

/** Accepts /Game/... package paths or a bare level name (looked up under /Game/Maps). */
export function normalizeMap(map) {
  return /^[A-Za-z0-9_]+$/.test(map) ? `/Game/Maps/${map}` : checkMap(map);
}
export function checkMap(map) {
  if (typeof map !== 'string' || !/^\/(Game|Engine)(\/[A-Za-z0-9_]+)+$/.test(map)) throw new Error(`invalid map path: ${map}`);
  return map;
}
export function positiveInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 100000) throw new Error(`${name} must be a positive integer (got ${v})`);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Windows command lines

const WIN_SAFE = /^[A-Za-z0-9_\-+=.,:/\\@]+$/;

/**
 * Quote one argument for a Windows command line. `-Key=value with spaces` becomes `-Key="value with spaces"`, the
 * form Unreal and its build tool read. Quotes and newlines are refused; for cmd.exe so are % and !.
 */
export function winQuote(arg, { forCmd = false } = {}) {
  const s = String(arg);
  if (/["\r\n\0]/.test(s)) throw new Error(`argument contains a quote or newline: ${JSON.stringify(s)}`);
  if (forCmd && /[%!]/.test(s)) throw new Error(`argument for cmd.exe contains % or !: ${JSON.stringify(s)}`);
  if (s && WIN_SAFE.test(s)) return s;
  const m = /^(-[A-Za-z0-9_.]+=)(.*)$/s.exec(s);
  const close = (v) => `"${v.replace(/(\\+)$/, '$1$1')}"`;   // a trailing backslash would escape the closing quote
  return m ? m[1] + close(m[2]) : close(s);
}

export function spawnPlan(file, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { command: file, args, options: {} };
  if (/\.(bat|cmd)$/i.test(file)) {
    const line = [file, ...args].map((a) => winQuote(a, { forCmd: true })).join(' ');
    return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { command: file, args: args.map((a) => winQuote(a)), options: { windowsVerbatimArguments: true } };
}

// ---------------------------------------------------------------------------------------------------------------
// Processes. Only processes started here are ever killed.

const live = new Set();
let handlers = false;
function installSignalHandlers() {
  if (handlers) return;
  handlers = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      for (const pid of live) killTree(pid);
      process.exit(130);
    });
  }
}

export function killTree(pid, platform = process.platform) {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    try { process.kill(pid, 0); } catch { return; }
    spawnSync('sleep', ['0.2']);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

/** Start a process with stdout and stderr in `logFile`. Returns {child, done}; done resolves to {code, signal, seconds}. */
export function start(file, args, { cwd = PROJ, env = process.env, logFile, detached = false } = {}) {
  const plan = spawnPlan(file, args);
  let fd;
  let stdio = ['ignore', 'inherit', 'inherit'];
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fd = fs.openSync(logFile, 'w');
    stdio = ['ignore', fd, fd];
  }
  if (!detached) installSignalHandlers();
  const t0 = Date.now();
  const child = spawn(plan.command, plan.args, { cwd, env, stdio, detached, ...plan.options });
  if (child.pid && !detached) live.add(child.pid);
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      live.delete(child.pid);
      if (fd !== undefined) fs.closeSync(fd);
      resolve({ code, signal, seconds: (Date.now() - t0) / 1000 });
    };
    child.on('error', (e) => {
      if (fd !== undefined) fs.writeSync(fd, `\nspawn error: ${e.message}\n`);
      else console.error(`spawn error (${file}): ${e.message}`);
      finish(127, null);
    });
    child.on('exit', finish);
  });
  return { child, done };
}

/**
 * Run an Unreal process with an optional wall-clock limit and a shutdown watchdog: once the log shows the engine
 * exiting, the process gets `exitGraceSec` more, then it is killed (the editor sometimes hangs in teardown).
 */
export async function runUnreal(cfg, file, args, { logFile, cwd = cfg.proj, timeoutSec = 0, exitGraceSec = 0, label = 'unreal' } = {}) {
  const slot = await acquireSlot({ label });
  const { child, done } = start(file, args, { cwd, logFile });
  let killedBy = null;
  const timers = [];
  // The limit counts time awake. A machine that sleeps (a closed laptop lid) freezes the engine too; charging that
  // time to the run would report a healthy run as hung. A gap between ticks far longer than the tick is a sleep.
  let slept = 0;
  let awake = 0;
  let last = Date.now();
  timers.push(setInterval(() => {
    const now = Date.now();
    const gap = (now - last) / 1000;
    last = now;
    if (gap > 20) { slept += gap; return; }
    awake += gap;
    if (timeoutSec > 0 && awake > timeoutSec && !killedBy) {
      killedBy = 'timeout';
      console.error(`${label}: pid ${child.pid} still running after ${timeoutSec}s awake, stopping it`);
      killTree(child.pid);
    }
  }, 1000));
  if (exitGraceSec > 0 && logFile) {
    let exitSeen = 0;
    timers.push(setInterval(() => {
      if (!/LogExit: Exiting|Engine exit requested/.test(readLog(logFile))) return;
      exitSeen += 3;
      if (exitSeen > exitGraceSec && !killedBy) {
        killedBy = 'shutdown-hang';
        console.error(`${label}: pid ${child.pid} hung in shutdown, stopping it`);
        killTree(child.pid);
      }
    }, 3000));
  }
  const r = await done;
  slot.release();
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  if (slept) console.error(`${label}: the machine slept for ${Math.round(slept)}s during this run; that time is not counted against the timeout`);
  return { ...r, killedBy, slept: Math.round(slept) };
}

/** Log text: the redirected stdout plus, on Windows, the -abslog file. Missing files read as empty. */
export function readLog(logFile) {
  let text = '';
  for (const f of [logFile, absLogPath(logFile)]) {
    try { text += fs.readFileSync(f, 'utf8'); } catch { /* absent */ }
  }
  return text;
}

export function grepLines(text, re, { exclude, max } = {}) {
  let lines = text.split(/\r?\n/).filter((l) => re.test(l));
  if (exclude) lines = lines.filter((l) => !exclude.test(l));
  return max ? lines.slice(0, max) : lines;
}

/**
 * PIDs of editors that have THIS project open (Mac and Linux; on Windows returns null, meaning "not checked").
 * Compiling C++ while one is open fails or loads stale modules, so the build refuses.
 */
export function editorsOnProject(cfg) {
  if (cfg.platform === 'win32') return null;
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return (r.stdout || '').split('\n')
    .filter((l) => /UnrealEditor/.test(l) && l.includes(cfg.uproject) && !/CrashReportClient/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => pid && pid !== process.pid);
}

/** What went wrong in an Unreal log, as short lists. Materials that fail to compile draw as flat grey and say so only here. */
export function logProblems(text) {
  const material = grepLines(text, /Failed to compile Material|LogMaterial: (Error|Warning): .*(error|failed)|\[SM\d\] .*error/i, { max: 20 });
  // Two engines starting at once race over the build tool's trace file; that one exception is noise, not a crash.
  const fatal = grepLines(text, /Fatal error|Assertion failed|Ensure condition failed|LogOutputDevice: Error|Unhandled Exception/i, { exclude: /UnrealBuildTool[\\/]Trace\.uba/, max: 20 });
  const script = grepLines(text, /LogPython: Error|Traceback \(most recent call last\)/, { max: 20 });
  return { material, fatal, script };
}

/**
 * What the ready-gate kit logged: whether the level became ready, and what a player would have seen go wrong after.
 * ready is 'ok', 'timeout', or 'none' (no gate in this project, or the level never began play).
 */
export function readiness(text) {
  const line = grepLines(text, /GAM3READY: (ok|TIMEOUT)/, { max: 1 })[0] || '';
  const ready = /GAM3READY: ok/.test(line) ? 'ok' : /GAM3READY: TIMEOUT/.test(line) ? 'timeout' : 'none';
  return {
    ready, line: line.replace(/^.*GAM3READY: /, 'GAM3READY: '),
    bindPose: grepLines(text, /GAM3WATCH: bind-pose visible|GAM3POSE: TIMEOUT/, { max: 20 }).map((l) => l.replace(/^.*(GAM3(WATCH|POSE): )/, '$1')),
    lateCompile: grepLines(text, /GAM3WATCH: late-compile/).length,
    hitches: grepLines(text, /GAM3WATCH: hitch/, { max: 20 }).map((l) => l.replace(/^.*GAM3WATCH: /, '')),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isMain(url) {
  return !!process.argv[1] && pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href === url;
}

export function runMain(url, main) {
  if (!isMain(url)) return;
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (e) => { console.error(e?.message || String(e)); process.exit(2); },
  );
}

/** Flag parser: --name value, --name=value, --flag, and positionals. Everything after `--` is passed through. */
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const out = { _: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    const m = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!m) { out._.push(a); continue; }
    const [, name, inline] = m;
    if (flags.includes(name)) out[name] = true;
    else if (options.includes(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      out[name] = v;
    } else throw new Error(`unknown option --${name}`);
  }
  return out;
}
