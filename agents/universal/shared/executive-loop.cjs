'use strict';
// executive-loop.cjs — the pure functions at the center of the executive
// decision loop. Neither touches fs, network, the model, or the fleet/mission
// machinery: they are plain data transforms, unit-testable with fixtures and
// nothing else. shared/executive-state.cjs owns getting state on/off disk;
// universal-agent.cjs's `executive` verb owns the actual frontier call and
// mission dispatch and glues everything together. shared/mission-outcome.cjs
// (required below) is likewise pure/dependency-free — reusing its
// deriveOutcome is the SAME rule every other surface in the harness follows:
// outcome vocabulary is derived in exactly one place, never re-invented here.
const missionOutcome = require('./mission-outcome.cjs');
// The engine (providers/pricing/mcp-remote…) was extracted to the standalone
// in this layout,
// an installed/flattened layout still has it as a sibling of shared/. Try both
// rather than assuming either. Returns null when neither is present.
const requireEngine = (mod) => {
  for (const rel of ['../' + mod]) {
    try { return require(require('path').resolve(__dirname, rel)); } catch (e) {
      if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  return null;
};
const providers = requireEngine('providers.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
// Reused ONLY for objectiveIdFor, so an Executive run's console-facing id is
// the exact same id shared/executive-state.cjs already keys its per-objective
// disk file with — the two records describe the same run and must agree.
const executiveState = require('./executive-state.cjs');

const MAX_SUMMARY_CHARS = 2000; // matches shared/executive-state.cjs's cap
// The run record's decision history is bounded for the SAME reason
// executive-state.cjs's summary is a rolling window, not a log: a long-lived
// objective must never grow its console-visible record without limit. Newest
// entries survive; oldest fall off the front once the cap is exceeded.
const MAX_TIMELINE_ENTRIES = 50;

// Cross-process run visibility for console/server.mjs: one compact JSON
// record per locked objective, written on every applyDecision fold — the
// SAME "one JSON file per record under CONFIG_DIR/<subsystem>/" pattern
// console/fleet/store.mjs already uses for fleet missions, so the console
// can list/read Executive runs the identical way, with no new IPC channel.
// This is deliberately the one exception to this module otherwise being a
// pure data transform: applyDecision is the single place that sees every
// decision — terminal or not — for every `executive` verb caller, making it
// the one correct place to keep this record current.
const EXECUTIVE_RUNS_DIR = path.join(process.env.CONVERGE_CONSOLE_DIR || path.join(os.homedir(), '.converge-console'), 'executive', 'runs');
function executiveRunFile(runId) {
  return path.join(EXECUTIVE_RUNS_DIR, `${String(runId).replace(/[^\w.-]/g, '_')}.json`);
}
// Best-effort: a console that isn't installed/running, or a read-only
// filesystem, must never break the executive decision loop itself.
function writeExecutiveRun(state, action, note) {
  try {
    const st = state || {};
    const runId = executiveState.objectiveIdFor(st.objective);
    const file = executiveRunFile(runId);
    let createdAt = null;
    let prevTimeline = [];
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      createdAt = prev.createdAt || null;
      prevTimeline = Array.isArray(prev.timeline) ? prev.timeline : [];
    } catch { /* first record for this run */ }
    const now = new Date().toISOString();
    const timeline = [...prevTimeline, {
      at: now,
      action,
      note: note || '',
      subgoal: st.subgoal != null ? st.subgoal : null,
      decisions: Number(st.decisions) || 0,
    }].slice(-MAX_TIMELINE_ENTRIES);
    const record = {
      id: runId,
      objective: String(st.objective || ''),
      subgoal: st.subgoal != null ? st.subgoal : null,
      lastAction: action,
      lastNote: note || '',
      latestResult: st.latestResult != null ? st.latestResult : null,
      status: st.status || 'active',
      decisions: Number(st.decisions) || 0,
      timeline,
      createdAt: createdAt || now,
      updatedAt: now,
    };
    fs.mkdirSync(EXECUTIVE_RUNS_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  } catch { /* best-effort console visibility only — never break the loop */ }
}

// The decision vocabulary. `continue`/`replan` dispatch another mission and
// keep the loop running; the rest stop it. `replan` changes the objective's
// near-term SUBGOAL (see below) without abandoning the locked objective —
// the objective is a caller input this module never overwrites, at any
// action. Kept as exported arrays so the loop driver (universal-agent.cjs)
// and this module's own status mapping never drift apart on what "terminal"
// means.
const TERMINAL_ACTIONS = ['complete', 'halt', 'failed'];
const VALID_ACTIONS = ['continue', 'replan', ...TERMINAL_ACTIONS];
// Terminal action -> the state.status it settles into. `continue`/`replan`
// both map to 'active' (handled as the fallback below).
const TERMINAL_STATUS = { complete: 'complete', halt: 'halted', failed: 'failed' };

// Where a dispatched mission runs. Absent/invalid always falls back to
// 'node': node-local dispatch must remain backward compatible. Never default to
// 'fleet': an old/malformed decision must never accidentally fan out onto
// real machines.
const VALID_DISPATCH = ['node', 'fleet'];
const DEFAULT_CONCURRENCY = 5;

function truncateForError(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n) + `...[${str.length} chars total]` : str;
}

function trimmedOrUndefined(v) {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function positiveIntOr(v, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

// A parsed object looks like an Executive decision when it carries any of the
// decision-schema keys the frontier is asked to emit. Used to skip incidental
// {...} blobs Claude embeds in prose (prior latestResult, example shapes)
// before the actual decision object.
function looksLikeExecutiveDecision(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (Object.prototype.hasOwnProperty.call(o, 'action')) return true;
  if (o.missionGoal != null || o.mission != null) return true;
  if (o.dispatch != null || o.selector != null) return true;
  if (o.subgoal != null) return true;
  return false;
}

// Parse ONE raw frontier reply into a normalized executive decision. Strip
// fences, then take the first valid balanced {...} via the same string-aware
// scan providers.extractJsonObjects uses — never the greedy first-{ to last-}
// regex, which breaks on noisy Claude frontier text that embeds multiple
// objects. Try candidates until one JSON.parses; prefer decision-shaped ones.
// `dispatch` defaults to 'node' whenever missing or not one of VALID_DISPATCH
// — this is the one field this function refuses to be permissive about in the
// fleet direction.
function parseExecutiveDecision(raw) {
  const text = String(raw || '').trim();
  const cleaned = providers.stripFences(text).trim();
  const candidates = providers.extractJsonObjects(cleaned);
  if (!candidates.length && cleaned) candidates.push(cleaned);

  let parsed = null;
  let fallback = null;
  for (const cand of candidates) {
    let o;
    try { o = JSON.parse(cand); } catch { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (!fallback) fallback = o;
    if (looksLikeExecutiveDecision(o)) { parsed = o; break; }
  }
  if (!parsed) parsed = fallback;
  if (!parsed) throw new Error(`executive decision was not valid JSON: ${truncateForError(text, 200)}`);

  const p = parsed;
  const action = VALID_ACTIONS.includes(p.action) ? p.action : 'continue';
  const dispatch = VALID_DISPATCH.includes(p.dispatch) ? p.dispatch : 'node';
  let selector = p.selector != null ? String(p.selector).trim() : '';
  // Ergonomic normalization: the frontier often names an explicit machine set
  // as "host-a,host-b,host-c". The console selector grammar represents that
  // as name:host-a,host-b,host-c. Preserve all already-typed selectors.
  if (dispatch === 'fleet' && selector.includes(',') && !selector.includes(':')) selector = `name:${selector}`;
  return {
    action,
    missionGoal: String(p.missionGoal || p.mission || '').trim(),
    subgoal: p.subgoal != null ? String(p.subgoal).trim() : undefined,
    note: String(p.note || p.reason || '').trim(),
    moonshot: !!p.moonshot,
    dispatch,
    selector,
    build: !!p.build,
    readonly: !!p.readonly,
    confirm: !!p.confirm,
    concurrency: positiveIntOr(p.concurrency, DEFAULT_CONCURRENCY),
    provider: trimmedOrUndefined(p.provider),
    model: trimmedOrUndefined(p.model),
    effort: trimmedOrUndefined(p.effort),
    role: p.role === 'tester' ? 'tester' : 'worker',
    skill: p.skill && typeof p.skill === 'object' ? {
      name: String(p.skill.name || '').trim(),
      title: String(p.skill.title || '').trim(),
      procedure: Array.isArray(p.skill.procedure) ? p.skill.procedure.map(String) : [],
    } : null,
  };
}

// Fail-closed gate for a fleet dispatch, independent of how the decision was
// built (parseExecutiveDecision's own defaults, or a hand-built object in a
// test). A malformed fleet decision must never reach launchFleetMission.
// Backward-compatible pure helpers retained for the original Stage 1 tests
// and any callers that still exercise dispatch independently from the full
// universal-agent Executive driver. Runtime Executive dispatch lives in
// universal-agent.cjs; these wrappers intentionally stay dependency-injected.
function parseDecision(input) {
  const decision = parseExecutiveDecision(typeof input === 'string' ? input : JSON.stringify(input || {}));
  const check = validateFleetDecision(decision);
  return check.ok ? { ...decision, ok: true } : { ...decision, ok: false, reason: check.reason };
}

async function dispatchDecision(decision, deps = {}) {
  const d = decision || {};
  if (d.ok === false) return { ok: false, dispatch: d.dispatch || 'node', reason: d.reason || 'invalid decision' };
  if (d.dispatch === 'fleet') {
    const check = validateFleetDecision(d);
    if (!check.ok) return { ok: false, dispatch: 'fleet', reason: check.reason };
    if (typeof deps.launchFleetMission !== 'function') return { ok: false, dispatch: 'fleet', reason: 'launchFleetMission dependency is required' };
    const result = await deps.launchFleetMission({ goal: d.missionGoal, selector: d.selector, build: d.build, readonly: d.readonly, confirm: d.confirm, concurrency: d.concurrency, provider: d.provider, model: d.model, effort: d.effort });
    return { dispatch: 'fleet', ...(result || {}) };
  }
  if (typeof deps.runMission !== 'function') return { ok: false, dispatch: 'node', reason: 'runMission dependency is required' };
  // Forward provider/model/effort exactly like the fleet branch above — an
  // explicit node dispatch choice must reach runMission, or it silently falls
  // back to the host's configured provider (see validateNodeDecision above).
  const result = await deps.runMission({ goal: d.missionGoal, moonshot: !!d.moonshot, provider: d.provider, model: d.model, effort: d.effort });
  return { dispatch: 'node', ...(result || {}) };
}

function validateFleetDecision(decision, allowedModels) {
  const d = decision || {};
  if (d.dispatch !== 'fleet') return { ok: true };
  if (!d.selector || !String(d.selector).trim()) {
    return { ok: false, reason: 'fleet dispatch requires a non-empty selector' };
  }
  if (!Number.isInteger(d.concurrency) || d.concurrency <= 0) {
    return { ok: false, reason: 'fleet dispatch requires a positive integer concurrency' };
  }
  if (Array.isArray(allowedModels) && allowedModels.length) {
    const refs = allowedModels.map((x) => typeof x === 'string' ? x : x && x.ref).filter(Boolean);
    if (!d.provider || !d.model) return { ok: false, reason: 'fleet dispatch must choose provider and model from the executive allowedModels list' };
    const ref = `${d.provider}/${d.model}`;
    if (!refs.includes(ref)) return { ok: false, reason: `fleet dispatch provider/model is not allowed: ${ref}` };
  }
  return { ok: true };
}

// The operator allowlist applies to node-local Executive child missions too.
// Without this, dispatch:'node' silently falls back to the host's configured
// provider and can escape the authority envelope (observed live: Fireworks was
// invoked even though the objective explicitly forbade it). A non-empty
// allowlist therefore requires an explicit exact provider/model on every node
// dispatch, just like fleet dispatch.
function validateNodeDecision(decision, allowedModels) {
  const d = decision || {};
  if (d.dispatch !== 'node') return { ok: true };
  if (!Array.isArray(allowedModels) || !allowedModels.length) return { ok: true };
  const refs = allowedModels.map((x) => typeof x === 'string' ? x : x && x.ref).filter(Boolean);
  if (!d.provider || !d.model) return { ok: false, reason: 'node dispatch must choose provider and model from the executive allowedModels list' };
  const ref = `${d.provider}/${d.model}`;
  if (!refs.includes(ref)) return { ok: false, reason: `node dispatch provider/model is not allowed: ${ref}` };
  return { ok: true };
}

// Assemble the compact payload sent to the frontier model for ONE executive
// decision: the locked objective, the current near-term subgoal (set by the
// most recent `replan`, if any), a rolling summary of prior decisions (not
// the full transcript), current fleet/provider status, and the latest
// settled mission result. `latestResult` is accepted separately from `state`
// so a caller can hand in a just-settled result before it has been folded
// into state via applyDecision.
function buildExecutiveContext({ objective, state, fleetStatus, latestResult, skillCandidates } = {}) {
  const st = state || {};
  return {
    objective: String(objective || st.objective || ''),
    subgoal: st.subgoal != null ? st.subgoal : null,
    summary: String(st.summary || ''),
    fleetStatus: fleetStatus != null ? fleetStatus : null,
    latestResult: latestResult !== undefined ? latestResult : (st.latestResult != null ? st.latestResult : null),
    decisions: Number(st.decisions) || 0,
    skillCandidates: Array.isArray(skillCandidates) ? skillCandidates : [],
  };
}

// The executive's system prompt. Kept here — not inline in
// universal-agent.cjs's call site — so the exact framing that produces the
// decision schema lives next to the schema itself and stays unit-testable.
// The executive plays the delegation role a human executive plays over a
// team, not a second conversational assistant: it never performs the work
// itself, it assigns the next concrete unit of work to a worker (dispatch
// node|fleet), or it escalates/halts when a call needs human judgment. Its
// input is always buildExecutiveContext's compact shape — the locked
// objective, current subgoal, the <=MAX_SUMMARY_CHARS rolling summary, fleet
// status, and the latest settled (compact) mission result — never a raw
// transcript, so the prompt says so explicitly rather than leaving it
// implicit. The JSON reply schema below is UNCHANGED from the original
// prompt: parseExecutiveDecision, dispatchDecision and every downstream
// mission-machinery caller depend on these exact field names.
function buildExecutiveSystemPrompt() {
  return [
    'You are the executive for a long-horizon fleet objective — the same delegation role a human executive plays over a team, not a second conversational assistant. You never perform the work yourself and you never carry on a conversation with anyone: you assign the next concrete unit of work to a worker, or you escalate/halt when a call needs human judgment.',
    'Your input state is ALWAYS compact: the locked objective, the current near-term subgoal (if any was set by an earlier replan), a short rolling summary of prior decisions (never the full transcript), current fleet/provider status, and the latest settled mission RESULT — a compact report (ok/outcome/label/detail), never raw logs or transcripts. Decide from these reports alone; you cannot ask for more detail than they contain.',
    'Decide the single next step:',
    '"continue" — delegate another concrete unit of work toward the objective (or current subgoal) to a worker.',
    '"replan" — the approach so far is not working; delegate a unit of work that changes course AND set a new near-term subgoal — the locked objective itself never changes.',
    '"complete" — the settled evidence already satisfies the objective; delegate nothing more.',
    '"failed" — the objective cannot be reached with what is available; delegate nothing more.',
    '"halt" — escalate to the operator without declaring success or failure; delegate nothing more. Prefer this whenever the next step requires human judgment you cannot make from a compact report alone (ambiguous tradeoffs, missing authorization, safety, anything the report itself cannot resolve).',
    'Each delegated unit of work also names WHERE it runs: "dispatch":"node" (default — this same local process, exactly like the plain `mission`/`moonshot` verbs) or "dispatch":"fleet" (the existing console fleet mission route, fanning the missionGoal out to real machines). Never choose "fleet" unless the objective genuinely needs work done on other machines — it is not the default, and an invalid/missing dispatch always falls back to "node".',
    'When dispatch is "fleet", "selector" is REQUIRED (the fleet selector naming which machines to target) — a fleet decision with no selector fails closed and delegates nothing. Also set "concurrency" (positive integer, default 5), "build" (true to let workers modify files, false for read-only investigation), "readonly" (true to force a read-only audit), and "confirm" (true only to REQUEST the operator authorize a mutating multi-node fan-out — you cannot manufacture that authorization yourself; if it is required and not already granted, escalate with "halt" instead of silently dispatching).',
    'Set "provider"/"model"/"effort" to route the delegated work. If fleetStatus.allowedModels is non-empty, it is the OPERATOR AUTHORITY ENVELOPE: EVERY delegated unit of work — node or fleet — MUST choose provider+model from that exact list; never fall back to the host default and never choose a provider merely because historical roster/usage says it once worked. Providers absent from allowedModels are unavailable/ineligible for this objective.',
    'When a concrete reusable procedure succeeds, attach "skill":{"name":"lowercase-kebab-case","title":"...","procedure":["exact step 1","exact step 2"]}. Reuse the exact same name and steps on later successes. skillCandidates tells you which candidates need another worker replay or an independent test. Allocate that verification explicitly with "role":"tester"; tester work must independently replay and verify the procedure, not implement it.',
    'Reply with ONLY a JSON object — no prose, no markdown fences: {"action":"continue"|"replan"|"complete"|"failed"|"halt","missionGoal":"<the concrete next unit of work to delegate — required for continue/replan>","subgoal":"<the new near-term subgoal — set this on replan>","note":"<one short sentence why>","moonshot":false,"dispatch":"node"|"fleet","selector":"<fleet selector — required when dispatch is fleet>","build":false,"readonly":false,"concurrency":5,"confirm":false,"provider":"<optional provider override>","model":"<optional model override>","effort":"minimal"|"low"|"medium"|"high","role":"worker"|"tester","skill":{"name":"optional-kebab-name","title":"...","procedure":["..."]}}',
  ].join('\n');
}

// A settled report can carry two signals a delegating executive must never
// paper over by guessing or quietly looping again: the report itself says
// the call is ambiguous ('needs_review' — confirmed findings or no
// recognizable verdict, see foldFleetSettlement above) or that it needs
// authority the executive does not have ('blocked' — e.g. the fleet confirm
// gate, an allowlist rejection, a missing selector). Ordinary transient
// failure ('verification_failed', 'infra_error', 'interrupted', ...) stays a
// legitimate replan/retry signal for the next frontier decision — only these
// two outcomes name a decision point outside what a delegating executive
// should resolve on its own. Exported standalone so it is directly testable
// against a mock report; consulted inside applyDecision below so every
// existing caller gets the guard for free, with no dispatch/schema changes.
const ESCALATE_ON_OUTCOME = ['needs_review', 'blocked'];
function needsEscalation(report) {
  if (!report) return null;
  const outcome = String(report.outcome || '').trim();
  if (!ESCALATE_ON_OUTCOME.includes(outcome)) return null;
  return report.detail ? `${outcome}: ${report.detail}` : outcome;
}

// Fold ONE executive decision back into state. `decision` is the normalized
// result of the frontier call — { action, note?, subgoal?, result? } — where
// `result`, if present, is the settled outcome of the mission this
// decision's dispatch produced, attached by the caller AFTER the mission
// ran; this function never goes and gets it itself. A `replan` decision's
// `subgoal` (its new near-term subgoal) replaces state.subgoal; the LOCKED
// objective is never touched here, by any action — only the caller (which
// owns what "locked" means) ever sets it, via the objective it originally
// loaded state with. Returns a NEW state object; never mutates the one it
// was given.
//
// Before folding, a continue/replan decision is escalated to 'halt' when its
// attached result trips needsEscalation — mirroring how the human executive
// role has been escalating an unclear call rather than resolving it
// unilaterally, instead of letting the frontier guess past it or silently
// retry the same ambiguous/out-of-scope report forever. An already-terminal
// decision (halt/failed/complete) is left exactly as the frontier chose.
function applyDecision(decision, state) {
  const st = state || {};
  const d = decision || {};
  let action = VALID_ACTIONS.includes(d.action) ? d.action : 'continue';
  let note = String(d.note || '').trim();
  if (action === 'continue' || action === 'replan') {
    const escalate = needsEscalation(d.result);
    if (escalate) {
      action = 'halt';
      note = `Escalated — ${escalate} is outside what a delegating executive resolves on its own${note ? `; frontier said: ${note}` : ''}`;
    }
  }
  const line = `[${action}]${note ? ' ' + note : ''}`;
  const next = {
    objective: String(st.objective || ''),
    subgoal: d.subgoal !== undefined ? d.subgoal : (st.subgoal != null ? st.subgoal : null),
    summary: appendSummary(st.summary, line),
    latestResult: d.result !== undefined ? d.result : (st.latestResult != null ? st.latestResult : null),
    status: TERMINAL_STATUS[action] || 'active',
    decisions: (Number(st.decisions) || 0) + 1,
  };
  writeExecutiveRun(next, action, note);
  return next;
}

// Append one line to the rolling summary, dropping the oldest text once it
// would exceed the cap — a rolling window, never an unbounded log.
function appendSummary(prev, line) {
  const joined = [String(prev || '').trim(), line].filter(Boolean).join(' | ');
  return joined.length > MAX_SUMMARY_CHARS ? joined.slice(joined.length - MAX_SUMMARY_CHARS) : joined;
}

// A settled fleet mission's report has no single boolean "the gate passed"
// field — console/fleet/reconcile.mjs's report carries per-node
// `verification` receipts instead ({implemented, testsPassed, ...}, see
// reconcile.mjs). An EXPLICIT failure is a node that did the work
// (implemented:true) but whose tests did not pass — as opposed to a node
// with no verification evidence at all, which is "unknown", not "failed".
// report.gate is also honored if a future caller ever attaches one directly.
function explicitGateFailure(report) {
  if (!report) return false;
  if (report.gate && typeof report.gate.ok === 'boolean') return report.gate.ok === false;
  const perNode = Array.isArray(report.perNode) ? report.perNode : [];
  return perNode.some((n) => n && n.verification && n.verification.implemented === true && n.verification.testsPassed === false);
}

// A reported worker can still explicitly say its check FAILED even when the
// coordinator transport itself succeeded. Quorum means "all required nodes
// returned", not "all returned PASS". Inner-tools providers do not always
// populate the harness validation receipt, so preserve this narrow explicit
// failure signal from the reconciled per-node answer as a deterministic veto.
function explicitReportedFailure(report) {
  const perNode = report && Array.isArray(report.perNode) ? report.perNode : [];
  return perNode.some((n) => {
    if (!n || n.state !== 'reported') return false;
    const answer = String(n.answer || '').trim();
    return /^(?:\*\*)?FAIL(?:\*\*)?\b/i.test(answer);
  });
}

// Remote Executive missions (policy.mode === 'executive') emit one compact
// terminal answer shaped `Executive <status>: ...` (see emitExecutiveTerminal
// in universal-agent.cjs). That status is the objective verdict — coordination
// being reconciled is not enough. Without this, "Executive failed:" /
// "Executive infra:" / "Executive decision_limit:" folded as successful
// investigation results because they are not build missions and do not start
// with the literal word FAIL.
function executiveTerminalStatus(report) {
  const perNode = report && Array.isArray(report.perNode) ? report.perNode : [];
  for (let i = perNode.length - 1; i >= 0; i--) {
    const n = perNode[i];
    if (!n || n.state !== 'reported') continue;
    const answer = String(n.answer || '').trim();
    const m = /^(?:\*\*)?Executive\s+([A-Za-z_]+)\s*:/i.exec(answer);
    if (m) return String(m[1] || '').toLowerCase();
  }
  return null;
}

// Classify ONE settled fleet mission record (as returned by GET
// /api/fleet/mission — the durable console record, never a worker
// transcript) into the compact latestResult shape, using shared/mission-outcome.cjs's deriveOutcome for the
// outcome/label vocabulary exactly like every other surface in the harness.
//
// A reconciled mission means coordination completed — it does NOT
// automatically mean the requested work succeeded, so this checks (in
// order): quorum, then explicit gate/verification evidence, then confirmed
// critical/high findings on a BUILD mission (surfaced unresolved rather than
// blindly marked verified), before falling through to a plain success for a
// build with none of those problems, or a legitimately-successful
// investigation (findings are evidence, not execution failure, for
// read-only/non-build missions regardless of severity).
//
// Deliberately excludes report/journal/perNode/transcripts: the caller
// persists ONLY what this function returns as latestResult; the full
// evidence stays addressable by missionId in the durable mission store.
function foldFleetSettlement(mission) {
  const m = mission || {};
  const status = String(m.status || '').trim();
  const policy = m.policy || {};
  const mode = String(policy.mode || m.mode || '').trim();
  const isBuild = mode === 'build';
  const isExecutive = mode === 'executive';
  const isReadonly = policy.perms === 'readonly';
  const report = m.report || null;
  const fleet = (report && report.fleet) || null;
  const severityCounts = (report && report.severityCounts) || null;
  const targets = Array.isArray(m.targets) ? m.targets : [];
  const targeted = fleet && Number.isFinite(fleet.targeted) ? fleet.targeted : targets.length;
  const reported = fleet && Number.isFinite(fleet.reported)
    ? fleet.reported
    : targets.filter((t) => t && t.state === 'reported').length;
  const providerRefs = (m.provider && m.provider.name)
    ? [String(m.provider.name) + (m.provider.model ? '/' + String(m.provider.model) : '')]
    : [];
  const base = {
    missionId: m.id || null,
    goal: String(m.goal || ''),
    dispatch: 'fleet',
    selector: String(m.selector || ''),
    targeted,
    reported,
    ...(severityCounts ? { severityCounts } : {}),
    providerRefs,
    at: new Date().toISOString(),
  };
  const settle = (ok, outcome) => ({
    ...base, ok, exit: status || 'infra', outcome: outcome.state, label: outcome.label,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  });

  // Canceled/interrupted/timed-out/failed: coordination itself did not settle
  // cleanly. That is a dispatch/transport fact, not a verdict on the
  // requested work, so it maps to the SAME infra/interrupted/cancelled
  // vocabulary the node dispatch path already uses for a dead provider.
  if (status === 'canceled' || status === 'cancelled') return settle(false, missionOutcome.deriveOutcome({ canceled: true }));
  if (status === 'interrupted') return settle(false, missionOutcome.deriveOutcome({ interrupted: true }));
  if (status !== 'reconciled') return settle(false, missionOutcome.deriveOutcome({ infra: true })); // timeout/failed/error/unknown

  // Reconciled: coordination completed. Distinguish transport/settlement
  // success from objective/verification success (spec's "Success semantics").
  if (fleet && fleet.quorumMet === false) {
    return settle(false, missionOutcome.deriveOutcome({ gate: { ok: false } })); // 'verification_failed' — not enough evidence to trust
  }
  if (explicitGateFailure(report) || explicitReportedFailure(report)) {
    return settle(false, missionOutcome.deriveOutcome({ gate: { ok: false } })); // 'verification_failed'
  }
  if (isExecutive) {
    const terminal = executiveTerminalStatus(report);
    if (terminal === 'complete') {
      return settle(true, missionOutcome.deriveOutcome({ gate: { ok: true } }));
    }
    if (terminal === 'failed') {
      return settle(false, missionOutcome.deriveOutcome({ gate: { ok: false } }));
    }
    if (terminal === 'infra') {
      return settle(false, missionOutcome.deriveOutcome({ infra: true }));
    }
    if (terminal === 'halted' || terminal === 'halt') {
      return settle(false, missionOutcome.deriveOutcome({ blocked: 'executive halted for operator' }));
    }
    if (terminal === 'decision_limit' || terminal === 'stopped') {
      return settle(false, missionOutcome.deriveOutcome({ interrupted: true }));
    }
    // Reconciled but no recognizable Executive terminal answer — never invent
    // investigation success for a long-horizon control-plane mission.
    return settle(false, { state: 'needs_review', label: missionOutcome.OUTCOME_LABELS.needs_review });
  }
  const criticalOrHigh = !!(severityCounts && (Number(severityCounts.critical) > 0 || Number(severityCounts.high) > 0));
  if (isBuild && !isReadonly && criticalOrHigh) {
    // Confirmed critical/high findings on a BUILD/FIX objective are never
    // blindly marked verified — surface as unresolved and let the NEXT
    // executive decision replan, rather than this fold guessing for it.
    return settle(false, { state: 'needs_review', label: missionOutcome.OUTCOME_LABELS.needs_review });
  }
  if (!isBuild || isReadonly) {
    // Read-only/investigation work can legitimately complete WITH findings —
    // findings are evidence, not execution failure.
    return settle(true, missionOutcome.deriveOutcome({ reviewOnly: true }));
  }
  return settle(true, missionOutcome.deriveOutcome({ gate: { ok: true } })); // build, quorum met, no gate/severity problem
}

module.exports = {
  buildExecutiveContext, buildExecutiveSystemPrompt, applyDecision, needsEscalation, parseExecutiveDecision, parseDecision, dispatchDecision, validateFleetDecision, validateNodeDecision, foldFleetSettlement,
  TERMINAL_ACTIONS, VALID_ACTIONS, VALID_DISPATCH,
};
