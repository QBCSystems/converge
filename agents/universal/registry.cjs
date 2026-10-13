'use strict';
// Model Capability Registry — evidence over assumptions.
//
// Not "use model X for UI" in a config file: the harness RECORDS what every
// model actually did — calls (latency, timeouts, quota failures, malformed
// replies) and VERIFIED outcomes (gate pass/fail, judge scores, runtime,
// tokens) per workflow type — and routes future work to whichever available
// model has historically produced the best verified outcome for that kind of
// work. Declared capabilities (context, vision, cost, speed, strengths) seed
// the choice until real evidence accumulates.
//
// Storage is an append-only JSONL event log (multi-process safe: every
// harness process — mission parent, stage children — appends single lines;
// aggregation happens on read). No dependencies, no daemon, no lock files.
// Location: $CONVERGE_REGISTRY_DIR/registry-events.jsonl (default ~/.converge).
// Event lines never contain credentials — refs are "provider/model" strings.
//
// Workflow types: planning · coding · ui · investigation · repair · documentation

const fs = require('fs');
const os = require('os');
const path = require('path');
const pricing = require('./pricing.cjs');

// CONVERGE_REGISTRY_DIR wins; else an explicit AGENT_STATE_DIR keeps the
// evidence with that state (test harnesses isolate automatically); else the
// user-level ~/.converge so evidence accumulates across all projects.
function baseDir() {
  return process.env.CONVERGE_REGISTRY_DIR
    || process.env.AGENT_STATE_DIR
    || path.join(os.homedir(), '.converge');
}
function eventsPath() { return path.join(baseDir(), 'registry-events.jsonl'); }

// Append one event. { t:'call', ref, ok, ms, kind? } or
// { t:'outcome', ref, wf, pass, ms?, tin?, tout?, score? }. Best-effort:
// telemetry must never break the run it measures.
// TEST FIXTURES MUST NEVER SCORE A REAL MODEL.
//
// Several tests exercise the harness end-to-end by spawning it with a stand-in
// model name (`--model mock`, `mockA`, `A`, …). The harness's telemetry does not
// know it is under test, so every one of those runs appended real `call`/
// `outcome` events to the operator's live registry — and because none of those
// tests set CONVERGE_REGISTRY_DIR, they wrote to ~/.converge. Measured: 33k
// events in which `ollama/mock` had accumulated 40 investigation outcomes at 83%
// and 17 planning at 100% — more samples than any real model except one, all of
// it invented. Routing then ranked fixtures against real engines, which is a
// large part of why the auto-scoring was untrustworthy.
//
// A model whose name is a fixture word, or a bare single letter, is not a model.
// Blocked on WRITE so pollution cannot recur even when a test forgets to sandbox,
// and ignored on READ so the events already on disk stop skewing scores without
// rewriting anyone's append-only history. Deliberately conservative: it matches
// the fixture word only at the START of the model id and requires a single letter
// to be exactly that, so real ids like `r1`, `gpt-oss:120b`, `mockingbird-7b`
// (were it real) and `gemma4:31b` are untouched.
//
// …AND IT APPLIES TO THE SHARED REGISTRY ONLY. Deciding "this is a fixture" from
// the model's NAME is a heuristic, and enforcing it everywhere had two costs I
// caused and then had to come back for. It broke test/chat-outcome, which sandboxes
// itself properly (CONVERGE_REGISTRY_DIR) and asserts on its own telemetry through a
// model called `mock-rater` — the events were dropped and every assertion read
// empty. And in production it would make any legitimately-named model
// (`test-`, `sample-`, `example-`) permanently unrateable, silently.
//
// The premise of this whole guard was that the polluting tests DID NOT sandbox
// themselves — "none of those tests set CONVERGE_REGISTRY_DIR, so they wrote to
// ~/.converge". A run that HAS pointed the registry elsewhere is isolated by
// construction and cannot pollute anything, so it gets to record and read whatever
// it likes. That is the seam: protect the shared file, stay out of the way of an
// explicitly private one.
const SYNTHETIC_MODEL_RE = /^(mock|test|fixture|dummy|fake|stub|sample|example|placeholder)/i;
// Is this process writing to the operator's shared registry, or to a private one
// it named? Only the shared file needs protecting from fixture names.
function sharedRegistry() {
  return !process.env.CONVERGE_REGISTRY_DIR && !process.env.AGENT_STATE_DIR;
}
function isSyntheticRef(ref) {
  const r = String(ref || '');
  const cut = r.indexOf('/');
  if (cut < 0) return false;
  const model = r.slice(cut + 1);
  if (!model) return false;
  return SYNTHETIC_MODEL_RE.test(model) || /^[A-Za-z]$/.test(model);
}
// What the read/write paths actually gate on: a fixture name, and only where it
// could contaminate shared evidence.
function blockedRef(ref) { return sharedRegistry() && isSyntheticRef(ref); }
function record(ev) {
  try {
    if (ev && ev.ref && blockedRef(ev.ref)) return; // a fixture is not shared evidence
    fs.mkdirSync(baseDir(), { recursive: true });
    fs.appendFileSync(eventsPath(), JSON.stringify({ ...ev, at: ev.at || new Date().toISOString() }) + '\n');
  } catch { /* registry is evidence, not a dependency */ }
}

