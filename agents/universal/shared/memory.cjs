'use strict';
// Durable project memory that does NOT flood the context window.
//
// The old design was a flat append-only `.converge/MEMORY.md`: every `/remember`
// appended a line, and every turn injected the whole file cut off at 2000
// chars. Three failures, all watched live:
//   1. It grows forever. Past ~2KB the blunt `truncate()` silently dropped the
//      tail — so the OLDEST facts survived and everything learned recently was
//      invisible. Exactly backwards.
//   2. It is injected whole regardless of the task. A turn about the deploy
//      script paid for 2000 chars of unrelated notes about mail parsing.
//   3. Re-saying a fact appended a near-duplicate line, so the file filled
//      with restatements and the effective capacity kept shrinking.
//
// This replaces it with a scored store. Facts are entries with usage stats;
// retrieval ranks them against the CURRENT task and emits only what fits a
// fixed character budget. The budget is the point: memory cost per turn is
// bounded and predictable no matter how much has been remembered, so the store
// can grow to thousands of facts without the context growing at all.
//
// Zero dependencies, synchronous, CommonJS — it loads inside the harness's
// require-graph at startup and must not add install surface to the fleet.

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
// Injected-context budget in characters. The whole design exists to make this
// a constant rather than a function of how much the user has remembered.
const DEFAULT_BUDGET = parseInt(process.env.CONVERGE_MEMORY_BUDGET || '1800', 10) || 1800;
// Above this many live entries, the weakest unpinned ones are archived (never
// deleted — they move to memory-archive.jsonl and can be grepped by hand).
const MAX_ENTRIES = parseInt(process.env.CONVERGE_MEMORY_MAX || '600', 10) || 600;
// Two facts this similar are the same fact restated; the newer text wins.
// Deliberately high. Merging is destructive — "chi-il-1 runs the daemon on
// 8787" and "atl-ga-1 runs the daemon on 8787" differ by one token out of
// nine (Jaccard ~0.78) and must NOT collapse into one. Over-storing is cheap
// because retrieval is budgeted; wrongly merging loses a fact permanently.
const DUP_THRESHOLD = 0.9;
// Spend a little budget on facts saved in the last day even when they don't
// match the task lexically. Without this a fact saved 30 seconds ago is
// invisible until the user happens to reuse its vocabulary — which reads as
// "it didn't remember", the exact complaint this module exists to fix. Bounded
// to genuinely-fresh entries so the store's tail never squats on the budget.
const RECENT_QUOTA = 2;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Pinned facts are standing rules, but a large pinned set must not consume the
// entire envelope and hide the fact that actually matches the current task.
// When relevant unpinned facts exist, reserve this share for them.
const PINNED_BUDGET_SHARE = 0.7;
const MUTABLE_STALE_DAYS = parseInt(process.env.CONVERGE_MEMORY_STALE_DAYS || '30', 10) || 30;

const storePath = (workdir) => path.join(workdir, '.converge', 'memory.json');
const archivePath = (workdir) => path.join(workdir, '.converge', 'memory-archive.jsonl');
const legacyPath = (workdir) => path.join(workdir, '.converge', 'MEMORY.md');

// ---------- text similarity (cheap, dependency-free) ----------

