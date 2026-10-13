'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { safeName, sha256: hash, readJson, atomicWrite: atomic } = require('./utils.cjs');

const FORMAT_VERSION = 1;
const SAFE_ACTIONS = new Set(['click', 'hover', 'focus', 'blur', 'type', 'press', 'select_option', 'check', 'uncheck', 'set_checked', 'upload_file', 'scroll_to', 'wait_for', 'assert', 'read_text', 'scroll']);
const VERIFY_ACTIONS = new Set(['assert', 'wait_for']);
function baseDir(root) { return root || process.env.CONVERGE_AGENT_HOME || path.join(os.homedir(), '.converge'); }
function dirs(root) {
  const base = path.join(baseDir(root), 'unblink-helpers');
  return { base, candidates: path.join(base, 'candidates'), active: path.join(base, 'active'), versions: path.join(base, 'versions') };
}
function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^\.+|\.+$/g, ''); } catch { return ''; }
}
function domainMatches(host, domain) {
  const h = normalizeDomain(host);
  const d = normalizeDomain(domain);
  return !!h && !!d && (h === d || h.endsWith(`.${d}`));
}
function normalizeSteps(input) {
  if (!Array.isArray(input) || !input.length) throw new Error('helper steps are required');
  const steps = input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`step ${index + 1} must be an object`);
    const action = String(raw.action || '').toLowerCase();
    if (!SAFE_ACTIONS.has(action)) throw new Error(`step ${index + 1} uses unsafe action ${JSON.stringify(action)}`);
    const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {};
    if (action === 'type' && typeof args.text === 'string' && !/^\{\{[a-z][a-z0-9_]*\}\}$/i.test(args.text)) {
      throw new Error(`step ${index + 1} type text must be an input placeholder; secrets and user data cannot be stored`);
    }
    return { action, args: JSON.parse(JSON.stringify(args)) };
  });
  if (!steps.some((step) => VERIFY_ACTIONS.has(step.action))) throw new Error('helper needs an assert or wait_for verification step');
  return steps;
}
function candidateFile(root, name) { return path.join(dirs(root).candidates, `${safeName(name)}.json`); }
function validateObservation(input) {
  if (!input || input.ok !== true) throw new Error('only a successful replay is evidence');
  const name = safeName(input.name);
  if (!name || name !== input.name) throw new Error('helper name must be lowercase kebab-case');
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error('a valid domain is required');
  const replayId = String(input.replayId || '').trim();
  if (!replayId) throw new Error('replayId is required');
  return { name, domain, replayId, steps: normalizeSteps(input.steps) };
}
function observe(root, input, opts = {}) {
  const valid = validateObservation(input);
  const file = candidateFile(root, valid.name);
  const fingerprint = hash(JSON.stringify({ domain: valid.domain, steps: valid.steps }));
  const prior = readJson(file, null);
  if (prior && prior.fingerprint !== fingerprint) throw new Error(`candidate ${valid.name} changed; use a new name or discard it`);
  const candidate = prior || { formatVersion: FORMAT_VERSION, name: valid.name, title: String(input.title || valid.name), domain: valid.domain, steps: valid.steps, fingerprint, replays: [], createdAt: new Date().toISOString() };
  if (!candidate.replays.some((r) => r.replayId === valid.replayId)) {
    candidate.replays.push({ replayId: valid.replayId, at: input.at || new Date().toISOString(), finalUrl: String(input.finalUrl || ''), evidence: input.evidence || {} });
  }
  candidate.updatedAt = new Date().toISOString();
  atomic(file, `${JSON.stringify(candidate, null, 2)}\n`);
  const required = Math.max(2, Number(opts.minReplays) || 2);
  return { candidate, ready: candidate.replays.length >= required };
}
function createCandidate(root, input) {
  const name = safeName(input && input.name);
  if (!name || name !== input.name) throw new Error('helper name must be lowercase kebab-case');
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error('a valid domain is required');
  const steps = normalizeSteps(input.steps);
  const fingerprint = hash(JSON.stringify({ domain, steps }));
  const file = candidateFile(root, name);
  const prior = readJson(file, null);
  if (prior && prior.fingerprint !== fingerprint) throw new Error(`candidate ${name} changed; use a new name or discard it`);
  const candidate = prior || { formatVersion: FORMAT_VERSION, name, title: String(input.title || name), domain, steps, fingerprint, replays: [], createdAt: new Date().toISOString() };
  atomic(file, `${JSON.stringify(candidate, null, 2)}\n`);
  return candidate;
}
async function replayCandidate(root, name, inputs, executor, currentUrl) {
  const candidate = readJson(candidateFile(root, name), null);
  if (!candidate) throw new Error(`no helper candidate ${safeName(name)}`);
  if (!domainMatches(currentUrl, candidate.domain)) throw new Error(`candidate ${name} is scoped to ${candidate.domain}, not ${currentUrl || 'an empty page'}`);
  for (let i = 0; i < candidate.steps.length; i++) {
    const step = candidate.steps[i];
    const result = await executor(step.action, substitute(step.args, inputs || {}));
    if (!result || result.ok === false) throw new Error(`candidate ${name} failed at step ${i + 1} (${step.action})`);
    currentUrl = result.url || currentUrl;
    if (!domainMatches(currentUrl, candidate.domain)) throw new Error(`candidate ${name} left its allowed domain at step ${i + 1}`);
  }
  const replayId = crypto.randomUUID();
  candidate.replays.push({ replayId, at: new Date().toISOString(), finalUrl: currentUrl, evidence: { source: 'unblink-execution', steps: candidate.steps.length } });
  candidate.updatedAt = new Date().toISOString();
  atomic(candidateFile(root, candidate.name), `${JSON.stringify(candidate, null, 2)}\n`);
  return { ok: true, name: candidate.name, replayId, replays: candidate.replays.length, ready: candidate.replays.length >= 2, url: currentUrl };
}
function nextVersion(root, name) {
  const current = readJson(path.join(dirs(root).active, `${name}.json`), null);
  return current ? `${Number(String(current.version).split('.')[0]) + 1}.0.0` : '1.0.0';
}
function promote(root, name, opts = {}) {
  const clean = safeName(name);
  const file = candidateFile(root, clean);
  const candidate = readJson(file, null);
  if (!candidate) throw new Error(`no helper candidate ${clean}`);
  const required = Math.max(2, Number(opts.minReplays) || 2);
  if (candidate.replays.length < required) throw new Error(`promotion requires ${required} distinct successful replays`);
  const version = nextVersion(root, clean);
  const manifest = { ...candidate, version, promotedAt: new Date().toISOString() };
  delete manifest.createdAt;
  delete manifest.updatedAt;
  const versionFile = path.join(dirs(root).versions, clean, `${version}.json`);
  if (fs.existsSync(versionFile)) throw new Error(`immutable helper version already exists: ${clean}@${version}`);
  atomic(versionFile, `${JSON.stringify(manifest, null, 2)}\n`);
  atomic(path.join(dirs(root).active, `${clean}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.unlinkSync(file);
  return { name: clean, version, versionFile, helper: manifest };
}
function list(root, urlOrDomain = '') {
  let files = [];
  try { files = fs.readdirSync(dirs(root).active).filter((x) => x.endsWith('.json')).sort(); } catch {}
  const helpers = files.map((file) => readJson(path.join(dirs(root).active, file), null)).filter(Boolean);
  return urlOrDomain ? helpers.filter((h) => domainMatches(urlOrDomain, h.domain)) : helpers;
}
function get(root, name) { return readJson(path.join(dirs(root).active, `${safeName(name)}.json`), null); }
function substitute(value, inputs) {
  if (typeof value === 'string') return value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gi, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) throw new Error(`missing helper input ${key}`);
    return String(inputs[key]);
  });
  if (Array.isArray(value)) return value.map((v) => substitute(v, inputs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, inputs)]));
  return value;
}
async function run(root, name, inputs, executor, currentUrl) {
  const helper = get(root, name);
  if (!helper) throw new Error(`unknown promoted helper ${name}`);
  if (!domainMatches(currentUrl, helper.domain)) throw new Error(`helper ${name} is scoped to ${helper.domain}, not ${currentUrl || 'an empty page'}`);
  const results = [];
  for (let i = 0; i < helper.steps.length; i++) {
    const step = helper.steps[i];
    const result = await executor(step.action, substitute(step.args, inputs || {}));
    if (!result || result.ok === false) throw new Error(`helper ${name} failed at step ${i + 1} (${step.action}): ${(result && result.error) || 'no successful result'}`);
    const landed = result.url || currentUrl;
    if (!domainMatches(landed, helper.domain)) throw new Error(`helper ${name} left its allowed domain at step ${i + 1}`);
    currentUrl = landed;
    results.push({ step: i + 1, action: step.action, ok: true });
  }
  return { ok: true, action: 'helper_run', name: helper.name, version: helper.version, domain: helper.domain, url: currentUrl, steps: results };
}

module.exports = { FORMAT_VERSION, SAFE_ACTIONS, dirs, normalizeDomain, domainMatches, normalizeSteps, createCandidate, replayCandidate, observe, promote, list, get, run };
