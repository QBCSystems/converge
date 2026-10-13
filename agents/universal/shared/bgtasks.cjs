// Background tasks — the durable long-job primitive shared by the harness
// (task_start/task_status/task_list/task_wait/task_cancel tools), the CLI
// (:tasks / the harness tasks), the TUI task strip, and the GUI (/api/bgtasks).
// One store, no per-surface drift.
//
// Design: there is NO daemon. The launched command runs under a detached bash
// wrapper that appends all output to task.log and, when the command exits,
// writes its exit code to exit.code (tmp+rename, so a partial write is never
// read). Status is therefore a PURE function of on-disk state + pid liveness:
// any process — a later harness turn, the GUI server, a CLI list — computes it
// by calling reconcileTask(), with no living monitor required. The "monitor
// loop" hosts run (watchTask) is just that pure check on an interval, in HOST
// code — the model never burns a turn polling.
//
// Store layout (STATE_DIR defaults to ~/.universal-agent, like the harness
// task store; bgtasks/ because STATE_DIR/tasks/ is already the mission store):
//   bgtasks/<id>/task.json   durable record (atomic tmp+rename writes)
//   bgtasks/<id>/task.log    combined stdout+stderr stream
//   bgtasks/<id>/exit.code   written by the wrapper when the command exits
//
// Secrets: the RAW command is executed but never persisted — task.json and
// every UI copy carry only the scrubbed form (installs may carry tokens).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { killTree } = require('./kill-tree.cjs');
const { atomicWrite, readJson } = require('./utils.cjs');

function defaultStateDir() {
  return process.env.AGENT_STATE_DIR || path.join(os.homedir(), '.universal-agent');
}
function tasksRoot(stateDir) { return path.join(stateDir || defaultStateDir(), 'bgtasks'); }
function taskDir(stateDir, id) { return path.join(tasksRoot(stateDir), String(id)); }

