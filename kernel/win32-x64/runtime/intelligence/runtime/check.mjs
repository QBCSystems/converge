// The agent runtime held to what it promises, with a scripted mind (no model): writes only where it
// may, commands run only once aios allows them (by the host's exec hook, here a plain one) and
// policed afterwards, every decision on the ledger, every cycle recorded, and a rewind that puts the
// entity and the work tree back.
//
//   node intelligence/runtime/check.mjs        (needs build/aios-agent-control; AIOS_AGENT_CONTROL overrides)
//
// Starts its own agent-control on a spare port with a throwaway root. Exit code 1 if any check fails.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureService } from './control.mjs';
import { runAgent } from './agent.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-runtime-check-'));
const work = path.join(base, 'work');
const outside = path.join(base, 'outside');
fs.mkdirSync(work);
fs.mkdirSync(outside);
const git = (...a) => execFileSync('git', ['-C', work, ...a], { encoding: 'utf8' });
git('init', '-q');
fs.writeFileSync(path.join(work, 'notes.md'), 'one\n');
fs.writeFileSync(path.join(work, 'locked.md'), 'locked\n');
git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start');

const script = path.join(base, 'script.jsonl');
const steps = [
  { action: 'edit', path: 'notes.md', old: 'one\n', new: 'one\ntwo\n' },                     // 1 allowed
  { action: 'edit', path: 'locked.md', old: 'locked\n', new: 'changed\n' },                  // 2 refused: not writable
  { action: 'run', command: 'echo sneaky > locked.md' },                                     // 3 ran, change undone
  { action: 'run', command: 'echo hi' },                                                     // 4 run by the host, as allowed
  { action: 'run', command: 'printf "#!/bin/sh\\n" > .git/hooks/post-commit; chmod +x .git/hooks/post-commit' }, // 5 restored
  { action: 'edit', path: 'notes.md', old: 'two\n', new: 'two\nthree\n' },                   // 6 allowed
  { action: 'rewind', to: 6 },                                                               // 7 back to before #6
  { action: 'run', command: 'cat notes.md' },                                                // 8 sees one, two
  { action: 'done', summary: 'checked' },
];
fs.writeFileSync(script, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');

let failures = 0, checks = 0;
const check = (ok, what, detail = '') => { checks++; if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ': ' + detail : ''}`); };

const ctl = await ensureService({ dataDir: path.join(base, 'svc'), port: 7000 + (process.pid % 900) });
const seen = [];
const asked = [];
const res = await runAgent({
  ctl, label: 'runtime-check', mind: { name: 'script', model: script }, workdir: work, scratch: path.join(base, 'scratch'),
  prompt: 'check', maxCycles: 12, log: (e) => seen.push(e),
  hooks: {
    start: (ctx) => ctx.setWritable(['notes.md']),
    writeHint: 'You may write only notes.md.',
    // The host's part: run what aios allowed. A real host fences it (converge: its jail); this check
    // runs it plainly and keeps what it was asked.
    exec(req) {
      asked.push(req);
      const r = Array.isArray(req.command)
        ? spawnSync(req.command[0], req.command.slice(1), { cwd: req.cwd, env: req.env, encoding: 'utf8' })
        : spawnSync('/bin/sh', ['-c', req.command], { cwd: req.cwd, env: req.env, encoding: 'utf8' });
      return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    },
  },
});
const obs = (n) => String(seen.find((e) => e.cycle === n)?.observation || '');

check(res.finished?.summary === 'checked', 'the run finishes', JSON.stringify(res.finished));
check(/^edited notes\.md/.test(obs(1)), 'a writable path is written');
check(/^refused by aios/.test(obs(2)) && fs.readFileSync(path.join(work, 'locked.md'), 'utf8') === 'locked\n', 'an unwritable path is refused', obs(2).split('\n')[0]);
check(/reverted: the command changed locked\.md/.test(obs(3)) && fs.readFileSync(path.join(work, 'locked.md'), 'utf8') === 'locked\n', 'a shell write to an unwritable path is undone');
const echo = asked.find((r) => r.command === 'echo hi');
check(/^exit 0\nhi/.test(obs(4)) && echo && echo.readWrite.includes(fs.realpathSync(work)) && !echo.readWrite.some((p) => p.startsWith(outside)) && !echo.network && Object.keys(echo.env).every((k) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'npm_config_cache'].includes(k)),
  'a command runs by the host, asked to let it write only the work tree and scratch, no network, a minimal environment', obs(4).split('\n')[0]);
check(/refused and restored: .*\.git\/hooks\/post-commit/.test(obs(5)) && !fs.existsSync(path.join(work, '.git/hooks/post-commit')), 'a planted git hook is removed');
check(/^rewound to the start of cycle 6/.test(obs(7)), 'rewind to a cycle', obs(7));
check(/one\ntwo\n?$/.test(obs(8).replace(/^exit 0\n/, '')) && fs.readFileSync(path.join(work, 'notes.md'), 'utf8') === 'one\ntwo\n', 'after the rewind the work tree is as it was', JSON.stringify(fs.readFileSync(path.join(work, 'notes.md'), 'utf8')));

const recs = await ctl.call({ op: 'cycle.records', entity: res.entity });
const byCycle = new Map((recs.cycles || []).map((c) => [c.cycle, c]));
check(recs.ok && byCycle.size >= 8, 'every cycle is recorded, also after the entity ended', `${byCycle.size} records`);
check(byCycle.get(2)?.verdict === 'refused' && byCycle.get(1)?.verdict === 'allowed', 'the record carries each verdict');
check(String(byCycle.get(1)?.reply || '').includes('"notes.md"') && Boolean(byCycle.get(1)?.checkpoint) && /^[0-9a-f]{40}$/.test(String(byCycle.get(1)?.tree || '')),
  'the record carries the reply, the checkpoint and the work tree');
const refused = res.ledger.filter((e) => /refus/i.test(e.kind)).length;
const exercised = res.ledger.filter((e) => /exercis/i.test(e.kind)).length;
check(refused >= 2 && exercised >= 5, 'allowed and refused actions are on the aios ledger', `${exercised} exercised, ${refused} refused`);

// Stop the service this check started (its command line names its own root).
try { execFileSync('pkill', ['-f', path.join(base, 'svc', 'aios', 'root')]); } catch { /* already gone */ }
fs.rmSync(base, { recursive: true, force: true });
console.log(`${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
