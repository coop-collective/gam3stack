// Shared helpers for the Unity drivers in this directory (Mac, Windows, Linux). No dependencies.
//
// Environment:
//   UNITY_EDITOR        editor binary to use. Default: the Unity Hub install whose version matches the project.
//   UNITY_HUB_EDITORS   extra directory that holds one sub-directory per editor version.
//   GAM3_LOG_DIR        where logs and test results go. Default: <project>/Logs/gam3.
//   GAM3_MAX_ENGINES    how many engine processes may run on this machine at once (see slots.mjs). Default 3.
//
// The project is the directory two levels above this file (Tools/gam3/), unless --project is given.
// Processes are started with argument lists, never through a shell string.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT = path.resolve(here, '..', '..');

export function projectVersion(project) {
  try {
    const m = /m_EditorVersion:\s*(\S+)/.exec(fs.readFileSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'));
    return m ? m[1] : null;
  } catch { return null; }
}

export function hubRoots({ platform = process.platform, env = process.env } = {}) {
  const extra = env.UNITY_HUB_EDITORS ? [env.UNITY_HUB_EDITORS] : [];
  if (platform === 'darwin') return [...extra, '/Applications/Unity/Hub/Editor'];
  if (platform === 'win32') return [...extra, 'C:\\Program Files\\Unity\\Hub\\Editor'];
  return [...extra, path.join(env.HOME || os.homedir(), 'Unity', 'Hub', 'Editor')];
}

export function editorBinary(versionDir, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return P.join(versionDir, 'Unity.app', 'Contents', 'MacOS', 'Unity');
  if (platform === 'win32') return P.join(versionDir, 'Editor', 'Unity.exe');
  return P.join(versionDir, 'Editor', 'Unity');
}

/** Everything a run needs. Throws with a message a person can act on. */
export function unityConfig({ project = DEFAULT_PROJECT, env = process.env, platform = process.platform } = {}) {
  const root = path.resolve(project);
  const version = projectVersion(root);
  if (!version) throw new Error(`not a Unity project (no ProjectSettings/ProjectVersion.txt): ${root}`);
  let editor = env.UNITY_EDITOR || null;
  if (!editor) {
    const P = platform === 'win32' ? path.win32 : path.posix;
    for (const hub of hubRoots({ platform, env })) {
      const bin = editorBinary(P.join(hub, version), platform);
      if (fs.existsSync(bin)) { editor = bin; break; }
    }
  }
  if (!editor || !fs.existsSync(editor)) {
    throw new Error(`no Unity editor for version ${version}. Install it in Unity Hub or set UNITY_EDITOR to the editor binary.`);
  }
  const logDir = env.GAM3_LOG_DIR ? path.resolve(env.GAM3_LOG_DIR) : path.join(root, 'Logs', 'gam3');
  return { project: root, version, editor, logDir, platform };
}

/** Command lines of running Unity editors that have this project open (best effort; empty when it cannot tell). */
export function editorsOnProject(project, platform = process.platform) {
  const want = path.resolve(project);
  let text = '';
  if (platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }"], { encoding: 'utf8' });
    text = r.stdout || '';
  } else {
    const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    text = r.stdout || '';
  }
  const norm = (s) => (platform === 'win32' ? s.toLowerCase().replaceAll('/', '\\') : s);
  // Asset import workers are helper processes of an editor. They outlive it by a few seconds and do not hold the
  // project, so they do not count.
  return text.split(/\r?\n/).filter((l) => /Unity(\.app\/Contents\/MacOS\/Unity|\.exe)?\s/.test(l) && /-projectpath/i.test(l)
    && !/AssetImportWorker/i.test(l) && norm(l).includes(norm(want)));
}

/**
 * Why a batch run must not start, or null. Unity allows one editor per project: a second one fails late and with a
 * confusing message, so check first. A lock file with no editor behind it is a leftover from a crash and is ignored.
 */
export function projectBusy(cfg) {
  const procs = editorsOnProject(cfg.project, cfg.platform);
  if (!procs.length) return null;
  const pid = procs[0].trim().split(/\s+/)[0];
  return `the project is open in a Unity editor (pid ${pid}). Close that editor, or do the work inside it; a second editor cannot open the same project.`;
}

export const PROFILES = ['blind', 'agent', 'human'];

/**
 * The three ways to run, by how much the run needs to see:
 *   blind  no graphics device (-nographics). Compile, tests, data work. Nothing can be rendered.
 *   agent  graphics on, but cheap: lowest quality level, small captures, and in play mode a fixed time step that
 *          does not follow the clock. Enough to see that a thing is there and where.
 *   human  the project's own quality, real time. What a player gets; the only tier that can judge the final look.
 * Every run also gets -gam3Profile <name>, which the kit's editor scripts read.
 */
