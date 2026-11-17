#!/usr/bin/env node
// Call the running editor's own MCP server (the engine's experimental "Unreal MCP" plugin) from the shell.
// Start the editor with ue_editor.mjs first. Port: --port, else env UE_MCP_PORT, else the one in .gam3/env.json
// (a dedicated environment made by env.mjs), else 8123.
//
//   node Tools/gam3/ue_mcp.mjs toolsets                              names and one-line descriptions
//   node Tools/gam3/ue_mcp.mjs describe <Toolset> [...]              the tools of a toolset
//   node Tools/gam3/ue_mcp.mjs schema <Toolset.Tool> [...]           a tool's input schema
//   node Tools/gam3/ue_mcp.mjs call <Toolset> <Tool> '<json args>'
//   node Tools/gam3/ue_mcp.mjs py 'import unreal; ...'               or: py @path/to/script.py
//   node Tools/gam3/ue_mcp.mjs shot out.png --world /Game/Maps/L.L --at X,Y,Z [--dist 1500] [--pitch -40] [--yaw 45]
//                                           [--fov 70] [--mode Lit] [--size 1600x900]
//
// py: the value of the script's last expression comes back as the result. Imports must be at the top level of
// the script. Output of a nested exec() is lost: put what you want in a variable and name it on the last line.
// Results print as JSON, with JSON strings nested inside them opened up. Exit code 1 when the tool reports an error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PY_TOOLSET = process.env.UE_MCP_PY_TOOLSET || 'editor_toolset.toolsets.python_scripting.PythonScriptingTools';
const PY_TOOL = process.env.UE_MCP_PY_TOOL || 'execute_python';
const CAPTURE_TOOLSET = process.env.UE_MCP_CAPTURE_TOOLSET || 'SceneCaptureToolset.SceneCaptureToolset';

function envPort() {
  try { return JSON.parse(fs.readFileSync(new URL('../../.gam3/env.json', import.meta.url), 'utf8')).port; } catch { return undefined; }
}
export function mcpUrl(port) {
  return `http://127.0.0.1:${Number(port) || envPort() || 8123}/mcp`;
}

async function post(url, body, session, timeoutMs) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session) headers['Mcp-Session-Id'] = session;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  let raw = await res.text();
  if (/^\s*(event|data):/.test(raw)) raw = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
  return { json: raw.trim() ? JSON.parse(raw) : null, session: res.headers.get('mcp-session-id') };
}

/** Tool results arrive as JSON strings inside JSON ({"returnValue": "<json>"}): open them up. */
export function unwrap(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s[0] === '{' || s[0] === '[') {
      try { return unwrap(JSON.parse(s)); } catch { return v; }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(unwrap);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === 'returnValue') return unwrap(v.returnValue);
    return Object.fromEntries(keys.map((k) => [k, unwrap(v[k])]));
  }
  return v;
}

/** One tool call on a fresh session. Returns {out, isError, images:[base64]}. */
export async function tool(name, args, { port = process.env.UE_MCP_PORT, timeoutMs = 600000 } = {}) {
  const url = mcpUrl(port);
  const init = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gam3stack-ue_mcp', version: '1' } } }, null, 15000);
  try { await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session, 15000); } catch { /* optional */ }
  const { json } = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, init.session, timeoutMs);
  if (json?.error) return { out: { error: json.error }, isError: true, images: [] };
  const content = json?.result?.content || [];
  const texts = content.filter((c) => c.type === 'text').map((c) => c.text || '');
  return { out: unwrap(texts.length === 1 ? texts[0] : texts), isError: !!json?.result?.isError, images: content.filter((c) => c.type === 'image').map((c) => c.data) };
}

export const callTool = (toolset, toolName, args, opts) => tool('call_tool', { toolset_name: toolset, tool_name: toolName, arguments: args }, opts);
export const runPython = (code, opts) => callTool(PY_TOOLSET, PY_TOOL, { script: { content: code, language: 'Python' } }, opts);

