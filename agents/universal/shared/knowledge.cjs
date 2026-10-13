'use strict';
// Durable, provenanced, re-verifiable knowledge about a RESOURCE.
//
// WHY THIS EXISTS — the exact failure it replaces
// ----------------------------------------------
// `db-mcp/schema-maps/example_db__km.json` told every agent that read it:
//
//   locstock — "quantity is exactly in sync with the LATEST stockmoves.newqoh
//   for that stockid/loccode — use that equality to test whether stock was
//   genuinely relieved."   purpose: "Quantity on hand per stockid / location"
//
// That record's own `pk` field said ["loccode","stockid","bin"]. So the note
// over-generalised an equality that holds only for recently-active stock, AND
// described a multi-bin table as one row per stock/location. It carried no
// author, no timestamp, no evidence and no expiry — only a single map-level
// `curatedAt`. An AI wrote a confident sentence and it became a permanent fact.
//
// Three entries away sat the CORRECT rule ("qtyinvoiced stays 0 even on
// correctly invoiced orders — completed=1 is the real marker"), equally
// unprovenanced. Two annotations, one right and one wrong, indistinguishable.
//
// So the problem was never "nobody wrote it down". It was that written-down
// knowledge had no STATE, no PROVENANCE, and never reached the model at the
// moment it mattered. This module fixes all three:
//
//   * STATE       — four states, and only the engine can mint `verified`.
//   * PROVENANCE  — author, timestamp, trust level and evidence are mandatory.
//   * RETRIEVAL   — recall() ranks against the task under a hard char budget.
//
// THE `check` BLOCK IS THE CORE OF THE DESIGN. Prose evidence can never reach
// `verified`; only a stored, re-runnable assertion that the engine executes and
// matches. That is what makes drift SELF-DETECTING: re-run later and a schema
// or semantics change DEMOTES the record instead of letting it rot into a
// confident lie. A claim nobody can re-run is, by construction, `observed`.
//
// Reuses rather than reinvents:
//   * shared/memory.cjs      — coverage/similarity scoring, hard char budget
//   * shared/trust-taint.cjs — trust levels, non-forgeable operator authority
//   * shared/forge-ledger.cjs discipline — state RANK, "an unverified claim is
//     not a resolution", supersede-don't-delete
//
// Zero dependencies, synchronous, CommonJS: it loads in the harness require
// graph at startup and must not add install surface to the fleet. db-mcp is an
// ES module and pulls it in through createRequire (see db-mcp/server.js).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { _internals: mem } = require('./memory.cjs');
const { coverage } = mem;
const trust = require('./trust-taint.cjs');
const { atomicWrite, readJson } = require('./utils.cjs');

const STORE_VERSION = 1;

// Injected-context budget in characters. Deliberately smaller than memory's
// 1800: knowledge rides in projectContextLines(), which is memoized
// process-wide and NOT trimmed after assembly, so it is paid on every model
// call of every round of every turn. It must be small and self-limiting by
// construction, not by hoping the store stays little.
const DEFAULT_BUDGET = parseInt(process.env.CONVERGE_KNOWLEDGE_BUDGET || '1200', 10) || 1200;

// A `verified` record whose check has not been re-run in this long is still
// shown, but labelled with its age. Schemas drift; a proof from last quarter is
// evidence about last quarter.
const STALE_DAYS = parseInt(process.env.CONVERGE_KNOWLEDGE_STALE_DAYS || '90', 10) || 90;

// ---------- states ----------
//
// Mirrors shared/forge-ledger.cjs's ranking discipline: these are DIFFERENT
// states and the difference is the whole point. `observed` is one agent's
// opinion; `verified` is the engine having independently re-run a proof.
// Ranking exists so a later record cannot quietly downgrade a stronger one.
const STATES = ['observed', 'verified', 'user_rule', 'superseded'];
const STATE_RANK = Object.freeze({ superseded: 0, observed: 1, verified: 2, user_rule: 3 });
// Retained for audit but NEVER injected. "Why did the harness used to believe X" has
// to stay answerable, which is why supersession does not delete
// (shared/harness-gc.cjs:26 precedent).
const INJECTABLE_STATES = ['user_rule', 'verified', 'observed'];

// Only this issuer counts. Same shape as the receipt gates in
// shared/harness-depth.cjs:28 and shared/config-tournament.cjs:26 — a record
// that merely SAYS it is verified is rejected, not trusted.
const ENGINE = 'converge-agent';

