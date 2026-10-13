import fs from 'node:fs';
import path from 'node:path';
import { waitFor, editLines, writeFile, numberedLines } from './dev-helpers.mjs';
import { PORT, DATA, ADMIN_KEY, gitAsync, projects } from './dev-context.mjs';
import { PLATFORM_TOKEN, withToken } from './git-host.mjs';
import { setMeta } from './persist.mjs';

// ---- demo seed: real agents doing real work through the public interfaces -----------------------

async function api(pathname, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {}) },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`${pathname}: ${json.error}`);
  return json;
}

async function mcp(agent, name, args) {
  const r = await fetch(agent.mcp_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${agent.mcp_key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const reply = await r.json();
  if (reply.error || reply.result?.isError) throw new Error(`${name} (${agent.agent_id}): ${reply.error?.message || reply.result.content?.[0]?.text}`);
  return reply.result;
}

/** Clone the agent's fork, edit, commit and push: the push itself fires the hook. */
async function workerCommit(agent, edit, message) {
  const wt = path.join(DATA, 'work', agent.agent_id);
  if (!fs.existsSync(wt)) await gitAsync(DATA, 'clone', '-q', withToken(agent.remote, agent.token), wt);
  edit(wt);
  await gitAsync(wt, 'add', '-A');
  await gitAsync(wt, 'commit', '-q', '-m', message);
  await gitAsync(wt, 'push', '-q', '--force', 'origin', 'HEAD:main');
  return gitAsync(wt, 'rev-parse', 'HEAD');
}

async function waitForChange(agent) {
  await waitFor(async () => {
    const st = await mcp(agent, 'status', {});
    return st.change_id && st.change_id !== '';
  }, `push from ${agent.agent_id} to register`, 15000);
}

async function seed() {
  // Project with a real file tree.
  await api('/api/projects', { name: 'converge-demo' });
  setMeta('converge-demo', { kind: 'demo', detail: 'the seeded demo', created_at: new Date().toISOString() });
  const p = projects.get('converge-demo');
  const seedWt = path.join(DATA, 'work', 'seed');
  await gitAsync(DATA, 'clone', '-q', withToken(p.main.url, PLATFORM_TOKEN), seedWt);
  writeFile('net/tcp.cpp', numberedLines(160, 'tcp'))(seedWt);
  writeFile('net/tcp.hpp', numberedLines(30, 'hdr'))(seedWt);
  writeFile('docs/net.md', '# net\n')(seedWt);
  await gitAsync(seedWt, 'add', '-A');
  await gitAsync(seedWt, 'commit', '-q', '-m', 'net stack');
  await gitAsync(seedWt, 'push', '-q', 'origin', 'HEAD:main');
  // The engine learns about the new main the next time it fetches (at landing or preview).

  const split = await api('/api/projects/converge-demo/tasks', { title: 'Tidy retransmit backoff', description: 'Backoff constants are scattered; centralise them.', mode: 'split', agents: 1 });
  const compete = await api('/api/projects/converge-demo/tasks', { title: 'Fix TCP window stall', description: 'Connections stall forever when the peer advertises a zero window and the ACK reopening it is lost.', mode: 'compete', agents: 3 });
  const reviewer = await api('/api/projects/converge-demo/reviewers', {});
  const b = split.agents[0];
  const [f, t, e] = compete.agents;

  await mcp(b, 'claim', { paths: ['net/tcp.cpp:100-140'], summary: 'Tidy retransmit backoff' });
  await workerCommit(b, editLines('net/tcp.cpp', 100, 104, 'backoff'), 'Centralise backoff constants');
  await waitForChange(b);
  await mcp(b, 'submit', { summary: 'Centralise retransmit backoff', tests: { command: 'ctest -R backoff', passed: 12, failed: 0 }, context: { prompt: 'Backoff constants are scattered; centralise them.', plan: '1. Move constants to tcp.hpp\n2. Use them in on_timeout' } });

  await mcp(f, 'claim', { paths: ['net/tcp.cpp:40-80', 'net/tcp.hpp'], summary: 'Probe the zero window' });
  await mcp(t, 'claim', { paths: ['net/timer.cpp'], summary: 'Persist timer approach' });
  await mcp(e, 'claim', { paths: ['net/tcp.cpp:50-60'], summary: 'Force-flush approach' });

  // The forks were cut before the backoff landing, so a contender editing those lines conflicts.
  for (const [agent, edit, msg] of [
    [f, (wt) => { editLines('net/tcp.cpp', 44, 49, 'probe')(wt); editLines('net/tcp.hpp', 20, 20, 'probes_field')(wt); }, 'Probe the zero window'],
    [t, (wt) => { writeFile('net/timer.cpp', 'void persist_timer_reset(Conn& c) {\n  c.persist_ms = c.rto_ms;\n}\n')(wt); editLines('net/tcp.cpp', 60, 66, 'persist')(wt); }, 'Persist timer'],
    [e, (wt) => { editLines('net/tcp.cpp', 52, 53, 'force')(wt); editLines('net/tcp.cpp', 101, 102, 'force-backoff')(wt); }, 'Force flush'],
  ]) {
    await workerCommit(agent, edit, msg);
    await waitForChange(agent);
  }
  const tests = (passed, failed) => ({ command: 'ctest -R tcp_probe', passed, failed });
  const prompt = 'Fix zero-window stall when buffer fills before ACK.';
  await mcp(f, 'submit', { summary: 'Probe the zero window instead of stalling', tests: tests(18, 0), context: { prompt, plan: '1. Shrink window threshold\n2. Force probing on stall\n3. Reset probe count on a non-zero window', notes: 'MAX_PROBES reuses the RFC 1122 bound.' } });
  await mcp(t, 'submit', { summary: 'Clamp the window and drive the persist timer', tests: tests(18, 0), context: { prompt, plan: '1. Clamp snd_wnd\n2. Reset the persist timer on every ACK' } });
  await mcp(e, 'submit', { summary: 'Force a flush flag on stall', tests: tests(16, 2), context: { prompt, plan: 'Add a force flag that bypasses the window check.' } });

  return { reviewer, workers: [b, f, t, e] };
}

export { seed };