export function profileArgs(profile) {
  if (!PROFILES.includes(profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')} (got ${profile})`);
  return ['-gam3Profile', profile];
}

/** Arguments every batch run shares. */
export function batchArgs(cfg, { logFile, profile = 'human', quit = true, extra = [] }) {
  const args = ['-batchmode', '-projectPath', cfg.project, '-logFile', logFile];
  if (profile === 'blind') args.push('-nographics');
  if (quit) args.push('-quit');
  return [...args, ...profileArgs(profile), ...extra];
}

/** Resident memory of one process in MB, or 0 when it cannot be read (Windows, or the process is gone). */
function rssMb(pid, platform) {
  if (platform === 'win32') return 0;
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  const kb = Number((r.stdout || '').trim());
  return Number.isFinite(kb) ? kb / 1024 : 0;
}

/**
 * Run the editor to completion. Kills only the process it started, and only on timeout or a signal.
 * `peakRssMb` is the largest resident memory seen for the editor process itself (sampled once a second; its import
 * and shader worker processes are not included), so parallel runs can be planned against real numbers.
 */
export function runUnity(cfg, args, { timeoutSec = 0 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cfg.editor, args, { cwd: cfg.project, stdio: 'ignore' });
    let timedOut = false;
    let peakRssMb = 0;
    const sampler = setInterval(() => { if (child.pid) peakRssMb = Math.max(peakRssMb, rssMb(child.pid, cfg.platform)); }, 1000);
    const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref(); };
    // The limit counts time awake: a machine that sleeps (a closed laptop lid) freezes the editor too, and charging
    // that time to the run would report a healthy run as hung. A gap far longer than the tick is a sleep.
    let slept = 0;
    let awake = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const gap = (now - last) / 1000;
      last = now;
      if (gap > 20) { slept += gap; return; }
      awake += gap;
      if (timeoutSec > 0 && awake > timeoutSec && !timedOut) { timedOut = true; stop(); }
    }, 1000);
    const onSignal = () => { stop(); process.exitCode = 130; };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const finish = (code, signal) => {
      clearInterval(timer);
      if (slept) console.error(`the machine slept for ${Math.round(slept)}s during this run; that time is not counted against the timeout`);
      clearInterval(sampler);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve({ code: code ?? (signal ? 1 : 0), signal, timedOut, seconds: (Date.now() - t0) / 1000, pid: child.pid, peakRssMb: Math.round(peakRssMb), slept: Math.round(slept) });
    };
    child.on('error', (e) => { console.error(`could not start the editor: ${e.message}`); finish(127, null); });
    child.on('exit', finish);
  });
}

/**
 * What the log says about readiness: 'ok', 'timeout' or 'none' (nothing in this run waited for readiness).
 * A capture is only worth looking at after "GAM3READY: ok"; see the unity-readiness skill.
 */
export function readiness(text) {
  if (/^GAM3READY: TIMEOUT\b/m.test(text)) return 'timeout';
  if (/^GAM3READY: ok\b/m.test(text)) return 'ok';
  return 'none';
}

export function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

export function grepLines(text, re, { max = 0 } = {}) {
  const seen = new Set();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!re.test(line) || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (max && out.length >= max) break;
  }
  return out;
}

/** C# compiler errors in an editor log: "Assets/X.cs(12,5): error CS0103: ..." (each once). */
export function compileErrors(text) {
  return grepLines(text, /\berror CS\d{4}\b/);
}

/** Known reasons the editor could not do the work at all, as plain sentences. */
export function fatalReasons(text) {
  const out = [];
  if (/No valid Unity Editor license|com\.unity\.editor\.headless.*not (found|entitled)|License.*(invalid|expired)|Unity has not been activated/i.test(text)) {
    out.push('Unity has no usable licence on this machine. Sign in with Unity Hub once (or activate a licence for build machines), then run again.');
  }
  if (/another Unity instance is running with this project open/i.test(text)) out.push('Another Unity instance has this project open.');
  if (/executeMethod (class|method) '.*' could not be found|executeMethod.*could not be found/i.test(text)) out.push('The -executeMethod target was not found. It must be a public static method with no arguments, in a class under an Editor folder, and the scripts must compile.');
  if (/Scripts have compiler errors/i.test(text)) out.push('Scripts have compiler errors.');
  const threw = /executeMethod method (\S+) threw exception/i.exec(text);
  if (threw) out.push(`${threw[1]} threw an exception (the line above it in the log names it).`);
  return out;
}

/** Totals from an NUnit results file written by -runTests. */
export function testSummary(xml) {
  const run = /<test-run\b([^>]*)>/.exec(xml);
  if (!run) return null;
  const attr = (k) => { const m = new RegExp(`\\b${k}="([^"]*)"`).exec(run[1]); return m ? m[1] : null; };
  const failed = [];
  const re = /<test-case\b([^>]*)>/g;
  for (let m; (m = re.exec(xml));) {
    if (!/\bresult="Failed"/.test(m[1])) continue;
    const n = /\bfullname="([^"]*)"/.exec(m[1]);
    failed.push(n ? n[1] : '(unnamed)');
  }
  return { result: attr('result'), total: Number(attr('total')), passed: Number(attr('passed')), failed: Number(attr('failed')), skipped: Number(attr('skipped')), failedNames: failed };
}

/** Minimal flag parser: --name value, --name=value, --flag, positionals; everything after "--" is kept verbatim. */
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