// Aggregate the whole log into per-ref stats. Cheap for years of real use
// (one line per model call); corrupt lines are skipped, never fatal.
function load() {
  let lines = [];
  try { lines = fs.readFileSync(eventsPath(), 'utf8').split('\n').filter(Boolean); } catch {}
  const by = {};
  // ALIAS → REAL. A configured ref is often a label, not an id: `claude-cli/
  // default` and `cursor-cli/default` resolve to whatever the CLI actually runs
  // (`claude-cli/claude-opus-5`). Outcomes are deliberately recorded against the
  // model that RAN, so attribution is honest — but routing candidates come from
  // the roster, which holds the CONFIGURED ref. The two never joined, so
  // `claude-cli/default` looked like it had zero evidence while its real record
  // sat under a ref no candidate ever matched: measured, 10 investigation
  // outcomes at 80% and 2 coding at 100% were invisible, and the ref "won" every
  // workflow purely by being unproven enough for exploration to try it. The
  // harness emits {t:'alias', ref:<configured>, real:<what ran>} so the two can
  // be reunited here.
  const aliasOf = new Map();
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.t === 'alias' && e.ref && e.real && e.ref !== e.real && !blockedRef(e.ref) && !blockedRef(e.real)) aliasOf.set(e.ref, e.real);
    if (!e.ref) continue;
    if (blockedRef(e.ref)) continue;     // fixture events already on the SHARED log never score
    if (e.t === 'alias') continue;       // mapping only; carries no measurements
    const r = by[e.ref] || (by[e.ref] = { calls: { n: 0, ok: 0, msSum: 0, kinds: {} }, recent: [], outcomes: {} });
    if (e.t === 'call') {
      r.calls.n++; if (e.ok) r.calls.ok++; r.calls.msSum += e.ms || 0;
      if (!e.ok && e.kind) r.calls.kinds[e.kind] = (r.calls.kinds[e.kind] || 0) + 1;
      r.recent.push({ ok: !!e.ok, kind: e.kind || null, at: e.at });
      if (r.recent.length > 50) r.recent.shift();
    } else if (e.t === 'outcome') {
      const o = r.outcomes[e.wf] || (r.outcomes[e.wf] = { n: 0, pass: 0, msSum: 0, tin: 0, tout: 0, scoreSum: 0, scoreN: 0 });
      o.n++; if (e.pass) o.pass++;
      o.msSum += e.ms || 0; o.tin += e.tin || 0; o.tout += e.tout || 0;
      if (e.score != null) { o.scoreSum += Number(e.score) || 0; o.scoreN++; }
    }
  }
  // Fold each real model's record onto the alias that points at it, so a roster
  // candidate carrying the configured label is scored on what that engine has
  // actually done. Both keys keep the evidence — they are the same model wearing
  // two names, and a caller may legitimately look up either. Merged at load time
  // rather than inside stats() so every consumer (routing, cards, dashboards)
  // sees one consistent picture without each re-implementing the join.
  for (const [alias, real] of aliasOf) {
    const src = by[real];
    if (!src) continue;
    const dst = by[alias] || (by[alias] = { calls: { n: 0, ok: 0, msSum: 0, kinds: {} }, recent: [], outcomes: {} });
    if (dst === src) continue;
    dst.calls.n += src.calls.n; dst.calls.ok += src.calls.ok; dst.calls.msSum += src.calls.msSum;
    for (const [k, v] of Object.entries(src.calls.kinds)) dst.calls.kinds[k] = (dst.calls.kinds[k] || 0) + v;
    dst.recent = dst.recent.concat(src.recent).slice(-50);
    for (const [wf, o] of Object.entries(src.outcomes)) {
      const d = dst.outcomes[wf] || (dst.outcomes[wf] = { n: 0, pass: 0, msSum: 0, tin: 0, tout: 0, scoreSum: 0, scoreN: 0 });
      d.n += o.n; d.pass += o.pass; d.msSum += o.msSum; d.tin += o.tin; d.tout += o.tout;
      d.scoreSum += o.scoreSum; d.scoreN += o.scoreN;
    }
  }
  return by;
}

