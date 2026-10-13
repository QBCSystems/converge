'use strict';

// Failure-mined regression corpus.  The lifecycle is deliberately mechanical:
// a failure is captured, reproduced while still broken, and only then may a
// passing fix promote it into the permanent corpus.  A model's assertion is
// never accepted as either half of that proof.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const taxonomy = require('./failure-taxonomy.cjs');

const { atomicJson, readJson, safeId, sha256: sha } = require('./utils.cjs');

const VERSION = 1;
function paths(root) {
  const dir = path.join(root, 'regressions');
  return { dir, inbox: path.join(dir, 'inbox'), corpus: path.join(dir, 'cases'), baseline: path.join(dir, 'quality-baseline.json') };
}
function validate(spec, promoted = false, root = null) {
  const errors = [];
  if (!spec || spec.version !== VERSION) errors.push(`version must be ${VERSION}`);
  if (!safeId(spec && spec.id) || safeId(spec.id) !== spec.id) errors.push('id must be lowercase kebab-case');
  if (!String(spec && spec.title || '').trim()) errors.push('title is required');
  if (!String(spec && spec.command || '').trim()) errors.push('command is required');
  if (!Array.isArray(spec && spec.affected) || !spec.affected.length) errors.push('affected must contain at least one repo-relative path or glob');
  if (!spec || !spec.source || !String(spec.source.summary || '').trim()) errors.push('source.summary is required');
  if (promoted && (!spec.reproduction || spec.reproduction.exitCode === 0 || !spec.reproduction.outputHash)) errors.push('a recorded failing reproduction is required');
  if (promoted && (!spec.fixVerification || spec.fixVerification.exitCode !== 0)) errors.push('a passing fix verification is required');
  if (promoted && !spec.classification) errors.push('an active taxonomy classification is required');
  if (spec && spec.classification && root) errors.push(...taxonomy.validateClassification(root, spec.classification));
  if (promoted && spec && spec.classification && spec.classification.recoveryThatWorked === 'none') errors.push('promoted classification must record the recovery that worked');
  return errors;
}
function runCommand(spec, root, timeoutMs = 120000) {
  const started = Date.now();
  const result = spawnSync(spec.command, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CONVERGE_REGRESSION_ID: spec.id } });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return { exitCode: result.status == null ? 124 : result.status, signal: result.signal || null, durationMs: Date.now() - started, outputHash: sha(output), output: output.slice(-4000) };
}
function capture(root, input) {
  const id = safeId(input.id || input.title);
  const spec = { version: VERSION, id, title: String(input.title || '').trim(), command: String(input.command || '').trim(), affected: [...new Set((input.affected || []).map(String))], tags: [...new Set((input.tags || []).map(String))], source: input.source || {}, ...(input.classification ? { classification: { ...input.classification, taxonomyRevision: taxonomy.load(root).revision } } : {}), createdAt: new Date().toISOString() };
  const errors = validate(spec, false, root);
  if (errors.length) throw new Error(errors.join('; '));
  const file = path.join(paths(root).inbox, `${id}.json`);
  if (fs.existsSync(file) || fs.existsSync(path.join(paths(root).corpus, `${id}.json`))) throw new Error(`regression ${id} already exists`);
  atomicJson(file, spec);
  return { file, spec };
}
function reproduce(root, id, opts = {}) {
  const file = path.join(paths(root).inbox, `${safeId(id)}.json`);
  const spec = readJson(file, null);
  if (!spec) throw new Error(`no captured failure ${id}`);
  const run = runCommand(spec, root, opts.timeoutMs);
  if (run.exitCode === 0) throw new Error(`failure did not reproduce: ${spec.command}`);
  spec.reproduction = { ...run, reproducedAt: new Date().toISOString() };
  atomicJson(file, spec);
  return { file, spec, run };
}
function promote(root, id, opts = {}) {
  const p = paths(root);
  const from = path.join(p.inbox, `${safeId(id)}.json`);
  const spec = readJson(from, null);
  if (!spec) throw new Error(`no captured failure ${id}`);
  const preErrors = validate(spec, true, root).filter((e) => !e.includes('passing fix') && !e.includes('recovery that worked'));
  if (preErrors.length) throw new Error(preErrors.join('; '));
  const run = runCommand(spec, root, opts.timeoutMs);
  if (run.exitCode !== 0) throw new Error(`fix is not verified; regression still fails (exit ${run.exitCode})\n${run.output}`);
  spec.fixVerification = { ...run, verifiedAt: new Date().toISOString() };
  if (spec.classification && spec.classification.recoveryThatWorked === 'none') spec.classification.recoveryThatWorked = 'code-fix';
  spec.promotedAt = new Date().toISOString();
  const errors = validate(spec, true, root);
  if (errors.length) throw new Error(errors.join('; '));
  const to = path.join(p.corpus, `${spec.id}.json`);
  atomicJson(to, spec);
  fs.unlinkSync(from);
  return { file: to, spec, run };
}
function listCases(root) {
  const dir = paths(root).corpus;
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => readJson(path.join(dir, n), null)).filter(Boolean); } catch { return []; }
}
function globMatch(pattern, value) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}(?:/.*)?$`).test(String(value).replace(/\\/g, '/'));
}
function selectCases(cases, changed) {
  if (!changed || !changed.length) return cases;
  return cases.filter((c) => c.affected.some((pattern) => changed.some((file) => globMatch(pattern, file))));
}
function runCases(root, cases, opts = {}) {
  const results = cases.map((spec) => ({ id: spec.id, title: spec.title, ...runCommand(spec, root, opts.timeoutMs) }));
  return { passed: results.filter((r) => r.exitCode === 0).length, total: results.length, results, ok: results.every((r) => r.exitCode === 0) };
}
function benchmarkQuality(root) {
  const dashboard = require(path.join(root, 'bench', 'dashboard.cjs')).build();
  let passed = 0, total = 0;
  for (const row of dashboard.rows) {
    if (row.void || row.kind === 'structural') continue;
    if (row.kind === 'honesty') { total++; if (row.gate !== true) passed++; }
    else if (row.gate !== null) { total++; if (row.gate === true) passed++; }
  }
  return { passed, total, score: total ? passed / total : 1 };
}
function fullGate(root, opts = {}) {
  const cases = runCases(root, listCases(root), opts);
  const quality = benchmarkQuality(root);
  const baselineFile = paths(root).baseline;
  const baseline = readJson(baselineFile, null);
  const floor = baseline ? Number(baseline.bestScore) : quality.score;
  const scoreOk = quality.score + Number.EPSILON >= floor;
  const ok = cases.ok && scoreOk;
  if (ok && (!baseline || quality.score > floor)) atomicJson(baselineFile, { version: VERSION, bestScore: quality.score, passed: quality.passed, total: quality.total, recordedAt: new Date().toISOString() });
  return { ok, cases, quality, baseline: baseline || { bestScore: floor }, scoreOk };
}

module.exports = { VERSION, paths, validate, capture, reproduce, promote, listCases, selectCases, runCases, benchmarkQuality, fullGate, globMatch, runCommand };
