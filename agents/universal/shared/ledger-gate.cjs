'use strict';
// ledger-gate.cjs — Stage 1 shared core of the ledger-driven completion gate.
//
// Today a model can end its turn while the durable ledger still holds open,
// actionable work: turns end in universal-agent.cjs the moment the model
// returns no tool call (~"a turn ends only when the model returns NO tool
// call"), even though open ledger items were injected at turn start via
// taskLedger.contextLines(). This module is the pure decision core every
// surface (console, GUI, TUI/CLI) will share: given the ledger's tasks it
// decides whether the turn may end, and if not, emits the imperative
// continuation directive naming the next actionable task ids.
//
// Grounded in the REAL durable ledger (shared/task-ledger.cjs) — no invented
// fields:
//   document : { version: 1, seq: <n>, items: [...] }
//   item     : { id: 'L<n>', title, status, note, createdAt, updatedAt }
//   statuses : STATUSES = ['pending', 'in_progress', 'done', 'blocked']
//   markdown : [ ] pending · [>] [/] [*] in_progress · [x] done · [!] [-] blocked
//
// Semantics:
//   - terminal     := status 'done' (repo-native) or 'completed'/'complete'
//                     (accepted alias). Only terminal tasks let a turn end.
//   - actionable   := non-terminal AND IN FLIGHT — i.e. the model said it
//                     STARTED this ('in_progress'). 'blocked' is the repo's own
//                     "parked — missing something" state (the ledger tool's
//                     contract: "...or blocked with a note saying exactly what
//                     is missing"), so it never blocks turn-end. Neither does
//                     bare 'pending': see WHY PENDING DOES NOT BLOCK below. An
//                     explicit `actionable` boolean on a task overrides this.
//   - block        := true iff ANY task is non-terminal AND actionable.
//   - continueDirective := imperative instruction naming the next actionable
//                     ids, ready to inject as the turn-end guard prompt.
//   - remaining    := the actionable, non-terminal task ids in ledger order.
//
// Dependency-free and pure: no fs, no locks, no I/O — callers hand it tasks.

// Statuses that satisfy the ledger. Everything else is open work.
const TERMINAL_STATUSES = new Set(['done', 'completed', 'complete']);
// Repo-native "parked" state: recorded, but not currently actionable.
const NON_ACTIONABLE_STATUSES = new Set(['blocked']);
// WHY PENDING DOES NOT BLOCK. 'pending' means noted; 'in_progress' means the
// model said it started. Treating both as actionable made every item ever
// jotted down hold turns open FOREVER, because nothing ages a ledger out: a
// conversation that pivots topics (universal-agent.cjs sets the transcript
// aside on a topic switch and never touches the ledger) kept being forced back
// onto pending items from two topics ago, mid-answer about something else.
// Holding a turn open for work in flight catches the real abandonment case —
// "I started this and then quit" — without the stale-item gravity. Items that
// were only ever noted stay visible in the checklist; they just stop steering.
const IN_FLIGHT_STATUSES = new Set(['in_progress', 'in_flight', 'active', 'started', 'doing', 'wip']);

function normStatus(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isTerminal(task) {
  return TERMINAL_STATUSES.has(normStatus(task && task.status));
}

// Explicit `actionable` on the task wins; otherwise derive from the real
// status vocabulary: in_progress is actionable, done/completed are terminal,
// blocked is parked, and pending (or no status yet) is merely noted.
function explicitActionable(task) {
  const v = task ? task.actionable : undefined;
  if (v === undefined || v === null || v === '') return null;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return true;
}

function isActionable(task) {
  if (!task || typeof task !== 'object') return false;
  if (isTerminal(task)) return false;
  const ex = explicitActionable(task);
  if (ex !== null) return ex;
  const status = normStatus(task.status);
  if (NON_ACTIONABLE_STATUSES.has(status)) return false;
  return IN_FLIGHT_STATUSES.has(status);
}

function taskId(task) { return task && task.id != null ? String(task.id) : '(unnumbered)'; }

// evaluateLedger({tasks}) -> { block, continueDirective, remaining }
// Also accepts a bare task array or a full ledger document ({items:[...]}) —
// `items` is the ledger's real collection field — so any surface can feed it
// whatever shape it already holds.
function evaluateLedger(input) {
  const tasks = Array.isArray(input)
    ? input
    : input && Array.isArray(input.tasks)
      ? input.tasks
      : input && Array.isArray(input.items)
        ? input.items
        : [];

  const remaining = [];
  for (const task of tasks) {
    if (isActionable(task)) remaining.push(taskId(task));
  }

  if (!remaining.length) {
    return { block: false, continueDirective: '', remaining: [] };
  }

  const shown = remaining.slice(0, 12);
  const more = remaining.length - shown.length;
  const noun = shown.length === 1 ? 'task' : 'tasks';
  const listing = `${shown.join(', ')}${more > 0 ? `, … +${more} more` : ''}`;
  const continueDirective =
    `Continue working: the durable task ledger still holds ${remaining.length} actionable ${noun} ` +
    `(${listing}). Resolve the next one now — drive it to done once verified, ` +
    `or mark it blocked with a note saying exactly what is missing — and do not end ` +
    `the turn while actionable ledger tasks remain.`;

  return { block: true, continueDirective, remaining };
}

module.exports = { evaluateLedger, isTerminal, isActionable };
