'use strict';
// forge-ledger.cjs — the durable record for ONE /forge run: the thing every
// participating agent reads before it works and writes after it works.
//
// A forge is not one long mission. It is many separate agent turns, on
// possibly many machines and providers, all pointed at one goal, passing the
// ACTUAL PROJECT to each other through a shared git branch. What they cannot
// pass through git is intent: what the last worker believed it accomplished,
// what it does not trust, what it deliberately left alone, and which findings
// have merely been CLAIMED fixed versus independently VERIFIED fixed. That is
// this file.
//
// Two deliberate design rules:
//
//  1. The ledger is committed to the forge branch (see shared/forge-git.cjs),
//     so git is the only transport. There is no second sync channel to get out
//     of step with the code, and a node that fast-forwards to the new HEAD gets
//     the ledger and the code in the same operation, always consistent.
//  2. Every write is read-modify-write under an exclusive local lock, and the
//     merge of two divergent copies is a pure function (mergeLedgers) rather
//     than "last writer wins". Two nodes checkpointing minutes apart must never
//     silently drop each other's findings — that is exactly the failure mode
//     that would let a forge declare convergence while holding open defects.
//
// shared/forge-loop.cjs holds the pure decision functions (roles, prompts,
// convergence); this file only knows how to get the record on and off disk and
// how to apply one lawful transition to it.

const fs = require('fs');
const path = require('path');
const { sleepSync } = require('./utils.cjs');
const crypto = require('crypto');

// ---------- identity ----------

