'use strict';

// Provider adaptation is evidence-driven, local to a worktree, and deliberately
// narrow.  It never changes a user-selected mode; it only changes future `auto`
// calls after a recorded native-tool serialization failure.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const FAILURE_THRESHOLD = 1;

function paths(root) {
  const dir = path.join(path.resolve(root || process.cwd()), '.converge', 'reflexion');
  return { dir, adaptations: path.join(dir, 'provider-adaptations.json') };
}

function empty() { return { version: VERSION, providers: {} }; }
function load(root) {
  try {
    const value = JSON.parse(fs.readFileSync(paths(root).adaptations, 'utf8'));
    return value && value.version === VERSION && value.providers && typeof value.providers === 'object' ? value : empty();
  } catch { return empty(); }
}
function save(root, value) {
  const file = paths(root).adaptations;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
function key(provider, model) { return `${String(provider || 'unknown')}/${String(model || 'unknown')}`; }
function isToolSerializationFault(error) {
  const text = String(error && error.message || error || '').toLowerCase();
  return /malformed|truncated json|invalid json|stream drop|tool_calls?.*(parse|invalid)|function.*(parse|invalid)/.test(text);
}

// The harness's text protocol is XML-delimited and is parsed deterministically
// by universal-agent. `text` is therefore the actual constrained fallback mode,
// not a fictional provider option called "xml".
function recordProviderFault(root, { provider, model, mode, error } = {}) {
  if (!root || !isToolSerializationFault(error)) return { recorded: false, reason: 'not-tool-serialization' };
  const store = load(root);
  const id = key(provider, model);
  const prior = store.providers[id] || { nativeToolFailures: 0, successes: 0 };
  const next = {
    ...prior,
    nativeToolFailures: prior.nativeToolFailures + (mode === 'native' ? 1 : 0),
    lastFailureAt: new Date().toISOString(),
    lastFailure: String(error && error.message || error || '').slice(0, 500),
  };
  if (next.nativeToolFailures >= FAILURE_THRESHOLD) {
    next.recommendedMode = 'text';
    next.reason = 'native tool serialization failure; use constrained XML text protocol';
  }
  store.providers[id] = next;
  save(root, store);
  return { recorded: true, adaptation: { id, ...next } };
}

function recordProviderSuccess(root, { provider, model, mode } = {}) {
  if (!root) return { recorded: false };
  const store = load(root), id = key(provider, model);
  const prior = store.providers[id];
  if (!prior) return { recorded: false };
  store.providers[id] = { ...prior, successes: (prior.successes || 0) + 1, lastSuccessAt: new Date().toISOString(), lastSuccessMode: mode || null };
  save(root, store);
  return { recorded: true };
}

function adaptCall(root, options = {}) {
  // An explicit mode remains operator authority.
  if (!root || (options.mode && options.mode !== 'auto')) return { options, applied: null };
  const entry = load(root).providers[key(options.provider, options.model)];
  if (!entry || entry.recommendedMode !== 'text') return { options, applied: null };
  return {
    options: { ...options, mode: 'text', adaptiveToolProtocol: 'xml' },
    applied: { mode: 'text', protocol: 'xml', reason: entry.reason, since: entry.lastFailureAt },
  };
}

function status(root) {
  const providers = Object.entries(load(root).providers).map(([ref, value]) => ({ ref, ...value }));
  return { version: VERSION, providers, digest: crypto.createHash('sha256').update(JSON.stringify(providers)).digest('hex') };
}

module.exports = { VERSION, paths, load, status, adaptCall, recordProviderFault, recordProviderSuccess, isToolSerializationFault };
