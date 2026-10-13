'use strict';
// SIGNALLING A SHELL IS NOT SIGNALLING THE WORK.
//
// `bash -c "npm test"` is not the process doing anything. npm spawns the test
// runner, the runner spawns a process per test file, and those are what hold the
// CPU. Signal the shell alone and the tree carries on — which is exactly what was
// reported (2026-08-04, machine `arch`): Stop landed, the turn ended, and
// `npm test` kept running on the box afterwards.
//
// cancelCurrentCommand already TRIED to handle this — `process.kill(-pid)` first,
// "a shell running npm test is the parent of the process doing the work". But the
// command was spawned WITHOUT `detached: true`, so the child is not a process
// group leader: its pgid is the harness's, not its own pid. `-pid` therefore
// names a group that does not exist, ESRCH, straight into an empty catch. Every
// cancel silently degraded to signalling the shell. Measured:
//
//   as-shipped | group kill: FAILED ESRCH | grandchild: STILL RUNNING
//   detached   | group kill: sent         | grandchild: dead
//
// So why not just add `detached: true`? Because it trades one orphan class for
// another. Today every command runs inside the HARNESS's process group, which is
// what lets a front-end's hard stop (`process.kill(-harnessPid)`, see
// gui/server.js killTree) sweep the whole run in one signal. Move commands into
// their own groups and they escape that sweep — and a SIGKILLed harness runs no
// cleanup handlers, so nothing would be left to catch them.
//
// Walk the tree instead. It fixes the cancel without giving up the group sweep,
// so neither path leaks.
//
// ENUMERATE BEFORE SIGNALLING. Once the shell dies its children are reparented to
// init and the ppid links that identify them as ours are gone forever. Callers
// escalating SIGINT → SIGKILL therefore accumulate what they have seen (see
// `seen`) rather than re-deriving it from a tree that is already collapsing.

const fs = require('fs');
const { execFileSync } = require('child_process');

// pid -> [child pids], read in ONE pass over /proc rather than one pass per
// level. Field 4 of /proc/<pid>/stat is the ppid, but fields are positional
// AFTER comm — and comm is an arbitrary process name in parentheses that may
// itself contain spaces and parentheses ("(my (odd) name)"). Split from the LAST
// ')' so a hostile-looking process name cannot shift the field offsets.
function procChildMap() {
  const map = new Map();
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return null; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; } // exited mid-walk
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const ppid = Number(stat.slice(close + 1).trim().split(/\s+/)[1]);
    if (!Number.isFinite(ppid)) continue;
    const kids = map.get(ppid);
    if (kids) kids.push(Number(name)); else map.set(ppid, [Number(name)]);
  }
  return map;
}

// Fallback for platforms with no /proc (macOS, BSD). One pgrep per level, which
// is why /proc is preferred — but correctness first.
function pgrepChildren(pid) {
  try {
    return String(execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
      .split('\n').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  } catch { return []; } // no children, or no pgrep
}

// Every descendant of `pid`, deepest LAST (breadth-first order). `pid` itself is
// never included — the caller owns the root, and killing it is its decision.
function descendants(pid, { map = undefined } = {}) {
  const root = Number(pid);
  if (!Number.isFinite(root) || root <= 0) return [];
  const kidsOf = map === undefined ? procChildMap() : map;
  const out = [];
  const seen = new Set([root]);
  const queue = [root];
  // A cycle is impossible in a real process tree, but a stale/garbled read must
  // not be able to spin here.
  while (queue.length && out.length < 4096) {
    const cur = queue.shift();
    const kids = kidsOf ? (kidsOf.get(cur) || []) : pgrepChildren(cur);
    for (const k of kids) {
      if (seen.has(k)) continue;
      seen.add(k); out.push(k); queue.push(k);
    }
  }
  return out;
}

function signalPid(pid, signal) {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, signal); return true; } catch { return false; }
}

// Signal `pid` and everything under it. Returns the pids signalled, so a caller
// can accumulate them and re-signal on escalation once the tree has collapsed.
//
// DEEPEST FIRST, root last: killing the root first reparents everything below it
// to init in the same instant, and on a slow read that is the difference between
// sweeping the tree and orphaning it.
//
// `also` re-signals pids from an earlier sweep (see the module note) — they may
// already be gone, which is not an error.
function killTree(pid, signal = 'SIGTERM', { also = [] } = {}) {
  const root = Number(pid);
  const hit = [];
  // Windows has no process groups or /proc; taskkill /T walks the tree itself.
  if (process.platform === 'win32') {
    const tk = fs.existsSync('C:\\Windows\\System32\\taskkill.exe') ? 'C:\\Windows\\System32\\taskkill.exe' : 'taskkill';
    for (const p of [...also, root]) {
      if (!Number.isFinite(p) || p <= 0) continue;
      try { execFileSync(tk, ['/PID', String(p), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); hit.push(p); } catch { /* already gone, or timed out */ }
    }
    return hit;
  }
  const kin = descendants(root);
  // `also` first: those are from a previous sweep, so they are the most likely to
  // have been orphaned out of reach of this one.
  for (const p of [...also].reverse()) if (signalPid(p, signal)) hit.push(p);
  for (const p of kin.slice().reverse()) if (signalPid(p, signal)) hit.push(p);
  // The process group too, when the root happens to lead one (a `detached` spawn):
  // it costs one syscall and catches anything forked between the walk and now.
  try { process.kill(-root, signal); } catch { /* not a group leader — the walk covered it */ }
  if (signalPid(root, signal)) hit.push(root);
  return hit;
}

module.exports = { killTree, descendants, procChildMap };
