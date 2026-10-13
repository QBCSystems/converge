// What the converge CLI (agents/converge.mjs) and its run command (agents/run.mjs) share: the command line, the
// platform API call, a project's converge MCP tools, and git authentication by token.

const [cmd, ...rest] = process.argv.slice(2);
const opts = { api: process.env.CONVERGE_API_URL || 'http://127.0.0.1:8787', adminKey: process.env.ADMIN_KEY || '', mode: 'split', agents: '1' };
for (let i = 0; i < rest.length; i++) {
  const m = /^--([a-z-]+)$/.exec(rest[i]);
  if (!m) fail(`unexpected argument: ${rest[i]}`);
  const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (key === 'json' || key === 'outsideAios' || key === 'inAios') opts[key] = true;
  else if (key === 'accept' && i + 1 < rest.length) (opts.accept ||= []).push(rest[++i]);
  else if (i + 1 < rest.length && !/^--[a-z]/.test(rest[i + 1])) opts[key] = rest[++i];
  else fail(`--${m[1]} needs a value`);
}

function fail(msg) {
  console.error(`converge: ${msg}`);
  process.exit(1);
}

async function call(path, body, method = 'POST') {
  let res;
  try {
    res = await fetch(`${opts.api.replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(opts.adminKey ? { 'X-Admin-Key': opts.adminKey } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    fail(`cannot reach ${opts.api} (${err.cause?.code || err.message}). Start it with \`npm run dev\` or pass --api.`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { fail(`${path}: HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) fail(`${path}: ${data.error || `HTTP ${res.status}`}`);
  return data;
}

const need = (k) => opts[k] || fail(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} is required`);

async function mcp(agent, name, args = {}) {
  let reply;
  // A platform restarting its engine (a deploy, a container woken from sleep) answers with an engine
  // error for a few seconds: ask again rather than fail the agent.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(agent.mcp_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${agent.mcp_key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      reply = await res.json();
    } catch (err) {
      reply = { error: { message: String(err.message || err) } };
    }
    if (!reply.error || attempt >= 4 || !/engine error|container|fetch failed|ECONNRESET|Unexpected token/i.test(reply.error.message)) break;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
  const text = reply.result?.content?.[0]?.text || '{}';
  // A tool error comes back as plain text (isError): hand the agent the words, not a parse failure.
  try { return JSON.parse(text); } catch { return { error: text }; }
}

/** git -c arguments that authenticate one command with a token, leaving nothing on disk. */
export function gitAuth(token) {
  return token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x:${token}`).toString('base64')}`] : [];
}

export { cmd, opts, fail, call, need, mcp };
