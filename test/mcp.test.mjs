import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const plugins = path.resolve(import.meta.dirname, '..', 'plugins');

function session(script) {
  const child = spawn(process.execPath, [script, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buffer += d;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      const msg = JSON.parse(buffer.slice(0, i));
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, close: () => child.stdin.end() };
}

for (const engine of fs.readdirSync(plugins)) {
  test(`${engine}: the MCP server lists its tools and answers them`, async () => {
    const s = session(path.join(plugins, engine, 'scripts', 'gam3.mjs'));
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, `gam3stack-${engine}`);
    const tools = (await s.call('tools/list', {})).result.tools.map((t) => t.name);
    assert.deepEqual(tools, [`${engine}_doctor`, `${engine}_kits`, `${engine}_kit`, `${engine}_install`]);
    const kits = JSON.parse((await s.call('tools/call', { name: `${engine}_kits`, arguments: {} })).result.content[0].text);
    assert.ok(kits.length > 0);
    const one = JSON.parse((await s.call('tools/call', { name: `${engine}_kit`, arguments: { name: kits[0].name } })).result.content[0].text);
    assert.ok(one.readme.length > 100);
    const doctor = JSON.parse((await s.call('tools/call', { name: `${engine}_doctor`, arguments: { project: import.meta.dirname } })).result.content[0].text);
    assert.equal(doctor.project, null);
    const bad = await s.call('tools/call', { name: `${engine}_install`, arguments: { name: kits[0].name, project: import.meta.dirname } });
    assert.equal(bad.result.isError, true);
    assert.equal((await s.call('nope', {})).error.code, -32601);
    s.close();
  });
}