// Read the raw event log (best-effort; corrupt/half-written lines skipped).
function readEvents() {
  let lines = [];
  try { lines = fs.readFileSync(eventsPath(), 'utf8').split('\n').filter(Boolean); } catch {}
  const out = [];
  for (const l of lines) { let e; try { e = JSON.parse(l); } catch { continue; } if (e && e.ref && blockedRef(e.ref)) continue; out.push(e); }
  return out;
}

// The usage + cost report that drives the dashboards. Reads `usage` events
// (one per model call — {ref, account, tin, tout, at}), buckets them by model
// AND by account, and joins the pricing table for real dollars. `since` (ms
// epoch) windows it, e.g. start-of-week. Pure over the log — safe to call from
// the CLI, the GUI server, or over the relay.
function usageReport({ since = 0, now = Date.now(), callLimit = 200 } = {}) {
  const events = readEvents();
  const byModel = {}; // ref -> { calls, tin, tout }
  const byAccount = {}; // label -> { calls, tin, tout, providers:Set }
  const bestOf = {}; // ref -> { wf -> {n,pass,scoreSum,scoreN} } for "best at" / verified outcomes
  const byMission = {}; // missionId -> { refs:{ref:{tin,tout}}, calls, first, last }
  // Cost per PIECE OF WORK — a conversation, a mission, a fleet run — with the
  // model breakdown INSIDE each. This is the view that answers "what did this
  // chat cost me, and which model ate it" without dumping every individual API
  // call as its own line. Keyed by a content id the harness tags onto each
  // usage event (CONVERGE_CONTENT_ID for chats, the mission id for missions).
  const byContent = {}; // contentId -> { kind, label, refs:{ref:{tin,tout,cache,calls}}, calls, first, last }
  for (const e of events) {
    const at = Date.parse(e.at || 0) || 0;
    if (e.t === 'usage' && e.ref && at >= since) {
      const m = byModel[e.ref] || (byModel[e.ref] = { calls: 0, tin: 0, tout: 0, cache: 0 });
      m.calls++; m.tin += e.tin || 0; m.tout += e.tout || 0; m.cache += e.cache || 0;
      const label = e.account || 'default';
      const a = byAccount[label] || (byAccount[label] = { calls: 0, tin: 0, tout: 0, refs: {} });
      a.calls++; a.tin += e.tin || 0; a.tout += e.tout || 0;
      // Per-account TOKENS per model, not just a call count: apportioning an
      // account's cost by call share billed one 200k-token call the same as
      // one 1k-token call.
      const ar = a.refs[e.ref] || (a.refs[e.ref] = { n: 0, tin: 0, tout: 0, cache: 0 });
      ar.n++; ar.tin += e.tin || 0; ar.tout += e.tout || 0; ar.cache += e.cache || 0;
      if (e.mission) {
        const mm = byMission[e.mission] || (byMission[e.mission] = { refs: {}, calls: 0, first: at, last: at });
        const rr = mm.refs[e.ref] || (mm.refs[e.ref] = { tin: 0, tout: 0, cache: 0 });
        rr.tin += e.tin || 0; rr.tout += e.tout || 0; rr.cache += e.cache || 0; mm.calls++;
        if (at && at < mm.first) mm.first = at; if (at > mm.last) mm.last = at;
      }
      // Attribute to a content bucket: the tagged content id, else the mission
      // id, else an "untagged" catch-all so nothing silently vanishes from the
      // total. The model breakdown lives inside each bucket.
      const cid = e.content || e.mission || '(untagged)';
      const ck = byContent[cid] || (byContent[cid] = {
        id: cid,
        kind: e.contentKind || (e.mission ? 'mission' : (cid === '(untagged)' ? 'other' : 'chat')),
        label: e.contentLabel || '',
        refs: {}, calls: 0, first: at, last: at,
      });
      if (e.contentLabel && !ck.label) ck.label = e.contentLabel;
      const cr = ck.refs[e.ref] || (ck.refs[e.ref] = { tin: 0, tout: 0, cache: 0, calls: 0 });
      cr.tin += e.tin || 0; cr.tout += e.tout || 0; cr.cache += e.cache || 0; cr.calls++;
      ck.calls++; if (at && at < ck.first) ck.first = at; if (at > ck.last) ck.last = at;
    } else if (e.t === 'outcome' && e.ref && at >= since) {
      const w = bestOf[e.ref] || (bestOf[e.ref] = {});
      const o = w[e.wf] || (w[e.wf] = { n: 0, pass: 0, scoreSum: 0, scoreN: 0 });
      o.n++; if (e.pass) o.pass++;
      if (e.score != null) { o.scoreSum += Number(e.score) || 0; o.scoreN++; }
    }
  }
  const splitRef = (ref) => { const i = ref.indexOf('/'); return { provider: ref.slice(0, i), model: ref.slice(i + 1) }; };
  const models = Object.entries(byModel).map(([ref, m]) => {
    const { provider, model } = splitRef(ref);
    const c = pricing.costOf(provider, model, m.tin, m.tout, m.cache);
    // "best at": the workflow this model has the highest VERIFIED pass rate on.
    // Requires at least one PASS (you're not "best at" something you only fail)
    // — the old min-2-runs floor left this permanently blank for anyone with a
    // single model or sparse gated history (the common case), so it now shows
    // from the first success. Ties break toward more evidence (higher n).
    let best = null;
    const w = bestOf[ref] || {};
    const outcomes = [];
    for (const [wf, o] of Object.entries(w)) {
      if (o.pass) {
        outcomes.push({ wf, passRate: o.pass / o.n, n: o.n, avgScore: o.scoreN ? o.scoreSum / o.scoreN : null });
      }
      if (!o.pass) continue;
      const pr = o.pass / o.n;
      if (!best || pr > best.passRate || (pr === best.passRate && o.n > best.n)) best = { wf, passRate: pr, n: o.n };
    }
    outcomes.sort((a, b) => b.passRate - a.passRate || b.n - a.n || a.wf.localeCompare(b.wf));
    return { ref, provider, model, calls: m.calls, tin: m.tin, tout: m.tout, usd: c.usd, estimated: c.estimated, free: c.free, ...(c.unknown ? { unknown: true } : {}), best, outcomes };
  }).sort((a, b) => b.usd - a.usd || (b.tin + b.tout) - (a.tin + a.tout));
  const accounts = Object.entries(byAccount).map(([label, a]) => {
    // An account's cost = its OWN tokens priced by the model each ran — not a
    // call-count share of the model's pooled tokens.
    let usd = 0; let estimated = false, unknown = false;
    for (const [ref, ar] of Object.entries(a.refs)) {
      const { provider, model } = splitRef(ref);
      const c = pricing.costOf(provider, model, ar.tin, ar.tout, ar.cache);
      usd += c.usd; estimated = estimated || c.estimated; unknown = unknown || !!c.unknown;
    }
    return { account: label, calls: a.calls, tin: a.tin, tout: a.tout, usd, estimated, ...(unknown ? { unknown: true } : {}) };
  }).sort((a, b) => b.usd - a.usd || b.calls - a.calls);
  const totalUsd = models.reduce((s, m) => s + m.usd, 0);
  const totalTin = models.reduce((s, m) => s + m.tin, 0);
  const totalTout = models.reduce((s, m) => s + m.tout, 0);
  // Per-mission totals + the average, which is the "estimate a mission costs"
  // figure the UIs show. Cost is summed across each mission's models via the
  // same pricing table.
  const missionList = Object.entries(byMission).map(([id, mm]) => {
    let usd = 0, tin = 0, tout = 0, estimated = false, unknown = false;
    for (const [ref, r] of Object.entries(mm.refs)) {
      const { provider, model } = splitRef(ref);
      const c = pricing.costOf(provider, model, r.tin, r.tout, r.cache || 0);
      usd += c.usd; estimated = estimated || c.estimated; unknown = unknown || !!c.unknown; tin += r.tin; tout += r.tout;
    }
    return { id, usd, tin, tout, calls: mm.calls, at: mm.last, estimated, ...(unknown ? { unknown: true } : {}) };
  }).sort((a, b) => b.at - a.at);
  const n = missionList.length;
  const missions = {
    count: n,
    avgUsd: n ? missionList.reduce((s, m) => s + m.usd, 0) / n : 0,
    avgTin: n ? Math.round(missionList.reduce((s, m) => s + m.tin, 0) / n) : 0,
    avgTout: n ? Math.round(missionList.reduce((s, m) => s + m.tout, 0) / n) : 0,
    estimated: missionList.some((m) => m.estimated),
    recent: missionList.slice(0, 10),
  };
  // Cost BY CONTENT — each conversation / mission / run, priced, with the
  // per-model split inside. Newest first; capped so an unbounded log can't
  // produce an unbounded payload, with contentCount reporting the true total.
  const contentList = Object.entries(byContent).map(([id, ck]) => {
    let usd = 0, tin = 0, tout = 0, estimated = false, unknown = false;
    const modelsIn = Object.entries(ck.refs).map(([ref, r]) => {
      const { provider, model } = splitRef(ref);
      const c = pricing.costOf(provider, model, r.tin, r.tout, r.cache || 0);
      usd += c.usd; estimated = estimated || c.estimated; unknown = unknown || !!c.unknown; tin += r.tin; tout += r.tout;
      return { ref, provider, model, calls: r.calls, tin: r.tin, tout: r.tout, usd: c.usd, estimated: c.estimated, free: c.free, ...(c.unknown ? { unknown: true } : {}) };
    }).sort((a, b) => b.usd - a.usd || (b.tin + b.tout) - (a.tin + a.tout));
    return { id: ck.id, kind: ck.kind, label: ck.label || '', usd, tin, tout, calls: ck.calls, at: ck.last, estimated, ...(unknown ? { unknown: true } : {}), models: modelsIn };
  }).sort((a, b) => b.at - a.at);
  const contents = contentList.slice(0, Math.max(0, callLimit));
  return {
    since, now, totalUsd, totalTin, totalTout, models, accounts, missions,
    contents, contentCount: contentList.length,
  };
}