// A forge is identified by its GOAL plus its BRANCH. The same goal re-run on a
// new branch is a new forge (a fresh attempt from a fresh base); the same goal
// on the same branch always resolves to the same record, so `/forge` re-invoked
// after a crash, on any machine, rejoins the run in progress instead of
// starting a second one alongside it.
function forgeIdFor(goal, branch) {
  const key = `${String(goal || '').trim()}\n${String(branch || '').trim()}`;
  return 'fg_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

// The default branch name for a goal, so `/forge <goal>` needs no second
// argument. Slugged from the goal itself: readable in `git branch` months
// later, which "forge/a3f19c" would not be.
function branchFor(goal) {
  const slug = String(goal || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-');
  return `forge/${slug || 'run'}`;
}

// Committed INTO the repo (relative to the repo root), not hidden in a
// per-machine state dir — see rule 1 above. `.converge/` is already this repo's
// convention for harness-owned files inside a workdir.
function ledgerRelPath(forgeId) { return path.join('.converge', 'forge', `${forgeId}.json`); }
function ledgerPath(workdir, forgeId) { return path.join(String(workdir || '.'), ledgerRelPath(forgeId)); }

// ---------- vocabulary ----------

// A finding's lifecycle. The whole point of the forge is that these are
// DIFFERENT states: 'claimed-fixed' is one agent's opinion, 'verified-fixed'
// is a different agent having independently driven it. Convergence may only
// ever count the latter. 'reopened' exists so a verifier that finds a claimed
// fix wanting can say so without deleting the history of the claim.
const FINDING_STATES = ['observed', 'claimed-fixed', 'verified-fixed', 'reopened', 'rejected'];
// Still demanding work from the forge. Note 'claimed-fixed' is OPEN: an
// unverified claim is not a resolution, and treating it as one is precisely
// how a self-reporting agent loop declares victory over a broken product.
const OPEN_FINDING_STATES = ['observed', 'claimed-fixed', 'reopened'];
// Settled — no further work owed. 'rejected' means a reviewer judged it not a
// real defect (or explicitly out of scope), which is a legitimate ending.
const CLOSED_FINDING_STATES = ['verified-fixed', 'rejected'];

// Roles rotate so no single agent is permanently the builder or permanently
// the critic — a critic that also wrote the code grades its own homework.
const ROLES = ['builder', 'driver', 'critic', 'integrator'];

// Agent-to-agent task states. A task is a real queued unit of work one agent
// creates FOR another ("I don't trust keyboard focus handling — attack it"),
// not a line of prose in a handoff the next agent may or may not read.
const TASK_STATES = ['queued', 'claimed', 'done', 'dropped'];

// Operator control. `stop` is durable and authoritative: it survives restarts
// and the turn-complete hook refuses to dispatch anything while it is set.
const CONTROL_STATES = ['running', 'paused', 'stopped', 'converged', 'finished'];

const MAX_HANDOFFS = 40;      // rolling — the ledger is a record, not a transcript
const MAX_ROUND_LOG = 60;
const MAX_STEER = 20;

// ---------- shape ----------

function freshLedger({ goal, branch, baseSha, nodes, forgeId } = {}) {
  const b = String(branch || branchFor(goal));
  return {
    version: 1,
    forgeId: forgeId || forgeIdFor(goal, b),
    goal: String(goal || '').trim(),
    branch: b,
    baseSha: baseSha || null,
    currentHead: baseSha || null,
    round: 0,
    participatingNodes: Array.isArray(nodes) ? nodes.map(String).filter(Boolean) : [],
    currentAgent: null,
    currentRole: null,
    activeCheckpoint: null,
    control: 'running',
    stopReason: null,
    // Rounds that produced no NEW finding, consecutively. This is the number
    // convergence is actually decided on — see forge-loop.assessConvergence.
    quietRounds: 0,
    findings: [],
    tasks: [],
    changes: [],            // accepted, checkpointed work
    rejectedChanges: [],    // work explicitly backed out or refused, with why
    observations: [],       // free-form quality notes worth carrying forward
    handoffs: [],
    rounds: [],
    steer: [],              // operator instructions injected mid-run
    cost: { usd: 0, turns: 0 },
    startedAt: new Date().toISOString(),
    updatedAt: null,
    finishedAt: null,
  };
}

function normalize(raw, fallback) {
  const base = freshLedger(fallback || {});
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base, ...raw };
  for (const k of ['findings', 'tasks', 'changes', 'rejectedChanges', 'observations', 'handoffs', 'rounds', 'steer', 'participatingNodes']) {
    if (!Array.isArray(out[k])) out[k] = [];
  }
  if (!out.cost || typeof out.cost !== 'object') out.cost = { usd: 0, turns: 0 };
  if (!CONTROL_STATES.includes(out.control)) out.control = 'running';
  out.round = Number(out.round) || 0;
  out.quietRounds = Number(out.quietRounds) || 0;
  return out;
}

// ---------- disk ----------

function load(workdir, forgeId, fallback) {
  try {
    return normalize(JSON.parse(fs.readFileSync(ledgerPath(workdir, forgeId), 'utf8')), fallback);
  } catch {
    // Missing (first round) or corrupt (crash mid-write, hand edit) both start
    // from a fresh record rather than throwing — a forge must survive either.
    return fallback ? freshLedger({ ...fallback, forgeId }) : null;
  }
}

function save(workdir, ledger) {
  const led = normalize(ledger);
  led.updatedAt = new Date().toISOString();
  const file = ledgerPath(workdir, led.forgeId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(led, null, 2));
  fs.renameSync(tmp, file);   // atomic — a reader never sees a half-written ledger
  return led;
}

// Exclusive read-modify-write. Several things on ONE machine legitimately
// touch the ledger at once (the coordinator folding a turn, an operator typing
// `/forge steer`, a subagent filing a finding), and a plain load→mutate→save
// from each would lose whichever write landed first. O_EXCL on a sibling
// lockfile is the cheapest correct mutex for that, and a stale lock from a
// killed process is broken by age rather than left to wedge the run forever.
// Cross-MACHINE exclusion is a different problem with a different answer — the
// git ref lock in shared/forge-git.cjs.
const LOCK_STALE_MS = 30_000;
// sleepSync imported from ./utils.cjs

function update(workdir, forgeId, fn, fallback) {
  const file = ledgerPath(workdir, forgeId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd = null;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = Infinity; }
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`forge ledger ${forgeId} is locked by another process (waited 10s)`);
      sleepSync(25);
    }
  }
  try {
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    const led = load(workdir, forgeId, fallback);
    if (!led) throw new Error(`no forge ledger ${forgeId} in ${workdir}`);
    const next = fn(led) || led;
    return save(workdir, next);
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

// ---------- transitions ----------

function nextId(prefix, list) {
  let n = 0;
  for (const it of list || []) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(it && it.id || ''));
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return `${prefix}${n + 1}`;
}