// Scrub obvious secret material from a command string before it is persisted
// or rendered anywhere. Conservative on purpose: mangle only what clearly
// reads as a credential, never arbitrary long strings (paths/URLs must
// survive intact so the record stays useful).
function scrubSecrets(cmd) {
  return String(cmd || '')
    .replace(/(--?(?:token|password|passwd|pass|secret|api[-_]?key|apikey|auth|bearer|credentials?)[=\s]+)(["']?)[^"'\s]+\2/gi, '$1$2***$2')
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|AUTH|CREDENTIALS)[A-Z0-9_]*=)(["']?)[^"'\s]+\2/g, '$1$2***$2')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/(https?:\/\/[^/\s:@]+:)[^@\s]+(@)/gi, '$1***$2');
}

function newTaskId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `bg-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A fan-out job ("install deps on 18 servers") reports one line per item; the
// overall exit code alone cannot say WHICH server failed to build. matcher
// modes:
//   'exit'  (default) — status from the exit code only.
//   'items'           — additionally parse per-line item verdicts from the log.
// The default items pattern recognizes the common fan-out shapes:
//   [mcp-3] build FAILED     mcp-3: OK      mcp-3: build done     mcp-3: ERROR
// A custom `pattern` (regex source) must expose capture group 1 = item name
// and its last group = verdict word; a verdict matching /fail|error/i is a
// failure. Last line per item wins (a retry that later succeeds counts as ok).
const DEFAULT_ITEM_PATTERN = '^\\s*(?:\\[([^\\]\\s]+)\\]|([\\w.@-]+)\\s*:)\\s*.*?\\b(ok|pass(?:ed)?|built|succe(?:ss|eded)|done|complete[d]?|fail(?:ed)?|error)\\b\\s*\\S*\\s*$';

function parseItems(logText, matcher) {
  const src = (matcher && matcher.pattern) || DEFAULT_ITEM_PATTERN;
  let re;
  try { re = new RegExp(src, 'i'); } catch { re = new RegExp(DEFAULT_ITEM_PATTERN, 'i'); }
  const byItem = new Map();
  for (const line of String(logText || '').split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const groups = m.slice(1).filter((g) => g !== undefined && g !== null);
    if (groups.length < 2) continue;
    const item = groups[0];
    const verdict = groups[groups.length - 1];
    if (!item || !verdict) continue;
    byItem.set(item, { item, ok: !/fail|error/i.test(verdict), line: line.trim().slice(0, 200) });
  }
  return [...byItem.values()];
}

// Launch `command` detached under the platform shell and return the durable
// record immediately. Unix gets bash+pipefail; Windows gets cmd.exe with delayed
// expansion so the real exit code can be written durably without requiring bash.
function startTask({ stateDir, command, name, cwd, matcher, env, source }) {
  const sd = stateDir || defaultStateDir();
  const id = newTaskId();
  const dir = taskDir(sd, id);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'task.log');
  const exitPath = path.join(dir, 'exit.code');
  fs.writeFileSync(logPath, '');
  let shellBin, shellArgs, childEnv = env || process.env;
  if (process.platform === 'win32') {
    // Do not make cmd.exe also be the durable monitor. Quoting a compound cmd
    // line through CreateProcess is fragile, and a dead wrapper can lose the
    // exit receipt entirely. A tiny detached Node monitor owns the child,
    // streams both outputs to task.log, then atomically records the exit code.
    const runner = [
      "const fs=require('fs'),{spawn}=require('child_process');",
      "const e=process.env,log=fs.createWriteStream(e.CONVERGE_BG_LOG,{flags:'a'});",
      "const c=spawn(e.CONVERGE_BG_COMMAND,{cwd:e.CONVERGE_BG_CWD,shell:true,env:process.env,stdio:['ignore','pipe','pipe']});",
      "c.stdout.pipe(log,{end:false});c.stderr.pipe(log,{end:false});",
      "const done=(code)=>{try{log.end();fs.writeFileSync(e.CONVERGE_BG_EXIT+'.w',String(Number.isInteger(code)?code:1));try{fs.renameSync(e.CONVERGE_BG_EXIT+'.w',e.CONVERGE_BG_EXIT);}catch{try{fs.copyFileSync(e.CONVERGE_BG_EXIT+'.w',e.CONVERGE_BG_EXIT);fs.unlinkSync(e.CONVERGE_BG_EXIT+'.w');}catch{}}}catch{}process.exit(Number.isInteger(code)?code:1)};",
      "c.on('error',()=>done(1));c.on('exit',(code)=>done(code));",
    ].join('');
    shellBin = process.execPath;
    shellArgs = ['-e', runner];
    childEnv = {
      ...childEnv,
      CONVERGE_BG_COMMAND: String(command),
      CONVERGE_BG_CWD: cwd || process.cwd(),
      CONVERGE_BG_LOG: logPath,
      CONVERGE_BG_EXIT: exitPath,
    };
  } else {
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    // Subshell so `cd`/`exec` inside the command can't dodge the exit capture;
    // tmp+rename on exit.code so a reader never sees a half-written code.
    const wrapper = `( ${command}\n) >> ${q(logPath)} 2>&1; rc=$?; echo $rc > ${q(exitPath)}.w && mv ${q(exitPath)}.w ${q(exitPath)}`;
    const unixBash = process.env.CONVERGE_BASH && process.env.CONVERGE_BASH.toLowerCase() !== 'none' && fs.existsSync(process.env.CONVERGE_BASH) ? process.env.CONVERGE_BASH
      : fs.existsSync('/bin/bash') ? '/bin/bash' : (fs.existsSync('/usr/bin/bash') ? '/usr/bin/bash' : 'bash');
    shellBin = unixBash;
    shellArgs = ['-o', 'pipefail', '-c', wrapper];
  }
  let child;
  try {
    child = spawn(shellBin, shellArgs, {
      cwd: cwd || process.cwd(),
      env: childEnv,
      detached: true,           // own process group / Windows process root
      windowsHide: true,        // don't pop a console window for detached Node on Win
      stdio: 'ignore',          // all output goes through the wrapper redirect
    });
    child.on('error', (err) => {
      try {
        fs.appendFileSync(logPath, `\n[bgtask spawn error: ${err.message}]\n`);
        fs.writeFileSync(`${exitPath}.w`, '1');
        fs.renameSync(`${exitPath}.w`, exitPath);
      } catch {}
    });
    child.unref();              // the launching process is free to exit
  } catch (err) {
    try {
      fs.appendFileSync(logPath, `\n[bgtask spawn exception: ${err.message}]\n`);
      fs.writeFileSync(`${exitPath}.w`, '1');
      fs.renameSync(`${exitPath}.w`, exitPath);
    } catch {}
    child = { pid: 0, unref() {} };
  }
  const rec = {
    v: 1, id,
    name: String(name || command).slice(0, 120),
    cmd: scrubSecrets(command),   // NEVER the raw command — installs carry tokens
    cwd: cwd || process.cwd(),
    pid: child.pid,
    logPath,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null, exitCode: null,
    matcher: (matcher && matcher.mode === 'items') ? { mode: 'items', ...(matcher.pattern ? { pattern: matcher.pattern } : {}) } : { mode: 'exit' },
    items: [], failedItems: [],
    source: source || 'task_start',
    waiters: [],
  };
  saveTask(sd, rec);
  return rec;
}

// Adopt an already-running detached process (run_command's server detach) into
// the store so it shows up in every surface and can be cancelled like any
// task. No exit.code will ever appear — status comes from pid liveness alone.
function adoptTask({ stateDir, pid, command, name, cwd, startupLog, source }) {
  const sd = stateDir || defaultStateDir();
  const id = newTaskId();
  const dir = taskDir(sd, id);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'task.log');
  fs.writeFileSync(logPath, String(startupLog || ''));
  const rec = {
    v: 1, id,
    name: String(name || command).slice(0, 120),
    cmd: scrubSecrets(command),
    cwd: cwd || process.cwd(),
    pid,
    logPath,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null, exitCode: null,
    matcher: { mode: 'exit' },
    items: [], failedItems: [],
    source: source || 'detached-server',
    adopted: true,            // no wrapper → no exit.code; liveness-only status
    waiters: [],
  };
  saveTask(sd, rec);
  return rec;
}

function saveTask(stateDir, rec) {
  atomicWrite(path.join(taskDir(stateDir, rec.id), 'task.json'), JSON.stringify(rec, null, 2));
}

function readTask(stateDir, id) {
  return readJson(path.join(taskDir(stateDir, id), 'task.json'));
}

// The monitor's core: reconcile on-disk truth into the record. Terminal states
// are sticky; a running task resolves the moment exit.code lands (or its pid
// dies). Returns the fresh record, persisting any transition.
function reconcileTask(stateDir, id) {
  const sd = stateDir || defaultStateDir();
  const rec = readTask(sd, id);
  if (!rec) return null;
  if (rec.status !== 'running') return rec;
  const exitRaw = (() => { try { return fs.readFileSync(path.join(taskDir(sd, id), 'exit.code'), 'utf8').trim(); } catch { return null; } })();
  if (exitRaw !== null && exitRaw !== '') {
    rec.exitCode = parseInt(exitRaw, 10);
    rec.endedAt = new Date().toISOString();
    if (rec.matcher && rec.matcher.mode === 'items') {
      let log = ''; try { log = fs.readFileSync(rec.logPath, 'utf8'); } catch {}
      rec.items = parseItems(log, rec.matcher);
      rec.failedItems = rec.items.filter((i) => !i.ok).map((i) => i.item);
    }
    // "Whether any item failed to build", not just overall exit: a batch whose
    // wrapper exited 0 but logged FAILED lines is still a failed task.
    rec.status = (rec.exitCode === 0 && rec.failedItems.length === 0) ? 'done' : 'failed';
    saveTask(sd, rec);
    return rec;
  }
  if (!pidAlive(rec.pid)) {
    // Adopted long-lived listeners have no wrapper: pid death IS their exit.
    if (rec.adopted) {
      rec.endedAt = new Date().toISOString();
      rec.status = 'done';
      saveTask(sd, rec);
      return rec;
    }
    // A wrapped task whose pid died without an exit.code yet: the wrapper
    // writes exit.code AFTER the process exits (`mv exit.code.w exit.code`), so
    // there is a real window where pid is dead but the code hasn't landed.
    // Grace by TIME, not by reconcile-count — a one-pass grace collapsed to
    // zero when two pollers (GUI + CLI + every watchTask tick) raced through
    // it in the same instant, and the code 0 that landed a moment later was
    // never read because the terminal 'failed' is sticky. Stamp when the pid
    // was first seen dead; only conclude 'failed' after the window with STILL
    // no exit.code (which the top of this function re-reads every call).
    const GRACE_MS = 3000;
    if (!rec._deadAt) {
      rec._deadAt = Date.now();
      saveTask(sd, rec);
      return rec;
    }
    if (Date.now() - rec._deadAt < GRACE_MS) return rec; // still within the window; wait
    rec.endedAt = new Date().toISOString();
    rec.status = 'failed';
    rec.note = 'process died without recording an exit code (killed or crashed)';
    delete rec._deadAt;
    saveTask(sd, rec);
    return rec;
  }
  // pid came back / never really died — clear a stale death stamp.
  if (rec._deadAt) { delete rec._deadAt; saveTask(sd, rec); }
  return rec;
}

function listTasks(stateDir) {
  const sd = stateDir || defaultStateDir();
  let names = [];
  try { names = fs.readdirSync(tasksRoot(sd)); } catch { return []; }
  return names
    .filter((n) => n.startsWith('bg-'))
    .map((n) => reconcileTask(sd, n))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function tailLog(stateDir, id, maxBytes = 4000) {
  maxBytes = Math.max(100, Math.min(1000000, parseInt(maxBytes, 10) || 4000));
  const p = path.join(taskDir(stateDir || defaultStateDir(), id), 'task.log');
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(p, 'r');
    try {
      const readLen = Math.max(0, size - start);
      if (readLen === 0) return '';
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, buf.length, start);
      return (start > 0 ? '…' : '') + buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch { return ''; }
}

// Kill the whole process group (the detached wrapper is its group leader), give
// it a moment to die politely, SIGKILL what remains, and reconcile the record.
function cancelTask(stateDir, id, { graceMs = 1500 } = {}) {
  const sd = stateDir || defaultStateDir();
  const rec = reconcileTask(sd, id);
  if (!rec) return null;
  if (rec.status !== 'running') return rec;   // already settled — nothing to kill
  try { killTree(rec.pid, 'SIGTERM'); } catch {}
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (pidAlive(rec.pid)) {
        try { killTree(rec.pid, 'SIGKILL'); } catch {}
      }
      // The task may have COMPLETED during the grace (it finished before SIGTERM
      // landed, or exited cleanly on it). reconcile first so a real exit code is
      // read — unconditionally stamping 'canceled' discarded a genuine
      // done/failed outcome and its exit code.
      const fresh = reconcileTask(sd, id) || readTask(sd, id) || rec;
      if (fresh.status === 'running') {
        fresh.status = 'canceled';
        fresh.endedAt = new Date().toISOString();
        saveTask(sd, fresh);
      }
      resolve(fresh);
    }, graceMs);
    t.unref?.();
  });
}

// Park/resume contract: the harness registers a waiter when the model calls
// task_wait — a durable "the agent is holding on this task, with this plan"
// marker. The HOST that owns the conversation (CLI REPL, TUI, GUI server)
// watches the task and, when it settles, consumes the waiters (read → clear →
// write; an empty read means another host already woke it) and injects the
// wake turn.
function registerWaiter(stateDir, id, waiter) {
  const sd = stateDir || defaultStateDir();
  const rec = readTask(sd, id);
  if (!rec) return null;
  rec.waiters = [...(rec.waiters || []), { ...waiter, at: new Date().toISOString() }];
  saveTask(sd, rec);
  return rec;
}

function consumeWaiters(stateDir, id, match) {
  const sd = stateDir || defaultStateDir();
  const rec = readTask(sd, id);
  if (!rec || !(rec.waiters || []).length) return [];
  // Optional predicate: a host takes ONLY the waiters it owns (the GUI must
  // never steal a CLI conversation's waiter, and vice versa).
  const take = match ? rec.waiters.filter((w) => { try { return !!match(w); } catch { return false; } }) : rec.waiters;
  if (!take.length) return [];
  rec.waiters = match ? rec.waiters.filter((w) => !take.includes(w)) : [];
  saveTask(sd, rec);
  return take;
}

// Host-side monitor loop: poll reconcileTask until the task leaves 'running',
// then call back ONCE with the settled record. Interval-based on purpose — it
// runs in host code between turns, never inside a model turn (the harness
// blocks sleep-spin there; this is the sanctioned replacement). The timer is
// unref'd so it never pins a process open.
function watchTask(stateDir, id, cb, { intervalMs = 1500 } = {}) {
  const sd = stateDir || defaultStateDir();
  let initial = null;
  try { initial = reconcileTask(sd, id); } catch {}
  if (!initial) { cb(null); return () => {}; }
  if (initial.status !== 'running') { cb(initial); return () => {}; }
  const t = setInterval(() => {
    let rec = null;
    try { rec = reconcileTask(sd, id); } catch { /* keep watching */ }
    if (!rec) { clearInterval(t); cb(null); return; }
    if (rec.status !== 'running') { clearInterval(t); cb(rec); }
  }, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}

const STATUS_GLYPH = { running: '▶', done: '✓', failed: '✗', canceled: '◼' };

function fmtElapsed(rec, now = Date.now()) {
  const start = Date.parse(rec.startedAt || '') || now;
  const end = rec.endedAt ? (Date.parse(rec.endedAt) || now) : now;
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// One-line summary every surface renders the same way:
//   ✗ deps install (18 servers) · failed · 4m12s · 2/18 items failed: mcp-7, mcp-12
function taskLine(rec, now = Date.now()) {
  const bits = [`${STATUS_GLYPH[rec.status] || '·'} ${rec.name}`, rec.status, fmtElapsed(rec, now)];
  if (rec.items && rec.items.length) {
    bits.push(rec.failedItems.length
      ? `${rec.failedItems.length}/${rec.items.length} items failed: ${rec.failedItems.join(', ')}`
      : `${rec.items.length}/${rec.items.length} items ok`);
  } else if (rec.status === 'failed' && rec.exitCode != null) {
    bits.push(`exit ${rec.exitCode}`);
  }
  return bits.join(' · ');
}

// The UI-safe subset of a record: what events and HTTP endpoints carry. cmd is
// already scrubbed at persist time; waiters/log paths stay server-side.
function publicTask(rec, now = Date.now()) {
  if (!rec) return null;
  return {
    id: rec.id, name: rec.name, cmd: rec.cmd, status: rec.status,
    startedAt: rec.startedAt, endedAt: rec.endedAt, exitCode: rec.exitCode,
    elapsed: fmtElapsed(rec, now), line: taskLine(rec, now),
    items: rec.items || [], failedItems: rec.failedItems || [],
    holding: (rec.waiters || []).length, source: rec.source || '',
  };
}

// The wake turn every host injects when a parked task settles — one composer,
// so CLI/TUI/GUI wake the agent with the exact same contract: continue the
// parked plan on success, HALT and report per-item failures on failure.
function wakeMessage(rec, plan) {
  const lines = [`[task-monitor] Background task ${rec.id} ("${rec.name}") settled: ${taskLine(rec)}.`];
  if ((rec.failedItems || []).length) lines.push(`Failed items: ${rec.failedItems.join(', ')}.`);
  if (rec.note) lines.push(rec.note);
  lines.push('');
  lines.push(`This is the automatic wake-up for your task_wait — no human sent it. ${plan ? `Continue the plan you parked:\n${plan}` : 'Continue the work you parked when you called task_wait.'}`);
  lines.push(`If the task FAILED, do NOT proceed with the remaining steps: report exactly which items failed and why (task_status {"id":"${rec.id}"} shows the log), then stop.`);
  return lines.join('\n');
}

module.exports = {
  defaultStateDir, tasksRoot, taskDir,
  publicTask, wakeMessage,
  scrubSecrets, parseItems, DEFAULT_ITEM_PATTERN,
  startTask, adoptTask, readTask, reconcileTask, listTasks, tailLog,
  cancelTask, registerWaiter, consumeWaiters, watchTask,
  STATUS_GLYPH, fmtElapsed, taskLine,
};