// The usage of ONE mission by id — for the per-mission receipt line.
function missionUsage(missionId) {
  if (!missionId) return null;
  const rep = usageReport({ since: 0 });
  return (rep.missions.recent || []).find((m) => m.id === missionId) || null;
}

// Start of the current week (Monday 00:00 local) as ms epoch — the default
// window for "what am I spending this week".
function startOfWeek(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - day);
  return d.getTime();
}

// Classify a model-call error into a health kind. 'quota'/'timeout'/'net' are
// provider unavailability (they sideline); 'malformed' is recorded by the
// loop when replies can't be used; anything else is 'error'.
function classifyKind(msg) {
  const m = String(msg || '');
  if (/quota|usage limit|rate.?limit|too many requests|\b429\b/i.test(m)) return 'quota';
  if (/timed out|ETIMEDOUT|\btimeout\b/i.test(m)) return 'timeout';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|\bnetwork\b|HTTP 5\d\d|API error 5\d\d|gateway|overloaded/i.test(m)) return 'net';
  return 'error';
}

// Deterministic workflow classifier — the vocabulary lives in
// shared/task-shape.cjs with every other text-shape list (this was a fifth
// private copy). Delegation keeps this module's API stable for its callers.
const classify = require('./shared/task-shape.cjs').classifyWorkflow;

