import test from 'node:test';
import assert from 'node:assert/strict';
import { concat, indexOf, takeRequest, CRLFCRLF } from '../worker/engine-http.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const ascii = (s) => enc.encode(s);

// Deliver `buf` split at every position; takeRequest must be null before the
// whole request is present and identical (on values) once it is. `completeAt` is
// the byte length that completes the whole request (body included).
function everySplit(buf, completeAt, check) {
  for (let i = 0; i <= buf.length; i++) {
    const a = buf.subarray(0, i);
    const b = buf.subarray(i);
    const r0 = takeRequest(a);
    if (i < completeAt) {
      assert.equal(r0, null, `split ${i}: expected null, got a request`);
    } else {
      assert.notEqual(r0, null, `split ${i}: expected a request`);
      check(r0, `split ${i}`);
    }
    const r1 = takeRequest(concat(a, b));
    assert.notEqual(r1, null, `split ${i}: rejoined should parse`);
    check(r1, `split ${i} rejoined`);
  }
}

function fields(r, { method, path, headers, body, rest }) {
  assert.equal(r.method, method);
  assert.equal(r.path, path);
  if (headers !== undefined) assert.deepEqual(r.headers, headers);
  if (body !== undefined) assert.deepEqual([...r.body], [...body]);
  if (rest !== undefined) assert.deepEqual([...r.rest], [...rest]);
}

// ---- helpers themselves --------------------------------------------------

test('concat and indexOf basics', () => {
  assert.deepEqual([...concat(ascii('ab'), ascii('cd'))], [97, 98, 99, 100]);
  assert.equal(indexOf(ascii('xxabcxx'), [97, 98, 99]), 2);
  assert.equal(indexOf(ascii('abc'), [120, 121]), -1);
  assert.equal(indexOf(ascii('a\r\n\r\nb'), CRLFCRLF), 1);
});

// ---- no body -------------------------------------------------------------

test('GET with no body and no Content-Length', () => {
  const buf = ascii('GET /a HTTP/1.1\r\nHost: h\r\n\r\n');
  const r = takeRequest(buf);
  fields(r, { method: 'GET', path: '/a', body: [], rest: [] });
  everySplit(buf, buf.length, (x) => fields(x, { method: 'GET', path: '/a', body: [] }));
});

test('Content-Length: 0 is a complete request', () => {
  const buf = ascii('POST /a HTTP/1.1\r\nContent-Length: 0\r\n\r\n');
  const r = takeRequest(buf);
  fields(r, { method: 'POST', path: '/a', body: [], rest: [] });
  everySplit(buf, buf.length, (x) => fields(x, { method: 'POST', path: '/a', body: [] }));
});

// ---- Content-Length bodies with binary bytes -----------------------------

test('binary body with 0x00, 0xff and CR LF inside', () => {
  const body = [0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x00, 0xff];
  const head = ascii(`POST /git/x.git/git-upload-pack HTTP/1.1\r\nHost: h\r\nContent-Length: ${body.length}\r\n\r\n`);
  const buf = concat(head, new Uint8Array(body));
  const r = takeRequest(buf);
  fields(r, { method: 'POST', path: '/git/x.git/git-upload-pack', body, rest: [] });
  everySplit(buf, buf.length, (x) => fields(x, { method: 'POST', path: '/git/x.git/git-upload-pack', body }));
});

test('CRLFCRLF inside a Content-Length body does not split the request early', () => {
  const body = [0x61, 0x0d, 0x0a, 0x0d, 0x0a, 0x62];
  const buf = concat(ascii('PUT /p HTTP/1.1\r\nContent-Length: 6\r\n\r\n'), new Uint8Array(body));
  const r = takeRequest(buf);
  fields(r, { method: 'PUT', path: '/p', body, rest: [] });
  // a shorter prefix must not report a request based on the body's CRLFCRLF
  assert.equal(takeRequest(buf.subarray(0, 30)), null);
});

// ---- pipelining ----------------------------------------------------------

test('two pipelined requests in one buffer', () => {
  const buf = ascii('GET /a HTTP/1.1\r\nHost: h\r\n\r\nPOST /b HTTP/1.1\r\nContent-Length: 3\r\n\r\nxyz');
  const r1 = takeRequest(buf);
  fields(r1, { method: 'GET', path: '/a', body: [] });
  const r2 = takeRequest(r1.rest);
  fields(r2, { method: 'POST', path: '/b', body: [120, 121, 122], rest: [] });
  assert.equal(takeRequest(r2.rest), null);
});

