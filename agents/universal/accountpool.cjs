'use strict';
// Account pool — rotate a provider's labeled accounts (e.g. several free Ollama
// Cloud keys, each with its own rate limit) round-robin, so no single account
// gets hammered, and skip one that recently failed until it cools down. Pure,
// in-memory, per-process; zero-dep. The harness wires this to
// providers.setKeyResolver so rotation happens transparently at every call site.

const COOLDOWN_MS = 60 * 1000;

// A COOLDOWN THAT DIES WITH THE PROCESS PROTECTS NOTHING.
//
// This pool is per-process by design, and the comment below says why the seed
// exists: every CLI call, chat turn and mission stage is its OWN short-lived
// process. That is exactly what made fail() useless — process 1 rate-limits an
// account and cools it down, process 2 starts two seconds later with an empty
// map and picks the same account again. Across a fleet the cooldown never had a
// chance to apply, so a throttled account kept being hammered.
//
// So the cooldown (and ONLY the cooldown) is shared through one small file.
// Keys are never written: an API key is hashed, and only the hash and an expiry
// land on disk. Every read and write is best-effort — this is a routing hint,
// and it must never be able to fail a call.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const COOLDOWN_FILE = process.env.CONVERGE_ACCOUNT_COOLDOWN_FILE
  || path.join(process.env.AGENT_STATE_DIR || path.join(os.homedir(), '.universal-agent'), 'account-cooldown.json');
const keyId = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
function readShared(now) {
  try {
    const raw = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
    const out = new Map();
    for (const [id, until] of Object.entries(raw || {})) if (typeof until === 'number' && until > now) out.set(id, until);
    return out;
  } catch { return new Map(); }
}
function writeShared(id, until, now) {
  try {
    const cur = readShared(now);
    cur.set(id, until);
    fs.mkdirSync(path.dirname(COOLDOWN_FILE), { recursive: true });
    // tmp + rename so a concurrent reader never sees a half-written file.
    const tmp = `${COOLDOWN_FILE}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(cur)));
    fs.renameSync(tmp, COOLDOWN_FILE);
  } catch { /* a routing hint is never worth failing a call over */ }
}

// `seed` offsets where each provider's rotation STARTS. The harness passes
// process.pid so that many short-lived harness processes (every CLI call, chat
// turn, and mission stage is its own process) don't all begin on account #1 —
// they spread across the pool from the first call, not just within one process.
function makePool(accounts, { cooldownMs = COOLDOWN_MS, seed = 0 } = {}) {
  const byProvider = {};
  for (const a of (Array.isArray(accounts) ? accounts : [])) {
    if (a && a.key) (byProvider[a.provider] || (byProvider[a.provider] = [])).push({ label: a.label || a.provider, key: a.key, host: a.host });
  }
  const counter = {};        // provider -> monotonically increasing pick index (starts at seed)
  const cooldown = new Map(); // key -> epoch ms until which it's skipped
  // Sticky pinning: once a provider resolves to an account, keep returning it
  // until that account fails. Upstream prompt caches are per-key/per-route, so
  // round-robining every call guarantees a cold cache (0% hit) on all but one
  // account. Rotation now happens on FAILURE only — which is what it was for.
  const sticky = {}; // provider -> key

  return {
    // True when a provider has ≥2 accounts (rotation is meaningful). Used to
    // decide whether a failure should cool an account down — cooling a lone
    // account routes to nothing, so it's pointless there.
    has(provider) { const p = byProvider[provider]; return !!(p && p.length >= 2); },

    // Next usable account key for a provider, or null if this provider has no
    // labeled account at all. A SINGLE account still resolves (it's where the
    // key lives when the model entry is keyless — e.g. Fireworks); it just
    // rotates to itself. Accounts in cooldown are skipped; if ALL are cooling
    // down we still return one (a rate-limited account beats no key at all).
    resolve(provider, now = Date.now()) {
      const pool = byProvider[provider];
      if (!pool || !pool.length) return null;
      // Merge this process's own view with what other processes have recorded.
      const shared = readShared(now);
      const coolUntil = (k) => Math.max(cooldown.get(k) || 0, shared.get(keyId(k)) || 0);
      const usable = pool.filter((a) => coolUntil(a.key) <= now);
      const list = usable.length ? usable : pool;
      // Prefer the pinned account while it stays usable; otherwise advance the
      // round-robin ONCE and pin the new choice (fail() unpins cooled keys).
      const pinned = sticky[provider];
      const stillGood = pinned && list.some((a) => a.key === pinned);
      if (stillGood) return { apiKey: pinned, host: list.find((a) => a.key === pinned).host, label: list.find((a) => a.key === pinned).label };
      counter[provider] = (counter[provider] == null ? seed : counter[provider]) + 1;
      const pick = list[counter[provider] % list.length];
      sticky[provider] = pick.key;
      return { apiKey: pick.key, host: pick.host, label: pick.label };
    },

    // Mark an account's key as failed — skip it for the cooldown window so the
    // next calls route around a rate-limited or down account.
    fail(key, now = Date.now()) {
      if (!key) return;
      const until = now + cooldownMs;
      cooldown.set(String(key), until);
      writeShared(keyId(key), until, now); // so the NEXT process skips it too
      for (const p of Object.keys(sticky)) if (sticky[p] === key) delete sticky[p];
    },
  };
}

module.exports = { makePool, COOLDOWN_MS };
