'use strict';
// A SILENT AGENT IS NOT A WEDGED AGENT.
//
// A CLI agent (cursor-agent, agy, claude, codex, gemini) runs its own shell tool
// and hands us NOTHING on stdout while that shell command is in flight — no
// partial output, no keepalive, not even a token. `ollama pull` of a multi-GB
// model is twenty quiet minutes on a good link and hours on a bad one. The
// provider layer's silence watchdog reads that as a wedge and SIGKILLs the whole
// process tree, which takes the download with it (watched live 2026-08-11: a
// turn ten tool calls deep, killed mid-pull, reported to the operator as
// "stalled: no output for 600s").
//
// Silence only means "wedged" when NOTHING underneath is working. That is a
// measurable question, not a guess: walk the agent's descendants and read what
// the kernel already counts for them — CPU time consumed, bytes moved, processes
// spawned. A download advances all three. An agent parked on a `sudo` password
// prompt or blocked on a dead socket advances none of them, and still gets
// killed exactly as it does today.
//
// This module ONLY observes. It never signals anything — see kill-tree.cjs for
// the other half.

const fs = require('fs');
const { execFileSync } = require('child_process');
const { descendants } = require('./kill-tree.cjs');

// Linux reports process CPU time in USER_HZ ticks. It is settable at kernel
// build time but is 100 on every mainstream build, and getconf is an exec per
// sample for a constant — a wrong denominator here only shifts a threshold.
const USER_HZ = 100;
// A tree wider than this is a runaway; sampling every member of it costs more
// than the answer is worth, and "is anything alive" is already answered by the
// first few hundred.
const MAX_PROCS = 256;

// One process's counters on Linux. Fields in /proc/<pid>/stat are positional
// AFTER comm, and comm is an arbitrary name in parens that may itself contain
// parens — split from the LAST ')' exactly as kill-tree.cjs does.
function linuxProc(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; } // exited mid-walk
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  // rest[0] is state, so utime (stat field 14) is rest[11] and stime is rest[12].
  const utime = Number(rest[11]), stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  // rchar/wchar count bytes through read()/write() — which is what a download
  // moves. read_bytes/write_bytes only count what actually reached the block
  // layer, so a write sitting in page cache reads as zero progress.
  let io = 0;
  try {
    for (const line of fs.readFileSync(`/proc/${pid}/io`, 'utf8').split('\n')) {
      const m = /^(rchar|wchar):\s*(\d+)/.exec(line);
      if (m) io += Number(m[2]);
    }
  } catch { /* /proc/<pid>/io is unreadable across uid boundaries — CPU still counts */ }
  let cmd = '';
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch { /* gone */ }
  if (!cmd) {
    const open = stat.indexOf('(');
    if (open >= 0 && close > open) cmd = stat.slice(open + 1, close);
  }
  // stat field 22 is starttime in ticks since boot; rest[19] after the comm split.
  const started = Number(rest[19]);
  const startedAt = Number.isFinite(started) ? bootEpochMs() + (started / USER_HZ) * 1000 : 0;
  return { cpuMs: ((utime + stime) / USER_HZ) * 1000, ioBytes: io, cmd, startedAt };
}

let BOOT_EPOCH_MS = null;
function bootEpochMs() {
  if (BOOT_EPOCH_MS != null) return BOOT_EPOCH_MS;
  BOOT_EPOCH_MS = 0;
  try {
    const m = /^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    if (m) BOOT_EPOCH_MS = Number(m[1]) * 1000;
  } catch { /* no /proc/stat — start times fall back to 0 and gate nothing */ }
  return BOOT_EPOCH_MS;
}

