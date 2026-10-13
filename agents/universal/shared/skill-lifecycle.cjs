'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { safeName, sha256: hash, readJson, atomicJson: atomic, appendJsonl: append } = require('./utils.cjs');

const VERSION = 1;
const DAY = 86400000;
const DEFAULTS = Object.freeze({ staleDays: 90, pruneDays: 180, minHarmfulFailures: 2, harmfulFailureRate: 0.5 });
const paths = (root) => ({
  skills: path.join(root, '.converge', 'skills'),
  state: path.join(root, '.converge', 'skill-lifecycle.json'),
  receipts: path.join(root, '.converge', 'skill-lifecycle-receipts.jsonl'),
  audit: path.join(root, '.converge', 'skill-lifecycle-audit.jsonl'),
  quarantine: path.join(root, '.converge', 'skill-quarantine'),
});
const empty = () => ({ version: VERSION, revision: 0, skills: {} });
function load(root) { const value = readJson(paths(root).state, empty()); return value && value.skills ? value : empty(); }
function save(root, state) { state.revision = (state.revision || 0) + 1; atomic(paths(root).state, state); }
function at(opts) { return new Date(opts && opts.now != null ? opts.now : Date.now()).toISOString(); }
function manifests(root) {
  try {
    const dir = paths(root).skills;
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir);
    const jsonFiles = new Set(files.filter((x) => x.endsWith('.json')));
    const mdFiles = files.filter((x) => x.endsWith('.md') && !x.startsWith('.'));
    const result = [];
    for (const file of jsonFiles) {
      if (file.startsWith('.')) continue;
      const data = readJson(path.join(dir, file));
      if (data && data.name && data.activeVersion) result.push(data);
    }
    for (const mdFile of mdFiles) {
      const name = mdFile.replace(/\.md$/, '');
      if (!jsonFiles.has(`${name}.json`)) {
        const filePath = path.join(dir, mdFile);
        const content = fs.readFileSync(filePath, 'utf8');
        const mtime = fs.statSync(filePath).mtime.toISOString();
        result.push({
          name,
          activeVersion: '1.0.0',
          title: name.replace(/_/g, ' '),
          procedureHash: hash(content),
          promotedAt: mtime,
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}
function ensure(state, manifest) {
  const name = manifest.name;
  return state.skills[name] || (state.skills[name] = { name, activeVersion: manifest.activeVersion, procedureHash: manifest.procedureHash || '', state: 'active', uses: 0, successes: 0, failures: 0, compatibilityFailures: 0, lastUsedAt: null, lastSuccessAt: null, lastFailureAt: null, regressionRefs: [], mergedInto: null, quarantinedAt: null, archivedAt: null });
}
function validateReceipt(input) {
  if (!input || input.issuedBy !== 'converge-agent' || input.settled !== true) throw new Error('skill lifecycle evidence must be a settled converge-agent receipt');
  const name = safeName(input.skill);
  if (!name || name !== input.skill) throw new Error('skill must be lowercase kebab-case');
  if (!String(input.runId || '').trim()) throw new Error('runId is required');
  if (!['success', 'failure'].includes(input.outcome)) throw new Error('outcome must be success or failure');
  return name;
}
function record(root, input, opts = {}) {
  const name = validateReceipt(input);
  let manifest = readJson(path.join(paths(root).skills, `${name}.json`));
  if (!manifest && fs.existsSync(path.join(paths(root).skills, `${name}.md`))) {
    const content = fs.readFileSync(path.join(paths(root).skills, `${name}.md`), 'utf8');
    manifest = { name, activeVersion: '1.0.0', title: name, procedureHash: hash(content) };
  }
  if (!manifest) throw new Error(`unknown promoted skill ${name}`);
  if (String(input.version || '') !== String(manifest.activeVersion)) throw new Error(`receipt version must match active ${name}@${manifest.activeVersion}`);
  const receiptId = hash(JSON.stringify({ runId: input.runId, skill: name, version: input.version, outcome: input.outcome }));
  let existing = false;
  try { existing = fs.readFileSync(paths(root).receipts, 'utf8').split('\n').some((line) => line && readJsonLine(line).receiptId === receiptId); } catch {}
  if (existing) return { duplicate: true, receiptId };
  const state = load(root), item = ensure(state, manifest), timestamp = input.at || at(opts);
  item.activeVersion = manifest.activeVersion; item.procedureHash = manifest.procedureHash || item.procedureHash; item.uses += 1; item.lastUsedAt = timestamp;
  if (input.outcome === 'success') { item.successes += 1; item.lastSuccessAt = timestamp; } else { item.failures += 1; item.lastFailureAt = timestamp; }
  if (input.compatible === false) item.compatibilityFailures += 1;
  for (const ref of Array.isArray(input.regressionRefs) ? input.regressionRefs : []) if (String(ref).trim() && !item.regressionRefs.includes(String(ref))) item.regressionRefs.push(String(ref));
  save(root, state);
  const receipt = { version: VERSION, receiptId, runId: String(input.runId), skill: name, skillVersion: manifest.activeVersion, outcome: input.outcome, compatible: input.compatible !== false, regressionRefs: item.regressionRefs, issuedBy: 'converge-agent', settled: true, at: timestamp };
  append(paths(root).receipts, receipt); append(paths(root).audit, { at: timestamp, action: 'record', skill: name, receiptId, outcome: input.outcome });
  return { duplicate: false, receiptId, skill: item };
}
function readJsonLine(line) { try { return JSON.parse(line); } catch { return {}; } }
function plan(root, opts = {}) {
  const state = load(root), now = opts.now == null ? Date.now() : opts.now, policy = { ...DEFAULTS, ...(opts.policy || {}) }, all = manifests(root);
  for (const manifest of all) ensure(state, manifest);
  const groups = new Map();
  for (const item of Object.values(state.skills)) if (item.procedureHash) { const xs = groups.get(item.procedureHash) || []; xs.push(item); groups.set(item.procedureHash, xs); }
  const duplicateOf = new Map();
  for (const xs of groups.values()) if (xs.length > 1) {
    xs.sort((a, b) => (b.successes - b.failures) - (a.successes - a.failures) || String(b.lastSuccessAt || '').localeCompare(String(a.lastSuccessAt || '')) || a.name.localeCompare(b.name));
    for (const item of xs.slice(1)) duplicateOf.set(item.name, xs[0].name);
  }
  const actions = [];
  for (const item of Object.values(state.skills).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.state !== 'active') continue;
    if (duplicateOf.has(item.name)) { actions.push({ skill: item.name, action: 'merge', into: duplicateOf.get(item.name), reason: 'duplicate-procedure' }); continue; }
    const ageDays = item.lastUsedAt ? (now - Date.parse(item.lastUsedAt)) / DAY : (now - (Date.parse(readJson(path.join(paths(root).skills, `${item.name}.json`), {}).promotedAt) || now)) / DAY;
    const rate = item.uses ? item.failures / item.uses : 0;
    if (item.compatibilityFailures > 0) actions.push({ skill: item.name, action: 'quarantine', reason: 'incompatible' });
    else if (item.failures >= policy.minHarmfulFailures && rate >= policy.harmfulFailureRate) actions.push({ skill: item.name, action: 'quarantine', reason: 'harmful-failure-rate' });
    else if (ageDays >= policy.pruneDays) actions.push({ skill: item.name, action: 'archive', reason: 'stale', ageDays });
    else if (ageDays >= policy.staleDays) actions.push({ skill: item.name, action: 'demote', reason: 'decayed', ageDays });
  }
  return { policy, actions, state };
}
function moveAlias(root, name) {
  const source = path.join(paths(root).skills, `${name}.md`), target = path.join(paths(root).quarantine, `${name}.md`);
  if (fs.existsSync(source)) { fs.mkdirSync(path.dirname(target), { recursive: true }); if (fs.existsSync(target)) fs.unlinkSync(target); fs.renameSync(source, target); }
  return fs.existsSync(target) ? path.relative(root, target) : null;
}
function apply(root, opts = {}) {
  const proposal = plan(root, opts), state = proposal.state, timestamp = at(opts), applied = [];
  for (const action of proposal.actions) {
    const item = state.skills[action.skill]; if (!item || item.state !== 'active') continue;
    item.state = action.action === 'merge' ? 'merged' : action.action === 'archive' ? 'archived' : action.action === 'demote' ? 'dormant' : 'quarantined';
    if (action.into) item.mergedInto = action.into;
    if (item.state === 'quarantined' || item.state === 'merged') { item.quarantinedAt = timestamp; item.quarantinePath = moveAlias(root, item.name); }
    if (item.state === 'archived') { item.archivedAt = timestamp; item.quarantinePath = moveAlias(root, item.name); }
    applied.push({ ...action, state: item.state }); append(paths(root).audit, { at: timestamp, ...action, state: item.state });
  }
  if (applied.length) save(root, state);
  return { applied };
}
function restore(root, name, opts = {}) {
  name = safeName(name); const state = load(root), item = state.skills[name]; if (!item) throw new Error(`unknown lifecycle skill ${name}`);
  const versionFile = path.join(paths(root).skills, name, `${item.activeVersion}.md`); if (!fs.existsSync(versionFile)) throw new Error(`immutable version missing for ${name}@${item.activeVersion}`);
  fs.copyFileSync(versionFile, path.join(paths(root).skills, `${name}.md`)); item.state = 'active'; item.mergedInto = null; item.quarantinedAt = null; item.archivedAt = null; item.quarantinePath = null;
  save(root, state); append(paths(root).audit, { at: at(opts), action: 'restore', skill: name }); return item;
}

module.exports = { VERSION, DEFAULTS, paths, load, manifests, record, plan, apply, restore, _internals: { safeName, validateReceipt } };
