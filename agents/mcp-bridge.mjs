#!/usr/bin/env node
// converge's MCP server for a CLI that runs MCP servers as local commands (Antigravity's agy): this bridge speaks MCP
// over stdio and forwards every message to the agent's converge MCP endpoint over HTTP.
//
//   agy mcp add converge node /path/to/converge/agents/mcp-bridge.mjs converge      (once; the Mac helper does it)
//
// Registered ONCE, globally, with no address and no key in the CLI's config: each agent's process carries its own in
// AGENT_MCP (set by agents/converge.mjs: { converge: { url, headers: { Authorization } } }), which the CLI hands to the
// bridge it starts. So agents never see each other's keys, and a CLI session that is not a converge agent (no
// AGENT_MCP) gets an empty server instead of an error.
import readline from 'node:readline';

const NAME = process.argv[2] || 'converge';
let server = null;
try { const m = JSON.parse(process.env.AGENT_MCP || '{}'); server = (m.mcpServers || m)[NAME] || null; } catch { /* none */ }
let session = '';

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const fail = (id, message) => id !== undefined && out({ jsonrpc: '2.0', id, error: { code: -32603, message } });

// Not a converge agent: an empty server that answers the handshake and lists no tools.
function empty(msg) {
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'converge (not in a converge run)', version: '1' } } });
  if (msg.method === 'tools/list') return out({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
  return fail(msg.id, 'converge: this session is not a converge agent (no AGENT_MCP)');
}

async function forward(msg) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(server.headers || {}), ...(session ? { 'Mcp-Session-Id': session } : {}) };
  let r;
  try { r = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(15 * 60_000) }); }
  catch (e) { return fail(msg.id, `converge did not answer: ${e.message}`); }
  session = r.headers.get('mcp-session-id') || session;
  if (r.status === 202 || msg.id === undefined) return; // a notification: nothing to say back
  const text = await r.text();
  if (!r.ok) return fail(msg.id, `converge answered ${r.status}: ${text.slice(0, 300)}`);
  // Streamable HTTP: one JSON body, or server-sent events carrying JSON-RPC messages.
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const block of text.split(/\n\n+/)) {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) { try { out(JSON.parse(data)); } catch { /* not JSON */ } }
    }
    return;
  }
  try { out(JSON.parse(text)); } catch { fail(msg.id, 'converge sent something that is not JSON'); }
}

// Messages are handled in order (a reply never overtakes the one before it).
let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  chain = chain.then(() => (server?.url ? forward(msg) : empty(msg))).catch((e) => fail(msg.id, String(e.message || e)));
});