// Words that carry no retrieval signal. Kept deliberately short: an aggressive
// stoplist hurts recall on technical facts far more than it helps precision.
const STOP = new Set(('a an the is are was were be been being of to in on at for with by from as it its this that these those and or but if then than so we you i our your my me us they them he she his her do does did done have has had will would can could should may might must not no yes' +
  ' use using used make makes made get gets got set sets very just also into over under about').split(' '));

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    // Keep dots and slashes so paths/hosts (`chi-il-1`, `console/server.mjs`,
    // `universal-agent.cjs`) survive as single high-signal tokens instead of
    // shattering into noise.
    .split(/[^a-z0-9._/-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function tokenSet(s) { return new Set(tokens(s)); }

// Jaccard over token sets. Symmetric, 0..1, good enough to catch restatements
// without pulling in an embedding model.
function similarity(a, b) {
  const A = a instanceof Set ? a : tokenSet(a);
  const B = b instanceof Set ? b : tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Asymmetric overlap: what fraction of the QUERY's vocabulary does this entry
// cover? For retrieval this beats Jaccard, which unfairly penalises a long,
// detailed, genuinely-relevant fact just for being long.
function coverage(queryTokens, entryTokens) {
  if (!queryTokens.size || !entryTokens.size) return 0;
  let hit = 0;
  for (const t of queryTokens) if (entryTokens.has(t)) hit++;
  return hit / queryTokens.size;
}

// ---------- store I/O ----------

function emptyStore() { return { version: STORE_VERSION, entries: [] }; }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Pull a pre-existing flat MEMORY.md into the store, once. Runs on first load
// so an upgrade never looks like the harness forgot everything the user saved.
// The old file is left on disk untouched (renamed, not removed) so a rollback
// to the previous harness still finds its memory.
function migrateLegacy(workdir, store) {
  const legacy = legacyPath(workdir);
  let raw;
  try { raw = fs.readFileSync(legacy, 'utf8'); } catch { return false; }
  const lines = String(raw).split('\n').map((l) => l.trim()).filter(Boolean);
  let added = 0;
  for (const line of lines) {
    // Old format: "- YYYY-MM-DD: the fact". Tolerate a bare line too.
    const m = line.match(/^-\s*(\d{4}-\d{2}-\d{2})\s*:\s*([\s\S]+)$/);
    const text = (m ? m[2] : line.replace(/^[-*]\s*/, '')).trim();
    if (!text) continue;
    const when = m ? `${m[1]}T00:00:00.000Z` : new Date().toISOString();
    if (addEntry(store, text, { created: when, source: 'MEMORY.md' })) added++;
  }
  try { fs.renameSync(legacy, legacy + '.migrated'); } catch { /* best effort */ }
  return added > 0;
}

function load(workdir) {
  const store = readJson(storePath(workdir));
  if (store && Array.isArray(store.entries)) {
    // A legacy file appearing after migration (e.g. an older harness on the
    // same workdir wrote one) is folded in rather than ignored.
    if (migrateLegacy(workdir, store)) save(workdir, store);
    return store;
  }
  const fresh = emptyStore();
  if (migrateLegacy(workdir, fresh)) save(workdir, fresh);
  return fresh;
}

function save(workdir, store) {
  const file = storePath(workdir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename with a PER-PROCESS tmp name (pid + counter): a shared
  // `${file}.tmp` let two processes (a harness turn + the GUI, or two turns)
  // interleave writes into ONE file and both rename a truncated result — which
  // readJson swallows and load() returns emptyStore(), so the next save()
  // permanently overwrote every saved fact with nothing. A unique tmp per
  // writer means at worst the last full write wins.
  const tmp = `${file}.${process.pid}.${(save._seq = (save._seq || 0) + 1)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- mutation ----------

function newId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Next insertion number. Derived from the existing entries rather than a
// module-level counter so it survives across processes — every harness turn is
// a fresh node process reading the same store.
function nextSeq(store) {
  if (typeof store.seq !== 'number') {
    store.seq = store.entries.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  }
  return ++store.seq;
}

// Recency comparator: newest first, insertion order breaking timestamp ties.
function byRecency(a, b) {
  const ta = Date.parse(a.updated || a.created) || 0;
  const tb = Date.parse(b.updated || b.created) || 0;
  return tb - ta || (b.seq || 0) - (a.seq || 0);
}

// Returns the entry on insert/update, or null if the text was empty.
// Near-duplicates UPDATE in place (refreshing the text and timestamp) instead
// of appending, so restating a fact sharpens it rather than diluting the store.
function addEntry(store, text, opts) {
  const o = opts || {};
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const toks = tokenSet(clean);

  let best = null, bestScore = 0;
  for (const e of store.entries) {
    const s = similarity(toks, tokenSet(e.text));
    if (s > bestScore) { bestScore = s; best = e; }
  }
  const now = new Date().toISOString();
  if (best && bestScore >= DUP_THRESHOLD) {
    best.text = clean;              // newest phrasing wins
    best.updated = now;
    best.seq = nextSeq(store);      // restating a fact makes it recent again
    best.uses = (best.uses || 0) + 1;
    if (o.pinned) best.pinned = true;
    if (o.tags && o.tags.length) best.tags = Array.from(new Set([...(best.tags || []), ...o.tags]));
    if (o.aliases && o.aliases.length) best.aliases = Array.from(new Set([...(best.aliases || []), ...o.aliases]));
    if (o.verifiedAt) best.verifiedAt = o.verifiedAt;
    if (o.expiresAt) best.expiresAt = o.expiresAt;
    if (o.mutable != null) best.mutable = !!o.mutable;
    return best;
  }
  const entry = {
    id: newId(),
    text: clean,
    tags: o.tags || [],
    aliases: o.aliases || [],
    created: o.created || now,
    updated: o.created || now,
    // Monotonic insertion counter. ISO timestamps are millisecond-resolution,
    // and several /remember calls (or a legacy-file migration) land inside the
    // same millisecond — which makes a purely time-based recency sort unstable
    // and can rank a fact saved first ahead of one saved last. seq breaks those
    // ties by true insertion order.
    seq: nextSeq(store),
    lastUsed: null,
    uses: 0,
    pinned: !!o.pinned,
    mutable: !!o.mutable,
    verifiedAt: o.verifiedAt || null,
    expiresAt: o.expiresAt || null,
    source: o.source || 'remember',
  };
  store.entries.push(entry);
  return entry;
}

// Age out the weakest unpinned entries once the store exceeds MAX_ENTRIES.
// Archived, not dropped: the JSONL is append-only and greppable.
function prune(workdir, store) {
  if (store.entries.length <= MAX_ENTRIES) return 0;
  const scored = store.entries
    .map((e) => ({ e, v: pinned(e) ? Infinity : baseValue(e) }))
    .sort((a, b) => b.v - a.v);
  const keep = scored.slice(0, MAX_ENTRIES).map((x) => x.e);
  const drop = scored.slice(MAX_ENTRIES).map((x) => x.e);
  if (!drop.length) return 0;
  // The contract is "archived, not dropped". If the archive write FAILS, do
  // NOT delete — keep the entries this round rather than lose them silently
  // (a full disk would otherwise erase memory permanently with no trace).
  try {
    fs.mkdirSync(path.dirname(archivePath(workdir)), { recursive: true });
    fs.appendFileSync(archivePath(workdir), drop.map((e) => JSON.stringify({ ...e, archived: new Date().toISOString() })).join('\n') + '\n');
  } catch (e) {
    try { process.stderr.write(`agent memory: could not archive ${drop.length} pruned entr${drop.length === 1 ? 'y' : 'ies'} (${e.message}) — keeping them this round rather than dropping unarchived\n`); } catch { /* noop */ }
    return 0;
  }
  store.entries = keep;
  return drop.length;
}

const pinned = (e) => !!e.pinned;

// Task-independent worth of an entry: how recently it was touched and how often
// it has actually proven useful. Used for pruning and as the recency component
// of retrieval ranking.
function baseValue(e, nowMs) {
  const now = nowMs || Date.now();
  const touched = Date.parse(e.lastUsed || e.updated || e.created) || now;
  const ageDays = Math.max(0, (now - touched) / 86400000);
  // Half-life of 30 days: a fact untouched for a month is worth half as much
  // as one touched today, but never worth zero.
  const recency = 1 / (1 + ageDays / 30);
  const usage = Math.log1p(e.uses || 0) / Math.log(10); // 0 at 0 uses, 1 at ~9
  return recency + 0.5 * usage;
}

// ---------- public API ----------

function remember(workdir, text, opts) {
  const store = load(workdir);
  const entry = addEntry(store, text, opts);
  if (!entry) return { ok: false, reason: 'empty' };
  const pruned = prune(workdir, store);
  save(workdir, store);
  return { ok: true, entry, total: store.entries.length, pruned };
}

// Remove by id, or by text match. Returns what went away so the caller can
// echo it — a silent /forget is indistinguishable from a broken one.
function forget(workdir, query) {
  const store = load(workdir);
  const q = String(query || '').trim();
  if (!q) return { ok: false, reason: 'empty', removed: [] };
  const before = store.entries.length;
  let removed = [];
  const byId = store.entries.filter((e) => e.id === q);
  if (byId.length) {
    removed = byId;
    store.entries = store.entries.filter((e) => e.id !== q);
  } else {
    const qt = tokenSet(q);
    const lower = q.toLowerCase();
    // Substring match first (predictable for the user), similarity as fallback.
    const hit = (e) => e.text.toLowerCase().includes(lower) || similarity(qt, tokenSet(e.text)) >= 0.6;
    removed = store.entries.filter(hit);
    store.entries = store.entries.filter((e) => !hit(e));
  }
  if (removed.length) {
    try {
      fs.mkdirSync(path.dirname(archivePath(workdir)), { recursive: true });
      fs.appendFileSync(archivePath(workdir), removed.map((e) => JSON.stringify({ ...e, forgotten: new Date().toISOString() })).join('\n') + '\n');
    } catch {}
    save(workdir, store);
  }
  return { ok: removed.length > 0, removed, total: store.entries.length, before };
}

function list(workdir) {
  const store = load(workdir);
  const now = Date.now();
  return store.entries
    .slice()
    .sort((a, b) => (pinned(b) - pinned(a)) || (baseValue(b, now) - baseValue(a, now)))
    .map((e) => ({ id: e.id, text: e.text, pinned: !!e.pinned, uses: e.uses || 0, created: e.created, lastUsed: e.lastUsed }));
}

// Rank entries against the current task and return the block to inject, capped
// at `budget` characters. This is the whole point of the module: the cost of
// memory per turn is bounded by `budget`, not by how much is stored.
//
// Returns { text, used, shown, total } — `text` is '' when there is nothing
// worth injecting, so the caller can skip the section entirely.
function recall(workdir, taskText, opts) {
  const o = opts || {};
  const budget = o.budget || DEFAULT_BUDGET;
  const store = load(workdir);
  if (!store.entries.length) return { text: '', used: 0, shown: 0, total: 0 };

  const now = Date.now();
  const qt = tokenSet(taskText);
  const ranked = store.entries.map((e) => {
    const et = tokenSet(e.text);
    const routing = tokenSet([...(e.tags || []), ...(e.aliases || [])].join(' '));
    // Relevance dominates; base value breaks ties and floats durable facts.
    // Explicit routing metadata is deliberately stronger than prose overlap:
    // tags/aliases exist to bridge vocabulary such as "oauth" -> "auth".
    const textRel = coverage(qt, et);
    const routeRel = coverage(qt, routing);
    const rel = Math.max(textRel, routeRel);
    return { e, score: textRel * 2 + routeRel * 3 + baseValue(e, now) * 0.5, rel };
  });

  const chosen = [];
  const taken = new Set();
  const take = (r) => {
    if (taken.has(r.e.id)) return;
    taken.add(r.e.id);
    chosen.push(r);
  };

  // 1. Pinned facts are house rules — they are why pinning exists.
  ranked.filter((r) => pinned(r.e))
    .sort((a, b) => b.score - a.score)
    .forEach(take);
  // 2. Everything relevant, best first. Entries with no lexical overlap at all
  //    are excluded rather than used as filler — unrelated facts are precisely
  //    the noise that made the old whole-file injection expensive and useless.
  const relevant = ranked.filter((r) => r.rel > 0).sort((a, b) => b.score - a.score);
  relevant.forEach(take);
  // 3. Safety net, and ONLY a safety net: if relevance matched nothing at all,
  //    fall back to the last day's facts so something saved moments ago is not
  //    invisible just because the user changed vocabulary. This must not fire
  //    when step 2 found real matches — in a young store every fact is "recent",
  //    so an unconditional recency quota drags unrelated facts into every single
  //    turn, which is the flooding this module exists to stop.
  if (!relevant.length) {
    const fresh = now - RECENT_WINDOW_MS;
    ranked.filter((r) => (Date.parse(r.e.updated || r.e.created) || 0) >= fresh)
      .sort((a, b) => byRecency(a.e, b.e))
      .slice(0, RECENT_QUOTA)
      .forEach(take);
  }

  const lines = [];
  let used = 0;
  const hit = [];
  const relevantUnpinned = chosen.filter((r) => !pinned(r.e) && r.rel > 0);
  const pinnedLimit = relevantUnpinned.length ? Math.floor(budget * PINNED_BUDGET_SHARE) : budget;
  let pinnedUsed = 0;
  // Task matches go first within each class. This preserves pinned house rules
  // while ensuring the reserved slice is actually available to relevant facts.
  const ordered = [
    ...chosen.filter((r) => pinned(r.e)),
    ...chosen.filter((r) => !pinned(r.e)),
  ];
  for (const r of ordered) {
    const verifiedMs = Date.parse(r.e.verifiedAt) || 0;
    const expired = r.e.expiresAt && Date.parse(r.e.expiresAt) <= now;
    const aged = verifiedMs && now - verifiedMs >= MUTABLE_STALE_DAYS * 86400000;
    const stale = r.e.mutable && (!verifiedMs || expired || aged);
    const freshness = stale
      ? ` [possibly stale${r.e.verifiedAt ? `; last verified ${String(r.e.verifiedAt).slice(0, 10)}` : ''} — verify before relying]`
      : '';
    const line = `- ${r.e.text}${freshness}`;
    if (pinned(r.e) && pinnedUsed + line.length + 1 > pinnedLimit) continue;
    if (used + line.length + 1 > budget) continue; // keep scanning: a short
    // high-value fact further down should still fit after a long one is skipped
    lines.push(line);
    used += line.length + 1;
    if (pinned(r.e)) pinnedUsed += line.length + 1;
    hit.push(r.e);
  }
  if (!lines.length) return { text: '', used: 0, shown: 0, total: store.entries.length };

  // Record the hit so entries that keep proving relevant survive pruning and
  // rank higher next time. This is what makes the store improve with use
  // rather than just accumulate.
  const stamp = new Date().toISOString();
  for (const e of hit) { e.lastUsed = stamp; e.uses = (e.uses || 0) + 1; }
  try { save(workdir, store); } catch { /* recall must never break a turn */ }

  const withheld = store.entries.length - lines.length;
  const note = withheld > 0
    ? `\n(${withheld} more saved fact${withheld === 1 ? '' : 's'} not shown — they did not match this task. Ask and they can be recalled.)`
    : '';
  return {
    text: `${lines.join('\n')}${note}`,
    used,
    shown: lines.length,
    total: store.entries.length,
  };
}

module.exports = {
  remember, forget, list, recall, load, save,
  // exported for tests
  _internals: { similarity, coverage, tokens, addEntry, baseValue, prune, DEFAULT_BUDGET, MAX_ENTRIES, DUP_THRESHOLD, PINNED_BUDGET_SHARE, MUTABLE_STALE_DAYS },
};
