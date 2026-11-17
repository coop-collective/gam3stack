// Unity adapter for the gam3stack command line: find the project, report on the setup. Read-only. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'unity';
export const label = 'Unity';
export const projectHint = 'a directory with ProjectSettings/ProjectVersion.txt';

const isProject = (dir) => fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt')) && fs.existsSync(path.join(dir, 'Assets'));

/** The Unity project at `startDir`, above it, or one directory below it. */
export function findProject(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (isProject(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try {
    for (const e of fs.readdirSync(startDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const child = path.join(path.resolve(startDir), e.name);
      if (isProject(child)) return child;
    }
  } catch { /* unreadable */ }
  return null;
}

export function projectVersion(project) {
  try {
    const m = /m_EditorVersion:\s*(\S+)/.exec(fs.readFileSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'));
    return m ? m[1] : null;
  } catch { return null; }
}

/** Directories where Unity Hub keeps editors, one sub-directory per version. */
export function hubRoots({ platform = process.platform, env = process.env } = {}) {
  const extra = env.UNITY_HUB_EDITORS ? [env.UNITY_HUB_EDITORS] : [];
  if (platform === 'darwin') return [...extra, '/Applications/Unity/Hub/Editor'];
  if (platform === 'win32') return [...extra, 'C:\\Program Files\\Unity\\Hub\\Editor'];
  return [...extra, path.join(env.HOME || os.homedir(), 'Unity', 'Hub', 'Editor')];
}

export function editorBinary(versionDir, platform = process.platform) {
  if (platform === 'darwin') return path.join(versionDir, 'Unity.app', 'Contents', 'MacOS', 'Unity');
  if (platform === 'win32') return path.join(versionDir, 'Editor', 'Unity.exe');
  return path.join(versionDir, 'Editor', 'Unity');
}

/** { path, version, exact } for the editor that should open this project, or null. UNITY_EDITOR wins. */
export function findEditor(version, { platform = process.platform, env = process.env } = {}) {
  if (env.UNITY_EDITOR) return fs.existsSync(env.UNITY_EDITOR) ? { path: env.UNITY_EDITOR, version: null, exact: false, from: 'UNITY_EDITOR' } : null;
  const installed = [];
  for (const root of hubRoots({ platform, env })) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const v of names) {
      const bin = editorBinary(path.join(root, v), platform);
      if (fs.existsSync(bin)) installed.push({ path: bin, version: v });
    }
  }
  const exact = installed.find((e) => e.version === version);
  if (exact) return { ...exact, exact: true, from: 'Unity Hub' };
  return null;
}

export function installedVersions(opts = {}) {
  const out = [];
  for (const root of hubRoots(opts)) {
    try { for (const v of fs.readdirSync(root)) if (fs.existsSync(editorBinary(path.join(root, v), opts.platform || process.platform))) out.push(v); } catch { /* none */ }
  }
  return out.sort();
}

function renderPipeline(project) {
  try {
    const deps = JSON.parse(fs.readFileSync(path.join(project, 'Packages', 'manifest.json'), 'utf8')).dependencies || {};
    if (deps['com.unity.render-pipelines.high-definition']) return `HDRP ${deps['com.unity.render-pipelines.high-definition']}`;
    if (deps['com.unity.render-pipelines.universal']) return `URP ${deps['com.unity.render-pipelines.universal']}`;
    return 'Built-in (no scriptable render pipeline package in Packages/manifest.json)';
  } catch { return null; }
}

export function doctor(project) {
  const checks = [];
  const report = { engine: 'unity', project: project || null, checks };
  if (!project) {
    checks.push({ name: 'project', ok: false, detail: `no Unity project found here (${projectHint})` });
    const have = installedVersions();
    checks.push({ name: 'editors', ok: have.length > 0, warn: true, detail: have.length ? `installed: ${have.join(', ')}` : 'no editor found under the Unity Hub directory; set UNITY_EDITOR to the editor binary' });
    return report;
  }
  checks.push({ name: 'project', ok: true, detail: project });
  const version = projectVersion(project);
  report.version = version;
  checks.push({ name: 'project version', ok: !!version, detail: version || 'could not read m_EditorVersion from ProjectSettings/ProjectVersion.txt' });
  const editor = version ? findEditor(version) : null;
  report.editor = editor ? editor.path : null;
  if (editor) checks.push({ name: 'editor', ok: true, detail: `${editor.path} (${editor.from})` });
  else {
    const have = installedVersions();
    checks.push({ name: 'editor', ok: false, detail: `no editor for ${version}. Installed: ${have.join(', ') || 'none'}. Install that version in Unity Hub, or set UNITY_EDITOR to an editor binary (a different version re-imports and may upgrade the project).` });
  }
  const lock = fs.existsSync(path.join(project, 'Temp', 'UnityLockfile'));
  report.open_in_editor = lock;
  checks.push({
    name: 'editor lock', ok: !lock, warn: true,
    detail: lock ? 'Temp/UnityLockfile exists: an editor probably has this project open (or one crashed). The driver refuses to start only while an editor process for this project is running.' : 'project is not open in an editor',
  });
  const rp = renderPipeline(project);
  report.render_pipeline = rp;
  checks.push({ name: 'render pipeline', ok: !!rp, warn: true, detail: rp || 'Packages/manifest.json not readable' });
  const driver = fs.existsSync(path.join(project, 'Tools', 'gam3', 'unity_run.mjs'));
  checks.push({ name: 'driver', ok: driver, warn: true, detail: driver ? 'Tools/gam3/unity_run.mjs is in the project' : 'not installed yet: install the unity-driver kit to compile, run methods and run tests from the shell' });
  return report;
}

export function detectParams() {
  return {};
}