// ---------- resource identity ----------
//
// So the canonical key is a fingerprint of the ACTUAL TARGET, and local ids are
// aliases. Any machine, any credential, any local label resolves to the same
// knowledge — which is what makes "keyed to the resource" literally true.
function dbFingerprint(conn = {}, database) {
  const type = String(conn.type || conn.dbType || 'mysql').toLowerCase().trim();
  const db = String(database || conn.database || '').toLowerCase().trim();
  if (type === 'sqlite') {
    // A sqlite "host" is a file path; the file IS the resource. Resolve it so
    // two relative paths to the same file share knowledge.
    let file = String(database || conn.database || conn.file || conn.path || '');
    try { file = fs.realpathSync(file); } catch { file = path.resolve(file); }
    return `db:sqlite/${file}`;
  }
  const host = String(conn.host || conn.hostname || 'localhost').toLowerCase().trim();
  const port = String(conn.port || (type === 'postgres' || type === 'postgresql' ? 5432 : 3306)).trim();
  return `db:${type}/${host}:${port}/${db}`;
}

// A SHORT label for a resource, for building readable record ids. `database` is
// a name like "km" for mysql/postgres but a full filesystem path for sqlite, and
// interpolating that straight into an id produced
// `tmp-claude-0--home-user-...-km.sqlite.locstock`. Ids are read by humans.
function resourceLabel(resource = {}) {
  const db = String(resource.database || '');
  const base = /[\\/]/.test(db) ? path.basename(db).replace(/\.[^.]+$/, '') : db;
  return safeId(base) || safeId(String(resource.fingerprint || '').split('/').pop()) || 'resource';
}

// Filesystem-safe, human-readable, collision-free. A slug alone collides (`:`
// and `/` both flatten to `_`), and a bare hash makes the store unreadable by
// hand — which matters, because "go look at what the harness believes" has to be a
// thing an operator can do with `ls` and `cat`. So: slug + short digest of the
// true fingerprint, with the fingerprint itself stored inside every record.
function fingerprintSlug(fingerprint) {
  const fp = String(fingerprint || '');
  const slug = fp.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'resource';
  const h = crypto.createHash('sha1').update(fp).digest('hex').slice(0, 8);
  return `${slug}-${h}`;
}

// ---------- store locations ----------
//
// DB knowledge is CONSOLE-CANONICAL. Machines cache it, may work offline from
// last-known, and are never independently authoritative — a machine must not be
// able to mint `verified` for a database the whole fleet shares.
const consoleRoot = () => path.join(process.env.CONVERGE_CONSOLE_DIR || path.join(os.homedir(), '.converge-console'), 'knowledge');
const cacheRoot = () => path.join(process.env.CONVERGE_AGENT_HOME || path.join(os.homedir(), '.converge'), 'knowledge-cache');
const projectStorePath = (workdir) => path.join(workdir, '.converge', 'knowledge', 'project.md');

// ---------- receipt signing ----------
//
// The gate below rejects a model-authored `"state":"verified"` at the write
// door. But the store is JSON on disk, so the door is not the only way in — a
// hand-edited (or agent-written) file could claim `verified` directly. Sign the
// material content with a per-install secret and re-validate on LOAD, so a
// record whose claim does not match its content is demoted rather than obeyed.
//
// Scope note, stated plainly because it bounds the guarantee: this protects
// against forged claims from anything that cannot read the secret file. It is
// not a defence against an attacker who already has arbitrary read of the
// user's home directory — nothing at this layer could be. Records arriving from
// the console are accepted on the authority of the authenticated link instead
// (they are signed with the CONSOLE's secret, which machines do not hold) and
// are labelled `origin:'console'` so the two paths stay distinguishable.
function secretPath() {
  return path.join(process.env.CONVERGE_AGENT_HOME || path.join(os.homedir(), '.converge'), 'knowledge-secret');
}
let SECRET = null;
function secret() {
  if (SECRET) return SECRET;
  const f = secretPath();
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch { SECRET = ''; }
  if (!SECRET) {
    SECRET = crypto.randomBytes(32).toString('hex');
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); atomicWrite(f, SECRET); } catch { /* read-only home: fall back to in-process only */ }
  }
  return SECRET;
}
// Signed over the fields that carry MEANING, plus the STATE being claimed. The
// signature attests "the engine proved THIS rule, with THIS check, to THIS
// level" — so editing the rule, swapping the check, or flipping the state all
// break it. Binding `state` in is what stops a `verified` receipt being replayed
// onto a `user_rule` claim (and vice versa).
//
// `reason` carries the operator's words on a user_rule promotion. It is inside
// the signed tuple so the recorded justification cannot be rewritten after the
// fact into something the operator never said.
function receiptPayload(rec) {
  return JSON.stringify({
    id: rec.id,
    fingerprint: rec.resource && rec.resource.fingerprint,
    rule: rec.rule,
    caveat: rec.caveat || '',
    check: rec.check || null,
    state: rec.state,
  });
}
function signReceipt(rec, opts = {}) {
  const body = {
    issuedBy: ENGINE,
    settled: true,
    runId: String(opts.runId || ''),
    at: opts.at || new Date().toISOString(),
    reason: String(opts.reason || ''),
  };
  body.sig = crypto.createHmac('sha256', secret())
    .update(`${receiptPayload(rec)}|${body.runId}|${body.at}|${body.reason}`)
    .digest('hex');
  return body;
}
// Mirrors skill-lifecycle's validateReceipt: an issuer string is not evidence.
// `state` is passed explicitly because normalizeRecord has to ask "would this
// receipt be valid FOR the state being claimed?" before it decides to grant it.
function receiptValid(rec, state) {
  const r = rec && rec.receipt;
  if (!r || r.issuedBy !== ENGINE || r.settled !== true || !r.sig) return false;
  const want = crypto.createHmac('sha256', secret())
    .update(`${receiptPayload({ ...rec, state: state || rec.state })}|${String(r.runId || '')}|${String(r.at || '')}|${String(r.reason || '')}`)
    .digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(String(r.sig), 'hex'), Buffer.from(want, 'hex')); }
  catch { return false; }
}