// Health: three straight failures (quota/timeout/net/error) sideline a model
// for 10 minutes from the last failure, as does an abysmal overall reliability (<20% over 5+ calls).
// Computed from the log, never stored — it heals by itself when the window passes or a success lands.
const SIDELINE_MS = 10 * 60 * 1000;
function sidelined(snap, ref, now = Date.now()) {
  const r = snap[ref];
  if (!r) return false;
  if (r.calls && r.calls.n >= 5 && (r.calls.ok / r.calls.n) < 0.2) return true;
  if (r.recent && r.recent.length >= 3) {
    const last3 = r.recent.slice(-3);
    if (last3.every((c) => !c.ok)) {
      const lastAt = Date.parse(last3[2].at || 0) || 0;
      return now - lastAt < SIDELINE_MS;
    }
  }
  return false;
}
function reliability(snap, ref) {
  const r = snap[ref];
  return r && r.calls.n ? r.calls.ok / r.calls.n : null;
}
function stats(snap, ref, wf) {
  const o = snap[ref] && snap[ref].outcomes[wf];
  if (!o || !o.n) return null;
  return { n: o.n, pass: o.pass, passRate: o.pass / o.n, avgMs: o.msSum / o.n, avgScore: o.scoreN ? o.scoreSum / o.scoreN : null, tokensIn: o.tin, tokensOut: o.tout };
}

