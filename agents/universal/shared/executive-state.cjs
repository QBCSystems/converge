'use strict';
// executive-state.cjs — durable, COMPACT state for the executive loop: one
// small JSON file per locked objective under <workdir>/.converge/executive/.
// It holds only what the NEXT decision needs — the locked objective text, a
// short rolling summary of prior decisions, and the latest settled mission
// result — never a growing transcript. shared/executive-loop.cjs (pure, no
// fs/network) is what actually builds context from this and folds decisions
// back into it; this file only knows how to get that object on and off disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A rolling summary, not a log: bounded so the file can never grow with the
// objective's lifetime. shared/executive-loop.cjs enforces the same cap when
// it appends a line — this is the floor for anything written directly here.
const MAX_SUMMARY_CHARS = 2000;

// Stable id for an objective's state file — same objective text (the locked
// long-horizon goal) always resolves to the same file, across however many
// times `executive` is re-invoked at the next decision boundary.
function objectiveIdFor(objective) {
  return crypto.createHash('sha1').update(String(objective || '')).digest('hex').slice(0, 16);
}

function stateDir(workdir) { return path.join(String(workdir || '.'), '.converge', 'executive'); }
function stateFile(workdir, objective) { return path.join(stateDir(workdir), `${objectiveIdFor(objective)}.json`); }

function freshState(objective) {
  return { objective: String(objective || ''), subgoal: null, summary: '', latestResult: null, status: 'active', decisions: 0, updatedAt: null };
}

function truncateSummary(s) {
  const str = String(s || '');
  return str.length > MAX_SUMMARY_CHARS ? str.slice(str.length - MAX_SUMMARY_CHARS) : str;
}

// Best-effort read: no file yet (first run) or a corrupt/half-written one
// (crash mid-save, hand edit) both return a fresh state for this objective
// rather than throwing — the executive loop must survive either.
function loadExecutiveState(workdir, objective) {
  try {
    const raw = fs.readFileSync(stateFile(workdir, objective), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { ...freshState(objective), ...parsed, objective: String(objective || parsed.objective || '') };
    }
  } catch { /* missing or corrupt — start fresh for this objective */ }
  return freshState(objective);
}

const { atomicWrite } = require('./utils.cjs');

// Persist state, keeping only the compact fields — a caller handing back an
// enriched object (extra scratch fields from the executive loop) never grows
// the file on disk.
function saveExecutiveState(workdir, objective, state) {
  const st = state || {};
  const compact = {
    objective: String(objective || st.objective || ''),
    subgoal: st.subgoal != null ? st.subgoal : null,
    summary: truncateSummary(st.summary),
    latestResult: st.latestResult != null ? st.latestResult : null,
    status: st.status || 'active',
    decisions: Number(st.decisions) || 0,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(stateFile(workdir, objective), compact);
  return compact;
}

module.exports = { loadExecutiveState, saveExecutiveState, objectiveIdFor, stateFile, MAX_SUMMARY_CHARS };
