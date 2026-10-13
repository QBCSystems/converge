// A planner reply that is not a plan: asked once more (one bad answer from a model is not the end of a run), and when
// it still is not one, the error says what the model actually said (a free tier answers with a limit notice when it is
// out of quota), not a generic "could not be read". A stand-in model server; no real model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = { workstreams: [{ name: 'core', tasks: [{ key: 'a', title: 'A', description: 'd', accept: ['test -f nope'] }] }] };

async function plannerAgainst(replies, agents = '1') {
  let n = 0;
  // The planner clones main first: an empty repository stands in for a project with nothing in it yet.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-reply-main-'));
  execFileSync('git', ['init', '-q', '--bare', empty]);
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.includes('/main')) return res.end(JSON.stringify({ main_token: 'x', main_remote: empty }));
      const content = replies[Math.min(n++, replies.length - 1)];
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'agents', 'plan.mjs'), '--project', 'x', '--request', 'make the clock work', '--agents', agents, '--agent', 'openai', '--model', 'm', '--host', `http://127.0.0.1:${port}`],
      { cwd: ROOT, env: { ...process.env, CONVERGE_API_URL: `http://127.0.0.1:${port}`, ADMIN_KEY: 't', PLAN_API_KEY: 'k' } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => child.on('close', r));
    return { code, out, err, calls: n };
  } finally { srv.close(); fs.rmSync(empty, { recursive: true, force: true }); }
}

test('one bad reply is retried and the run goes on', async () => {
  const r = await plannerAgainst(['Sure! Here is what I would do, in words.', JSON.stringify(PLAN)]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out)[0].key, 'a');
  assert.ok(r.calls >= 2, 'the bad reply was asked again');
});

test('a limit notice instead of a plan is reported as what the model said', async () => {
  const r = await plannerAgainst(['You have reached your weekly usage limit. Upgrade to continue.']);
  assert.equal(r.code, 1);
  const last = r.err.trim().split('\n').pop();
  assert.match(last, /it said: "You have reached your weekly usage limit/);
  assert.match(last, /limit or quota/);
});

test('an empty answer is called an empty answer', async () => {
  const r = await plannerAgainst(['']);
  assert.equal(r.code, 1);
  assert.match(r.err.trim().split('\n').pop(), /it sent nothing back \(an empty answer\)/);
});
