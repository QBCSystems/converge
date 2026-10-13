// Tests for the verification runner. Unfenced (jail '') against a local repository used as the
// remote (the sandbox has no network). Node's built-in test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runJob, createRunner, probeFence } from '../runner/runner.mjs';

// The runner lives in converge's Linux containers: it runs every script with /bin/sh and probes a Landlock jail.
// Those parts cannot run on a Windows host; the rest of this file does.
const POSIX_ONLY = process.platform === 'win32' ? 'the runner runs in Linux containers (/bin/sh)' : false;

// Build a throwaway git repo with one commit and return { dir, commit }.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-src-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'a']);
  git(['config', 'user.email', 'a@a']);
  writeFileSync(join(dir, 's.sh'), 'echo hello\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'one']);
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  return { dir, commit };
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'runner-root-'));
}

function job(src, commit, over = {}) {
  return {
    kind: 'project',
    change_id: 'c-1',
    commit,
    remote: src.dir,
    token: '',
    ref: 'main',
    script: 'sh s.sh',
    timeout_s: 30,
    workspace: 'a/b',
    ...over,
  };
}

test('a passing script captures its output', { skip: POSIX_ONLY }, async () => {
  const src = makeRepo();
  const root = makeRoot();
  try {
    const r = await runJob(job(src, src.commit), { root, jail: '', git: 'git' });
    assert.equal(r.exit_code, 0);
    assert.equal(r.timed_out, false);
    assert.equal(r.commit, src.commit);
    assert.equal(r.command, 'sh s.sh');
    assert.match(r.output_tail, /hello/);
    assert.match(r.output_sha256, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(join(root, 'ws-a_b', '.git')));
    assert.ok(r.duration_ms >= 0);
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failing script reports its exit code', { skip: POSIX_ONLY }, async () => {
  const src = makeRepo();
  const root = makeRoot();
  try {
    const r = await runJob(job(src, src.commit, { script: 'exit 3' }), { root, jail: '', git: 'git' });
    assert.equal(r.exit_code, 3);
    assert.equal(r.timed_out, false);
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a hanging script times out quickly', { skip: POSIX_ONLY }, async () => {
  const src = makeRepo();
  const root = makeRoot();
  try {
    const started = Date.now();
    const r = await runJob(job(src, src.commit, { script: 'sleep 30', timeout_s: 1 }), { root, jail: '', git: 'git' });
    const elapsed = Date.now() - started;
    assert.equal(r.timed_out, true);
    assert.ok(elapsed < 15000, 'timeout finished quickly (' + elapsed + 'ms)');
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing commit is a result, not a throw', async () => {
  const src = makeRepo();
  const root = makeRoot();
  try {
    const r = await runJob(job(src, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), { root, jail: '', git: 'git' });
    assert.equal(r.exit_code, -1);
    assert.equal(r.timed_out, false);
    assert.ok(r.output_tail.length > 0);
    assert.match(r.output_sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('the queue runs two jobs of one workspace one after the other', { skip: POSIX_ONLY }, async () => {
  const src = makeRepo();
  const root = makeRoot();
  const order = [];
  try {
    const runner = createRunner({ root, jail: '', git: 'git', parallel: 4 });
    const a = runner.submit(job(src, src.commit, { workspace: 'w', script: 'sleep 1; echo one' })).then((r) => {
      order.push('one');
      return r;
    });
    const b = runner.submit(job(src, src.commit, { workspace: 'w', script: 'echo two' })).then((r) => {
      order.push('two');
      return r;
    });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.exit_code, 0);
    assert.equal(rb.exit_code, 0);
    assert.deepEqual(order, ['one', 'two']);
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('the fence probe refuses a runner with no jail, or one whose jail does not fence', { skip: POSIX_ONLY }, async () => {
  const root = makeRoot();
  try {
    assert.equal((await probeFence('', root)).state, 'failed');
    assert.equal((await probeFence('', root, { allowUnfenced: true })).state, 'unfenced');
    assert.equal((await probeFence(join(root, 'no-such-jail'), root)).state, 'failed');
    // A "jail" that just runs the command: the probe's write outside gets through, so it fails.
    const fake = join(root, 'fake-jail');
    writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n', { mode: 0o755 });
    const f = await probeFence(fake, root);
    assert.equal(f.state, 'failed');
    assert.match(f.reason, /cannot write outside/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
