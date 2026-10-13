'use strict';

// Offline negative learning deliberately produces suggestions, never authority.
// A recurring, independently observed failure/recovery pair may become an
// operating rule only after deterministic validation and independent review.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { sha256: digest, atomicJson: atomic, appendJsonl: append, readJson, readJsonl } = require('./utils.cjs');

const VERSION = 1;
const DEFAULTS = Object.freeze({ minOccurrences: 3, minDistinctRuns: 3, minSuccessRate: 0.8 });
const code = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const paths = (root) => ({
  evidence: path.join(root, '.converge', 'negative-learning', 'evidence.jsonl'),
  store: path.join(root, '.converge', 'negative-learning', 'rules.json'),
  audit: path.join(root, '.converge', 'negative-learning', 'audit.jsonl'),
});
const empty = () => ({ version: VERSION, revision: 0, proposals: [], active: [] });
function load(root) { const x = readJson(paths(root).store, empty()); return x.version === VERSION && Array.isArray(x.proposals) && Array.isArray(x.active) ? x : empty(); }
function evidence(root) { return readJsonl(paths(root).evidence); }
function normalized(input) {
  const classification = input && input.classification || {};
  return {
    runId: String(input && input.runId || '').trim(),
    failureClass: String(classification.failureClass || input && input.failureClass || '').trim(),
    rootCause: String(classification.rootCause || input && input.rootCause || '').trim(),
    affectedRole: String(classification.affectedRole || input && input.affectedRole || '').trim(),
    capability: String(classification.capability || input && input.capability || '').trim(),
    recovery: String(classification.recoveryThatWorked || input && input.recoveryThatWorked || input && input.recovery || '').trim(),
    recovered: input && input.recovered === true,
    source: String(input && input.source || '').trim(),
  };
}
function validateEvidence(item) {
  const errors = [];
  if (!item.runId) errors.push('runId is required');
  for (const key of ['failureClass', 'rootCause', 'affectedRole', 'capability', 'recovery']) if (!code.test(item[key])) errors.push(`${key} must be lowercase kebab-case`);
  if (!item.source) errors.push('source is required');
  return errors;
}
function record(root, input, opts = {}) {
  const item = normalized(input), errors = validateEvidence(item); if (errors.length) throw new Error(errors.join('; '));
  const prior = evidence(root); if (prior.some((x) => x.runId === item.runId && digest(normalized(x)) === digest(item))) return { recorded: false, reason: 'duplicate', evidence: item };
  const out = { version: VERSION, ...item, recordedAt: new Date(opts.now == null ? Date.now() : opts.now).toISOString() };
  append(paths(root).evidence, out); append(paths(root).audit, { at: out.recordedAt, action: 'record-evidence', runId: out.runId }); return { recorded: true, evidence: out };
}
const signature = (x) => [x.failureClass, x.rootCause, x.affectedRole, x.capability, x.recovery].join('/');
function candidates(root, policy = {}) {
  const p = { ...DEFAULTS, ...policy }, groups = new Map();
  for (const raw of evidence(root)) { const x = normalized(raw); if (validateEvidence(x).length) continue; const key = signature(x); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(x); }
  return [...groups.entries()].map(([key, xs]) => { const runs = [...new Set(xs.map((x) => x.runId))], successes = xs.filter((x) => x.recovered).length, successRate = xs.length ? successes / xs.length : 0; return { signature: key, classification: { failureClass: xs[0].failureClass, rootCause: xs[0].rootCause, affectedRole: xs[0].affectedRole, capability: xs[0].capability, recoveryThatWorked: xs[0].recovery }, occurrences: xs.length, distinctRuns: runs.length, successes, successRate, evidenceRunIds: runs.sort(), eligible: xs.length >= p.minOccurrences && runs.length >= p.minDistinctRuns && successRate >= p.minSuccessRate }; }).sort((a, b) => a.signature.localeCompare(b.signature));
}
function propose(root, input, actor, policy = {}) {
  if (!String(actor || '').trim()) throw new Error('proposer identity is required');
  const id = String(input && input.id || '').trim(); if (!code.test(id)) throw new Error('rule id must be lowercase kebab-case');
  const candidate = candidates(root, policy).find((x) => x.signature === input.signature); if (!candidate || !candidate.eligible) throw new Error('candidate lacks recurring independently observed successful recovery evidence');
  const condition = String(input.condition || '').trim(), action = String(input.action || '').trim(); if (!condition || !action) throw new Error('condition and action are required');
  const store = load(root); if (store.proposals.some((x) => x.id === id && ['pending-validation', 'pending-review'].includes(x.status)) || store.active.some((x) => x.id === id)) throw new Error(`rule ${id} already exists`);
  const at = new Date().toISOString(), proposal = { version: VERSION, id, status: 'pending-validation', condition, action, scope: String(input.scope || 'agent').trim(), signature: candidate.signature, evidence: candidate, proposedBy: actor, proposedAt: at, validation: null, review: null };
  proposal.contentHash = digest({ condition, action, scope: proposal.scope, signature: proposal.signature }); store.proposals.push(proposal); atomic(paths(root).store, store); append(paths(root).audit, { at, action: 'propose', id, actor }); return proposal;
}
function validate(root, id, receipt, validator) {
  if (!String(validator || '').trim()) throw new Error('validator identity is required'); const store = load(root), p = store.proposals.find((x) => x.id === id); if (!p) throw new Error(`unknown proposal ${id}`); if (p.status !== 'pending-validation') throw new Error(`proposal ${id} is ${p.status}`); if (p.proposedBy === validator) throw new Error('independent validation required');
  const checks = receipt && receipt.checks; if (!Array.isArray(checks) || !checks.length || checks.some((x) => x.passed !== true) || receipt.passed !== true) throw new Error('deterministic validation receipt must contain only passing checks');
  const at = new Date().toISOString(); p.validation = { passed: true, validator, at, checks: checks.map((x) => ({ name: String(x.name || ''), passed: true, evidence: String(x.evidence || '') })), receiptHash: digest(receipt) }; p.status = 'pending-review'; atomic(paths(root).store, store); append(paths(root).audit, { at, action: 'validate', id, actor: validator }); return p;
}
function review(root, id, decision, reviewer, note = '') {
  if (!['approve', 'reject'].includes(decision)) throw new Error('decision must be approve or reject'); if (!String(reviewer || '').trim()) throw new Error('reviewer identity is required'); const store = load(root), p = store.proposals.find((x) => x.id === id); if (!p) throw new Error(`unknown proposal ${id}`); if (p.status !== 'pending-review') throw new Error(`proposal ${id} is ${p.status}`); if ([p.proposedBy, p.validation.validator].includes(reviewer)) throw new Error('independent review required');
  const at = new Date().toISOString(); p.review = { decision, reviewer, note: String(note || ''), at }; p.status = decision === 'approve' ? 'active' : 'rejected';
  if (decision === 'approve') { store.revision++; const rule = { version: VERSION, revision: store.revision, id: p.id, condition: p.condition, action: p.action, scope: p.scope, contentHash: p.contentHash, evidenceHash: digest(p.evidence), activatedAt: at, proposedBy: p.proposedBy, validatedBy: p.validation.validator, reviewedBy: reviewer }; store.active.push(rule); }
  atomic(paths(root).store, store); append(paths(root).audit, { at, action: decision === 'approve' ? 'activate' : 'reject', id, actor: reviewer }); return p;
}
function active(root, scope) { return load(root).active.filter((x) => !scope || x.scope === scope).map((x) => ({ ...x })); }

module.exports = { VERSION, DEFAULTS, paths, load, evidence, record, candidates, propose, validate, review, active, _internals: { normalized, validateEvidence, signature, digest } };