test('two pipelined requests, second split across arrival', () => {
  const one = ascii('GET /a HTTP/1.1\r\n\r\n');
  const two = ascii('POST /b HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi');
  const r1 = takeRequest(concat(one, two.subarray(0, 10)));
  fields(r1, { method: 'GET', path: '/a' });
  assert.equal(takeRequest(r1.rest), null);
  const r2 = takeRequest(concat(r1.rest, two.subarray(10)));
  fields(r2, { method: 'POST', path: '/b', body: [104, 105], rest: [] });
});

// ---- byte-by-byte delivery ----------------------------------------------

test('byte-by-byte delivery yields null until complete', () => {
  const raw = concat(ascii('POST /git/x.git/git-receive-pack HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\n'), new Uint8Array([0x00, 0xff, 0x0d, 0x0a]));
  let acc = new Uint8Array(0);
  for (let i = 0; i < raw.length - 1; i++) {
    acc = concat(acc, raw.subarray(i, i + 1));
    assert.equal(takeRequest(acc), null, `after ${i + 1} bytes`);
  }
  acc = concat(acc, raw.subarray(raw.length - 1));
  const r = takeRequest(acc);
  fields(r, { method: 'POST', path: '/git/x.git/git-receive-pack', body: [0x00, 0xff, 0x0d, 0x0a], rest: [] });
});

// ---- header cases --------------------------------------------------------

test('header names are case-insensitive', () => {
  for (const name of ['Content-Length', 'content-length', 'CONTENT-LENGTH', 'CoNtEnT-LeNgTh']) {
    const buf = ascii(`POST /a HTTP/1.1\r\n${name}: 3\r\n\r\nabc`);
    const r = takeRequest(buf);
    assert.deepEqual([...r.body], [97, 98, 99], `name ${name}`);
    assert.equal(r.rest.length, 0, `name ${name}`);
  }
});

test('header value containing a colon is preserved whole', () => {
  const buf = ascii('GET /a HTTP/1.1\r\nX-Trace: a:b:c\r\nHost: h\r\n\r\n');
  const r = takeRequest(buf);
  assert.deepEqual(r.headers.find(([k]) => k === 'X-Trace'), ['X-Trace', 'a:b:c']);
});

test('a colon in the value plus a later header still frames correctly', () => {
  const buf = ascii('POST /a HTTP/1.1\r\nUrn: x:y\r\ncontent-length: 5\r\n\r\nhello');
  const r = takeRequest(buf);
  assert.deepEqual(r.headers.find(([k]) => k === 'Urn'), ['Urn', 'x:y']);
  assert.deepEqual([...r.body], [...ascii('hello')]);
  assert.equal(r.rest.length, 0);
});

// ---- chunked transfer encoding ------------------------------------------

test('chunked: several chunks accumulate into one body', () => {
  // chunk 1 "abc" (3), chunk 2 data "d\r\n\r\n" (4 bytes, given as raw
  // bytes) so the assembled body itself contains CR LF bytes.
  const body = [...ascii('abc'), 0x64, 0x0d, 0x0a, 0x0d];
  const buf = concat(
    concat(ascii('POST /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n4\r\nd'), new Uint8Array([0x0d, 0x0a, 0x0d, 0x0d, 0x0a])),
    ascii('0\r\n\r\n'),
  );
  const r = takeRequest(buf);
  fields(r, { method: 'POST', path: '/a', body, rest: [] });
  everySplit(buf, buf.length, (x) => fields(x, { method: 'POST', path: '/a', body }));
});

test('chunked: zero-size last chunk marks the end', () => {
  const buf = ascii('POST /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n');
  const r = takeRequest(buf);
  fields(r, { method: 'POST', path: '/a', body: [], rest: [] });
  everySplit(buf, buf.length, (x) => fields(x, { method: 'POST', path: '/a', body: [] }));
});

test('chunked: uppercase hex sizes', () => {
  const buf = ascii('POST /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n');
  const r = takeRequest(buf);
  fields(r, { method: 'POST', path: '/a', body: [...ascii('0123456789')], rest: [] });
  everySplit(buf, buf.length, (x) => fields(x, { method: 'POST', path: '/a', body: [...ascii('0123456789')] }));
});

test('chunked: binary chunk data with CR LF inside', () => {
  const chunk = [0x00, 0xff, 0x0d, 0x0a, 0x01];
  const head = ascii('POST /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n');
  const buf = concat(concat(head, new Uint8Array(chunk)), ascii('\r\n0\r\n\r\n'));
  const r = takeRequest(buf);
  fields(r, { method: 'POST', path: '/a', body: chunk, rest: [] });
  everySplit(buf, buf.length, (x) => fields(x, { method: 'POST', path: '/a', body: chunk }));
});

test('chunked: trailing bytes after the last chunk are rest', () => {
  const buf = ascii('POST /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\nGARBAGE');
  const r = takeRequest(buf);
  fields(r, { method: 'POST', path: '/a', body: [104, 105], rest: [...ascii('GARBAGE')] });
});