// Route: pick one candidate ({ref, provider, model, host?, ...}) for a
// workflow under a budget policy. Sidelined members are skipped (unless that
// empties the list — a sidelined model still beats no model). Ties keep
// roster order, so with no evidence and no declared edge the behavior is
// exactly the pre-registry behavior: the primary.
//   policies: best-quality (default) · balanced (performance-per-dollar) ·
//             fastest · cheapest · most-reliable · local-only · free-tier-first
function pick(candidates, opts = {}) {
  const { workflow = 'coding', policy = 'best-quality', snap = load(), declaredOf = () => ({}), now = Date.now() } = opts;
  if (!candidates.length) return null;
  // A fixture must not be a ROUTING CANDIDATE either, not merely unscorable.
  // Blocking its evidence alone creates a worse trap than the pollution it fixes:
  // with no stats it is permanently "undersampled", so the exploration pass picks
  // it on every single turn to build a record it can never accumulate — a routing
  // black hole. Drop synthetic refs up front, and only fall back to them if that
  // would leave nothing at all to run (better a stand-in than no model).
  const real = candidates.filter((c) => !blockedRef(c.ref));
  const pool = real.length ? real : candidates;
  let list = pool.filter((c) => !sidelined(snap, c.ref, now));
  if (!list.length) list = pool.slice();
  const idx = (c) => candidates.indexOf(c);
  const cost = (c) => { const d = declaredOf(c); return d.cost != null ? Number(d.cost) : (d.costIn != null || d.costOut != null ? (Number(d.costIn) || 0) + (Number(d.costOut) || 0) : null); };
  const isLocal = (c) => { const d = declaredOf(c); if (d.local != null) return !!d.local; return /^(https?:\/\/)?(localhost|127\.)/.test(String(c.host || '')) || (!c.host && /^(ollama|llamacpp|vllm)$/.test(c.provider)); };
  const avgCallMs = (c) => { const r = snap[c.ref]; return r && r.calls.n ? r.calls.msSum / r.calls.n : (declaredOf(c).speed != null ? -Number(declaredOf(c).speed) : null); };
  const by = (fn, dir) => (a, b) => {
    const fa = fn(a), fb = fn(b);
    if (fa == null && fb == null) return idx(a) - idx(b);
    if (fa == null) return 1;
    if (fb == null) return -1;
    return dir * (fa - fb) || idx(a) - idx(b);
  };
  // Real per-token price (pricing table), independent of declared caps — the
  // authority for cost ranking. Free providers (Ollama/local) are 0.
  const price = (c) => { const r = pricing.rateFor(c.provider, c.model).rate; return (Number(r.in) || 0) + (Number(r.out) || 0); };
  // EXPLORATION (evidence-based policies only). Without it, whichever model was
  // used first accrues all the outcomes and monopolizes routing forever — the
  // rest of the roster (a coding specialist, a bigger model, a paid model) never
  // gets tried, never builds a record, never gets picked. So the "best model per
  // task" registry only ever knows ONE model. Fix: until every candidate has a
  // minimum sample for THIS workflow, route to the least-sampled one to build
  // its record — and among equally-unproven models try the CHEAPEST first, so we
  // learn on free models at $0 and only spend on a paid model once frees are
  // sampled. EXPLORE=0 (env) disables it for a deterministic, evidence-only run.
  const EXPLORE_MIN = Math.max(0, parseInt(process.env.CONVERGE_EXPLORE_MIN || '3', 10));
  const sampleN = (c) => { const s = stats(snap, c.ref, workflow); return s ? s.n : 0; };
  if (EXPLORE_MIN && (policy === 'best-quality' || policy === 'balanced' || policy === 'value' || policy === 'most-reliable')) {
    // FREE models are explored first — learning which free model is best per
    // task costs $0. Exploration NEVER surprise-spends on a paid model while a
    // free one exists to try or exploit (a mixed roster with a proven free
    // model keeps exploiting it, not paying to learn a paid alternative). But
    // if the roster is ALL PAID (a Fireworks-only fleet is the common case),
    // exploring the paid models is the ONLY way the registry can ever
    // differentiate them — without it an all-paid roster never builds
    // comparative evidence and routing is frozen on the primary forever (the
    // rating system is inert, exactly the "not updated" failure). So: explore
    // free first; only when NO free candidate exists in the roster at all fall
    // back to exploring the unproven PAID models (bounded by EXPLORE_MIN — a
    // few turns each — the implicit cost of "pick the best model for me" over a
    // paid-only roster). CONVERGE_EXPLORE_PAID=1 forces paid exploration even in a
    // mixed roster; CONVERGE_EXPLORE_PAID=0 forbids it entirely (evidence-only).
    const explorePaidEnv = process.env.CONVERGE_EXPLORE_PAID; // '1' force, '0' forbid, unset = all-paid fallback
    const hasFree = list.some((c) => price(c) === 0);
    let undersampled = list.filter((c) => sampleN(c) < EXPLORE_MIN && (explorePaidEnv === '1' || price(c) === 0));
    if (!undersampled.length && explorePaidEnv !== '0' && (explorePaidEnv === '1' || !hasFree)) {
      undersampled = list.filter((c) => sampleN(c) < EXPLORE_MIN); // all-paid roster: differentiate the paid models
    }
    if (undersampled.length) {
      // Prefer exploring a model DECLARED good at this workflow first (a coding
      // specialist should get the coding trials), then the least-sampled, then
      // the cheapest, then roster order.
      const fit = (c) => ((declaredOf(c).strengths || []).includes(workflow) ? 0 : 1);
      return undersampled.slice().sort((a, b) => (fit(a) - fit(b)) || (sampleN(a) - sampleN(b)) || (price(a) - price(b)) || (idx(a) - idx(b)))[0];
    }
  }
  // Wilson lower bound (95%) on the pass rate: passRate alone let 3 lenient
  // judge passes (1.00 @ n=3 → lower bound ≈ 0.44) outrank 40 real gate
  // outcomes at 0.95 (lower bound ≈ 0.84) — the confidence interval makes
  // "more evidence" beat "small perfect streak" without hard cutoffs.
  const wilson = (pass, n) => {
    if (!n) return 0;
    const z = 1.96, p = pass / n;
    const denom = 1 + (z * z) / n;
    return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  };
  switch (policy) {
    case 'local-only': { const loc = list.filter(isLocal); return loc[0] || list[0]; }
    case 'cheapest':
    // Declared per-model cost wins when the operator wrote one; the PRICING
    // TABLE is the fallback — with no capabilities block configured (the
    // default), cost() was null for every candidate and both policies
    // silently returned the primary, paid or not.
    case 'free-tier-first': return list.slice().sort((a, b) => { const ca = cost(a) != null ? cost(a) : price(a); const cb = cost(b) != null ? cost(b) : price(b); return (ca - cb) || (idx(a) - idx(b)); })[0];
    case 'balanced': case 'value': {
      // Performance AND cost. Among models with ACCEPTABLE verified performance
      // for this workflow (within a small margin of the best pass rate), take
      // the CHEAPEST — so a free model that performs as well beats a paid one,
      // and a paid model only wins when it is meaningfully better. With no
      // verified evidence yet, prefer the cheapest/free so we don't pay to learn.
      const rated = list.filter((c) => { const s = stats(snap, c.ref, workflow); return s && s.n >= 3; });
      if (rated.length) {
        const best = Math.max(...rated.map((c) => stats(snap, c.ref, workflow).passRate));
        const MARGIN = 0.1; // a paid model must beat the best free one by >10pp to be chosen
        const acceptable = rated.filter((c) => stats(snap, c.ref, workflow).passRate >= best - MARGIN);
        return acceptable.slice().sort((a, b) => (price(a) - price(b)) || (stats(snap, b.ref, workflow).passRate - stats(snap, a.ref, workflow).passRate) || (idx(a) - idx(b)))[0];
      }
      return list.slice().sort((a, b) => (price(a) - price(b)) || (idx(a) - idx(b)))[0];
    }
    case 'fastest': return list.slice().sort(by(avgCallMs, 1))[0];
    case 'most-reliable': return list.slice().sort(by((c) => reliability(snap, c.ref), -1))[0];
    default: {
      // best-quality: verified outcomes for THIS workflow win (needs n>=3 so
      // one lucky pass can't hijack routing), declared strengths break the
      // no-evidence tie, roster order is the final word.
      const rated = list.filter((c) => { const s = stats(snap, c.ref, workflow); return s && s.n >= 3; });
      if (rated.length) {
        return rated.sort((a, b) => {
          const sa = stats(snap, a.ref, workflow), sb = stats(snap, b.ref, workflow);
          return (wilson(sb.pass, sb.n) - wilson(sa.pass, sa.n)) || ((sb.avgScore || 0) - (sa.avgScore || 0)) || (idx(a) - idx(b));
        })[0];
      }
      const fit = list.filter((c) => (declaredOf(c).strengths || []).includes(workflow));
      return fit[0] || list[0];
    }
  }
}

