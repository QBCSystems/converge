'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Codex has no `models` subcommand.  Its own, authenticated model picker is
// backed by this cache, so read that instead of pretending `default` is the
// only choice.  Keep default first: it deliberately means "use Codex config".
function codexModels(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const out = ['default'];
  try {
    const json = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
    for (const row of Array.isArray(json.models) ? json.models : []) {
      const id = String(row && (row.slug || row.id || row.model) || '').trim();
      if (id && !out.includes(id) && row.visibility !== 'hide') out.push(id);
    }
  } catch { /* an unstarted/offline Codex install still has `default` */ }
  return out;
}

// A hardcoded CLI model list is wrong within weeks: these vendors ship new
// tiers between our releases, and the stale list is not merely incomplete —
// it makes live models UNSELECTABLE in every picker. Observed 2026-08-18: the
// antigravity list offered 3 models while `agy models` served 14 (all of
// Gemini 3.7 Flash, 3.5 Flash, Opus 4.6 and GPT-OSS 120B were unreachable),
// and the claude list had no `fable` at all. So ask the CLI, cache the answer.
//
// Probing costs a network round-trip (~2s for `agy models`), and listModels
// sits on UI paths AND in a harness that is a fresh process per turn — so the
// cache has to outlive the process. Disk, with a TTL.
const CATALOG_CACHE_FILE = path.join(os.homedir(), '.converge', 'cli-model-cache.json');
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const catalogMemo = new Map();

function catalogCacheGet(key) {
  if (catalogMemo.has(key)) return catalogMemo.get(key);
  try {
    const all = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, 'utf8'));
    const row = all && all[key];
    if (row && Array.isArray(row.models) && Date.now() - Number(row.at || 0) < CATALOG_TTL_MS) {
      catalogMemo.set(key, row.models);
      return row.models;
    }
  } catch { /* no cache yet, or unreadable — probe instead */ }
  return null;
}

const { atomicWrite } = require('./utils.cjs');

function catalogCachePut(key, models) {
  catalogMemo.set(key, models);
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, 'utf8')) || {}; } catch { all = {}; }
    all[key] = { at: Date.now(), models };
    atomicWrite(CATALOG_CACHE_FILE, all, { mode: 0o600 });
  } catch { /* cache is an optimization; a read-only home must not break listing */ }
}

// Merge discovered ids onto a floor list without reordering or duplicating.
// The floor is what we still offer when the CLI is missing, logged out or
// offline — never an empty picker.
function catalogMerge(floor, found) {
  const out = floor.slice();
  for (const id of found) {
    const clean = String(id || '').trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

// Antigravity DOES have a `models` subcommand, and it is authoritative: it
// prints one "id<TAB>Human Label" line per model the logged-in account can
// actually select.
// The floor is LAST KNOWN GOOD, not the answer: the console host may have no
// `agy` installed at all (it picks models for other machines), and probing to
// an empty list there would be worse than the stale list this replaces. A
// successful probe always supersedes it.
const AGY_LAST_KNOWN = [
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
  'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
];

function antigravityModels(binary = 'agy') {
  const key = 'antigravity-cli';
  const cached = catalogCacheGet(key);
  if (cached) return cached;
  const floor = ['default'].concat(AGY_LAST_KNOWN);
  let found = [];
  try {
    const out = execFileSync(binary, ['models'], {
      encoding: 'utf8', timeout: 12000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    found = String(out).split(/\r?\n/)
      // Tab-separated id/label. Anything without a tab is chatter such as the
      // "Fetching available models..." progress line.
      .map((line) => (line.includes('\t') ? line.split('\t')[0] : '').trim())
      .filter((id) => id && /^[A-Za-z0-9][\w.:-]*$/.test(id));
  } catch { /* agy absent, logged out or offline — the floor still works */ }
  // A successful probe SUPERSEDES the floor rather than merging with it. Merging
  // kept retired ids alive forever — gemini-3.5-flash-* stayed in every picker
  // after agy stopped serving them, and choosing one failed the whole turn with
  // "model gemini-3.5-flash-medium is not recognized" — and then cached the
  // union as though it were authoritative.
  const models = found.length ? ['default'].concat(found) : floor;
  if (found.length) catalogCachePut(key, models);
  return models;
}

// Claude Code has NO `models` subcommand, so read the two places it does
// publish what the logged-in account may select:
//   1. ~/.claude.json `additionalModelOptionsCache` — where a newly released
//      model actually turns up. This is precisely why `fable` was missing from
//      every picker here while the CLI itself offered it.
//   2. `claude --help`, whose --model text names the current short aliases.
// The alias floor stays because both sources are additive, and the help text
// only gives examples ("e.g. 'fable', 'opus', or 'sonnet'") — haiku is real
// but unnamed there.
function claudeModels(binary = 'claude') {
  const key = 'claude-cli';
  const cached = catalogCacheGet(key);
  if (cached) return cached;
  const floor = ['default', 'sonnet', 'opus', 'haiku', 'fable'];
  const found = [];
  let discovered = false;
  try {
    const json = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const row of Array.isArray(json.additionalModelOptionsCache) ? json.additionalModelOptionsCache : []) {
      const id = String(row && row.value || '').trim();
      if (id) { found.push(id); discovered = true; }
    }
  } catch { /* no CLI config yet */ }
  try {
    const help = execFileSync(binary, ['--help'], {
      encoding: 'utf8', timeout: 12000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Only the --model paragraph, so quoted words from other flags cannot leak in.
    const section = String(help).split(/--model\s+<model>/)[1];
    if (section) {
      for (const m of section.slice(0, 400).matchAll(/'([a-z][a-z0-9]*)'/g)) {
        found.push(m[1]);
        discovered = true;
      }
    }
  } catch { /* claude absent — the alias floor still works */ }
  const models = catalogMerge(floor, found);
  if (discovered) catalogCachePut(key, models);
  return models;
}

module.exports = { codexModels, antigravityModels, claudeModels };