// macOS/BSD have no /proc, so one `ps` covers the whole list. There is no
// per-process IO counter without dtrace (which needs privileges we do not have
// and would not take), so liveness there rests on CPU and on tree churn.
function bsdProcs(pids) {
  const out = new Map();
  if (!pids.length) return out;
  let text;
  try {
    // lstart is fixed-width ("Mon Aug 11 12:34:56 2026") so command= can still
    // be last and keep its spaces.
    text = String(execFileSync('ps', ['-o', 'pid=,time=,lstart=,command=', '-p', pids.join(',')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return out; } // every pid exited between the walk and now
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+ \S+ +\d+ \d+:\d+:\d+ \d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const startedAt = Date.parse(m[3]);
    out.set(Number(m[1]), { cpuMs: parseBsdTime(m[2]), ioBytes: 0, cmd: m[4].trim(), startedAt: Number.isFinite(startedAt) ? startedAt : 0 });
  }
  return out;
}

// ps TIME comes as MM:SS.ss, HH:MM:SS, or DD-HH:MM:SS depending on magnitude.
function parseBsdTime(s) {
  const str = String(s || '');
  const dash = str.indexOf('-');
  const days = dash > 0 ? Number(str.slice(0, dash)) || 0 : 0;
  const parts = (dash > 0 ? str.slice(dash + 1) : str).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return (secs + days * 86400) * 1000;
}

// Everything running under `pid`, with the counters that say whether it is
// doing anything. `pid` itself is included: an agent burning CPU in its own
// process is working too. Returns null where the platform cannot answer — the
// caller must then behave exactly as it did before this module existed, never
// treat "cannot tell" as "alive".
function sampleTree(pid) {
  if (process.platform === 'win32') return null;
  const root = Number(pid);
  if (!Number.isFinite(root) || root <= 0) return null;
  const pids = [root, ...descendants(root)].slice(0, MAX_PROCS);
  const procs = new Map();
  if (process.platform === 'linux') {
    for (const p of pids) {
      const info = linuxProc(p);
      if (info) procs.set(p, info);
    }
  } else {
    for (const [p, info] of bsdProcs(pids)) procs.set(p, info);
  }
  if (!procs.size) return null; // the tree is gone; the exit handlers own that case
  let cpuMs = 0, ioBytes = 0;
  for (const info of procs.values()) { cpuMs += info.cpuMs; ioBytes += info.ioBytes; }
  return { at: Date.now(), cpuMs, ioBytes, procs };
}

// How much CPU counts as working, once the agent's own machinery is excluded.
// It has to be near zero, and that is a MEASUREMENT, not caution: a real
// `ollama pull` spends 20-40ms of CPU per 6s window, because the download runs
// in the ollama daemon and the client is only draining a progress stream. A
// 150ms floor — under 1% of one core, and the obvious "surely nothing real is
// below this" number — rejected the exact case this exists for. A parked
// process reads a clean 0, and 10ms is one tick of `ps` resolution above it.
const MIN_CPU_MS = 10;

// Did anything happen between two samples, and what? `since` is what makes the
// answer mean anything: an agent carries its own long-lived machinery (node
// runtime, stdio MCP sidecars) that ticks over forever, and counting it made a
// WEDGED agent read as busy — watched over a `sleep`, the movers being
// other tools' heartbeats. Pass the moment the command began; only
// processes started since then answer for it. A pid snapshot taken at that same
// moment cannot do this job — the command's own process spawns milliseconds
// later, so whether it lands inside the snapshot is a race, and it lost,
// measuring a live `ollama pull` as zero processes doing zero work.
function compareTree(prev, next, { minCpuMs = MIN_CPU_MS, since = 0 } = {}) {
  const none = { advanced: false, cpuMs: 0, ioBytes: 0, spawned: 0, movers: [], procs: 0 };
  if (!prev || !next) return none;
  let cpuMs = 0, ioBytes = 0, spawned = 0, procs = 0;
  const movers = [];
  for (const [pid, info] of next.procs) {
    if (since && !(info.startedAt >= since)) continue;
    procs++;
    const was = prev.procs.get(pid);
    if (!was) {
      spawned++;
      cpuMs += info.cpuMs;
      ioBytes += info.ioBytes;
      movers.push({ pid, cmd: info.cmd, cpuMs: info.cpuMs, ioBytes: info.ioBytes, fresh: true });
      continue;
    }
    const dCpu = Math.max(0, info.cpuMs - was.cpuMs), dIo = Math.max(0, info.ioBytes - was.ioBytes);
    cpuMs += dCpu; ioBytes += dIo;
    if (dCpu > 0 || dIo > 0) movers.push({ pid, cmd: info.cmd, cpuMs: dCpu, ioBytes: dIo, fresh: false });
  }
  // Busiest first: the downloading child, not the agent idling above it.
  movers.sort((a, b) => (b.ioBytes - a.ioBytes) || (b.cpuMs - a.cpuMs));
  // Spawn churn is a shell working through a script; both counters can stay flat.
  const advanced = cpuMs >= minCpuMs || ioBytes > 0 || spawned > 0;
  return { advanced, cpuMs, ioBytes, spawned, movers, procs };
}

function humanBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// CPU deltas here are legitimately tiny — a download's client spends tens of
// milliseconds per window — and rounding those to "0s" printed a live process
// as doing nothing, which is the opposite of what this line is for.
function humanMs(ms) {
  const raw = Number(ms) || 0;
  if (raw < 950) return `${Math.round(raw)}ms`;
  const s = Math.round(raw / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The line an operator reads while a quiet command runs. This is NOT the
// command's stdout — that pipe belongs to the CLI agent and we never see it —
// so say what we actually observed and let the numbers move, rather than
// printing a spinner that proves nothing.
function describeLiveWork(cmp, { elapsedMs = 0, subject = '' } = {}) {
  const c = cmp || {};
  const bits = [`${c.procs || 0} process${(c.procs || 0) === 1 ? '' : 'es'}`];
  if (c.cpuMs > 0) bits.push(`+${humanMs(c.cpuMs)} CPU`);
  if (c.ioBytes > 0) bits.push(`+${humanBytes(c.ioBytes)} I/O`);
  if (c.spawned > 0) bits.push(`${c.spawned} new`);
  const head = `⋯ still working${elapsedMs ? ` — ${humanMs(elapsedMs)} into this step` : ''} (${bits.join(', ')})`;
  const lines = [head];
  if (subject) lines.push(`  ${String(subject).replace(/\s+/g, ' ').slice(0, 200)}`);
  for (const m of (c.movers || []).slice(0, 3)) {
    if (!m.cmd) continue;
    const detail = [m.ioBytes > 0 ? humanBytes(m.ioBytes) : '', m.cpuMs > 0 ? humanMs(m.cpuMs) : ''].filter(Boolean).join(' / ');
    lines.push(`  [${m.pid}] ${String(m.cmd).replace(/\s+/g, ' ').slice(0, 120)}${detail ? `  ${detail}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = { sampleTree, compareTree, describeLiveWork, humanBytes, humanMs, MIN_CPU_MS };
