'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { safeName, sha256: hash, readJson, atomicWrite: atomic } = require('./utils.cjs');

const VERSION = 1;
function dirs(root) {
  const base = path.join(root, '.converge', 'skill-promotion');
  return { base, candidates: path.join(base, 'candidates'), skills: path.join(root, '.converge', 'skills') };
}
function candidateFile(root, name) { return path.join(dirs(root).candidates, `${safeName(name)}.json`); }
function normalizeProcedure(procedure) {
  const steps = Array.isArray(procedure) ? procedure : String(procedure || '').split(/\r?\n/);
  return steps.map((x) => String(x).replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}
function validateEvidence(input) {
  if (!input || input.ok !== true) throw new Error('only a settled successful result is promotion evidence');
  if (!String(input.missionId || '').trim()) throw new Error('missionId is required for independent evidence');
  const name = safeName(input.name);
  if (!name || name !== input.name) throw new Error('skill name must be lowercase kebab-case');
  const steps = normalizeProcedure(input.procedure);
  if (!steps.length) throw new Error('a concrete procedure is required');
  return { name, steps };
}
function observe(root, input, opts = {}) {
  const { name, steps } = validateEvidence(input);
  const file = candidateFile(root, name);
  const fingerprint = hash(JSON.stringify(steps));
  const prior = readJson(file, null);
  if (prior && prior.fingerprint !== fingerprint) throw new Error(`candidate ${name} changed procedure; use a new skill name or discard the candidate`);
  const candidate = prior || { version: VERSION, name, title: String(input.title || name), procedure: steps, fingerprint, successes: [], tests: [], createdAt: new Date().toISOString() };
  const role = input.role === 'tester' ? 'tester' : 'worker';
  const evidence = { missionId: String(input.missionId), providerRefs: input.providerRefs || [], at: input.at || new Date().toISOString() };
  if (role === 'tester') {
    const workerIds = new Set(candidate.successes.map((x) => x.missionId));
    if (!workerIds.size) throw new Error('tester evidence requires prior worker success');
    if (workerIds.has(evidence.missionId)) throw new Error('tester must be independent of worker mission evidence');
    if (!candidate.tests.some((x) => x.missionId === evidence.missionId)) candidate.tests.push(evidence);
  } else if (!candidate.successes.some((x) => x.missionId === evidence.missionId)) candidate.successes.push(evidence);
  candidate.updatedAt = new Date().toISOString();
  atomic(file, `${JSON.stringify(candidate, null, 2)}\n`);
  const minSuccesses = Math.max(2, Number(opts.minSuccesses) || 2);
  return { candidate, ready: candidate.successes.length >= minSuccesses && candidate.tests.length >= 1 };
}
function nextVersion(root, name) {
  const manifest = readJson(path.join(dirs(root).skills, `${name}.json`), null);
  return manifest ? `${Number(String(manifest.activeVersion || '0').split('.')[0]) + 1}.0.0` : '1.0.0';
}
function promote(root, name, opts = {}) {
  const file = candidateFile(root, name);
  const candidate = readJson(file, null);
  if (!candidate) throw new Error(`no skill candidate ${name}`);
  const minSuccesses = Math.max(2, Number(opts.minSuccesses) || 2);
  if (candidate.successes.length < minSuccesses) throw new Error(`promotion requires ${minSuccesses} distinct successful worker missions`);
  if (!candidate.tests.length) throw new Error('promotion requires an independent successful tester mission');
  const version = nextVersion(root, candidate.name);
  const body = [`# ${candidate.title}`, '', `Version: ${version}`, '', 'Follow this verified procedure:', '', ...candidate.procedure.map((s, i) => `${i + 1}. ${s}`), '', 'Verify the requested outcome before reporting success.', ''].join('\n');
  const versionFile = path.join(dirs(root).skills, candidate.name, `${version}.md`);
  if (fs.existsSync(versionFile)) throw new Error(`immutable skill version already exists: ${candidate.name}@${version}`);
  atomic(versionFile, body);
  atomic(path.join(dirs(root).skills, `${candidate.name}.md`), body);
  const manifest = { version: VERSION, name: candidate.name, activeVersion: version, contentHash: hash(body), procedureHash: candidate.fingerprint, workerEvidence: candidate.successes, testerEvidence: candidate.tests, promotedAt: new Date().toISOString() };
  atomic(path.join(dirs(root).skills, `${candidate.name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.unlinkSync(file);
  return { version, versionFile, activeFile: path.join(dirs(root).skills, `${candidate.name}.md`), manifest };
}
function pending(root) {
  try { return fs.readdirSync(dirs(root).candidates).filter((x) => x.endsWith('.json')).sort().map((x) => readJson(path.join(dirs(root).candidates, x))).filter(Boolean); } catch { return []; }
}

module.exports = { VERSION, dirs, normalizeProcedure, observe, promote, pending };