test('chunked: incomplete chunk data yields null', () => {
  const full = ascii('POST /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n');
  for (let i = 40; i < full.length; i++) {
    const r = takeRequest(full.subarray(0, i));
    if (i >= full.length) continue;
    assert.equal(r, null, `prefix ${i}`);
  }
  assert.notEqual(takeRequest(full), null);
});

test('chunked: Transfer-Encoding casing and chunked substring', () => {
  for (const v of ['chunked', 'Chunked', 'CHUNKED', 'gzip, chunked']) {
    const buf = ascii(`POST /a HTTP/1.1\r\nTransfer-Encoding: ${v}\r\n\r\n1\r\nx\r\n0\r\n\r\n`);
    const r = takeRequest(buf);
    assert.deepEqual([...r.body], [120], `value ${v}`);
  }
});

// ---- the acceptance-check shape -----------------------------------------

test('acceptance shape: content-length then chunked pipelined', () => {
  const body = new Uint8Array([0, 13, 10, 255, 1]);
  const head = enc.encode('POST /git/x.git/git-upload-pack HTTP/1.1\r\nHost: h\r\ncontent-length: 5\r\n\r\n');
  const one = concat(head, body);
  const two = concat(one, enc.encode('GET /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\nA\r\n0123456789\r\n0\r\n\r\n'));
  for (let i = 0; i < one.length; i++) assert.equal(takeRequest(one.subarray(0, i)), null, `prefix ${i}`);
  const r = takeRequest(two);
  assert.equal(r.method, 'POST');
  assert.equal(r.body.length, 5);
  assert.equal(r.body[3], 255);
  const r2 = takeRequest(r.rest);
  assert.equal(r2.path, '/a');
  assert.equal(dec.decode(r2.body), 'abc0123456789');
  assert.equal(r2.rest.length, 0);
});

// ---- the engine itself, end to end ----------------------------------------
//
// A native converge-engine (built on the kernel: CONVERGE_ENGINE_BIN, else kernel/<os>-<arch>/, else engine/build-in-aios) against real git repositories served over smart HTTP by
// `git http-backend`, driven the way the platform drives it: /v1/project, /v1/task, /v1/push,
// /v1/mcp, /v1/sweep. Skipped only when none of those is here.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineBin, kernelHint } from '../agents/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_BIN = engineBin('converge-engine', ROOT);
const haveEngine = !!ENGINE_BIN && fs.existsSync(ENGINE_BIN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let commitClock = 1700000000;
function git(cwd, ...args) {
  const when = `${commitClock++} +0000`;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd,
    },
  }).trim();
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Bare repositories under `dir`, over smart HTTP (fetch and push), at http://127.0.0.1:<port>/<name>.git
async function gitServer(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
        REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '', GIT_PROTOCOL: req.headers['git-protocol'] || '',
        REMOTE_USER: 'engine', REMOTE_ADDR: '127.0.0.1',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.receivepack', GIT_CONFIG_VALUE_0: 'true',
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let done = false;
    cgi.stdout.on('data', (chunk) => {
      if (done) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf('\r\n\r\n'), sep = 4;
      if (end < 0) { end = head.indexOf('\n\n'); sep = 2; }
      if (end < 0) return;
      let status = 200;
      const headers = {};
      for (const line of head.subarray(0, end).toString().split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200; else headers[k] = v;
      }
      res.writeHead(status, headers);
      done = true;
      if (head.length > end + sep) res.write(head.subarray(end + sep));
    });
    cgi.stdout.on('end', () => res.end());
    cgi.stderr.resume();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: (name) => `http://127.0.0.1:${server.address().port}/${name}.git` };
}

