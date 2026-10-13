'use strict';
// mission-outcome.cjs — THE one place a turn/mission outcome is derived from
// evidence. Every surface (harness receipts, fleet headlines, GUI, web console)
// reads this instead of guessing status independently — the "Live + Done at the
// same time" and "Completed successfully over untrustworthy evidence" class of
// contradictions all came from parallel per-component status logic.
//
// Ground rules encoded here (see the the harness trust-model brief):
//   - A model returning an answer is not success.
//   - A file being created is not automatically verified.
//   - A reviewer model claiming success is not verification — only a
//     deterministic gate that ran and passed earns "Verified" / green.
//   - An untracked file is not a failure and is never described as missing.
//   - A failed verification pass does not erase a successful build pass:
//     "Work produced — verification failed" keeps both facts visible.
//
// Dual-published: this CJS file is canonical (harness, gui server/renderer via
// <script>, fleet .mjs via Node CJS interop, tests). console/web/src/
// mission-outcome.mjs carries a byte-identical BODY for the Vite app;
// test/mission-outcome.test.cjs fails if the two ever drift.
//
// Browser-safe by construction: no requires, no Node APIs in the body.
//
// IIFE-wrapped like shared/hunks.cjs: this file is loaded as a CLASSIC script
// by the GUI, where top-level const/function declarations land in the shared
// global scope — an unwrapped `const api` here collided with app.js's own
// `async function api` and killed the entire renderer with a parse-time
// "Identifier 'api' has already been declared" (zero bubbles, no console
// error visible; found via chat-virtualization.test.cjs).
(function () {

// === BODY START === (identical in console/web/src/mission-outcome.mjs)
const OUTCOME_LABELS = {
  running: 'Running',
  verified: 'Verified',
  work_unverified: 'Work produced — verification pending',
  verification_failed: 'Verification failed',
  work_verification_failed: 'Work produced — verification failed',
  reported: 'Completed — report collected',
  done_chat: 'Done',
  needs_review: 'Needs review',
  blocked: 'Blocked',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  infra_error: 'Infrastructure error',
  reviewer_mutation: 'Blocked — review-only turn attempted file changes',
};

// deriveOutcome(evidence) → { state, label, badge, allowGreen, detail? }
//   badge: 'ok' | 'warn' | 'fail' | 'neutral' | 'pending'
//   allowGreen is true ONLY when a deterministic gate ran and passed — it is
//   the single switch every green check/success styling must consult.
function deriveOutcome(e) {
  e = e || {};
  const gate = e.gate || null;
  const gateCanceled = !!(gate && gate.canceled);
  const gateRan = !!(gate && gate.ok !== undefined && gate.ok !== null && !gateCanceled);
  const gateOk = gateRan && gate.ok === true;
  const files = Number(e.filesChanged || 0);
  const out = (state, badge, allowGreen, detail) => ({
    state, label: OUTCOME_LABELS[state], badge, allowGreen: !!allowGreen,
    ...(detail ? { detail: String(detail) } : {}),
  });
  if (e.running) return out('running', 'pending', false);
  if (e.infra) return out('infra_error', 'fail', false, e.infra === true ? '' : e.infra);
  if (e.canceled) return out('cancelled', 'neutral', false);
  if (e.interrupted) return out('interrupted', 'neutral', false);
  if (e.mutatedInReviewMode) return out('reviewer_mutation', 'fail', false);
  if (e.blocked) return out('blocked', 'fail', false, e.blocked === true ? '' : e.blocked);
  if (gateOk) {
    // A gate that passed is not, by itself, evidence of anything real if
    // there is no final answer to have graded — an empty/whitespace answer
    // means the "Verified" label would be describing work nobody can see.
    // Fail closed to an existing non-green state rather than trust the gate
    // in isolation.
    const answered = String(e.answer == null ? '' : e.answer).trim().length > 0;
    if (answered) return out('verified', 'ok', true);
    return files > 0
      ? out('work_verification_failed', 'fail', false)
      : out('verification_failed', 'fail', false);
  }
  if (gateRan && !gateOk) {
    return files > 0
      ? out('work_verification_failed', 'fail', false)
      : out('verification_failed', 'fail', false);
  }
  // No gate verdict this turn (none configured, or the operator canceled it):
  // nothing is Verified, whatever the model said.
  if (files > 0 || e.buildIntent) {
    return out('work_unverified', 'warn', false,
      gateCanceled ? 'verification canceled by the operator' : '');
  }
  if (e.reviewOnly) return out('reported', 'neutral', false);
  return out('done_chat', 'neutral', false);
}

// Harness {t:'summary'} receipt event → outcome. `validation` is the harness's
// structured gate verdict ({ok,label} or null — some emitters call it
// `verification`); `status` alone proves nothing: 'failed' means a gate ran
// and failed, but 'completed' only means the turn ENDED, and it used to render
// as a green "✓ Completed" even when no gate ran — so it maps to NO gate here,
// never to green.
function outcomeFromSummary(s) {
  s = s || {};
  const files = Array.isArray(s.files) ? s.files.filter((f) => f && f.action !== 'shown').length : 0;
  const v = s.validation || s.verification;
  return deriveOutcome({
    interrupted: !!s.interrupted,
    filesChanged: files,
    gate: v ? { ok: !!v.ok } : (s.status === 'failed' ? { ok: false } : null),
    buildIntent: !!s.buildIntent,
    reviewOnly: !!s.reviewOnly,
  });
}

// Attribute repository dirt honestly: only files THIS turn touched belong to
// the mission; everything else is pre-existing repository state and must not
// be blamed on (or credited to) the current work.
function classifyRepoState(input) {
  input = input || {};
  const strip = (p) => String(p || '').replace(/^\.\//, '');
  const turn = new Set((input.turnFiles || []).map(strip));
  const split = (list) => {
    const mission = [], preExisting = [];
    for (const p of list || []) (turn.has(strip(p)) ? mission : preExisting).push(strip(p));
    return { mission, preExisting };
  };
  const u = split(input.untracked), m = split(input.modified);
  return {
    missionUntracked: u.mission,
    missionModified: m.mission,
    preExistingUntracked: u.preExisting,
    preExistingModified: m.preExisting,
  };
}

// Unicode look-alikes → ASCII before extracting path claims from model prose.
// Proven live: a model wrote `neon‑aquarium` with U+2011 (non-breaking hyphen);
// the ASCII-only token regex split it at the exotic dash, "checked"
// aquarium/index.html instead, and reported a real file as missing.
function normalizeClaimText(text) {
  return String(text || '')
    .replace(/[\u2010-\u2015\u2043\u2212\uFE63\uFF0D]/g, '-')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function canonPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

// Exact path comparison — never substring matching. The only inexact match it
// recognizes is the deliberate scratch redirect (.converge-scratch/<same tail>),
// and it names that redirect instead of calling the file missing.
function comparePathClaim(requested, actual, opts) {
  const markers = (opts && opts.scratchMarkers) || ['.converge-scratch', '.converge-tmp'];
  const req = canonPath(requested), act = canonPath(actual);
  if (!req || !act) return { exact: false, redirected: false, requested: req, actual: act };
  if (req === act) return { exact: true, redirected: false, requested: req, actual: act };
  for (const mk of markers) {
    const seg = '/' + mk + '/';
    if (act.indexOf(seg) !== -1 && act.split(seg).join('/') === req) {
      return {
        exact: false, redirected: true, marker: mk, requested: req, actual: act,
        note: 'work landed under ' + mk + ' (scratch isolation), not at the requested path',
      };
    }
  }
  return { exact: false, redirected: false, requested: req, actual: act };
}

// A review/audit/verification brief is READ-ONLY unless it explicitly
// authorizes repair. Reference case: a "verify it" mission ran with full
// perms, added a second canvas and empty controls to the file it was
// auditing, then stalled — a reviewer must never silently damage the
// artifact it reviews. Prose asking a model not to edit is a request;
// perms=readonly is a rule the machine enforces.
function auditReadonlyIntent(message, opts) {
  opts = opts || {};
  if (opts.readonly === true) return true;
  if (opts.readonly === false || opts.build === true) return false;
  const text = String(message || '');
  if (/^\s*\/mission\b/i.test(text)) return false;
  const auditShaped = /\b(?:review|audit|verif(?:y|ication)|second opinion|inspect|double[\s-]?check|read[\s-]?only)\b/i.test(text);
  const repairAuthorized = /\b(?:repair|fix|patch|apply|implement|rewrite|refactor|modify|restore|write)\b/i.test(text);
  return auditShaped && !repairAuthorized;
}

// Operator-facing wording for internal lifecycle vocabulary. Technical terms
// stay available in expandable detail panels; these are the display defaults.
function humanizeNodeState(state) {
  const map = {
    reported: 'worker responded',
    reconciled: 'result collected',
    terminal: 'finished',
    canceled: 'cancelled',
  };
  return map[String(state || '')] || String(state || '');
}

function humanizeProgress(label) {
  return String(label || '')
    .replace(/\bFleet report reconciled\b/g, 'Result collected')
    .replace(/\bmission receipt received\b/gi, 'execution receipt captured')
    .replace(/\bMission receipt received\b/g, 'Execution receipt captured');
}

// severityCounts → a sentence, not "findings info:1".
function findingsSummary(sc) {
  if (!sc || typeof sc !== 'object') return 'no findings';
  const names = [
    ['critical', 'critical'], ['high', 'high'], ['medium', 'medium'],
    ['low', 'low'], ['info', 'informational'], ['unknown', 'unassessed'],
  ];
  const parts = [];
  let total = 0;
  for (const [key, word] of names) {
    const n = Number(sc[key] || 0);
    if (n > 0) { parts.push(n + ' ' + word); total += n; }
  }
  if (!parts.length) return 'no findings';
  return parts.join(', ') + ' finding' + (total === 1 ? '' : 's');
}
// === BODY END ===

const api = {
  OUTCOME_LABELS, deriveOutcome, outcomeFromSummary, classifyRepoState,
  normalizeClaimText, canonPath, comparePathClaim, auditReadonlyIntent,
  humanizeNodeState, humanizeProgress, findingsSummary,
};

/* eslint-disable no-undef */
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.MissionOutcome = api;
})();
