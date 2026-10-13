// The macOS agent fence (agents/fenced.mjs): the Seatbelt profile it generates, judged by a small model of how
// Seatbelt decides (the last rule that matches wins; subpath, literal and regex filters), so it runs on Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seatbeltProfile, agentPolicy, agentFence, AGENT_SECRETS } from '../agents/fenced.mjs';

// Parses "(allow|deny op... filter...)" lines; a rule with no filter matches every path.
function rules(profile) {
  const out = [];
  for (const line of profile.split('\n')) {
    const m = /^\((allow|deny) ([^()]*?)\s*((?:\(.*\))?)\)$/.exec(line.trim());
    if (!m || m[2] === '') continue;
    const filters = [...m[3].matchAll(/\((subpath|literal|regex|remote ip|local ip|target) #?"((?:[^"\\]|\\.)*)"\)|\((target) ([\w-]+)\)/g)]
      .map((f) => (f[3] ? { kind: 'target', value: f[4] } : { kind: f[1], value: f[2].replace(/\\(["\\])/g, '$1') }));
    out.push({ action: m[1], ops: m[2].split(/\s+/), filters, raw: line });
  }
  return out;
}
const opMatches = (ruleOp, op) => ruleOp === op || (ruleOp.endsWith('*') && op.startsWith(ruleOp.slice(0, -1)));
function decide(profile, op, target) {
  let verdict = 'deny';   // (deny default) unless the profile says otherwise
  for (const r of rules(profile)) {
    if (r.ops.includes('default')) { verdict = r.action; continue; }
    if (!r.ops.some((o) => opMatches(o, op))) continue;
    const hit = !r.filters.length || r.filters.some((f) => (f.kind === 'subpath' ? target === f.value || target.startsWith(f.value.replace(/\/$/, '') + '/')
      : f.kind === 'literal' ? target === f.value
        : f.kind === 'regex' ? new RegExp(f.value).test(target)
          : f.kind === 'remote ip' || f.kind === 'local ip' ? (f.value === '*:*' || f.value === target || f.value === `*:${target.split(':')[1]}`)
            : false));
    if (hit) verdict = r.action;
  }
  return verdict;
}

const HOME = '/Users/example';
const RUN = `${HOME}/.converge-local/data/runs/demo-1/t1`;
const REPO = `${RUN}/repo`;
const policy = agentPolicy({ home: HOME, workdir: REPO, stateDir: RUN, tmp: ['/private/tmp'] });
const P = seatbeltProfile(policy);

test('the agent writes its checkout, its run directory and tmp', () => {
  for (const f of [`${REPO}/src/a.js`, `${REPO}/.git/index`, `${RUN}/universal-agent.log`, '/private/tmp/x']) assert.equal(decide(P, 'file-write-create', f), 'allow', f);
});

test('the agent writes nowhere else: not home, not another repo, not the system, not another run', () => {
  for (const f of [`${HOME}/.zshrc`, `${HOME}/repos/other/x.c`, '/usr/local/bin/git', '/etc/hosts', `${HOME}/.local/bin/git`,
    `${HOME}/.converge-local/data/runs/demo-1/t2/repo/a.js`, `${HOME}/.converge-local/data/engine.key`, `${HOME}/.config/fish/config.fish`]) {
    assert.equal(decide(P, 'file-write-data', f), 'deny', f);
  }
});

test('the agent reads the system and the owner\'s code, as under bubblewrap', () => {
  for (const f of ['/usr/bin/git', '/System/Library/dyld/x', `${HOME}/repos/other/x.c`, `${HOME}/.converge/config.json`]) assert.equal(decide(P, 'file-read-data', f), 'allow', f);
});

test('secrets are hidden: ~/.ssh, ~/.aws, ~/.gnupg, the platform\'s own data', () => {
  for (const f of [`${HOME}/.ssh/id_ed25519`, `${HOME}/.aws/credentials`, `${HOME}/.gnupg/private-keys-v1.d/k`, `${HOME}/.config/gh/hosts.yml`,
    `${HOME}/.converge-local/host-token`, `${HOME}/.converge-local/data/receipt.key`]) {
    assert.equal(decide(P, 'file-read-data', f), 'deny', f);
    assert.equal(decide(P, 'file-write-data', f), 'deny', f);
  }
  assert.ok(AGENT_SECRETS.includes('.ssh'));
});

test('its own run directory stays readable although it sits in the hidden platform data', () => {
  assert.equal(decide(P, 'file-read-data', `${REPO}/package.json`), 'allow');
});

test('its CLI state is writable, but not what would run later outside the fence', () => {
  for (const f of [`${HOME}/.claude/projects/x.jsonl`, `${HOME}/.claude.json`, `${HOME}/.claude.json.tmp.123`, `${HOME}/.codex/sessions/s`, `${HOME}/.converge/logs/l`])
    assert.equal(decide(P, 'file-write-create', f), 'allow', f);
  for (const f of [`${HOME}/.claude/settings.json`, `${HOME}/.claude/hooks/h.sh`, `${HOME}/.codex/config.toml`, `${HOME}/.converge/config.json`])
    assert.equal(decide(P, 'file-write-data', f), 'deny', f);
});

test('/dev/null is writable', () => {
  assert.equal(decide(P, 'file-write-data', '/dev/null'), 'allow');
  assert.equal(decide(P, 'file-write-data', '/dev/disk0'), 'deny');
});

test('network: the agent reaches its model and converge (as under bubblewrap); a fence without network reaches nothing but its ports', () => {
  assert.equal(decide(P, 'network-outbound', '*:443'), 'allow');
  assert.equal(decide(P, 'network-outbound', 'localhost:8787'), 'allow');
  const none = seatbeltProfile({ ...policy, network: false });
  assert.equal(decide(none, 'network-outbound', '*:443'), 'deny');
  assert.equal(decide(none, 'network-bind', '*:8080'), 'deny');
  const ports = seatbeltProfile({ ...policy, network: [443] });
  assert.equal(decide(ports, 'network-outbound', '*:443'), 'allow');
  assert.equal(decide(ports, 'network-outbound', '*:22'), 'deny');
});

test('nothing outside the sandbox is signalled or driven, and launchd/LaunchServices are not reachable by exec', () => {
  assert.match(P, /^\(deny signal\)$/m);
  assert.match(P, /^\(allow signal \(target same-sandbox\)\)$/m);
  assert.match(P, /^\(deny appleevent-send\)$/m);
  assert.equal(decide(P, 'process-exec', '/usr/bin/open'), 'deny');
  assert.equal(decide(P, 'process-exec', '/usr/bin/git'), 'allow');
});

test('paths are quoted for the profile language', () => {
  const q = seatbeltProfile({ writable: ['/Users/a "b"/c\\d'] });
  assert.match(q, /\(subpath "\/Users\/a \\"b\\"\/c\\\\d"\)/);
  assert.equal(decide(q, 'file-write-data', '/Users/a "b"/c\\d/x'), 'allow');
});

test('the profile is balanced and versioned', () => {
  assert.ok(P.startsWith('(version 1)\n(allow default)\n'));
  for (const line of P.trim().split('\n')) assert.equal((line.match(/\(/g) || []).length, (line.match(/\)/g) || []).length, line);
});

test('on Linux (bubblewrap per command), or with AGENT_SANDBOX=off, the agent starts as before', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'agentfence-state-'));
  try {
    const env = { AGENT_SANDBOX: 'require' };
    const r = agentFence({ cmd: '/usr/bin/node', args: ['ua.cjs'], env, workdir: '/w', stateDir: state });
    if (process.platform === 'darwin') { assert.equal(r.how, 'seatbelt'); if (r.env.CONVERGE_BASH) assert.match(r.env.CONVERGE_BASH, /aios-sh$/); }
    else if (process.platform === 'win32') {
      // Windows: the whole agent under converge-jail --agent, its work tree writable, aios-sh as its shell.
      assert.match(r.how, /converge-jail --agent/);
      assert.equal(r.args[0], '--agent');
      assert.ok(r.args.includes('/w'));
      assert.deepEqual(r.args.slice(r.args.indexOf('--')), ['--', '/usr/bin/node', 'ua.cjs']);
      assert.match(r.env.CONVERGE_BASH, /aios-sh(\.exe)?$/);
    } else {
      // Linux: no whole-agent fence, but the same shell as everywhere (aios-sh from the kernel bundle, when it has one).
      assert.deepEqual({ ...r, env: { ...r.env, CONVERGE_BASH: undefined } }, { cmd: '/usr/bin/node', args: ['ua.cjs'], env: { ...env, CONVERGE_BASH: undefined }, how: '' });
      if (r.env.CONVERGE_BASH) assert.match(r.env.CONVERGE_BASH, /aios-sh$/);
    }
    const off = agentFence({ cmd: '/usr/bin/node', args: ['ua.cjs'], env: { AGENT_SANDBOX: 'off' }, workdir: '/w', stateDir: state });
    assert.equal(off.cmd, '/usr/bin/node');
    assert.equal(off.how, '');
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

// Fenced on macOS, the agent's own temp folder is made first: if it cannot be, the agent does not start (it would run
// with a TMPDIR that does not exist), rather than the error being swallowed.
test('a state directory that cannot be made stops the agent from starting', { skip: process.platform !== 'darwin' }, () => {
  assert.throws(() => agentFence({ cmd: '/usr/bin/node', args: ['ua.cjs'], env: { AGENT_SANDBOX: 'require' }, workdir: '/w', stateDir: '/dev/null/state' }), /ENOTDIR|ENOENT|not a directory/i);
});
