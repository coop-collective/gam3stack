// A small Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
// Enough of the protocol for tools: initialize, ping, tools/list, tools/call.
import readline from 'node:readline';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * tools: [{ name, description, inputSchema, handler(args) -> value | Promise<value> }]
 * A handler's value is returned as JSON text. A thrown error becomes an isError result, so the agent can read it.
 */
export function serve({ name, version, instructions, tools, input = process.stdin, output = process.stdout }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params = {} } = msg;
    const wantsReply = id !== undefined && id !== null;
    if (method === 'initialize') {
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name, version },
        ...(instructions ? { instructions } : {}),
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      return reply(id, { tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) });
    }
    if (method === 'tools/call') {
      const tool = byName.get(params.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params.name}`);
      try {
        const value = await tool.handler(params.arguments || {});
        return reply(id, { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: String(e?.message || e) }], isError: true });
      }
    }
    if (wantsReply) fail(id, -32601, `method not found: ${method}`);
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    chain = chain.then(() => handle(msg)).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e?.message || e)); });
  });
  return new Promise((resolve) => rl.on('close', () => chain.then(resolve)));
}
