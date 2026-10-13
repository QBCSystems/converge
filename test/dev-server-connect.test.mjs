// The local server returns the same paste-ready MCP lines the Worker does (worker/connect.mjs), with every agent it
// creates: a task's workers, a joined worker, a reviewer. Skipped when the engine is not built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectLines } from '../worker/connect.mjs';
import { engineBin } from '../agents/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const haveEngine = !!engineBin('converge-engine', ROOT);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('dev server: every agent it creates comes with the Worker\'s connect lines', { skip: haveEngine ? false : 'engine not built', timeout: 60_000 }, async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-dev-connect-'));
  const port = await freePort();
  const admin = 'test-admin-key';
  const proc = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs')], {
    env: { ...process.env, CONVERGE_PORT: String(port), CONVERGE_HOST: '127.0.0.1', CONVERGE_DATA: data, ADMIN_KEY: admin, NO_SEED: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  // SIGTERM: the server stops its engines on the way out (SIGKILL would leave them running).
  t.after(async () => {
    const gone = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
    proc.kill('SIGKILL');
    fs.rmSync(data, { recursive: true, force: true });
  });
  const api = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': admin }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`${p}: ${r.status} ${text}\n${stderr}`);
    return JSON.parse(text);
  };
  for (let i = 0; ; i++) {
    try { await api('/api/projects'); break; } catch (e) { if (i > 200) throw e; await new Promise((r) => setTimeout(r, 100)); }
  }
  await api('/api/projects', { name: 'p' });
  const task = await api('/api/projects/p/tasks', { title: 't', agents: 1 });
  const joined = await api(`/api/projects/p/tasks/${task.task_id}/agents`, {});
  const reviewer = await api('/api/projects/p/reviewers', {});
  for (const a of [task.agents[0], joined.agent, reviewer]) {
    assert.ok(a.mcp_key && a.mcp_url, JSON.stringify(a));
    assert.deepEqual(a.connect, connectLines(a.agent_id, a.mcp_url, a.mcp_key));
    assert.match(a.connect.claude_code, /^claude mcp add --transport http converge-/);
  }
});