// Human-readable card for one model — the "capability registry" view.
function card(snap, ref, declared = {}) {
  const r = snap[ref] || { calls: { n: 0, ok: 0, msSum: 0, kinds: {} }, outcomes: {} };
  const lines = [`${ref}`];
  if (declared.context) lines.push(`  context     ${declared.context}`);
  if (declared.cost != null || declared.costIn != null) lines.push(`  cost        ${declared.cost != null ? declared.cost : `${declared.costIn || 0}/${declared.costOut || 0} per 1M`}`);
  if (declared.strengths && declared.strengths.length) lines.push(`  declared    ${declared.strengths.join(', ')}`);
  lines.push(`  reliability ${r.calls.n ? `${((r.calls.ok / r.calls.n) * 100).toFixed(1)}% of ${r.calls.n} calls` : 'no calls recorded'}`);
  if (r.calls.n) lines.push(`  avg call    ${(r.calls.msSum / r.calls.n / 1000).toFixed(1)}s`);
  const kinds = Object.entries(r.calls.kinds).map(([k, n]) => `${k}×${n}`).join(' ');
  if (kinds) lines.push(`  failures    ${kinds}`);
  for (const [wf, o] of Object.entries(r.outcomes)) {
    lines.push(`  ${wf.padEnd(11)} ${((o.pass / o.n) * 100).toFixed(0)}% verified pass over ${o.n} run${o.n === 1 ? '' : 's'}${o.scoreN ? ` · avg score ${(o.scoreSum / o.scoreN).toFixed(1)}` : ''}${o.n ? ` · avg ${(o.msSum / o.n / 1000).toFixed(0)}s` : ''}`);
  }
  return lines.join('\n');
}

module.exports = { record, load, isSyntheticRef, blockedRef, sharedRegistry, classify, classifyKind, sidelined, reliability, stats, pick, card, eventsPath, SIDELINE_MS, readEvents, usageReport, missionUsage, startOfWeek };
