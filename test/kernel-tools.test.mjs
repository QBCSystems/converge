import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { kernelDir, kernelOnPath, chownTree, processTable, kernelBin } from '../agents/common.mjs';
import { shellArgv } from '../agents/fenced.mjs';

// The kernel's tools stand in for the machine's: git is aios-git, the shell aios-sh, and no OS program (ps, chown) is needed.

const k = kernelDir();
const haveGit = !!kernelBin('git');

test('kernelOnPath puts the kernel bin first, once, and CONVERGE_GIT=host leaves PATH alone', { skip: haveGit ? false : 'no kernel git here' }, () => {
  const saved = { PATH: process.env.PATH, host: process.env.CONVERGE_GIT };
  try {
    const bin = path.join(k, 'bin');
    process.env.CONVERGE_GIT = 'host';
    process.env.PATH = '/usr/bin';
    kernelOnPath();
    assert.equal(process.env.PATH, '/usr/bin');
    delete process.env.CONVERGE_GIT;
    kernelOnPath();
    kernelOnPath();
    assert.equal(process.env.PATH, bin + path.delimiter + '/usr/bin');
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
    assert.match(r.stdout, /\(aios\)/, `git on PATH is aios-git: ${r.stdout}`);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.host === undefined) delete process.env.CONVERGE_GIT; else process.env.CONVERGE_GIT = saved.host;
  }
});

test('aios-git makes and serves a repository the way a platform needs: hooks/, a post-receive run by a push, checkout-index', { skip: haveGit ? false : 'no kernel git here' }, () => {
  const git = kernelBin('git');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-git-'));
  try {
    const run = (cwd, ...a) => spawnSync(git, a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const bare = path.join(d, 'bare.git');
    assert.equal(run(d, 'init', '-q', '--bare', bare).status, 0);
    assert.ok(fs.statSync(path.join(bare, 'hooks')).isDirectory(), 'init makes hooks/');
    const w = path.join(d, 'w');
    assert.equal(run(d, 'init', '-q', '-b', 'main', w).status, 0);
    fs.writeFileSync(path.join(w, 'f.txt'), 'one\n');
    run(w, 'add', '-A'); run(w, 'commit', '-qm', 'one');
    // checkout-index puts the index's files back
    fs.writeFileSync(path.join(w, 'f.txt'), 'changed\n');
    assert.equal(run(w, 'checkout-index', '-a', '-f').status, 0);
    assert.equal(fs.readFileSync(path.join(w, 'f.txt'), 'utf8'), 'one\n');
    // (the client's pack comes from the host's git: the oracle) a smart-HTTP push runs hooks/post-receive in the receiving repository, with "old new ref" on its standard input
    const seen = path.join(d, 'seen.txt');
    fs.writeFileSync(path.join(bare, 'hooks', 'post-receive'), `#!/bin/sh\nwhile read old new ref; do echo "$ref $new" >> '${seen}'; done\n`, { mode: 0o755 });
    const head = run(w, 'rev-parse', 'HEAD').stdout.trim();
    const adv = spawnSync(git, ['receive-pack', '--stateless-rpc', '--advertise-refs', bare], { encoding: 'buffer' });
    assert.equal(adv.status, 0);
    const pack = spawnSync('git', ['pack-objects', '--revs', '--stdout'], { cwd: w, input: `${head}\n` });
    assert.equal(pack.status, 0, String(pack.stderr));
    const zero = '0'.repeat(40);
    const cmd = `${zero} ${head} refs/heads/main\0 report-status side-band-64k`;
    const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, '0') + s);
    const body = Buffer.concat([pkt(cmd), Buffer.from('0000'), pack.stdout]);
    const r = spawnSync(git, ['receive-pack', '--stateless-rpc', bare], { input: body });
    assert.equal(r.status, 0);
    assert.match(fs.readFileSync(seen, 'utf8'), new RegExp(`refs/heads/main ${head}`));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('shellArgv is the kernel shell, and it runs what an agent writes', { skip: kernelBin('aios-sh') ? false : 'no kernel aios-sh here' }, () => {
  const argv = shellArgv('set -o pipefail; x=(a b); echo "${x[1]}" | sed s/b/ok/; yes | head -2');
  assert.match(argv[0], /aios-sh(\.exe)?$/);
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  assert.equal(r.stdout, 'ok\ny\ny\n');
});

test('chownTree walks a tree (links included) without a chown program', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chown-tree-'));
  try {
    fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a', 'b', 'f'), 'x');
    if (process.platform !== 'win32') fs.symlinkSync('/nonexistent', path.join(d, 'dangling'));
    const me = process.getuid ? process.getuid() : 0;
    chownTree(me, d);   // to ourselves: allowed anywhere, and a dangling link must not throw
    assert.ok(fs.existsSync(path.join(d, 'a', 'b', 'f')));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('processTable lists this process and its parent', { skip: process.platform === 'win32' ? 'no process table on Windows' : false }, () => {
  const t = processTable();
  const me = t.find((p) => p.pid === String(process.pid));
  assert.ok(me, 'this process is listed');
  assert.equal(me.ppid, String(process.ppid));
  assert.match(me.args, /node/);
});