/** Camera transform that looks at `at` from `dist` away, for an Unreal pitch/yaw in degrees. */
export function cameraLookingAt(at, dist, pitch, yaw) {
  const rad = (d) => (d * Math.PI) / 180;
  const fwd = [Math.cos(rad(pitch)) * Math.cos(rad(yaw)), Math.cos(rad(pitch)) * Math.sin(rad(yaw)), Math.sin(rad(pitch))];
  return { location: { x: at[0] - fwd[0] * dist, y: at[1] - fwd[1] * dist, z: at[2] - fwd[2] * dist }, rotation: { pitch, yaw, roll: 0 } };
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

async function main(argv) {
  const a = flags(argv);
  const [cmd, ...rest] = a._;
  const opts = { port: a.port || process.env.UE_MCP_PORT };
  let r;
  if (cmd === 'toolsets') r = await tool('list_toolsets', {}, opts);
  else if (cmd === 'describe' && rest.length) {
    r = await tool('describe_toolsets', { toolset_names: rest }, opts);
    if (!r.isError && r.out?.toolsets) {
      for (const [name, ts] of Object.entries(r.out.toolsets)) {
        console.log(name);
        for (const t of ts.tools || []) console.log(`   ${t.name.split('.').pop()} :: ${(t.description || '').split(/\s+/).join(' ').slice(0, 200)}`);
      }
      if (r.out.errors) console.log(JSON.stringify(r.out.errors));
      return 0;
    }
  } else if (cmd === 'schema' && rest.length) r = await tool('describe_tools', { tool_names: rest }, opts);
  else if (cmd === 'call' && rest.length >= 2) r = await callTool(rest[0], rest[1], rest[2] ? JSON.parse(rest[2]) : {}, opts);
  else if (cmd === 'py' && rest[0]) r = await runPython(rest[0].startsWith('@') ? fs.readFileSync(rest[0].slice(1), 'utf8') : rest[0], opts);
  else if (cmd === 'shot' && rest[0] && a.world && a.at) {
    const at = a.at.split(',').map(Number);
    if (at.length !== 3 || at.some(Number.isNaN)) throw new Error('--at needs X,Y,Z');
    const [width, height] = String(a.size || '1600x900').split('x').map(Number);
    const cam = cameraLookingAt(at, Number(a.dist ?? 1500), Number(a.pitch ?? -40), Number(a.yaw ?? 45));
    r = await callTool(CAPTURE_TOOLSET, 'Capture', {
      world: { refPath: a.world }, mode: a.mode || 'Lit',
      camera: { ...cam, projectionMode: 'Perspective', fOV: Number(a.fov ?? 70) },
      options: { width, height, screenPercentage: 1.0, visualizationSubMode: '' },
    }, opts);
    if (r.images.length) {
      const out = path.resolve(rest[0]);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(r.images[0], 'base64'));
      r.out = { saved: out, warnings: r.out?.warnings };
    } else r.isError = true;
  } else {
    console.error('usage: ue_mcp.mjs toolsets | describe <Toolset>... | schema <Toolset.Tool>... | call <Toolset> <Tool> [json] | py <code|@file> | shot <out.png> --world W --at X,Y,Z   [--port N]');
    return 2;
  }
  console.log(typeof r.out === 'string' ? r.out : JSON.stringify(r.out, null, 1));
  return r.isError ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    const cause = e?.cause?.code || e?.name;
    console.error(cause === 'ECONNREFUSED' ? 'ue_mcp: no editor is listening on that port. Start one: node Tools/gam3/ue_editor.mjs start'
      : cause === 'TimeoutError' ? 'ue_mcp: the editor did not answer in time. It may be busy (a long task) or a stale process may hold the port: node Tools/gam3/ue_editor.mjs status'
        : `ue_mcp: ${e?.message || e}`);
    process.exit(2);
  });
}