// Two agents finding the same defect in the same file must produce ONE ledger
// entry, or the forge inflates its own finding count and never goes quiet.
// Deliberately coarse (title words + file), because a stricter key misses the
// same bug described in two ways, and a missed duplicate is worse here than a
// wrongly-merged pair — the latter is visible in the ledger, the former quietly
// prevents convergence.
function findingKey(f) {
  const title = String(f && f.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).slice(0, 8).join(' ');
  return `${String(f && f.file || '').trim()}::${title}`;
}

function addFinding(led, finding, by) {
  const f = finding || {};
  const key = findingKey(f);
  const existing = led.findings.find((x) => findingKey(x) === key);
  if (existing) {
    // A finding re-reported while it sits claimed-fixed is a REOPEN, not a
    // duplicate: someone drove it again and it is still there.
    if (existing.state === 'claimed-fixed' || existing.state === 'verified-fixed') {
      existing.state = 'reopened';
      existing.history.push({ at: new Date().toISOString(), state: 'reopened', by: by || null, note: String(f.detail || 'observed again') });
    }
    return { ledger: led, finding: existing, created: false };
  }
  const rec = {
    id: nextId('f', led.findings),
    title: String(f.title || '').trim() || 'untitled finding',
    detail: String(f.detail || '').trim(),
    file: String(f.file || '').trim() || null,
    severity: ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
    state: 'observed',
    observedBy: by || null,
    observedRound: led.round,
    history: [{ at: new Date().toISOString(), state: 'observed', by: by || null, note: String(f.detail || '').slice(0, 500) }],
  };
  led.findings.push(rec);
  return { ledger: led, finding: rec, created: true };
}

// A lawful lifecycle move. The one rule enforced here — and it is the rule the
// whole forge rests on — is that an agent may not VERIFY its own claim. If the
// same agent that said "fixed" also says "verified", it is recorded as still
// merely claimed, because a self-verified fix carries exactly as much evidence
// as the claim did.
function transitionFinding(led, id, state, by, note) {
  const f = led.findings.find((x) => x.id === id);
  if (!f) return { ledger: led, ok: false, reason: `no finding ${id}` };
  if (!FINDING_STATES.includes(state)) return { ledger: led, ok: false, reason: `invalid finding state ${state}` };
  let applied = state;
  let why = note || '';
  if (state === 'verified-fixed') {
    const claimant = [...f.history].reverse().find((h) => h.state === 'claimed-fixed');
    if (claimant && by && claimant.by && String(claimant.by) === String(by)) {
      applied = 'claimed-fixed';
      why = `${why ? why + ' — ' : ''}self-verification refused: ${by} also claimed this fix; another agent must drive it`;
    }
  }
  f.state = applied;
  f.history.push({ at: new Date().toISOString(), state: applied, by: by || null, note: String(why).slice(0, 500) });
  return { ledger: led, ok: true, finding: f, applied };
}

const openFindings = (led) => (led.findings || []).filter((f) => OPEN_FINDING_STATES.includes(f.state));
const unverifiedClaims = (led) => (led.findings || []).filter((f) => f.state === 'claimed-fixed');

// One agent creating real work for another. `preferredNode` is a hint, never a
// requirement — the coordinator still picks from who is actually available.
function addTask(led, task, by) {
  const t = task || {};
  const rec = {
    id: nextId('t', led.tasks),
    role: ROLES.includes(t.role) ? t.role : 'critic',
    target: String(t.target || '').trim(),
    detail: String(t.detail || '').trim(),
    requestedBy: by || null,
    preferredNode: t.preferredNode ? String(t.preferredNode) : null,
    findingId: t.findingId || null,
    state: 'queued',
    createdRound: led.round,
    createdAt: new Date().toISOString(),
  };
  led.tasks.push(rec);
  return { ledger: led, task: rec };
}

