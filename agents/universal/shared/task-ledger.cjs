'use strict';
// Durable task ledger — the persistent checklist for one conversation.
//
// The transcript remembers what was SAID; the ledger remembers what is left TO
// DO. It is one JSON file next to the conversation's chat file (<name>.json →
// <name>.ledger.json) or a markdown LEDGER.md file, written synchronously on
// every change so Stop/SIGKILL/reload never loses it, and it survives
// compaction because it is state, not context. Every surface reads the same
// file: the engine's `ledger` tool writes it, chat/mission turns get open items
// injected at turn start, and the CLI/TUI/GUI/console display it read-only.
//
// Interoperability with external agents (Antigravity, Cursor, Claude Code, humans):
// External agents edit files rather than calling custom MCP/internal tools.
// task-ledger supports reading from and syncing to `LEDGER.md` (or `.agent/LEDGER.md`),
// parsing standard GitHub Flavored Markdown task lists:
//   - [ ] Pending task
//   - [>] In-progress task (also [/] or [*])
//   - [x] Completed task
//   - [!] Blocked task (also [-])

const fs = require('fs');
const path = require('path');
const { sleepSync } = require('./utils.cjs');

const STATUSES = ['pending', 'in_progress', 'done', 'blocked'];

// Concurrency: the parent process, N parallel `subtask` children (each its
// own Node process, all pointed at the SAME file via inherited
// CONVERGE_LEDGER_FILE — see spawnSubtask in universal-agent.cjs), and the
// ledger-mcp server can all touch this file at once. A naive load->mutate->
// save in each caller races two ways: (1) lost update — both load the same
// snapshot, both save their own copy, whichever save lands last silently
// erases the other's change; (2) a reader's load() can observe a half-
// written file mid-save and treat it as corrupt. `update()` below is the
// safe path: a cross-process lock serializes the read-modify-write, and the
// write itself is tempfile+rename so a reader never observes a partial file.
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 15000; // a holder that died (SIGKILL/OOM) can't release; steal after this

function lockPath(file) { return `${file}.lock`; }

// Cheap PID liveness probe: signal 0 succeeds iff the process exists and we
// can signal it; EPERM means it exists but is owned by someone else (still
// alive, from our point of view).
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// A lockfile whose recorded owner PID is no longer running, or that has sat
// untouched past STALE_LOCK_MS, belongs to a holder that can never release
// it (killed mid-turn). Rename it aside so the next attempt can proceed.
function tryStealLock(lp) {
  let st;
  try { st = fs.statSync(lp); } catch { return true; } // already gone — nothing to steal
  let pid = null;
  try { pid = parseInt(String(fs.readFileSync(lp, 'utf8')).split(/\r?\n/)[0], 10) || null; } catch { /* unreadable lock is stealable on age alone */ }
  const stale = (pid != null && !isAlive(pid)) || (Date.now() - st.mtimeMs) > STALE_LOCK_MS;
  if (!stale) return false;
  try { fs.renameSync(lp, `${lp}.stale-${Date.now().toString(36)}`); } catch { /* someone else stole it first — fine */ }
  return true;
}

// sleepSync imported from ./utils.cjs

// Exclusive create (O_EXCL) is atomic across processes on the same
// filesystem: only one caller's openSync succeeds when several race it.
// Bounded retry with stale-lock recovery so a killed holder never wedges
// every later caller forever.
function acquireLock(file) {
  const lp = lockPath(file);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lp); } catch { /* already gone/stolen — fine */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      tryStealLock(lp);
      if (Date.now() >= deadline) throw new Error(`ledger lock timeout on ${file} after ${LOCK_TIMEOUT_MS}ms`);
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

// Parse markdown task lists (e.g. from LEDGER.md or TODO.md).
function parseMarkdown(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let seq = 0;
  const now = new Date().toISOString();

  for (const line of lines) {
    const m = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX\/>!\-\*])\]\s+(.+)$/.exec(line);
    if (!m) continue;
    const mark = m[1];
    let rest = m[2].trim();
    if (!rest) continue;

    let status = 'pending';
    if (mark === 'x' || mark === 'X') status = 'done';
    else if (mark === '/' || mark === '>' || mark === '*') status = 'in_progress';
    else if (mark === '!' || mark === '-') status = 'blocked';

    // Extract ID if present: e.g. "L1", "L1:", "**L1**", "**L1:**", "[L1]", "task-1", "AIOS-ARCH-01", "TASK-001"
    let id = null;
    const idMatch = /^(?:\*\*|\[)?([a-zA-Z0-9_-]+)(?:\*\*|\])?[:\s-]\s*(.*)$/.exec(rest);
    if (idMatch && /^(?:L\d+|task-\d+|aios-[a-z0-9_-]+|[a-z0-9]+-[a-z0-9_-]+|\d+)$/i.test(idMatch[1])) {
      id = idMatch[1].toUpperCase();
      rest = idMatch[2].trim();
    }

    if (id && /^\d+$/.test(id)) id = `L${id}`;

    // Extract note if present: e.g. "Title — note" or "Title -- note" or "Title (note)"
    let title = rest;
    let note = '';
    const noteMatch = /^(.*?)\s*(?:[\u2014\u2013]|--)\s*(.+)$/.exec(rest);
    if (noteMatch) {
      title = noteMatch[1].trim();
      note = noteMatch[2].trim();
    } else {
      const parenMatch = /^(.*?)\s+\(([^)]+)\)$/.exec(rest);
      if (parenMatch) {
        title = parenMatch[1].trim();
        note = parenMatch[2].trim();
      }
    }

    seq++;
    if (!id) id = `L${seq}`;
    const seqNum = parseInt(id.replace(/\D/g, ''), 10);
    if (!isNaN(seqNum) && seqNum > seq) seq = seqNum;

    items.push({
      id,
      title: title.slice(0, 300) || rest.slice(0, 300),
      status,
      note: note.slice(0, 500),
      createdAt: now,
      updatedAt: now,
    });
  }

  return { version: 1, seq, items, format: 'markdown' };
}