// One project: main.git (seeded by `seed(work)` in a scratch clone), a fork per agent cloned from it,
// and an engine. Every agent works in its own clone of its fork.
async function world(t, { agents = ['a', 'b'], mode = 'split', seed, config, engineArgs = [], env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-engine-test-'));
  // Removed last (after hooks run in the order they are added): the engine is stopped first, and waited for,
  // because Windows will not delete a directory a running process still holds.
  const removeDir = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  const repos = path.join(dir, 'repos');
  fs.mkdirSync(repos);
  git(dir, 'init', '-q', '--bare', '-b', 'main', path.join(repos, 'main.git'));
  const seedDir = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seedDir);
  if (seed) seed(seedDir);
  else {
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'hello\n');
    git(seedDir, 'add', '-A');
    git(seedDir, 'commit', '-qm', 'init');
  }
  git(seedDir, 'push', '-q', path.join(repos, 'main.git'), 'HEAD:refs/heads/main');
  for (const a of agents) git(dir, 'clone', '-q', '--bare', path.join(repos, 'main.git'), path.join(repos, `fork-${a}.git`));

  const gs = await gitServer(repos);
  t.after(() => gs.server.close());
  const port = await freePort();
  const data = path.join(dir, 'engine');
  const proc = spawn(ENGINE_BIN, ['--port', String(port), '--data', data, '--loopback', '--insecure', '--allow-unjailed', ...engineArgs], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  t.after(async () => {
    proc.kill('SIGKILL');
    if (proc.exitCode === null && proc.signalCode === null) await new Promise((r) => proc.once('exit', r));
  });
  t.after(removeDir);
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text}\n${stderr}`);
    return JSON.parse(text);
  };
  for (let i = 0; ; i++) {
    try { await call('GET', '/v1/health'); break; } catch (e) { if (i > 100) throw e; await sleep(50); }
  }
  await call('POST', '/v1/project', { name: 'p', main_remote: gs.url('main'), main_branch: 'main' });
  await call('POST', '/v1/task', {
    task_id: 't1', title: 'task', mode, agents: agents.map((a) => ({ agent_id: a, fork_remote: gs.url(`fork-${a}`) })),
  });
  if (config) await call('POST', '/v1/configure', config);

  const work = {};
  for (const a of agents) {
    work[a] = path.join(dir, `work-${a}`);
    git(dir, 'clone', '-q', path.join(repos, `fork-${a}.git`), work[a]);
  }
  const w = {
    dir, repos, work, call,
    mainGit: path.join(repos, 'main.git'),
    write(a, file, text) { fs.mkdirSync(path.dirname(path.join(work[a], file)), { recursive: true }); fs.writeFileSync(path.join(work[a], file), text); },
    commit(a, msg = 'work') { git(work[a], 'add', '-A'); git(work[a], 'commit', '-qm', msg); return git(work[a], 'rev-parse', 'HEAD'); },
    async push(a) {
      git(work[a], 'push', '-qf', 'origin', 'HEAD:refs/heads/main');
      return call('POST', '/v1/push', { agent: a, ref: 'refs/heads/main', commit: git(work[a], 'rev-parse', 'HEAD') });
    },
    async tool(agent, name, args = {}, role = 'worker') {
      const r = await call('POST', '/v1/mcp', {
        agent_id: agent, role, request: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      const reply = JSON.parse(r.reply);
      const result = reply.result || { isError: true, error: reply.error };
      if (result.content?.[0]?.text) result.text = result.content[0].text;
      return result;
    },
    state: () => call('GET', '/v1/state'),
    async change(a) { return (await w.state()).changes.filter((c) => c.agent_id === a).at(-1); },
    sweep: () => call('POST', '/v1/sweep', {}),
    mainFile(file) { return execFileSync('git', ['--git-dir', w.mainGit, 'show', `main:${file}`], { encoding: 'utf8' }); },
    mainFiles() { return execFileSync('git', ['--git-dir', w.mainGit, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim().split('\n'); },
    async until(what, fn, ms = 20000) {
      const end = Date.now() + ms;
      for (;;) {
        await w.sweep();
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(200);
      }
    },
  };
  return w;
}

// Check commands are sh on every host (aios-sh on Windows, from the kernel bundle).
const PASS_CMD = 'true';
const COUNTS_CMD = 'echo "# pass 3"; echo "# fail 0"';

const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1) + '\n').join('');
const engineTest = (name, fn) => test(name, { skip: haveEngine ? false : `no engine: ${kernelHint(ROOT)}` }, fn);

engineTest('engine: a reviewer\'s ship applies the merge train\'s refusals (scope)', async (t) => {
  const w = await world(t, { mode: 'compete', config: { auto_land: false, check_claims: true } });
  await w.tool('a', 'claim', { paths: ['a.txt'], summary: 'a' });
  w.write('a', 'a.txt', 'a\n');
  w.write('a', 'unclaimed.txt', 'sneaky\n');
  w.commit('a');
  await w.push('a');
  const sub = await w.tool('a', 'submit', { summary: 'a' });
  assert.ok(!sub.isError, sub.text);
  const c = await w.change('a');
  assert.deepEqual(c.out_of_scope, ['unclaimed.txt']);
  const shipped = await w.tool('rev', 'ship', { change_id: c.change_id }, 'reviewer');
  assert.equal(shipped.isError, true);
  assert.match(shipped.text, /outside its claim \(unclaimed\.txt\)/);
  assert.equal((await w.change('a')).state, 'submitted');
  assert.deepEqual(w.mainFiles(), ['README.md']);

  // A test report with counts and no command is a test described, not given: refused the same way.
  await w.tool('b', 'claim', { paths: ['b.txt'], summary: 'b' });
  w.write('b', 'b.txt', 'b\n');
  w.commit('b');
  await w.push('b');
  await w.tool('b', 'submit', { summary: 'b', tests: { passed: 12, failed: 0 } });
  const cb = await w.change('b');
  const refused = await w.tool('rev', 'ship', { change_id: cb.change_id }, 'reviewer');
  assert.equal(refused.isError, true);
  assert.match(refused.text, /test counts without the command/);
  const status = await w.tool('b', 'status');
  assert.match(status.text, /gives no command/);
});

engineTest('engine: a redelivered push is idempotent on (agent, commit)', async (t) => {
  const w = await world(t, { config: { auto_land: false } });
  await w.tool('a', 'claim', { paths: ['a.txt'], summary: 'a' });
  w.write('a', 'a.txt', 'a\n');
  w.commit('a');
  const first = await w.push('a');
  assert.ok(first.events.some((e) => e.type === 'Pushed'));
  await w.tool('a', 'submit', { summary: 'a' });
  const before = await w.state();
  assert.equal((await w.change('a')).state, 'submitted');
  const again = await w.call('POST', '/v1/push', { agent: 'a', ref: 'refs/heads/main', commit: (await w.change('a')).head_commit });
  assert.deepEqual(again.events, []);
  const after = await w.state();
  assert.equal(after.state_version, before.state_version);
  assert.equal((await w.change('a')).state, 'submitted');
  assert.equal(after.changes.length, before.changes.length);
});

engineTest('engine: a push sharing no commit with main is Conflicted with a reason, main untouched', async (t) => {
  const w = await world(t);
  const mainBefore = execFileSync('git', ['--git-dir', w.mainGit, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  git(w.work.a, 'checkout', '-q', '--orphan', 'unrelated');
  git(w.work.a, 'rm', '-rqf', '.');
  w.write('a', 'other.txt', 'unrelated history\n');
  w.commit('a');
  await w.tool('a', 'claim', { paths: ['other.txt'], summary: 'a' });
  const pushed = await w.push('a');
  const prev = pushed.events.find((e) => e.type === 'Preview');
  assert.equal(prev.clean, false);
  assert.equal(prev.conflicts[0].path, '<no-common-ancestor>');
  assert.match(prev.conflicts[0].theirs, /shares no commit with main/);
  await w.tool('a', 'submit', { summary: 'a' });
  await w.sweep();
  assert.equal((await w.change('a')).state, 'conflicted');
  assert.equal(execFileSync('git', ['--git-dir', w.mainGit, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), mainBefore);
});

engineTest('engine: a rename on one side and an edit on the other merge at the new name', async (t) => {
  const w = await world(t, {
    seed: (d) => { fs.writeFileSync(path.join(d, 'a.txt'), lines(12)); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); },
  });
  await w.tool('a', 'claim', { paths: ['a.txt', 'b.txt'], summary: 'rename' });
  git(w.work.a, 'mv', 'a.txt', 'b.txt');
  w.commit('a', 'rename a.txt to b.txt');
  await w.push('a');
  await w.tool('a', 'submit', { summary: 'rename' });
  assert.equal((await w.change('a')).state, 'landed');

  await w.tool('b', 'claim', { paths: ['a.txt'], summary: 'edit' });
  w.write('b', 'a.txt', lines(12, (i) => (i === 3 ? 'line three, edited' : `line ${i}`)));
  w.commit('b', 'edit a.txt');
  const pushed = await w.push('b');
  assert.equal(pushed.events.find((e) => e.type === 'Preview').clean, true);
  await w.tool('b', 'submit', { summary: 'edit' });
  assert.equal((await w.change('b')).state, 'landed');
  assert.deepEqual(w.mainFiles(), ['b.txt']);
  assert.match(w.mainFile('b.txt'), /line three, edited/);
});

engineTest('engine: a criss-cross history merges against a virtual base', async (t) => {
  // O; X1 edits line 1, Y1 edits line 9; X2 = X1+Y1 and Y2 = Y1+X1 (two merge bases: X1, Y1).
  // main = X2 then line 1 again; the agent = Y2 then line 9 again. Against either base alone the
  // other side's merged edit looks new and clashes; against the merged bases each side changed one line.
  const f = (l1, l9) => lines(9, (i) => (i === 1 ? l1 : i === 9 ? l9 : `line ${i}`));
  let agentHead;
  const w = await world(t, {
    agents: ['a'],
    seed: (d) => {
      fs.writeFileSync(path.join(d, 'f.txt'), f('one', 'nine'));
      git(d, 'add', '-A'); git(d, 'commit', '-qm', 'O');
      git(d, 'checkout', '-qb', 'y');
      fs.writeFileSync(path.join(d, 'f.txt'), f('one', 'nine y')); git(d, 'commit', '-qam', 'Y1');
      git(d, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(d, 'f.txt'), f('one x', 'nine')); git(d, 'commit', '-qam', 'X1');
      const x1 = git(d, 'rev-parse', 'HEAD'), y1 = git(d, 'rev-parse', 'y');
      git(d, 'merge', '-q', '--no-edit', y1);                      // X2
      git(d, 'checkout', '-q', 'y');
      git(d, 'merge', '-q', '--no-edit', x1);                      // Y2
      fs.writeFileSync(path.join(d, 'f.txt'), f('one x', 'nine Y')); git(d, 'commit', '-qam', 'agent: line 9');
      agentHead = git(d, 'rev-parse', 'HEAD');
      git(d, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(d, 'f.txt'), f('one X', 'nine y')); git(d, 'commit', '-qam', 'main: line 1');
    },
  });
  assert.equal(git(w.dir, '--git-dir', path.join(w.dir, 'seed/.git'), 'merge-base', '--all', 'main', agentHead).split('\n').length, 2);
  git(w.work.a, 'fetch', '-q', path.join(w.dir, 'seed'), 'y');
  git(w.work.a, 'reset', '-q', '--hard', agentHead);
  await w.tool('a', 'claim', { paths: ['f.txt'], summary: 'line 9' });
  const pushed = await w.push('a');
  assert.equal(pushed.events.find((e) => e.type === 'Preview').clean, true);
  await w.tool('a', 'submit', { summary: 'line 9' });
  assert.equal((await w.change('a')).state, 'landed');
  assert.equal(w.mainFile('f.txt'), f('one X', 'nine Y'));
});

engineTest('engine: the merge train takes changes in the order they were submitted', async (t) => {
  const w = await world(t, { config: { test_command: PASS_CMD, auto_land: true } });
  for (const a of ['a', 'b']) {
    await w.tool(a, 'claim', { paths: [`${a}.txt`], summary: a });
    w.write(a, `${a}.txt`, `${a}\n`);
    w.commit(a);
    await w.push(a);  // a first
  }
  await w.tool('b', 'submit', { summary: 'b' });  // b submitted first
  await w.tool('a', 'submit', { summary: 'a' });
  await sleep(2500);  // both runs finish before the first sweep collects them: one train with both
  let landed;
  for (let i = 0; i < 100 && !landed; i++) {
    const r = await w.sweep();
    const ls = r.events.filter((e) => e.type === 'Landed').map((e) => e.change_id);
    if (ls.length) landed = ls;
    else await sleep(200);
  }
  const ids = Object.fromEntries((await w.state()).changes.map((c) => [c.agent_id, c.change_id]));
  assert.deepEqual(landed, [ids.b, ids.a]);  // one train, b's merge first
});

// Every agent adds shared.js with its own content: each pair conflicts, so one of them lands.
async function clash(t, agents, env = {}) {
  const w = await world(t, { agents, env, config: { auto_land: false } });
  for (const a of agents) {
    await w.tool(a, 'claim', { paths: ['shared.js'], summary: a });
    w.write(a, 'shared.js', `export const who = '${a}';\n`);
    w.commit(a);
    await w.push(a);
    await w.tool(a, 'submit', { summary: a });
  }
  return w;
}

engineTest('engine: pick proves its plan with the solver\'s UNSAT answer, and tells the left-out agents why', async (t) => {
  const w = await clash(t, ['a', 'b', 'c']);
  const r = await w.tool('rev', 'pick', { task_id: 't1' }, 'reviewer');
  assert.ok(!r.isError, r.text);
  assert.equal(r.land_together?.length, 1, r.text);
  assert.equal(r.optimal, true);
  assert.match(r.proof_sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.left_out.length, 2);
  const chosen = r.land_together[0];
  for (const lo of r.left_out) {
    assert.notEqual(lo.change_id, chosen);
    assert.equal(lo.why, `conflicts with ${chosen} in shared.js`);  // the other change, never itself
  }
  const leftAgent = (await w.state()).changes.find((c) => c.change_id === r.left_out[0].change_id).agent_id;
  const status = await w.tool(leftAgent, 'status');
  assert.match(status.text, new RegExp(`pick left your change out: it conflicts with ${chosen} in shared\\.js`));
});

engineTest('engine: a solver that gives up (Unknown) is no proof', async (t) => {
  // Five mutually exclusive changes: proving no two fit takes the solver more than one conflict.
  const w = await clash(t, ['a', 'b', 'c', 'd', 'e'], { CONVERGE_SAT_CONFLICT_LIMIT: '1' });
  const r = await w.tool('rev', 'pick', { task_id: 't1' }, 'reviewer');
  assert.ok(!r.isError, r.text);
  assert.equal(r.land_together.length, 1);
  assert.equal(r.optimal, false);
  assert.equal(r.proof_sha256, '');
  assert.match(r.reason, /best found/);
});

engineTest('engine: nothing lands unsealed when no receipt key can be had', async (t) => {
  const w = await world(t, { mode: 'compete', config: { auto_land: false }, engineArgs: ['--receipt-key', '/nonexistent-dir/receipt.key'] });
  await w.tool('a', 'claim', { paths: ['a.txt'], summary: 'a' });
  w.write('a', 'a.txt', 'a\n');
  w.commit('a');
  await w.push('a');
  await w.tool('a', 'submit', { summary: 'a' });
  const shipped = await w.tool('rev', 'ship', { change_id: (await w.change('a')).change_id }, 'reviewer');
  assert.equal(shipped.isError, true);
  assert.match(shipped.text, /no landing-receipt signing key/);
  assert.deepEqual(w.mainFiles(), ['README.md']);
});

engineTest('engine: a re-run whose counts differ from the report does not reproduce it', async (t) => {
  const w = await world(t, { config: { auto_land: false, check_claims: true } });
  await w.tool('a', 'claim', { paths: ['a.txt'], summary: 'a' });
  w.write('a', 'a.txt', 'a\n');
  w.commit('a');
  await w.push('a');
  await w.tool('a', 'submit', { summary: 'a', tests: { command: COUNTS_CMD, passed: 5, failed: 0 } });
  const c = await w.until('the claim re-run', async () => { const c = await w.change('a'); return c.claim_check && c; });
  assert.notEqual(c.claim_check.exit_code, 0);
  assert.match(c.claim_check.output_tail, /reported 5 passed, 0 failed; the re-run shows 3 passed, 0 failed/);

  await w.tool('a', 'submit', { summary: 'a', tests: { command: COUNTS_CMD, passed: 3, failed: 0 } });
  const ok = await w.until('the second re-run', async () => { const c = await w.change('a'); return c.claim_check && c; });
  assert.equal(ok.claim_check.exit_code, 0);
});

engineTest('engine: a claim unlocks deleting only the documentation it names', async (t) => {
  const w = await world(t, {
    config: { auto_land: false },
    seed: (d) => {
      fs.writeFileSync(path.join(d, 'one.md'), 'one true line\nanother\n');
      fs.writeFileSync(path.join(d, 'two.md'), 'two true line\nanother\n');
      fs.writeFileSync(path.join(d, 'code.txt'), 'version 3 of the code\n');
      git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
    },
  });
  await w.tool('a', 'claim', { paths: ['one.md', 'two.md'], summary: 'docs' });
  w.write('a', 'one.md', 'another\n');
  w.write('a', 'two.md', 'another\n');
  w.commit('a');
  await w.push('a');
  const claim = { statement: 'one.md was wrong: the code says version 3', file: 'code.txt', excerpt: 'version 3 of the code' };
  await w.tool('a', 'submit', { summary: 'docs', claims: [claim] });
  const status = await w.tool('a', 'status');
  assert.match(status.text, /no claim backing the removal from two\.md/);
  const shipped = await w.tool('rev', 'ship', { change_id: (await w.change('a')).change_id }, 'reviewer');
  assert.match(shipped.text, /without a claim backing the removal from two\.md/);
});

engineTest('engine: a conflict hunk carries the base text of its range, in status and the read model', async (t) => {
  const w = await world(t, {
    config: { auto_land: false },
    seed: (d) => { fs.writeFileSync(path.join(d, "f.js"), lines(9)); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); },
  });
  for (const a of ['a', 'b']) {
    await w.tool(a, 'claim', { paths: ["f.js"], summary: a });
    w.write(a, "f.js", lines(9, (i) => (i === 5 ? `line 5 by ${a}` : `line ${i}`)));
    w.commit(a);
    await w.push(a);
    await w.tool(a, 'submit', { summary: a });
  }
  const shipped = await w.tool('rev', 'ship', { change_id: (await w.change('a')).change_id }, 'reviewer');
  assert.ok(!shipped.isError, shipped.text);
  const st = JSON.parse((await w.tool('b', 'status')).text);
  const hunk = st.preview.conflicts.find((h) => h.path === "f.js");
  assert.ok(hunk, JSON.stringify(st.preview));
  assert.equal(hunk.base, 'line 5\n');
  assert.equal(hunk.ours, 'line 5 by a\n');
  assert.equal(hunk.theirs, 'line 5 by b\n');
});

engineTest('engine: an auto-land records the other contenders for its task in the git note', async (t) => {
  const w = await world(t, { config: { auto_land: true } });
  for (const a of ['a', 'b']) {
    await w.tool(a, 'claim', { paths: [`${a}.txt`], summary: a });
    w.write(a, `${a}.txt`, `${a}\n`);
    w.commit(a);
    await w.push(a);
  }
  for (const a of ['a', 'b']) await w.tool(a, 'submit', { summary: a });
  await w.until('both landed', async () => (await w.state()).changes.every((c) => c.state === 'landed'));
  const ids = Object.fromEntries((await w.state()).changes.map((c) => [c.agent_id, c]));
  const note = (commit) => JSON.parse(execFileSync('git', ['--git-dir', w.mainGit, 'notes', '--ref=converge', 'show', commit], { encoding: 'utf8' }));
  assert.deepEqual(note(ids.a.landed_commit).contenders_considered, [ids.b.change_id]);
  assert.deepEqual(note(ids.b.landed_commit).contenders_considered, [ids.a.change_id]);
});

engineTest('engine: a merge train landing records the other contenders in the git note', async (t) => {
  const w = await world(t, { config: { test_command: PASS_CMD, auto_land: true } });
  for (const a of ['a', 'b']) {
    await w.tool(a, 'claim', { paths: [`${a}.txt`], summary: a });
    w.write(a, `${a}.txt`, `${a}\n`);
    w.commit(a);
    await w.push(a);
  }
  for (const a of ['a', 'b']) await w.tool(a, 'submit', { summary: a });
  await w.until('both landed', async () => (await w.state()).changes.every((c) => c.state === 'landed'));
  const ids = Object.fromEntries((await w.state()).changes.map((c) => [c.agent_id, c]));
  const note = (commit) => JSON.parse(execFileSync('git', ['--git-dir', w.mainGit, 'notes', '--ref=converge', 'show', commit], { encoding: 'utf8' }));
  assert.equal(note(ids.a.landed_commit).receipt.includes('merge train'), true);
  assert.deepEqual(note(ids.a.landed_commit).contenders_considered, [ids.b.change_id]);
  assert.deepEqual(note(ids.b.landed_commit).contenders_considered, [ids.a.change_id]);
});

// What `converge seed` pushes: the codebase laid over main (its README replacing main's), with the
// codebase's own unrelated history as the second parent. Replacing main's README deletes a
// documentation line: without a claim backing that the change is held, and the sweep must say why
// (it once sat `submitted` forever with a bare {"events":[],"pending":0}); with the claim the seed
// now gives, it lands.
async function seedLike(t, claims) {
  const w = await world(t, { agents: ['a'], config: { test_command: PASS_CMD, auto_land: true } });
  const code = path.join(w.dir, 'codebase');
  git(w.dir, 'init', '-q', '-b', 'main', code);
  fs.writeFileSync(path.join(code, 'README.md'), '# pocket\n\nA pocket of small tools.\n');
  fs.writeFileSync(path.join(code, 'app.js'), 'export const x = 1;\n');
  git(code, 'add', '-A');
  git(code, 'commit', '-qm', 'codebase');
  const head = git(code, 'rev-parse', 'HEAD');
  git(w.work.a, 'fetch', '-q', code, 'main');
  const base = git(w.work.a, 'rev-parse', 'HEAD');
  git(w.work.a, 'read-tree', '-m', '-u', head);
  const tree = git(w.work.a, 'write-tree');
  const seed = git(w.work.a, 'commit-tree', tree, '-p', base, '-p', head, '-m', 'Seed: codebase');
  git(w.work.a, 'reset', '-q', '--hard', seed);
  await w.tool('a', 'claim', { paths: ['README.md', 'app.js'], summary: 'the whole codebase' });
  await w.push('a');
  const sub = await w.tool('a', 'submit', { summary: 'Seed', ...(claims ? { claims } : {}) });
  assert.ok(!sub.isError, sub.text);
  return w;
}

engineTest('engine: a seed that replaces main\'s README is held with a reason the sweep carries', async (t) => {
  const w = await seedLike(t);
  const r = await w.until('a train_blocked reason', async () => {
    const s = await w.sweep();
    return s.train_blocked;
  });
  assert.match(r, /documentation lines without a claim/);
  assert.equal((await w.change('a')).state, 'submitted');
});

engineTest('engine: a seed that replaces main\'s README, with a claim backing it, lands', async (t) => {
  const w = await seedLike(t, [{ statement: 'README.md is replaced by the codebase\'s own README.md', file: 'README.md', excerpt: 'A pocket of small tools.' }]);
  await w.until('the seed to land', async () => (await w.change('a')).state === 'landed');
  assert.match(w.mainFile('README.md'), /pocket of small tools/);
});