function setTaskState(led, id, state, by) {
  const t = led.tasks.find((x) => x.id === id);
  if (!t || !TASK_STATES.includes(state)) return { ledger: led, ok: false };
  t.state = state;
  t.claimedBy = state === 'claimed' ? (by || null) : t.claimedBy || null;
  t.updatedAt = new Date().toISOString();
  return { ledger: led, ok: true, task: t };
}

const queuedTasks = (led) => (led.tasks || []).filter((t) => t.state === 'queued');

// A task this node CLAIMED and never finished is abandoned work, not work in
// progress: the only thing that ever sets 'claimed' is a round starting on this
// node, and a round cannot still be running while this node is starting a new
// forge process. Without this, a coordinator killed mid-round strands its
// subtask in 'claimed' forever — queuedTasks() stops returning it, so it is
// never re-dispatched, and assessConvergence never counts it, so the forge can
// converge with that work silently undone. Observed live: SIGKILL after the
// claim and before the handoff left t1 claimed by another machine with the resumed
// coordinator cheerfully choosing an unrelated role.
// Deliberately scoped to THIS node — a task claimed by a DIFFERENT machine may
// genuinely be running right now, and stealing it would double-dispatch it.
function reclaimAbandonedTasks(led, node) {
  const me = String(node || '').trim();
  const reclaimed = [];
  for (const t of led.tasks || []) {
    if (t.state !== 'claimed') continue;
    if (me && String(t.claimedBy || '') !== me) continue;
    t.state = 'queued';
    t.claimedBy = null;
    t.updatedAt = new Date().toISOString();
    t.reclaimedAt = t.updatedAt;
    reclaimed.push(t.id);
  }
  // The same crash leaves these pointing at an agent that is not running.
  if (me && String(led.currentAgent || '') === me) { led.currentAgent = null; led.currentRole = null; }
  return { ledger: led, reclaimed };
}

// Fold one completed agent turn (its handoff envelope) into the record. This
// is the ONLY place `round` and `quietRounds` advance, so the convergence
// counter can never be nudged by anything other than a real, completed turn.
function recordHandoff(led, handoff, meta) {
  const h = handoff || {};
  const m = meta || {};
  const before = (led.findings || []).length;
  for (const f of Array.isArray(h.findings) ? h.findings : []) addFinding(led, f, m.node);
  for (const c of Array.isArray(h.claimedFixes) ? h.claimedFixes : []) {
    if (c && c.findingId) transitionFinding(led, c.findingId, 'claimed-fixed', m.node, c.note);
  }
  for (const v of Array.isArray(h.verifiedFixes) ? h.verifiedFixes : []) {
    if (v && v.findingId) transitionFinding(led, v.findingId, 'verified-fixed', m.node, v.note);
  }
  for (const r of Array.isArray(h.reopened) ? h.reopened : []) {
    if (r && r.findingId) transitionFinding(led, r.findingId, 'reopened', m.node, r.note);
  }
  for (const r of Array.isArray(h.rejected) ? h.rejected : []) {
    if (r && r.findingId) transitionFinding(led, r.findingId, 'rejected', m.node, r.note);
  }
  for (const t of Array.isArray(h.tasksForOthers) ? h.tasksForOthers : []) addTask(led, t, m.node);
  for (const o of Array.isArray(h.observations) ? h.observations : []) {
    led.observations.push({ at: new Date().toISOString(), by: m.node || null, text: String(o).slice(0, 500) });
  }
  const newFindings = (led.findings || []).length - before;
  led.handoffs.push({
    at: new Date().toISOString(),
    round: led.round,
    node: m.node || null,
    role: m.role || null,
    providerRef: m.providerRef || null,
    changed: String(h.changed || '').slice(0, 2000),
    drove: String(h.drove || '').slice(0, 2000),
    bothers: String(h.bothers || '').slice(0, 2000),
    inspectNext: String(h.inspectNext || '').slice(0, 2000),
    untouched: String(h.untouched || '').slice(0, 2000),
    sha: h.sha || m.sha || null,
    ok: m.ok !== false,
  });
  led.handoffs = led.handoffs.slice(-MAX_HANDOFFS);
  led.rounds.push({ at: new Date().toISOString(), round: led.round, node: m.node || null, role: m.role || null, newFindings, ok: m.ok !== false });
  led.rounds = led.rounds.slice(-MAX_ROUND_LOG);
  // A round only counts as QUIET when it was a genuine, successful look that
  // turned up nothing new. Two kinds of round found nothing for reasons that
  // say NOTHING about the project, and both reset the counter instead:
  //   - it errored out, so it never really looked (an outage must never
  //     masquerade as "nothing left to improve");
  //   - it produced no parseable handoff, so we have no idea what it found.
  //     Observed live on the first real forge round: the worker did substantial
  //     work and reported it in prose, the envelope did not survive, and the
  //     round scored as quiet — banking a convergence credit for a round whose
  //     findings nobody ever saw.
  //   - it CHANGED the product. A round that rewrote a module and found no
  //     defects has not shown the forge is finished; it has produced a new
  //     state nobody has reviewed yet. Counting it as quiet is how a forge
  //     converges on its own most recent, least-inspected change. Also observed
  //     live: a round that rewrote calc.js end to end reported zero findings.
  if (m.ok === false || h.unstructured || m.changedCode) led.quietRounds = 0;
  else led.quietRounds = newFindings > 0 ? 0 : led.quietRounds + 1;
  led.round += 1;
  led.currentAgent = null;
  led.currentRole = null;
  if (m.cost) { led.cost.usd = Number((Number(led.cost.usd || 0) + Number(m.cost) || 0).toFixed(4)); }
  led.cost.turns = (Number(led.cost.turns) || 0) + 1;
  return led;
}