// Convert a structured ledger into clean GitHub Flavored Markdown.
function toMarkdown(led) {
  const items = Array.isArray(led && led.items) ? led.items : [];
  const lines = ['# Task Ledger', ''];
  if (!items.length) {
    lines.push('_No active tasks recorded._');
    return lines.join('\n') + '\n';
  }
  for (const it of items) {
    const mark = it.status === 'done' ? 'x' : it.status === 'in_progress' ? '>' : it.status === 'blocked' ? '!' : ' ';
    const notePart = it.note ? ` — ${it.note}` : '';
    lines.push(`- [${mark}] ${it.id} ${it.title}${notePart}`);
  }
  return lines.join('\n') + '\n';
}

// Search candidate markdown files for a conversation or workspace.
// opts.allowGlobalFallback (default true) gates the WORKSPACE-WIDE candidates
// (parent-dir LEDGER.md, <workdir>/{,.agent/}{LEDGER,TODO}.md). A
// per-conversation ledger MUST pass false: every console/GUI conversation
// shares one workdir, so the global fallback is how one conversation's open
// items leaked into another conversation's turn-start "persistent checklist"
// (and how a per-conversation save() clobbered the shared file back).
// Sibling candidates (<name>.md / <name>.ledger.md beside the ledger) stay
// unconditional — they belong to the same thread by construction.
function findMarkdownLedger(filePath, workdir, opts = {}) {
  const allowGlobal = opts.allowGlobalFallback !== false;
  const candidates = [];
  if (filePath) {
    if (/\.ledger\.json$/i.test(filePath)) {
      candidates.push(filePath.replace(/\.ledger\.json$/i, '.ledger.md'));
    } else if (/\.json$/i.test(filePath)) {
      candidates.push(filePath.replace(/\.json$/i, '.md'));
    }
    const dir = path.dirname(filePath);
    candidates.push(path.join(dir, 'LEDGER.md'));
    if (allowGlobal) {
      candidates.push(path.join(dir, '..', 'LEDGER.md'));
      candidates.push(path.join(dir, '..', '.agent', 'LEDGER.md'));
    }
  }
  if (workdir && allowGlobal) {
    candidates.push(path.join(workdir, '.agent', 'LEDGER.md'));
    candidates.push(path.join(workdir, 'LEDGER.md'));
    candidates.push(path.join(workdir, '.agent', 'TODO.md'));
    candidates.push(path.join(workdir, 'TODO.md'));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

// Write via a sibling tempfile + rename: rename is atomic on the same
// filesystem, so a concurrent load() either sees the old bytes or the new
// ones in full, never a half-written JSON or markdown target.
function atomicWrite(file, led) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const isMd = /\.md$/i.test(file);
  const content = isMd ? toMarkdown(led) : JSON.stringify(led, null, 1);
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// <anything>.json → <anything>.ledger.json (fallback: append the suffix).
function derivePath(chatFile) {
  const p = String(chatFile || '');
  return /\.json$/i.test(p) ? p.replace(/\.json$/i, '.ledger.json') : `${p}.ledger.json`;
}

function emptyLedger() {
  return { version: 1, seq: 0, items: [] };
}

// Same contract as chat history: an unreadable ledger is preserved as a corpse,
// never silently replaced by the next save. Supports loading from JSON or
// falling back to companion/workspace LEDGER.md.
function load(file, opts = {}) {
  const filePath = String(file || '');
  const workdir = (typeof opts === 'string' ? opts : opts && opts.workdir) || null;

  if (/\.md$/i.test(filePath)) {
    try {
      if (fs.existsSync(filePath)) {
        const text = fs.readFileSync(filePath, 'utf8');
        return parseMarkdown(text);
      }
    } catch { /* fallback */ }
    return emptyLedger();
  }

  if (fs.existsSync(filePath)) {
    try {
      const led = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (led && Array.isArray(led.items) && led.items.length > 0) return led;
      if (led && Array.isArray(led.items)) {
        const md = findMarkdownLedger(filePath, workdir, opts);
        if (md) {
          const mdLed = load(md);
          if (mdLed.items.length > 0) return mdLed;
        }
        return led;
      }
    } catch {
      if (fs.existsSync(filePath)) { try { fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now().toString(36)}`); } catch { /* best effort */ } }
    }
  }

  // JSON file does not exist: search for markdown ledger
  const md = findMarkdownLedger(filePath, workdir, opts);
  if (md) {
    const mdLed = load(md);
    if (mdLed.items.length > 0) return mdLed;
  }

  return emptyLedger();
}

// Explicit cross-chat READ (a fresh chat asking "what's on the ledger?"):
// merges this conversation's own ledger with the workspace-global markdown
// one (LEDGER.md / TODO.md), each under a labeled section. Turn-start
// injection stays scoped (load with allowGlobalFallback:false) — shared items
// are VISIBLE here, never auto-injected, never auto-adopted into this
// conversation's file, and never written back from this thread.
function loadMerged(filePath, workdir) {
  const own = load(filePath, { allowGlobalFallback: false });
  const sections = [];
  if (own.items.length) {
    const c = counts(own);
    sections.push(`THIS CONVERSATION — ${c.open} open / ${c.total} total:\n${own.items.map(itemLine).join('\n')}`);
  }
  const md = findMarkdownLedger(filePath, workdir || null, {});
  if (md && md !== filePath) {
    try {
      const shared = load(md);
      if (shared.items.length) {
        const cs = counts(shared);
        sections.push(`WORKSPACE SHARED — ${md} — ${cs.open} open / ${cs.total} total:\n${shared.items.map(itemLine).join('\n')}`);
      }
    } catch { /* unreadable shared file: list this conversation only */ }
  }
  if (!sections.length) return render(own);
  sections.push('(Workspace-shared items are a read-only view here: add/update/remove always land in THIS conversation\'s ledger.)');
  return ['Task ledger — merged view:', ...sections].join('\n');
}

// Returns '' on success, or a FAILED line the tool can surface — a ledger the
// model believes it updated but that never hit disk is worse than an error.
// Kept for callers that already hold an in-memory ledger from their own
// load(); prefer update() below for a read-modify-write, which additionally
// guards against a concurrent writer's change being silently lost.
// Dual-syncs companion LEDGER.md if present.
function save(file, led, opts = {}) {
  const workdir = (typeof opts === 'string' ? opts : opts && opts.workdir) || null;
  led.updatedAt = new Date().toISOString();
  try {
    atomicWrite(file, led);
    const companionMd = findMarkdownLedger(file, workdir, opts);
    if (companionMd && companionMd !== file && fs.existsSync(companionMd)) {
      try { atomicWrite(companionMd, led); } catch {}
    }
    return '';
  } catch (e) {
    return `FAILED: could not persist the ledger to ${file}: ${e.message}`;
  }
}

// The safe fan-in for a read-modify-write: acquire the cross-process lock,
// load a FRESH snapshot (folding in any change a concurrent writer already
// committed since the caller last read), run `mutator(led)`, and atomic-
// write iff it reports a change — all before releasing the lock. Returns
// `mutator`'s return value (e.g. apply()'s {text, changed}), with a
// `saveError` property set to the FAILED string on a write failure (mirrors
// save()'s return contract without overloading the mutator's own shape).
function update(file, mutator, opts = {}) {
  const release = acquireLock(file);
  try {
    const led = load(file, opts);
    const result = mutator(led);
    if (result && result.changed) {
      led.updatedAt = new Date().toISOString();
      try {
        atomicWrite(file, led);
        const workdir = (typeof opts === 'string' ? opts : opts && opts.workdir) || null;
        const companionMd = findMarkdownLedger(file, workdir, opts);
        if (companionMd && companionMd !== file && fs.existsSync(companionMd)) {
          try { atomicWrite(companionMd, led); } catch {}
        }
      } catch (e) {
        result.saveError = `FAILED: could not persist the ledger to ${file}: ${e.message}`;
      }
    }
    return result;
  } finally {
    release();
  }
}

function counts(led) {
  const done = (led && Array.isArray(led.items) ? led.items : []).filter((i) => i.status === 'done').length;
  const total = (led && Array.isArray(led.items) ? led.items.length : 0);
  return { open: total - done, done, total };
}

function icon(s) { return s === 'done' ? '[x]' : s === 'in_progress' ? '[>]' : s === 'blocked' ? '[!]' : '[ ]'; }
function itemLine(i) { return `${icon(i.status)} ${i.id} ${i.title}${i.note ? ` — ${i.note}` : ''}`; }

function render(led) {
  if (!led || !Array.isArray(led.items) || !led.items.length) return 'Ledger is empty.';
  const c = counts(led);
  return [`Task ledger — ${c.open} open / ${c.total} total:`, ...led.items.map(itemLine)].join('\n');
}

// Open items reach the model at turn start via the SYSTEM prompt — never as a
// user-role message, so the ledger cannot poison durable history the way
// unflagged scaffolding once did (see scrubChatHistory in the engine).
function contextLines(led) {
  const open = (led && Array.isArray(led.items) ? led.items : []).filter((i) => i.status !== 'done');
  if (!open.length) return [];
  return [
    "DURABLE TASK LEDGER — this conversation's persistent checklist (survives restarts and reloads; recorded by earlier runs or LEDGER.md). Open items:",
    ...open.slice(0, 30).map(itemLine),
    ...(open.length > 30 ? [`… and ${open.length - 30} more (ledger action:"list" shows all)`] : []),
    'Mark items done via the ledger tool or LEDGER.md as you verify them; record newly discovered follow-up work as new items. Do not redo done work unless asked.',
  ];
}

// The mission planner gets the ledger too, so "continue" plans the REMAINING
// work instead of re-deriving the whole job from the transcript.
function plannerBlock(led) {
  const open = (led && Array.isArray(led.items) ? led.items : []).filter((i) => i.status !== 'done');
  if (!open.length) return '';
  const done = (led && Array.isArray(led.items) ? led.items : []).filter((i) => i.status === 'done');
  return `\n\nDURABLE TASK LEDGER for this conversation — work items recorded by earlier runs or LEDGER.md. Plan the REMAINING (open) work; do not re-plan what is already done.\nOPEN:\n${open.slice(0, 30).map(itemLine).join('\n')}${done.length ? `\nALREADY DONE (do not redo): ${done.slice(-15).map((i) => i.title).join('; ')}` : ''}`;
}

function findItem(led, id) {
  if (id == null || !Array.isArray(led && led.items)) return null;
  const raw = String(id).trim();
  if (!raw) return null;
  // 1. Exact case-insensitive ID match: e.g. "L1" === "L1"
  let it = led.items.find((i) => i.id.toLowerCase() === raw.toLowerCase());
  if (it) return it;
  // 2. Numeric ID match: e.g. "1" matches "L1"
  if (/^\d+$/.test(raw)) {
    it = led.items.find((i) => i.id.toLowerCase() === `l${raw}`.toLowerCase() || i.id === raw);
    if (it) return it;
  }
  // 3. Match by ID prefix in input string: e.g. "L1: Do something" matches "L1"
  const m = /^(?:L)?(\d+)\b/i.exec(raw);
  if (m) {
    it = led.items.find((i) => i.id.toLowerCase() === `l${m[1]}`.toLowerCase() || i.id === m[1]);
    if (it) return it;
  }
  // 4. Match by title prefix or substring
  it = led.items.find((i) => i.title.toLowerCase().startsWith(raw.toLowerCase()) || raw.toLowerCase().startsWith(i.title.toLowerCase()));
  if (it) return it;
  return null;
}

// The whole tool surface: mutate `led` in place per the requested action and
// return the text the model should see. `changed` tells the caller whether to
// save. Unknown input comes back as an ERROR string, never a throw — a bad
// argument from the model must cost one round-trip, not the turn.
// One entry of `add`. The documented shape is a title string, but a model
// sooner or later sends back the shape the ledger DISPLAYS — an object with
// title/status/note — and `String(obj)` renders that as the literal text
// "[object Object]", which then persists in the durable file and is injected
// into every later turn as the agent's own plan. So read the title out of the
// object, and keep a status/note that arrived with it instead of dropping
// them. Returns null when there is no title to be had.
const TITLE_KEYS = ['title', 'text', 'task', 'name', 'item', 'description', 'content'];
function entryOf(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') {
    const t = String(v).trim();
    return t ? { title: t, status: 'pending', note: '' } : null;
  }
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const key = TITLE_KEYS.find((k) => typeof v[k] === 'string' && v[k].trim());
  if (!key) return null;
  return {
    title: v[key].trim(),
    status: STATUSES.includes(String(v.status)) ? String(v.status) : 'pending',
    note: typeof v.note === 'string' ? v.note.trim() : '',
  };
}

// An entry with no readable title is rejected rather than stored as garbage:
// the whole `add` fails, the model is shown what it actually sent, and the
// ledger stays clean.
function junkError(junk, total) {
  const shown = junk.slice(0, 2).map((v) => {
    try { return JSON.stringify(v).slice(0, 120); } catch { return Object.prototype.toString.call(v); }
  }).join(', ');
  return `ERROR: ${junk.length} of ${total} item(s) carried no readable title (${shown}) — nothing was added. Each entry must be a title string, or an object with the title under ${TITLE_KEYS.slice(0, 3).join('/')}.`;
}

function apply(led, { action, items, id, status, note } = {}) {
  const act = String(action || 'list');
  if (act === 'list') return { text: render(led), changed: false };
  if (act === 'add') {
    let arr = items;
    if (typeof arr === 'string' && (arr.startsWith('[') || arr.startsWith('{'))) {
      try { arr = JSON.parse(arr); } catch {
        try { arr = JSON.parse(arr.replace(/'/g, '"')); } catch {}
      }
    }
    const raw = Array.isArray(arr) ? arr : [arr];
    const entries = [];
    const junk = [];
    for (const v of raw) {
      const e = entryOf(v);
      if (e) entries.push(e);
      else if (v != null && String(v).trim()) junk.push(v);
    }
    if (junk.length) return { text: junkError(junk, raw.length), changed: false };
    if (!entries.length) return { text: 'ERROR: add needs `items` — an array of item titles.', changed: false };
    const now = new Date().toISOString();
    for (const entry of entries) {
      let t = entry.title;
      let customId = null;
      const idMatch = /^(?:\*\*|\[)?([a-zA-Z0-9_-]+)(?:\*\*|\])?[:\s-]\s*(.*)$/.exec(t);
      if (idMatch && /^(?:L\d+|task-\d+|\d+)$/i.test(idMatch[1])) {
        customId = idMatch[1].toUpperCase();
        if (/^\d+$/.test(customId)) customId = `L${customId}`;
        t = idMatch[2].trim() || t;
      }
      led.seq = (led.seq || 0) + 1;
      const itemId = customId || `L${led.seq}`;
      const num = parseInt(itemId.replace(/\D/g, ''), 10);
      if (!isNaN(num) && num >= led.seq) led.seq = num;
      led.items.push({ id: itemId, title: t.slice(0, 300), status: entry.status, note: entry.note.slice(0, 500), createdAt: now, updatedAt: now });
    }
    return { text: `Added ${entries.length} item(s).\n${render(led)}`, changed: true };
  }
  if (act === 'update' || act === 'remove') {
    const it = findItem(led, id);
    if (!it) return { text: `ERROR: no ledger item matching "${id}".\n${render(led)}`, changed: false };
    if (act === 'remove') {
      led.items = led.items.filter((i) => i !== it);
      return { text: `Removed ${it.id}.\n${render(led)}`, changed: true };
    }
    if (status !== undefined) {
      const s = String(status);
      if (!STATUSES.includes(s)) return { text: `ERROR: status must be one of ${STATUSES.join('|')}.`, changed: false };
      it.status = s;
    }
    if (note !== undefined) it.note = String(note).slice(0, 500);
    it.updatedAt = new Date().toISOString();
    return { text: render(led), changed: true };
  }
  if (act === 'clear_done') {
    const before = led.items.length;
    led.items = led.items.filter((i) => i.status !== 'done');
    return { text: `Removed ${before - led.items.length} done item(s).\n${render(led)}`, changed: before !== led.items.length };
  }
  return { text: `ERROR: unknown action "${act}" — use list|add|update|remove|clear_done.`, changed: false };
}

const { evaluateLedger, isTerminal, isActionable } = require('./ledger-gate.cjs');

module.exports = {
  STATUSES,
  derivePath,
  emptyLedger,
  load,
  loadMerged,
  save,
  update,
  counts,
  icon,
  itemLine,
  render,
  contextLines,
  plannerBlock,
  apply,
  parseMarkdown,
  toMarkdown,
  findMarkdownLedger,
  evaluateLedger,
  isTerminal,
  isActionable,
};
