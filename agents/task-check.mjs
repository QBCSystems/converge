// One task's plan checks, judged: run fenced in a copy of main of its own, each check must run, and at least one must
// fail on main as it is now (else the task proves nothing), within its time, without the sandbox or a missing tool
// stopping it. The swarm's preflight runs it for every task of a plan at once; the planner (agents/plan.mjs) runs it for
// each task the moment that task is planned, and asks again for that one task alone when it is refused.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runFencedAsync } from './fenced.mjs';
import { checkCannotPass } from './check-guard.mjs';
import { runPlanChecks } from './check-progress.mjs';

/** Problems with task `t`'s checks ("task <key>: ..."), [] when they hold. `dir`: main's checkout; `base`: a scratch
 *  folder for the copy (task-<ti>); `big`: source files in a big codebase (0 when not big); `onEvent`: each result. */
export async function checkTask(t, ti, { dir, base, big = 0, onEvent = () => {} }) {
  const problems = [];
  const own = fs.existsSync(path.join(dir, '.git')) ? path.join(base, `task-${ti}`) : dir;
  // A copy of the files and .git as they are: a git clone checks every file out again, and converge's own git (first
  // on PATH) took seconds per task at it. Windows has no cp -a: cloned there.
  // Not spawnSync: each copy blocked the others (five tasks' copies took 0.1, 0.6, 0.7, 0.8 and 0.7 s, one after another).
  const copy = () => new Promise((resolve) => {
    const c = process.platform === 'win32' ? spawn('git', ['clone', '-q', '--shared', dir, own], { stdio: 'ignore' })
      : spawn('cp', [...(process.platform === 'linux' ? ['--reflink=auto'] : []), '-a', dir, own], { stdio: 'ignore' });
    c.on('error', () => resolve({ status: 1 }));
    c.on('exit', (code) => resolve({ status: code }));
  });
  const copyAt = Date.now();
  if (own !== dir && (await copy()).status !== 0) { problems.push(`cannot copy main to check task ${t.key}`); return problems; }
  const copyMs = own !== dir ? Date.now() - copyAt : null;
  // The checks run through runPlanChecks so each result is reported (opts.onCheckEvent) the moment it is known.
  const ran = new Map();
  await runPlanChecks([t], async (check) => {
    if (checkCannotPass(check)) return { code: null, broken: true };
    // Fenced: checks can come from the planner (a model), so none runs loose on this machine.
    const r = await runFencedAsync(check, own, { timeoutMs: 60_000 });
    ran.set(check, r);
    return { code: r.status, timedOut: r.timedOut, broken: !r.fenced };
  }, (e) => onEvent(e.type === 'task' ? { ...e, copyMs } : e));
  // A task with a check that fails on main proves its work with that one: another of its checks that already passes
  // is a guard that the task keeps what works (it runs on every hand-in), not a reason to plan again. Refused, it cost
  // a whole second planning round. A task none of whose checks fails on main proves nothing, and still goes back.
  const provesWork = (t.accept || []).some((c) => { const r = ran.get(c); return r && r.fenced && !r.timedOut && r.status !== 0 && !checkCannotPass(c); });
  for (const check of t.accept || []) {
    const unpassable = checkCannotPass(check);
    if (unpassable) { problems.push(`task ${t.key}: ${unpassable}: ${check.slice(0, 120)}`); continue; }
    const r = ran.get(check);
    if (!r.fenced) { problems.push(`cannot check safely: ${r.stderr}`); break; }
    // Failing on main is not enough: a check that is too slow, or that fails because something it needs is not
    // installed here, fails for every agent forever, however good its work (aios's OpenCL header, a full build).
    const out = `${r.stdout}\n${r.stderr}`;
    const missingHeader = /fatal error: ([\w./+-]+\.(?:h|hpp|hh)): No such file/.exec(out);
    const headerInRepo = missingHeader && spawnSync('git', ['-C', dir, 'ls-files', `*${path.basename(missingHeader[1])}`], { encoding: 'utf8' }).stdout.trim();
    const missingTool = /(?:^|\n)(?:\/bin\/sh: \d+: )?([\w.+-]+): (?:command )?not found/.exec(out);
    const denied = /[^\n]*(?:Permission denied|Read-only file system|Operation not permitted|\bEACCES\b|\bEROFS\b|\bEPERM\b)[^\n]*/.exec(out);
    const cmakeMissing = /Could NOT find ([\w-]+)|CMake Error[^\n]*\n[^\n]*(?:find_package|Could not find)[^\n]*/.exec(out);
    // On a big codebase, a check that drives its build system (cmake, make, cargo, gradle...) builds most of it on every
    // hand-in: fast to fail on main (the new test is not there yet), minutes once it is. Refused up front.
    if (big && /\b(cmake\s+(-S|--build)|make\b|ninja\b|cargo\s+(build|test)|gradle|mvn\b|bazel\b|dotnet\s+build)/.test(check)) problems.push(`task ${t.key}: a check runs the project's build system, which on this codebase (${big} source files) builds most of it on every hand-in and takes minutes. Compile only the test and the files it needs instead (for example g++ -Iinclude tests/x.cpp src/x.cpp -o /tmp/x && /tmp/x): ${check.slice(0, 120)}`);
    else if (r.timedOut) problems.push(`task ${t.key}: a check takes over 60 s on a fresh checkout (it builds too much). Converge runs it on every hand-in: check only what the task changes (compile the test and the few files it needs, or run one fast test): ${check.slice(0, 120)}`);
    else if (missingHeader && !headerInRepo) problems.push(`task ${t.key}: a check cannot run here: the header ${missingHeader[1]} is not installed (it is not part of the project). Check without the code that needs it: ${check.slice(0, 120)}`);
    else if (missingTool && !/expected|FAIL/.test(out.slice(0, missingTool.index))) problems.push(`task ${t.key}: a check needs ${missingTool[1]}, which is not installed here: ${check.slice(0, 120)}`);
    else if (cmakeMissing) problems.push(`task ${t.key}: a check's build cannot find ${cmakeMissing[1] || 'a package it needs'} here: ${check.slice(0, 120)}`);
    // A check the sandbox itself stops (it writes to /tmp, the home folder, anywhere outside its own checkout)
    // fails on main, which is what a good check does too: but it fails the same once the work is done, so the
    // task could never land whatever the agent did (seen: two of three agents' correct work held by
    // "mkdir: /tmp/cfa: Permission denied"). Said back to the planner, which writes it again.
    else if (denied) problems.push(`task ${t.key}: a check is stopped by the sandbox, not by the missing work (${denied[0].trim().slice(0, 140)}): a check may create files only inside the repository folder it runs in or under "$TMPDIR", never /tmp, /var/tmp or the home folder: ${check.slice(0, 120)}`);
    else if (r.status === 0 && !provesWork) problems.push(`task ${t.key}: its checks already pass on main, so none of them proves the work: ${check.slice(0, 120)}`);
    else if (/SyntaxError|syntax error/.test(r.stderr)) {
      // In Node.js ESM, importing an export or module that has not yet been implemented throws:
      // "SyntaxError: The requested module ... does not provide an export named '...'"
      // That is a valid, expected test failure on main before the agent writes the export.
      const isMissingExport = /does not provide an export named|Cannot find module/.test(r.stderr);
      if (!isMissingExport) {
        problems.push(`task ${t.key}: a check is broken (${r.stderr.split('\n').find((l) => /yntax/.test(l))?.slice(0, 160)}): ${check.slice(0, 120)}`);
      }
    }
  }

  return problems;
}