function recordCheckpoint(led, cp) {
  const c = cp || {};
  led.currentHead = c.sha || led.currentHead;
  led.activeCheckpoint = {
    at: new Date().toISOString(), sha: c.sha || null, node: c.node || null,
    summary: String(c.summary || '').slice(0, 500),
    // Git's own account of the change, kept beside the agent's. See
    // shared/forge-git.cjs's changedFiles for why both are recorded.
    files: Array.isArray(c.files) ? c.files.slice(0, 50) : [],
  };
  led.changes.push(led.activeCheckpoint);
  return led;
}

function setControl(led, control, reason) {
  if (!CONTROL_STATES.includes(control)) return led;
  led.control = control;
  if (control === 'stopped' || control === 'converged' || control === 'finished') {
    led.stopReason = reason || led.stopReason || control;
    led.finishedAt = new Date().toISOString();
  }
  return led;
}

function addSteer(led, text, by) {
  led.steer.push({ at: new Date().toISOString(), by: by || 'operator', text: String(text || '').slice(0, 2000), consumed: false });
  led.steer = led.steer.slice(-MAX_STEER);
  return led;
}

// Steering is delivered exactly once, to the next agent that starts a turn —
// it is an instruction, not a standing part of the goal, and re-injecting it
// every round would quietly rewrite the objective.
function consumeSteer(led) {
  const pending = led.steer.filter((s) => !s.consumed);
  for (const s of pending) s.consumed = true;
  return pending.map((s) => s.text);
}

function addNode(led, node) {
  const n = String(node || '').trim();
  if (n && !led.participatingNodes.includes(n)) led.participatingNodes.push(n);
  return led;
}
function removeNode(led, node) {
  led.participatingNodes = led.participatingNodes.filter((n) => n !== String(node || '').trim());
  return led;
}

module.exports = {
  forgeIdFor, branchFor, ledgerPath, ledgerRelPath,
  freshLedger, normalize, load, save, update,
  addFinding, transitionFinding, findingKey, openFindings, unverifiedClaims,
  addTask, setTaskState, queuedTasks, reclaimAbandonedTasks,
  recordHandoff, recordCheckpoint, setControl, addSteer, consumeSteer, addNode, removeNode,
  FINDING_STATES, OPEN_FINDING_STATES, CLOSED_FINDING_STATES, ROLES, TASK_STATES, CONTROL_STATES,
};
