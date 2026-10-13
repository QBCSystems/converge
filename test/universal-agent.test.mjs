// The universal agent that ships in agents/universal takes its model providers from what converge hands it (the
// providers kept in ASQL, in CONVERGE_PROVIDERS_JSON) and not from ~/.converge/config.json; run on its own it still
// reads that file. A local stand-in for the model records the key each run sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'agents', 'universal', 'universal-agent.cjs');

async function keySentBy(env) {
  const seen = [];
  const model = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers.authorization || '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'fake', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-providers-'));
  fs.writeFileSync(path.join(dir, 'file-config.json'), JSON.stringify({ apiKeys: { openai: 'sk-from-the-file' } }));
  const args = [AGENT, '--workdir', dir, '--provider', 'openai', '--model', 'fake', '--host', `http://127.0.0.1:${model.address().port}`, '--task', 'say done', '--max-steps', '1'];
  const child = spawn(process.execPath, args, {
    cwd: dir, stdio: 'ignore',
    env: { PATH: process.env.PATH, HOME: dir, CONVERGE_CONFIG: path.join(dir, 'file-config.json'), CONVERGE_REGISTRY_DIR: path.join(dir, 'reg'), AGENT_SANDBOX: 'off', ...env },
  });
  await new Promise((r) => child.on('exit', r));
  model.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return seen[0];
}

test('the agent uses the providers converge hands it, not the config file', { timeout: 60_000 }, async () => {
  const key = await keySentBy({ CONVERGE_PROVIDERS_JSON: JSON.stringify({ apiKeys: { openai: 'sk-from-asql' } }) });
  assert.equal(key, 'Bearer sk-from-asql');
});

test('run on its own, the agent still reads the user config file', { timeout: 60_000 }, async () => {
  assert.equal(await keySentBy({}), 'Bearer sk-from-the-file');
});
