(function () {
'use strict';
// mission-progress.cjs — THE one normalized progress contract. Every surface
// that wants to say "how far along is this mission" derives it here, from the
// mission's REAL stages, gates and durable state.
//
// Why this exists at all: a caller asking "how far along?" used to get whatever
// the component in front of it happened to compute — a stage banner here, a
// journal tail there, and in the worst case a percentage the MODEL had written
// about itself. A model saying "I'm about 90% done" is not evidence; it is the
// same class of claim as "verification passed", and mission-outcome.cjs already
// refuses that one. So:
//
//   - Progress is counted from stages that ACTUALLY COMPLETED and gates that
//     ACTUALLY RAN. Nothing else moves the number.
//   - Self-reported percentages are not read. SELF_REPORTED_KEYS lists the
//     field names this module deliberately ignores even when a record carries
//     them — a mission blob with `progress_percent: 95` glued on by a model
//     comes out of here with the number its stages earned.
//   - 100% means TERMINAL. A running mission is capped at 99 no matter how
//     much of its plan has passed, because the last stage can still fail and a
//     bar that hits 100 and then keeps spinning is the "Live + Done at the same
//     time" contradiction wearing a different hat.
//   - Unknown is null, never a plausible-looking zero. `budget_ms: null` says
//     "no budget was configured"; `budget_ms: 0` would say "no time left".
//
// Pure and dependency-free: no requires, no Node APIs, no clock. `now` is
// passed in so elapsed time is testable and so this file stays browser-safe.
// IIFE-wrapped for the same reason as hunks.cjs / run-status.cjs — the GUI
// renderer loads shared/*.cjs as CLASSIC scripts, where a bare top-level
// `const api` lands in the shared global scope and can collide with app code.

// Lifecycle vocabulary. Small on purpose: these are the states an operator can
// act on differently. 'unknown' is a real answer for a record that carries no
// evidence yet — it is not a synonym for 'planning'.
const PHASES = ['unknown', 'planning', 'executing', 'verifying', 'complete', 'failed'];

// Verification vocabulary, matching console/fleet/progress.mjs so the two never
// drift: 'none' is the honest "nothing was verified" and must never render as
// success. 'running' is this module's addition — a gate that is executing right
// now is materially different from one that never ran.
const VERIFICATION_STATES = ['none', 'running', 'passed', 'failed'];

const TERMINAL_OK = new Set([
  'done', 'complete', 'completed', 'reconciled', 'finished', 'passed', 'succeeded', 'success', 'verified',
]);
const TERMINAL_BAD = new Set([
  'failed', 'error', 'halted', 'cancelled', 'canceled', 'interrupted', 'timeout', 'timed_out',
  'expired', 'deadline', 'incomplete', 'partial', 'blocked', 'not_accepted', 'stopped',
]);

// Field names a model (or a hopeful upstream summarizer) might put a percentage
// in. Exported so a test can prove they are ignored; read by nothing here.
const SELF_REPORTED_KEYS = [
  'percent', 'percentComplete', 'percent_complete', 'progress', 'progressPercent',
  'progress_percent', 'completion', 'completionPercent', 'estimatedCompletion',
  'estimated_completion', 'selfReported', 'modelProgress',
];

// Harness control markers that ride the tool channel but are status, not work.
// Counting the 5s `working` heartbeat as a step turned one 25-second shell
// command into "12 tool steps" (same bug fixed in console/fleet/progress.mjs).
const CONTROL_TOOLS = new Set(['working', 'checkpoint', 'ceiling']);

function isObj(v) { return !!v && typeof v === 'object'; }
function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
function lower(v) { return str(v).trim().toLowerCase(); }
function finite(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// Epoch ms from an ISO string, a Date, or a number. null (never NaN, never 0)
// when it cannot be read — a NaN leaking into elapsed_ms poisons every
// comparison downstream silently.
function parseTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

function firstTs(list) {
  for (const v of list) { const t = parseTs(v); if (t != null) return t; }
  return null;
}

function firstNum(list) {
  for (const v of list) { const n = finite(typeof v === 'string' ? Number(v) : v); if (n != null) return n; }
  return null;
}

function firstArray(list) {
  for (const v of list) if (Array.isArray(v) && v.length) return v;
  return null;
}

// Compact durations for a one-line summary: 45s · 4m12s · 1h02m. Deliberately
// tighter than run-status.cjs's spaced fmtDur — this string shares a line with
// three other facts, so it spends no characters on whitespace.
function fmtCompact(ms) {
  const n = finite(ms);
  if (n == null) return null;
  const total = Math.max(0, Math.round(n / 1000));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
}

function clampPercent(n) {
  const v = finite(n);
  if (v == null) return 0;
  return Math.max(0, Math.min(100, Math.floor(v)));
}

// --- stages -----------------------------------------------------------------
//
// Real shapes this has to swallow, all of them live in this repo:
//   plan.json          { objective, stages: [{ title, prompt, judge }] }
//   mission emit       { phase: 'planned', total, stages: ['title', ...] }
//   mission loop       stageResults: [{ title, pass, attempts, gate, resumedSkip }]
//   fleet/durable      mission.stages / mission.state.stages with state|status
// so entries may be objects OR bare title strings, and completion may live on
// the stage, on a parallel results array, or on neither yet.

function stageStatusOf(stage, result) {
  const s = isObj(stage) ? stage : {};
  const r = isObj(result) ? result : {};
  if (r.pass === true || s.pass === true) return 'passed';
  if (r.pass === false || s.pass === false) return 'failed';
  const raw = lower(r.state || r.status || s.state || s.status);
  if (!raw) return 'pending';
  if (['passed', 'pass', 'done', 'complete', 'completed', 'ok', 'reported', 'succeeded'].includes(raw)) return 'passed';
  if (['failed', 'fail', 'error', 'halted', 'skipped', 'cancelled', 'canceled'].includes(raw)) return 'failed';
  if (['running', 'active', 'in_progress', 'executing', 'verifying', 'repairing'].includes(raw)) return 'running';
  return 'pending';
}

function stageTitleOf(stage, result) {
  if (typeof stage === 'string' && stage.trim()) {
    const trimmed = stage.trim();
    if (trimmed.startsWith('{')) {
      try {
        const p = JSON.parse(trimmed);
        if (p && typeof p === 'object') {
          const t = str(p.title || p.name || p.step || p.stage || p.summary).trim();
          if (t) return t;
          const pr = str(p.prompt || p.description).trim();
          if (pr) return pr.length > 60 ? `${pr.slice(0, 57)}...` : pr;
        }
      } catch {}
    }
    return trimmed;
  }
  const s = isObj(stage) ? stage : {};
  const r = isObj(result) ? result : {};
  const t = str(s.title || s.name || s.step || s.stage || s.summary || r.title || r.name).trim();
  if (t) return t;
  const p = str(s.prompt || r.prompt || s.description).trim();
  return p ? (p.length > 60 ? `${p.slice(0, 57)}...` : p) : '';
}

function collectStages(m) {
  const plan = isObj(m.plan) ? m.plan : (isObj(m.durable) && isObj(m.durable.plan) ? m.durable.plan
    : (isObj(m.state) && isObj(m.state.plan) ? m.state.plan : null));
  const raw = firstArray([
    m.stages, plan && plan.stages,
    isObj(m.durable) ? m.durable.stages : null,
    isObj(m.state) ? m.state.stages : null,
  ]);
  const results = firstArray([
    m.stageResults, m.stage_results,
    isObj(m.durable) ? m.durable.stageResults : null,
    isObj(m.state) ? m.state.stageResults : null,
  ]) || [];
  const declaredTotal = firstNum([
    isObj(m.stage) ? m.stage.total : null, m.stageTotal, m.stage_total,
    plan && plan.total, m.totalStages,
  ]);
  const n = Math.max(raw ? raw.length : 0, results.length, declaredTotal != null ? Math.max(0, Math.floor(declaredTotal)) : 0);
  if (!n) return null; // no stage information AT ALL — distinct from "zero stages planned"
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = raw ? raw[i] : null;
    const r = results[i];
    out.push({
      title: stageTitleOf(s, r),
      status: stageStatusOf(s, r),
      gate: (isObj(r) && r.gate) || (isObj(s) && s.gate) || null,
    });
  }
  return out;
}

// --- journal / durable evidence ---------------------------------------------

function eventKind(e) { return lower(e.event || e.kind || (e.t === 'mission' ? 'mission' : e.type)); }

// One pass over the journal for every fact derived from it: finished tool
// calls, gate verdicts, whether a gate is open right now, and the label of the
// tool still running (the literal answer to "what is it doing").
function scanJournal(journal) {
  const out = { toolSteps: null, gatePassed: false, gateFailed: false, gateRunning: false, openTool: null, gateLabel: '' };
  if (!Array.isArray(journal) || !journal.length) return out;
  let steps = 0;
  const openTools = [];
  for (const raw of journal) {
    const e = isObj(raw) ? raw : {};
    const kind = eventKind(e);
    if (kind === 'gate' || kind === 'validation' || kind === 'verify') {
      const phase = lower(e.phase);
      if (e.label || e.command) out.gateLabel = str(e.label || e.command);
      if (e.canceled) { out.gateRunning = false; continue; } // a canceled gate verified nothing
      if (phase === 'start' || phase === 'running' || e.running === true) { out.gateRunning = true; continue; }
      if (e.ok === true) { out.gatePassed = true; out.gateFailed = false; out.gateRunning = false; }
      else if (e.ok === false) { out.gateFailed = true; out.gatePassed = false; out.gateRunning = false; }
      continue;
    }
    if (kind !== 'tool') continue;
    const name = lower(e.name);
    if (CONTROL_TOOLS.has(name)) continue;
    const phase = lower(e.phase);
    if (phase === 'start') { openTools.push(str(e.label || e.name || 'tool')); continue; }
    if (phase === 'end' || phase === 'done') {
      steps++;
      if (openTools.length) openTools.pop();
      // The engine runs a stage's gate as a `verify` tool call; that IS a
      // deterministic verdict and counts exactly like a gate event.
      if (name === 'verify' || name === 'validate') {
        if (e.ok === true) { out.gatePassed = true; out.gateFailed = false; }
        else if (e.ok === false) { out.gateFailed = true; out.gatePassed = false; }
        out.gateRunning = false;
      }
    }
  }
  if (openTools.length) {
    out.openTool = openTools[openTools.length - 1];
    const t = lower(out.openTool);
    if (t.startsWith('verify') || t.startsWith('validate')) out.gateRunning = true;
  }
  out.toolSteps = steps;
  return out;
}

// Live-turn tool rows (the shape run-status.cjs reads): finished real tool
// calls only — prose, stage banners and listings are transcript, not work.
function stepsFromTools(tools) {
  if (!Array.isArray(tools)) return null;
  return tools.filter((s) => isObj(s) && s.done && !s.interim && !s.stage && !s.listings).length;
}

function openToolFromTools(tools) {
  if (!Array.isArray(tools)) return null;
  for (let i = tools.length - 1; i >= 0; i--) {
    const s = tools[i];
    if (!isObj(s) || s.done) continue;
    if (s.interim || s.listings || s.browse) continue;
    if (s.stage) continue; // the stage banner is context; the tool inside it is the action
    return str(s.label || s.name || 'tool');
  }
  return null;
}

// The mission's verification verdict, from deterministic evidence only. A
// structured gate record on the mission (lastValidation is the engine's own
// durable one) outranks a journal reconstruction; a gate that is OPEN outranks
// an older resolved verdict, because "verifying now" is the more current fact.
function deriveVerification(m, stages, currentIdx, scan) {
  const explicitRunning = isObj(m.gate) && (m.gate.running === true || lower(m.gate.state) === 'running');
  if (explicitRunning || scan.gateRunning) return 'running';
  const records = [];
  if (isObj(m.lastValidation)) records.push(m.lastValidation);
  if (isObj(m.validationResult)) records.push(m.validationResult);
  if (isObj(m.verification)) records.push(m.verification);
  if (isObj(m.gate)) records.push(m.gate);
  if (stages && currentIdx != null && isObj(stages[currentIdx]) && isObj(stages[currentIdx].gate)) records.push(stages[currentIdx].gate);
  for (const r of records) {
    if (!isObj(r) || r.canceled) continue;
    if (r.ok === true || r.passed === true) return 'passed';
    if (r.ok === false || r.passed === false) return 'failed';
  }
  if (scan.gateFailed) return 'failed';
  if (scan.gatePassed) return 'passed';
  // The last resolved stage gate, newest first — a mission mid-plan reports the
  // verdict of the gate that most recently ran, not the oldest one on file.
  if (stages) {
    for (let i = stages.length - 1; i >= 0; i--) {
      const g = stages[i].gate;
      if (isObj(g) && !g.canceled) {
        if (g.ok === true || g.passed === true) return 'passed';
        if (g.ok === false || g.passed === false) return 'failed';
      }
    }
  }
  const ag = isObj(m.report) && isObj(m.report.acceptanceGate) ? m.report.acceptanceGate : null;
  if (ag && ag.passed === true) return 'passed';
  if (ag && ag.passed === false) return 'failed';
  return 'none';
}

// --- the contract -----------------------------------------------------------

function emptyProgress() {
  return {
    phase: 'unknown',
    // What the stage_index/stage_total pair COUNTS. 'stage' for a planned
    // mission; 'node' for a fleet fan-out, whose real units are machines.
    unit: 'stage',
    stage_index: null,
    stage_total: null,
    stage_name: null,
    current_action: null,
    elapsed_ms: null,
    budget_ms: null,
    tool_steps: null,
    verification_state: 'none',
    progress_percent: 0,
    summary: '',
  };
}

/**
 * normalizeMissionProgress(mission, now) → normalized progress object.
 *
 * `mission` may be a fleet mission record, the engine's durable task/mission
 * state, a mission emit frame, or any partial mix of them. `now` is epoch ms
 * (or a Date); omit it and elapsed_ms is null for a running mission rather than
 * a made-up number — this function never reads a clock itself.
 *
 * Throws for nothing. Garbage in yields the empty contract, not an exception:
 * a progress readout is the thing an operator stares at when a run is already
 * going badly, and it crashing is how a bad run becomes an invisible one.
 */
function normalizeMissionProgress(mission, now) {
  const p = emptyProgress();
  if (!isObj(mission)) { p.summary = formatProgressSummary(p); return p; }
  const m = mission;
  const nowMs = parseTs(now);

  const status = lower(m.status || m.state || (isObj(m.durable) ? m.durable.status : '') || (isObj(m.state) ? m.state.status : ''));
  const terminalOk = TERMINAL_OK.has(status) || m.done === true || m.terminal === true && !TERMINAL_BAD.has(status);
  const terminalBad = TERMINAL_BAD.has(status);
  const terminal = terminalOk || terminalBad;

  // A fleet fan-out has no stage plan; console/fleet/mission-progress-view.mjs
  // hands its NODES over as the units and says so here. Calling those "stages"
  // would invent a plan that was never written.
  p.unit = lower(m.progressUnit) === 'node' ? 'node' : 'stage';

  const stages = collectStages(m);
  const scan = scanJournal(m.journal || (isObj(m.durable) ? m.durable.journal : null) || m.events);

  // --- stage position ---
  let currentIdx = null; // 0-based
  if (stages) {
    const declared = firstNum([isObj(m.stage) ? m.stage.index : null, m.stageIndex, m.stage_index]);
    if (declared != null && declared >= 1) currentIdx = Math.min(stages.length - 1, Math.floor(declared) - 1);
    // A mission that finished cleanly sits at the END of its plan. A mission
    // that DIED keeps pointing at the stage it died on (below) — that is the
    // one an operator needs to look at.
    else if (terminalOk) currentIdx = stages.length - 1;
    else {
      const running = stages.findIndex((s) => s.status === 'running');
      const unfinished = stages.findIndex((s) => s.status !== 'passed');
      currentIdx = running >= 0 ? running : (unfinished >= 0 ? unfinished : stages.length - 1);
    }
    p.stage_total = stages.length;
    p.stage_index = currentIdx + 1;
    p.stage_name = stages[currentIdx].title || null;
  }

  const verification = deriveVerification(m, stages, currentIdx, scan);
  p.verification_state = VERIFICATION_STATES.includes(verification) ? verification : 'none';

  // --- phase ---
  if (terminalOk) p.phase = 'complete';
  else if (terminalBad) p.phase = 'failed';
  else if (p.verification_state === 'running') p.phase = 'verifying';
  else if (stages && (status === 'running' || status === 'pending' || status === '' || !terminal)) p.phase = 'executing';
  // No stage plan, but tools have demonstrably run: this is a plain gated run
  // doing work, not something still being planned. Calling it 'planning' for
  // its whole life was the one phase this contract got visibly wrong on the
  // CLI, where most tasks have no stages at all.
  else if (!terminal && scan.toolSteps > 0) p.phase = 'executing';
  else if (status === 'planning' || status === 'running' || status === 'pending' || m.journal || m.tools) p.phase = 'planning';
  else p.phase = 'unknown';

  // --- elapsed ---
  const startedAt = firstTs([
    m.startedAt, m.started_at, m.createdAt, m.created_at,
    isObj(m.durable) ? m.durable.createdAt : null,
    isObj(m.state) ? m.state.createdAt : null,
    isObj(m.plan) ? m.plan.at : null,
  ]);
  const endedAt = terminal ? firstTs([
    m.finishedAt, m.finished_at, m.endedAt, m.ended_at, m.completedAt, m.completed_at, m.updatedAt, m.updated_at,
  ]) : null;
  if (startedAt != null) {
    if (endedAt != null && endedAt >= startedAt) p.elapsed_ms = endedAt - startedAt;
    else if (nowMs != null) p.elapsed_ms = Math.max(0, nowMs - startedAt);
  }
  if (p.elapsed_ms == null) p.elapsed_ms = firstNum([m.elapsedMs, m.elapsed_ms]);

  // --- budget (null when nothing declared one; 0 would read as "no time left") ---
  const policy = isObj(m.policy) ? m.policy : {};
  let budget = firstNum([
    m.budgetMs, m.budget_ms, policy.fleetDeadlineMs, policy.deadlineMs, policy.budgetMs, policy.elapsedMs,
    isObj(m.budgets) ? m.budgets.elapsed_ms : null,
  ]);
  if (budget == null) {
    const deadlineAt = firstTs([m.deadlineAt, m.deadline_at, policy.deadlineAt]);
    if (deadlineAt != null && startedAt != null && deadlineAt > startedAt) budget = deadlineAt - startedAt;
  }
  p.budget_ms = budget != null && budget > 0 ? budget : null;

  // --- tool steps ---
  const declaredSteps = firstNum([m.toolSteps, m.tool_steps]);
  p.tool_steps = declaredSteps != null ? Math.max(0, Math.floor(declaredSteps))
    : (scan.toolSteps != null ? scan.toolSteps : stepsFromTools(m.tools));

  // --- current action: the most specific TRUE statement about right now ---
  const openTool = openToolFromTools(m.tools) || scan.openTool;
  if (m.approval || (isObj(m.run) && m.run.approval)) p.current_action = 'waiting for you to approve a command';
  else if (p.phase === 'verifying') p.current_action = scan.gateLabel ? `verifying · ${scan.gateLabel}` : 'running the verification gate';
  else if (openTool) p.current_action = openTool;
  else if (p.stage_name) p.current_action = p.stage_name;
  else if (p.phase === 'planning') p.current_action = 'planning stages';
  else if (p.phase === 'complete') p.current_action = null;
  else p.current_action = null;

  // --- percent: completed stages and resolved gates ONLY ---
  //
  // Half-credit for the stage whose gate is actually EXECUTING is the one
  // partial credit allowed, and it is still evidence: the stage's work is done
  // and a deterministic check is running on it. It is not a guess about how
  // much of the stage's prompt the model feels it has finished.
  let percent = 0;
  if (stages && stages.length) {
    const passed = stages.filter((s) => s.status === 'passed').length;
    let units = passed;
    if (!terminal && p.verification_state === 'running' && currentIdx != null && stages[currentIdx].status !== 'passed') units += 0.5;
    percent = Math.floor((units / stages.length) * 100);
    // A mission that ENDED CLEAN is 100 unless a stage is on record as having
    // failed. A stage with no recorded verdict is UNKNOWN, and unknown is not
    // failure: the harness persists its plan (plan.json) but not a per-stage
    // result, so insisting on per-stage passes reported finished missions as
    // 0% — the bar lying in the other direction, which is no better.
    if (terminalOk && !stages.some((s) => s.status === 'failed')) percent = 100;
  } else if (terminalOk) {
    percent = 100; // nothing was planned and the mission ended clean — it is done
  }
  // Monotonic across re-derivations: a repair attempt that reopens stage 3
  // must not walk the bar backwards. The floor is a durable number the caller
  // persisted, and it can never buy a running mission its way to 100.
  const floor = firstNum([m.progressFloor, m.progress_floor, m.lastProgressPercent, isObj(m.durable) ? m.durable.progressFloor : null]);
  if (floor != null) percent = Math.max(percent, clampPercent(floor));
  if (!terminal) percent = Math.min(percent, 99);
  p.progress_percent = clampPercent(percent);

  p.summary = formatProgressSummary(p);
  return p;
}

/**
 * formatProgressSummary(progress) → `stage 3/4 · verifying · 62% · 4m12s`
 *
 * Facts only, in the order an operator scans them: where, what, how far, how
 * long. Parts that are unknown are OMITTED rather than rendered as "?/?" or a
 * zero — a summary line that shows a fabricated denominator is worse than a
 * shorter one.
 */
function formatProgressSummary(progress) {
  if (!isObj(progress)) return 'unknown';
  const parts = [];
  const idx = finite(progress.stage_index);
  const total = finite(progress.stage_total);
  const unit = str(progress.unit) === 'node' ? 'node' : 'stage';
  if (idx != null && total != null && total > 0) parts.push(`${unit} ${idx}/${total}`);
  else if (idx != null) parts.push(`${unit} ${idx}`);
  const phase = str(progress.phase);
  if (phase && phase !== 'unknown') parts.push(phase);
  const pct = finite(progress.progress_percent);
  if (pct != null) parts.push(`${clampPercent(pct)}%`);
  const dur = fmtCompact(progress.elapsed_ms);
  if (dur != null) parts.push(dur);
  return parts.length ? parts.join(' · ') : 'unknown';
}

// Dim is the ONLY styling this line ever uses, and only on a real terminal.
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

/**
 * renderProgressLine(progress, opts) → one compact row for a live watcher:
 *
 *   stage 3/4 · verifying · 62% · 4m12s · 118 steps
 *
 * opts: { width, color, prefix }. Rules, all of them because this line is read
 * at a glance while something else is on fire:
 *
 *   - An unknown segment is OMITTED. A literal "null", or a zero standing in
 *     for a number nobody measured, is worse than a shorter line.
 *   - Colour ONLY when the caller states the sink is a TTY (`color: true`).
 *     Piped to a file, a log or another program this is plain text — no
 *     escapes, no cursor moves, nothing for the reader to strip back out.
 *     Default is plain: a caller that forgets cannot leak an escape.
 *   - Too narrow: drop whole trailing segments first, because the leading ones
 *     (where am I, what am I doing) are the ones worth the width. Only when a
 *     single segment still overflows is the line hard-cut with an ellipsis.
 */
function renderProgressLine(progress, opts) {
  if (!isObj(progress)) return '';
  const o = isObj(opts) ? opts : {};
  const base = formatProgressSummary(progress);
  const parts = (base && base !== 'unknown') ? base.split(' · ') : [];
  // Steps are the "it is still doing things" signal the summary alone lacks.
  // 0 is a real measurement (a turn that has not called a tool yet) and prints;
  // null means nobody counted, and prints nothing.
  const steps = finite(progress.tool_steps);
  if (steps != null && steps >= 0) {
    const n = Math.floor(steps);
    parts.push(`${n} step${n === 1 ? '' : 's'}`);
  }
  if (!parts.length) return '';
  const prefix = str(o.prefix || '');
  const width = finite(o.width);
  const fits = () => (prefix + parts.join(' · ')).length <= width;
  if (width != null && width > 0) while (parts.length > 1 && !fits()) parts.pop();
  let line = prefix + parts.join(' · ');
  if (width != null && width > 0 && line.length > width) {
    line = width > 1 ? `${line.slice(0, width - 1)}…` : line.slice(0, width);
  }
  if (o.color !== true) return line;
  // Applied AFTER truncation, so the escapes can never eat the visible width.
  return line.split(' · ').join(`${DIM} · ${OFF}`);
}

const api = {
  PHASES, VERIFICATION_STATES, SELF_REPORTED_KEYS,
  normalizeMissionProgress, formatProgressSummary, renderProgressLine, fmtCompact,
};

/* eslint-disable no-undef */
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.MissionProgress = api;
})();