// ---------- record normalisation + the forgery gate ----------

function nowIso() { return new Date().toISOString(); }
const safeId = (s) => String(s || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

function normalizeCheck(check) {
  if (!check || typeof check !== 'object') return null;
  const kind = String(check.kind || 'sql').toLowerCase();
  if (kind !== 'sql') return null;              // only executable kind today
  const sql = String(check.sql || '').trim();
  if (!sql) return null;
  // A check must be READ-ONLY. A "proof" that mutates the database it is
  // proving things about is not a proof, it is an incident.
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return null;
  const e = check.expect || {};
  const op = String(e.op || 'gt').toLowerCase();
  if (!['gt', 'gte', 'lt', 'lte', 'eq', 'ne'].includes(op)) return null;
  return {
    kind: 'sql',
    sql,
    expect: { op, value: Number(e.value) },
    proves: String(check.proves || '').trim(),
  };
}

// THE GATE. Every write path funnels through here, and it is the reason a model
// cannot promote its own guess: `state` from the caller is IGNORED unless it is
// accompanied by proof this function can check itself.
//
//   * `verified`  — only via verify(), which runs the check and signs. Arriving
//                   here with state:'verified' and a fabricated receipt is not
//                   an error to argue about; it lands as `observed`.
//   * `user_rule` — only with a trust-taint operator justification, whose
//                   non-enumerable Symbol a model cannot forge or serialise.
//
// `strict` makes the rejection loud (throw) for callers that want to know they
// were lied to; the default is to demote silently, because the SAFE outcome for
// a turn in flight is "we kept the claim, unverified" — never "we crashed", and
// never "we believed it".
function normalizeRecord(input, opts = {}) {
  const o = opts || {};
  const rec = { ...(input || {}) };
  const id = safeId(rec.id);
  if (!id) throw new Error('knowledge record needs an id');
  const rule = String(rec.rule || '').trim();
  if (!rule) throw new Error(`knowledge record ${id} needs a rule`);

  const res = rec.resource || {};
  const fingerprint = String(res.fingerprint || '').trim();
  if (!fingerprint) throw new Error(`knowledge record ${id} needs resource.fingerprint`);

  const claimed = STATES.includes(rec.state) ? rec.state : 'observed';
  let state = 'observed';
  let receipt = null;
  const demotions = [];

  if (claimed === 'verified') {
    // THREE WAYS TO HOLD `verified`, and the difference between them is the whole
    // trust model:
    //
    //   signature  — this store minted it: verify() ran the check and signed the
    //                result with the local secret. Checked cryptographically.
    //   fromConsole— it came DOWN from the console, the canonical store, over an
    //                authenticated link. Its receipt was signed with a secret
    //                this machine does not hold, so it is unverifiable HERE by
    //                design; the link is the authority.
    //   attested   — it came UP from a machine. Same situation mirrored: only the
    //                machine has the database driver and the credentials, so only
    //                the machine can run a check, and the console cannot check the
    //                signature. The console accepts it on the authenticated link
    //                and RECORDS WHO ATTESTED IT rather than pretending it
    //                verified anything itself.
    //
    // The limit of `attested`, stated plainly because it bounds the guarantee: a
    // machine that is compromised or simply buggy can assert `verified`, and the
    // console cannot tell. What it CANNOT do is assert `user_rule` — see below.
    // That asymmetry is deliberate: machines are infrastructure that already hold
    // production credentials, operators are people, and only one of those can
    // decide what a business rule is.
    if (o.fromConsole) { state = 'verified'; receipt = rec.receipt || null; }
    else if (receiptValid(rec, 'verified')) { state = 'verified'; receipt = rec.receipt; }
    else if (o.attested) { state = 'verified'; receipt = { ...(rec.receipt || {}), attestedBy: String(o.attested) }; }
    else demotions.push('state "verified" without a valid engine receipt — the engine mints these by RUNNING the check, they cannot be written by hand');
  } else if (claimed === 'user_rule') {
    // A user_rule needs a DURABLE proof, not just a live one. The operator's
    // justification is a Symbol-branded object: it cannot be serialised, so if
    // approval were only ever checked against the live object, every promoted
    // business rule would silently revert to `observed` the next time the store
    // was read. (Driven, and it did exactly that.) So an accepted justification
    // mints a signed receipt, and the receipt is what survives.
    // Deliberately NOT reachable via `attested`. A machine pushing up cannot
    // declare a business rule no matter how it asks: operator authority lives
    // with the operator, exercised through the console. `fromConsole` grants it
    // because that is where the approval happened.
    if (o.fromConsole) { state = 'user_rule'; receipt = rec.receipt || null; }
    else if (trust.trustedJustification(o.operatorJustification)) {
      state = 'user_rule';
      receipt = signReceipt({ ...rec, state: 'user_rule', check: normalizeCheck(rec.check) },
        { runId: `operator-${Date.now().toString(36)}`, reason: o.operatorJustification.reason });
    } else if (receiptValid(rec, 'user_rule')) { state = 'user_rule'; receipt = rec.receipt; }
    else demotions.push('state "user_rule" without an operator justification — a business rule is the operator\'s call, not the model\'s');
  } else if (claimed === 'superseded') {
    state = 'superseded';
  }

  if (demotions.length && o.strict) throw new Error(`knowledge record ${id}: ${demotions.join('; ')}`);

  // Provenance is MANDATORY — the missing-provenance bug, fixed at the source.
  // An unattributed claim is exactly what produced the locstock note.
  //
  // trust-taint's `normalize` reads `source` as a trust LEVEL (hostile/external/
  // local/operator) and silently falls back to 'external' on anything else. An
  // earlier cut of this stored the AUTHOR in `trust.source`, so re-normalising a
  // stored record fed a username in where a level belonged and quietly
  // downgraded every reloaded record to 'external' — including operator rules.
  // Level and author are now separate fields: `level` and `by`.
  const explicit = o.trustSource || (state === 'user_rule' ? 'operator' : '');
  const mark = trust.normalize({
    source: explicit || (rec.trust && rec.trust.level) || 'local',
    origin: String(rec.author || o.author || (rec.trust && rec.trust.by) || 'unknown'),
    chain: (rec.trust && rec.trust.chain) || [],
  });

  const out = {
    version: STORE_VERSION,
    id,
    resource: {
      kind: String(res.kind || 'db'),
      fingerprint,
      database: String(res.database || ''),
      aliases: Array.isArray(res.aliases) ? [...new Set(res.aliases.map(String).filter(Boolean))] : [],
    },
    topic: Array.isArray(rec.topic) ? [...new Set(rec.topic.map((x) => String(x).toLowerCase().trim()).filter(Boolean))] : [],
    rule,
    caveat: String(rec.caveat || '').trim() || undefined,
    state,
    trust: { level: mark.source, by: mark.origin, tainted: mark.tainted, chain: mark.chain },
    evidence: Array.isArray(rec.evidence) ? rec.evidence : [],
    check: normalizeCheck(rec.check),
    author: String(rec.author || o.author || 'unknown'),
    created_at: rec.created_at || nowIso(),
    updated_at: nowIso(),
    verified_at: state === 'verified' ? (rec.verified_at || nowIso()) : (rec.verified_at || undefined),
    verified_by: state === 'verified' ? (o.attested ? String(o.attested) : (rec.verified_by || ENGINE)) : (rec.verified_by || undefined),
    receipt: receipt || undefined,
    supersedes: Array.isArray(rec.supersedes) ? rec.supersedes.map(String) : [],
    supersededBy: rec.supersededBy ? String(rec.supersededBy) : undefined,
    // Kept on the record so the demotion is VISIBLE rather than silent — a
    // record that tried to claim more than it proved says so.
    demoted: demotions.length ? demotions : undefined,
  };
  if (out.state !== 'verified' && out.state !== 'user_rule') delete out.receipt;
  return out;
}

// ---------- store ----------
//
// One file per fingerprint holding that resource's records. The plan's console
// layout is a directory per fingerprint with a file per id; a single file per
// resource is the same data with one atomic write instead of N, which matters
// because a seed run writes 30+ records at once and a half-written resource is
// worse than a stale one. `list()` over one file is also what recall() wants.
function makeStore(baseDir) {
  const root = baseDir || cacheRoot();
  const file = (fingerprint) => path.join(root, `${fingerprintSlug(fingerprint)}.json`);

  function readBundle(fingerprint) {
    const b = readJson(file(fingerprint), null);
    if (!b || !Array.isArray(b.records)) return { version: STORE_VERSION, fingerprint, fetchedAt: null, records: [] };
    return b;
  }
  function writeBundle(fingerprint, bundle) {
    atomicWrite(file(fingerprint), JSON.stringify({ ...bundle, version: STORE_VERSION, fingerprint }, null, 2));
  }

  return {
    root,
    file,
    // Records as stored, each re-validated on the way out. A `verified` claim
    // whose signature no longer matches its content is demoted HERE, on read —
    // so tampering with the file on disk cannot make the harness believe it.
    list(fingerprint, opts = {}) {
      const b = readBundle(fingerprint);
      const out = [];
      for (const r of b.records) {
        try { out.push(normalizeRecord(r, { fromConsole: opts.fromConsole === true || r.origin === 'console' })); }
        catch { /* a corrupt record must never break a turn */ }
      }
      return out;
    },
    fetchedAt(fingerprint) { return readBundle(fingerprint).fetchedAt || null; },
    get(fingerprint, id) { return this.list(fingerprint).find((r) => r.id === safeId(id)) || null; },

    // Upsert. Same id ⇒ replace; the record keeps its original created_at so
    // "how long have we believed this" survives an edit.
    put(rec) {
      const fp = rec.resource.fingerprint;
      const b = readBundle(fp);
      const i = b.records.findIndex((r) => safeId(r.id) === rec.id);
      if (i >= 0) rec = { ...rec, created_at: b.records[i].created_at || rec.created_at };
      if (i >= 0) b.records[i] = rec; else b.records.push(rec);
      writeBundle(fp, b);
      return rec;
    },
    // Wholesale replace, for a console fetch landing in the machine cache.
    //
    // Each record is STAMPED with its origin. list() grants `verified`/`user_rule`
    // to records marked `origin:'console'` because their receipts were signed with
    // the console's secret, which this machine does not hold — but nothing was
    // setting the stamp, so every console-delivered rule was demoted to `observed`
    // the moment it was read back. Driven: an operator-approved rule survived the
    // wire and a machine-attested verified rule did not, which is the kind of
    // half-working that is worse than broken.
    replaceAll(fingerprint, records, meta = {}) {
      const origin = meta.origin || 'console';
      const stamped = (records || []).map((r) => ({ ...r, origin }));
      writeBundle(fingerprint, { fetchedAt: meta.fetchedAt || nowIso(), origin, records: stamped });
      return stamped;
    },
    // Every resource this store knows anything about.
    resources() {
      let names; try { names = fs.readdirSync(root); } catch { return []; }
      return names.filter((n) => n.endsWith('.json') && !n.includes('.tmp'))
        .map((n) => readJson(path.join(root, n), null))
        .filter((b) => b && b.fingerprint)
        .map((b) => ({ fingerprint: b.fingerprint, fetchedAt: b.fetchedAt || null, count: (b.records || []).length }));
    },
  };
}

// ---------- alias resolution ----------
//
// The point of the fingerprint is that a local label resolves TO it. An index
// maps every alias any machine has ever used onto the canonical key, so
// renaming `example_db` does not orphan its knowledge.
function aliasIndex(store) {
  const idx = new Map();
  for (const { fingerprint } of store.resources()) {
    for (const r of store.list(fingerprint)) {
      for (const a of r.resource.aliases) idx.set(String(a).toLowerCase(), fingerprint);
      if (r.resource.database) idx.set(String(r.resource.database).toLowerCase(), fingerprint);
    }
    idx.set(fingerprint.toLowerCase(), fingerprint);
  }
  return idx;
}
function resolveFingerprint(store, label) {
  const key = String(label || '').toLowerCase().trim();
  if (!key) return null;
  return aliasIndex(store).get(key) || null;
}

// ---------- write doors ----------

// propose(): the door a model reaches. ALWAYS lands as `observed` unless the
// caller supplies proof normalizeRecord can check itself. No argument, no
// error — the claim is kept, the promotion is not.
function propose(store, input, opts = {}) {
  const rec = normalizeRecord(input, { ...opts, strict: false });
  return store.put(rec);
}

// verify(): the ONLY path to `verified`, and it goes through the database.
//
// `run(sql)` is injected rather than imported because this module must stay
// dependency-free — db-mcp owns the drivers. It must return { rows } or an
// array of rows; the check reads the FIRST column of the FIRST row as a scalar.
//
// A check that does not run, returns nothing, or does not match does NOT throw:
// it DEMOTES. That asymmetry is the drift detector. Re-run this after a schema
// change and a record that is no longer true falls to `observed` — still
// visible, now caveated — instead of rotting into a confident lie.
async function verify(store, fingerprint, id, run, opts = {}) {
  const rec = store.get(fingerprint, id);
  if (!rec) return { ok: false, state: null, reason: 'no such record' };
  if (rec.state === 'user_rule') return { ok: true, state: 'user_rule', reason: 'business rule — operator-owned, not machine-checkable', record: rec };
  if (!rec.check) {
    const demoted = store.put(normalizeRecord({ ...rec, state: 'observed' }, { author: rec.author }));
    return { ok: false, state: 'observed', reason: 'no executable check — prose evidence cannot reach verified', record: demoted };
  }

  let observed = null; let error = null;
  try {
    const res = await run(rec.check.sql);
    const rows = Array.isArray(res) ? res : (res && Array.isArray(res.rows) ? res.rows : []);
    if (!rows.length) error = 'check returned no rows';
    else {
      const first = rows[0];
      const v = Array.isArray(first) ? first[0] : first[Object.keys(first)[0]];
      observed = Number(v);
      if (!Number.isFinite(observed)) error = `check returned a non-numeric value (${JSON.stringify(v)})`;
    }
  } catch (e) { error = String((e && e.message) || e); }

  const { op, value } = rec.check.expect;
  const matched = error ? false : ({
    gt: observed > value, gte: observed >= value,
    lt: observed < value, lte: observed <= value,
    eq: observed === value, ne: observed !== value,
  })[op];

  const at = nowIso();
  const evidence = [
    ...rec.evidence.filter((e) => e.kind !== 'check-run'),
    { kind: 'check-run', statement: rec.check.sql, observed: error || `${observed} ${op} ${value}`, matched: !!matched, at },
  ];

  if (!matched) {
    const demoted = store.put(normalizeRecord({ ...rec, state: 'observed', evidence, verified_at: rec.verified_at }, { author: rec.author }));
    return { ok: false, state: 'observed', reason: error || `check did not match: observed ${observed}, expected ${op} ${value}`, observed, record: demoted };
  }

  // Matched. Build the record FIRST, then sign it, so the signature covers the
  // content that was actually proved.
  const base = normalizeRecord({ ...rec, state: 'observed', evidence, verified_at: at, verified_by: ENGINE }, { author: rec.author });
  const signed = { ...base, state: 'verified', verified_at: at, verified_by: ENGINE };
  signed.receipt = signReceipt(signed, { runId: opts.runId || `verify-${Date.now().toString(36)}`, at });
  delete signed.demoted;
  const saved = store.put(normalizeRecord(signed, { author: rec.author, strict: true }));
  return { ok: true, state: 'verified', observed, record: saved };
}

// promoteUserRule(): business semantics. Gated on trust-taint's
// issueTrustedJustification, whose non-enumerable Symbol a model can neither
// forge nor serialise into JSON — so an agent cannot self-declare a house rule.
function promoteUserRule(store, fingerprint, id, justification) {
  const rec = store.get(fingerprint, id);
  if (!rec) return { ok: false, reason: 'no such record' };
  if (!trust.trustedJustification(justification)) return { ok: false, reason: 'operator justification required (trust-taint issueTrustedJustification)' };
  const saved = store.put(normalizeRecord(
    {
      ...rec,
      state: 'user_rule',
      // A business rule is not machine-proved, so any earlier verified_* stamps
      // would misdescribe it. The receipt carries the approval time instead.
      verified_at: undefined,
      verified_by: undefined,
      evidence: [...rec.evidence, { kind: 'operator', note: justification.reason, at: nowIso() }],
    },
    { operatorJustification: justification, author: rec.author, trustSource: 'operator', strict: true },
  ));
  return { ok: true, record: saved };
}

// supersede(): replace, never delete. The old record stays with supersededBy so
// "why did the harness used to believe X" remains answerable (harness-gc.cjs:26).
function supersede(store, fingerprint, oldId, newRecord, opts = {}) {
  const old = store.get(fingerprint, oldId);
  const next = propose(store, { ...newRecord, supersedes: [...(newRecord.supersedes || []), ...(old ? [old.id] : [])] }, opts);
  if (old) {
    store.put(normalizeRecord({ ...old, state: 'superseded', supersededBy: next.id }, { author: old.author }));
  }
  return next;
}

// ---------- retrieval ----------
//
// Ranked against the task under a hard character budget, same enforcement shape
// as shared/memory.cjs:389. Topic terms rank and TRIM within an already-chosen
// resource; they never decide WHETHER to inject. That decision is deterministic
// resource identity, made by the caller — see the comment at
// universal-agent.cjs:6127 recording that a relevance gate on injected guidance
// was deleted TWICE (keyword classifier, then a per-turn model call) because
// pre-deciding relevance was wrong more often than the lines cost.
function stateLabel(rec, nowMs) {
  if (rec.state === 'user_rule') return '[business rule — operator-approved]';
  if (rec.state === 'verified') {
    const ms = Date.parse(rec.verified_at) || 0;
    const days = ms ? Math.floor((nowMs - ms) / 86400000) : null;
    if (days != null && days >= STALE_DAYS) return `[verified ${String(rec.verified_at).slice(0, 10)} — ${days}d ago, re-check before relying]`;
    return `[verified ${String(rec.verified_at || '').slice(0, 10) || 'yes'}]`;
  }
  return '[UNVERIFIED — no re-runnable proof on record; treat as a lead and confirm]';
}

// Words that are noise in a QUERY specifically. memory.cjs's stoplist is
// deliberately short and applies to both sides; these are dropped only from the
// query, where they can never be the thing being asked about.
//
// This is not tidiness. Driven at realistic scale (37 KM records), a question
// about stock on hand pulled in the www_users record — because its note reads
// "Who changed what" and the query read "what is the current QOH", so the token
// `what` scored a match. Every question starts with an interrogative, so any
// record whose prose happens to contain one matched every question, and bought a
// slot in a hard-budgeted block from a rule that actually mattered.
const QUERY_STOP = new Set(('what which where when why how who whom whose'
  + ' show tell give find list need want please could would should'
  + ' current currently now today latest'
  + ' many much any some all every each').split(' '));
function queryTokens(text) {
  return new Set(mem.tokens(text || '').filter((t) => !QUERY_STOP.has(t)));
}

function recall(store, fingerprint, taskText, opts = {}) {
  const budget = opts.budget || DEFAULT_BUDGET;
  const all = store.list(fingerprint).filter((r) => INJECTABLE_STATES.includes(r.state));
  if (!all.length) return { text: '', used: 0, shown: 0, total: 0, records: [] };

  const now = Date.now();
  const qt = queryTokens(taskText);
  // NO TASK TEXT MEANS "SHOW ME EVERYTHING", NOT "SHOW ME NOTHING".
  //
  // Relevance filtering below drops `observed` records with no lexical overlap,
  // which is right when there IS a task to be relevant to. With an empty task
  // the overlap is zero by arithmetic, not by judgement — so db_context called
  // with no `task` reported "Nothing is recorded yet about this database" while
  // the store held records for it. Driven through the real MCP server, and it
  // did exactly that on the very door a bare Claude Code session uses.
  const untargeted = qt.size === 0;
  const ranked = all.map((r) => {
    const body = new Set(mem.tokens(`${r.rule} ${r.caveat || ''}`));
    const routing = new Set(mem.tokens([...(r.topic || []), ...(r.resource.aliases || []), r.resource.database].join(' ')));
    const textRel = coverage(qt, body);
    const routeRel = coverage(qt, routing);
    // Routing metadata beats prose overlap, exactly as memory.cjs does it:
    // `topic` exists to bridge vocabulary ("stock on hand" -> "qoh").
    const rel = untargeted ? 1 : Math.max(textRel, routeRel);
    // Carrying a re-runnable check is an objective signal that someone curated
    // this rule rather than dumping a sentence, so it breaks ties in its favour
    // among records of the same state. Deliberately small: it orders equals, it
    // does not override relevance.
    const curated = r.check ? 0.4 : 0;
    return { r, rel, score: textRel * 2 + routeRel * 3 + STATE_RANK[r.state] * 0.5 + curated };
  });

  // State class first — a business rule and a proof outrank an unproven guess
  // no matter how well the guess matches the wording — then relevance within
  // the class. STATE_RANK is the same ordering discipline forge-ledger uses.
  const order = ranked.slice().sort((a, b) => (STATE_RANK[b.r.state] - STATE_RANK[a.r.state]) || (b.score - a.score));

  const lines = [];
  const hit = [];
  let used = 0;
  for (const x of order) {
    // Unproven records must EARN their place: an `observed` claim with no
    // lexical connection to the task is the noise this module exists to stop.
    // Proven and operator-owned rules ride along regardless, because they are
    // the standing rules for this resource.
    if (x.r.state === 'observed' && x.rel <= 0) continue;
    const caveat = x.r.caveat ? ` CAVEAT: ${x.r.caveat}` : '';
    const line = `- ${stateLabel(x.r, now)} ${x.r.rule}${caveat}`;
    // Keep scanning rather than breaking: a short high-value rule further down
    // should still fit after a long one is skipped (memory.cjs does the same).
    if (used + line.length + 1 > budget) continue;
    lines.push(line);
    used += line.length + 1;
    hit.push(x.r);
  }
  if (!lines.length) return { text: '', used: 0, shown: 0, total: all.length, records: [] };

  const withheld = all.length - lines.length;
  const note = withheld > 0
    ? `\n(${withheld} more rule${withheld === 1 ? '' : 's'} known for this resource, not shown — ${untargeted ? 'budget reached' : 'they did not match this task'}.)`
    : '';
  return { text: `${lines.join('\n')}${note}`, used, shown: lines.length, total: all.length, records: hit, untargeted };
}

// The whole injected block, header included, so every consumer (harness
// preload, tool-time injection, db_context) renders it identically. `age` is
// the cache's fetchedAt: a stale cache must be VISIBLY stale rather than
// silently authoritative, which is what makes offline degrade honestly.
function block(fingerprint, r, opts = {}) {
  if (!r || !r.text) return '';
  const label = opts.label || fingerprint;
  const ageMs = opts.fetchedAt ? Date.now() - (Date.parse(opts.fetchedAt) || 0) : 0;
  const hrs = Math.floor(ageMs / 3600000);
  const age = opts.fetchedAt && hrs >= 1
    ? ` · cached ${hrs >= 48 ? `${Math.floor(hrs / 24)}d` : `${hrs}h`} ago${opts.offline ? ', console unreachable' : ''}`
    : (opts.offline ? ' · console unreachable, using cache' : '');
  // Say which selection actually happened. Claiming "relevant to this task" on a
  // call that had no task is a small lie, and small lies about provenance are
  // the entire subject of this module.
  const how = r.untargeted ? 'everything known' : 'selected as relevant to this task';
  return `KNOWN ABOUT ${label}${age} (${r.shown} of ${r.total} rule${r.total === 1 ? '' : 's'}, ${how}):
Rules marked [verified] were proved by re-running a stored check — follow them. Rules marked [UNVERIFIED] are leads, not facts: confirm before relying on one.
${r.text}`;
}

// ---------- project (repo) knowledge ----------
//
// Codebase knowledge is COMMITTED, not console-canonical: it belongs to the
// repo it describes and travels with a clone. Markdown, because a human reviews
// it in a diff.
function readProject(workdir) {
  try { return fs.readFileSync(projectStorePath(workdir), 'utf8'); } catch { return ''; }
}

module.exports = {
  STATES, STATE_RANK, INJECTABLE_STATES, ENGINE, DEFAULT_BUDGET, STALE_DAYS,
  dbFingerprint, fingerprintSlug, resourceLabel,
  makeStore, consoleRoot, cacheRoot, projectStorePath,
  resolveFingerprint, aliasIndex,
  propose, verify, promoteUserRule, supersede, recall, block, readProject,
  normalizeRecord, receiptValid, signReceipt,
  _internals: { normalizeCheck, stateLabel, receiptPayload, secretPath, atomicWrite, queryTokens, QUERY_STOP },
};
