'use strict';

// Versioned, review-gated failure vocabulary shared by missions and regressions.
// Codes are immutable once activated. Changing meaning creates a new revision;
// the author can never approve their own proposal.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { atomicJson, sha256: hash, readJson } = require('./utils.cjs');

const VERSION = 1;
const DIMENSIONS = ['failureClass', 'rootCause', 'affectedRole', 'capability', 'recoveryThatWorked'];
const codePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function taxonomyPath(root) { return path.join(root, 'regressions', 'failure-taxonomy.json'); }
function empty() { return { version: VERSION, revision: 0, active: {}, proposals: [] }; }
function load(root) {
  return readJson(taxonomyPath(root), empty());
}
function validateDefinition(input) {
  const errors = [];
  if (!DIMENSIONS.includes(input && input.dimension)) errors.push(`dimension must be one of ${DIMENSIONS.join(', ')}`);
  if (!codePattern.test(String(input && input.code || ''))) errors.push('code must be lowercase kebab-case');
  if (String(input && input.code || '').length > 64) errors.push('code must be at most 64 characters');
  if (!String(input && input.description || '').trim()) errors.push('description is required');
  else if (String(input.description).trim().length > 500) errors.push('description must be at most 500 characters');
  return errors;
}
function propose(root, input, actor) {
  if (!String(actor || '').trim()) throw new Error('proposer identity is required');
  const errors = validateDefinition(input);
  if (errors.length) throw new Error(errors.join('; '));
  const state = load(root);
  const definition = { dimension: input.dimension, code: input.code, description: input.description.trim() };
  const current = state.active[input.dimension] && state.active[input.dimension][input.code];
  if (current && current.description === definition.description) throw new Error('definition is already active');
  const id = hash({ definition, actor, revision: state.revision, at: Date.now() }).slice(0, 16);
  state.proposals.push({ id, definition, replacesRevision: current ? current.revision : null, status: 'pending', proposedBy: actor, proposedAt: new Date().toISOString() });
  atomicJson(taxonomyPath(root), state);
  return state.proposals[state.proposals.length - 1];
}
function review(root, id, reviewer, decision, note = '') {
  if (!String(reviewer || '').trim()) throw new Error('reviewer identity is required');
  if (!['approve', 'reject'].includes(decision)) throw new Error('decision must be approve or reject');
  const state = load(root);
  const proposal = state.proposals.find((p) => p.id === id);
  if (!proposal) throw new Error(`unknown taxonomy proposal ${id}`);
  if (proposal.status !== 'pending') throw new Error(`proposal ${id} is already ${proposal.status}`);
  if (proposal.proposedBy === reviewer) throw new Error('independent review required: proposer cannot review');
  proposal.reviewedBy = reviewer;
  proposal.reviewedAt = new Date().toISOString();
  proposal.reviewNote = String(note || '');
  if (decision === 'reject') proposal.status = 'rejected';
  else {
    const { dimension, code, description } = proposal.definition;
    const current = state.active[dimension] && state.active[dimension][code];
    if ((current ? current.revision : null) !== proposal.replacesRevision) throw new Error('active definition changed since proposal; submit a new proposal');
    state.revision++;
    state.active[dimension] ||= {};
    state.active[dimension][code] = { description, revision: state.revision, activatedAt: proposal.reviewedAt, proposedBy: proposal.proposedBy, reviewedBy: reviewer };
    proposal.status = 'active';
    proposal.activatedRevision = state.revision;
  }
  atomicJson(taxonomyPath(root), state);
  return proposal;
}
function validateClassification(root, classification, opts = {}) {
  const state = load(root);
  const errors = [];
  for (const dimension of DIMENSIONS) {
    const code = classification && classification[dimension];
    if (!code) { if (!opts.partial) errors.push(`${dimension} is required`); continue; }
    if (!state.active[dimension] || !state.active[dimension][code]) errors.push(`${dimension} code is not active: ${code}`);
  }
  return errors;
}
function classifyMission(root, evidence = {}) {
  const state = load(root);
  const pick = (dimension, preferred) => {
    const choices = state.active[dimension] || {};
    return choices[preferred] ? preferred : (choices.unknown ? 'unknown' : null);
  };
  const text = `${evidence.status || ''} ${evidence.message || ''}`.toLowerCase();
  return {
    taxonomyRevision: state.revision,
    failureClass: pick('failureClass', /gate|validat|test/.test(text) ? 'verification' : /quota|timeout|network|provider/.test(text) ? 'infrastructure' : 'execution'),
    rootCause: pick('rootCause', /permission|denied/.test(text) ? 'permission-denied' : /timeout|stalled|max-steps/.test(text) ? 'resource-exhaustion' : 'unknown'),
    affectedRole: pick('affectedRole', evidence.role || 'worker'),
    capability: pick('capability', /gate|validat|test/.test(text) ? 'validation' : /browser/.test(text) ? 'browser' : /tool/.test(text) ? 'tool-use' : 'reasoning'),
    recoveryThatWorked: pick('recoveryThatWorked', evidence.recovery || 'none'),
    evidence: { status: evidence.status || 'failed', message: String(evidence.message || '').slice(0, 500) },
  };
}

module.exports = { VERSION, DIMENSIONS, taxonomyPath, load, propose, review, validateDefinition, validateClassification, classifyMission };
