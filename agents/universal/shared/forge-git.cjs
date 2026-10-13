'use strict';
// forge-git.cjs — the branch, the lock, and the checkpoint protocol that let
// several agents on several machines hammer on ONE project without stomping
// each other.
//
// The whole coordination model is: agents work freely on a shared forge branch
// and synchronize only at coherent stable points ("forge checkpoints"), not
// after every file. A checkpoint is:
//
//    finish a coherent change -> drive it -> commit -> ACQUIRE THE INTEGRATION
//    LOCK -> fetch -> merge latest forge HEAD -> resolve -> (drive again if the
//    merge touched relevant code) -> push -> publish the new HEAD -> RELEASE
//    THE LOCK -> the rest of the fleet fast-forwards
//
// The lock is a git ref, not a file and not a service. `git push` of a ref that
// cannot fast-forward is rejected atomically by the remote, so if every
// contender pushes an ORPHAN commit (no parents, unique content) to the same
// ref name, exactly one can ever win — the others are guaranteed
// non-fast-forward. That gives real mutual exclusion across machines using
// nothing but the git remote both sides already share, with no new daemon to
// run, secure, or debug.
//
// Non-negotiable, and enforced below: this module NEVER stashes, resets, or
// discards work it did not create. A machine that reaches a checkpoint in a
// state it cannot reconcile cleanly returns that fact to the coordinator, which
// handles it explicitly. Silently blowing away another agent's dirty tree would
// destroy exactly the work the forge exists to accumulate.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sleepSync } = require('./utils.cjs');
const os = require('os');
const forgeLoop = require('./forge-loop.cjs');
const forgeLedger = require('./forge-ledger.cjs');

function git(cwd, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      // A forge commit must never open $EDITOR or block on a credential prompt:
      // this runs unattended inside an agent turn.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', ...(o.env || {}) },
    });
    return { ok: true, out: String(out).trim(), err: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '').trim(), err: String(e.stderr || e.message || '').trim(), code: e.status };
  }
}

const gitOut = (cwd, args) => { const r = git(cwd, args); return r.ok ? r.out : ''; };

function repoRoot(cwd) { return gitOut(cwd, ['rev-parse', '--show-toplevel']) || null; }
function currentBranch(cwd) { return gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null; }
function headSha(cwd) { return gitOut(cwd, ['rev-parse', 'HEAD']) || null; }
function isDirty(cwd) { return !!gitOut(cwd, ['status', '--porcelain']); }
function dirtyFiles(cwd) { return gitOut(cwd, ['status', '--porcelain']).split('\n').filter(Boolean); }

// `.agent/` is the HARNESS's own scratch directory — mission state files it
// writes into every workdir it touches, recreated freely and meaningless to
// carry between branches. It is emphatically not "another agent's uncommitted
// work", which is what the dirty guard exists to protect. Without this
// exception the guard fires on the harness's own droppings and a forge refuses
// to start in any workdir the harness has ever run in — observed live: a forge
// died with "working tree is dirty" over a single
// `.agent/mission-msqpski3.json`.
const SCRATCH_RE = /^\.agent\//;
function statusPath(line) {
  const p = String(line).slice(3).trim();
  const arrow = p.lastIndexOf(' -> ');   // renames: "R  old -> new"
  return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, '');
}
function meaningfulDirtyFiles(cwd) {
  return dirtyFiles(cwd).filter((l) => !SCRATCH_RE.test(statusPath(l)));
}
function isMeaningfullyDirty(cwd) { return meaningfulDirtyFiles(cwd).length > 0; }

// A forge with a remote coordinates across machines; a forge without one still
// works perfectly well on a single machine — it just uses a local lock and
// never pushes. Both are legitimate, so the remote is detected, not required.
function remoteName(cwd) {
  const r = gitOut(cwd, ['remote']).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!r.length) return null;
  return r.includes('origin') ? 'origin' : r[0];
}

// ---------- branch setup ----------

// Put this machine on the forge branch at the agreed starting point. Refuses —
// never stashes — if the tree is dirty with work that is not ours to move.
function ensureBranch(cwd, branch, opts) {
  const o = opts || {};
  const remote = remoteName(cwd);
  const cur = currentBranch(cwd);
  if (cur === branch) {
    if (remote) git(cwd, ['fetch', remote, branch]);
    return { ok: true, branch, sha: headSha(cwd), created: false, alreadyOn: true };
  }
  if (isMeaningfullyDirty(cwd) && !o.allowDirty) {
    return { ok: false, reason: `working tree is dirty on ${cur} — refusing to switch to ${branch} and risk another agent's uncommitted work`, dirty: meaningfulDirtyFiles(cwd) };
  }
  if (remote) git(cwd, ['fetch', remote, branch]);
  const remoteHas = remote && git(cwd, ['rev-parse', '--verify', `${remote}/${branch}`]).ok;
  const localHas = git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]).ok;
  let r;
  if (localHas) {
    r = git(cwd, ['checkout', branch]);
    // Join whatever the fleet has already built on this branch rather than
    // starting from a stale local copy of it.
    if (r.ok && remoteHas) git(cwd, ['merge', '--ff-only', `${remote}/${branch}`]);
  } else if (remoteHas) {
    r = git(cwd, ['checkout', '-b', branch, `${remote}/${branch}`]);
  } else {
    const base = o.baseSha || o.baseRef || 'HEAD';
    r = git(cwd, ['checkout', '-b', branch, base]);
  }
  if (!r.ok) return { ok: false, reason: `could not check out ${branch}: ${r.err}` };
  return { ok: true, branch, sha: headSha(cwd), created: !localHas, alreadyOn: false };
}

// Every node lands on the accepted HEAD after a checkpoint. Fast-forward ONLY:
// if this node has diverged it has real local work, and quietly reconciling it
// here — outside the lock, without driving the result — is precisely the kind
// of silent merge that loses a fix.
function fastForward(cwd, branch) {
  const remote = remoteName(cwd);
  if (!remote) return { ok: true, skipped: 'no remote' };
  const f = git(cwd, ['fetch', remote, branch]);
  if (!f.ok) return { ok: false, reason: `fetch failed: ${f.err}` };
  if (isMeaningfullyDirty(cwd)) return { ok: false, reason: 'working tree is dirty — not fast-forwarding over uncommitted work', dirty: meaningfulDirtyFiles(cwd) };
  const r = git(cwd, ['merge', '--ff-only', `${remote}/${branch}`]);
  if (!r.ok) return { ok: false, reason: `not a fast-forward (this node has diverged): ${r.err}`, diverged: true };
  return { ok: true, sha: headSha(cwd) };
}

// ---------- the integration lock ----------

const lockRefFor = (forgeId) => `refs/forge/${forgeId}/lock`;

const DEFAULT_LEASE_MS = 60 * 1000;      // active holder holds lease for 60s without heartbeat renewal
const DEFAULT_HEARTBEAT_MS = 15 * 1000;  // active holder heartbeats every 15s to maintain lease
const LOCK_TTL_MS = DEFAULT_LEASE_MS;    // back-compat export

// sleepSync imported from ./utils.cjs

// Build an ORPHAN commit with git plumbing: no parents, no working-tree or
// index side effects, unique content per holder. Two of these can never be
// ancestors of one another, which is exactly what makes the ref push a mutex.
function makeLockCommit(cwd, forgeId, node, opts) {
  const o = opts || {};
  const leaseMs = Number(o.leaseMs || o.ttlMs) > 0 ? Number(o.leaseMs || o.ttlMs) : DEFAULT_LEASE_MS;
  const payload = JSON.stringify({
    forgeId,
    node,
    pid: process.pid,
    host: os.hostname(),
    at: new Date().toISOString(),
    leaseMs,
    seq: Number(o.seq || 0),
  });
  // Written through a temp file rather than stdin so the blob write uses the
  // plain, portable `git hash-object -w <file>` form on every platform.
  const tmp = path.join(os.tmpdir(), `forge-lock-${forgeId}-${process.pid}`);
  fs.writeFileSync(tmp, payload);
  const b = git(cwd, ['hash-object', '-w', tmp]);
  try { fs.unlinkSync(tmp); } catch {}
  if (!b.ok) return { ok: false, reason: b.err };
  const mk = (() => {
    try {
      const out = execFileSync('git', ['mktree'], { cwd, encoding: 'utf8', input: `100644 blob ${b.out}\tlock\n`, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return { ok: true, out: String(out).trim() };
    } catch (e) { return { ok: false, reason: String(e.stderr || e.message) }; }
  })();
  if (!mk.ok) return { ok: false, reason: mk.reason };
  const c = git(cwd, ['commit-tree', mk.out, '-m', `forge lock ${forgeId} by ${node} at ${new Date().toISOString()}`]);
  if (!c.ok) return { ok: false, reason: c.err };
  return { ok: true, sha: c.out, payload };
}

function readLockHolder(cwd, forgeId) {
  const remote = remoteName(cwd);
  const ref = lockRefFor(forgeId);
  let sha = null;
  if (remote) {
    const ls = git(cwd, ['ls-remote', remote, ref]);
    if (!ls.ok || !ls.out.trim()) return null;
    sha = ls.out.split(/\s+/)[0];
    if (!sha) return null;
    const fetchRes = git(cwd, ['fetch', remote, `${ref}:${ref}`, '--force']);
    if (!fetchRes.ok) return null; // Lock ref was deleted on remote between ls-remote and fetch
  } else {
    const r = git(cwd, ['rev-parse', '--verify', ref]);
    if (!r.ok || !r.out.trim()) return null;
    sha = r.out.trim();
  }
  if (!sha) return null;

  // The holder's identity travels IN the lock commit, so any machine can see
  // who holds it and since when without a side channel.
  const msgRes = git(cwd, ['cat-file', 'commit', sha]);
  if (!msgRes.ok || !msgRes.out) return null; // Commit object deleted or unreadable
  const msg = msgRes.out;
  const m = /forge lock \S+ by (\S+) at (\S+)/.exec(msg);

  let payload = null;
  try {
    const rawPayload = gitOut(cwd, ['cat-file', 'blob', `${sha}:lock`]);
    if (rawPayload) payload = JSON.parse(rawPayload);
  } catch {}

  if (!m && !payload) return null; // Lock message and payload both unparseable (deleted/corrupt object)

  const node = (payload && payload.node) || (m ? m[1] : 'unknown');
  const at = (payload && payload.at) || (m ? m[2] : null);
  if (!at && node === 'unknown') return null;

  const pid = payload ? payload.pid : null;
  const host = payload ? payload.host : null;
  const leaseMs = payload && payload.leaseMs ? Number(payload.leaseMs) : DEFAULT_LEASE_MS;
  const seq = payload && payload.seq ? Number(payload.seq) : 0;
  return { sha, node, at, pid, host, leaseMs, seq, payload };
}

function isLockExpired(holder, leaseMs) {
  if (!holder || !holder.at) return true;
  const l = Number(leaseMs || (holder && holder.leaseMs)) > 0 ? Number(leaseMs || (holder && holder.leaseMs)) : DEFAULT_LEASE_MS;
  const age = Date.now() - Date.parse(holder.at);
  return !Number.isFinite(age) || age >= l;
}

// Take the integration lock, or report who holds it. Replaces fixed TTL expiry with
// renewable lease & heartbeat semantics. Supports exponential backoff and bounded fairness retries.
function acquireLock(cwd, forgeId, node, opts) {
  const o = opts || {};
  const leaseMs = Number(o.leaseMs || o.ttlMs) > 0 ? Number(o.leaseMs || o.ttlMs) : DEFAULT_LEASE_MS;
  const maxAttempts = Number(o.maxAttempts) > 0 ? Number(o.maxAttempts) : (o.retry ? 5 : 1);
  const startTime = Date.now();
  const remote = remoteName(cwd);
  const ref = lockRefFor(forgeId);

  const attempt = () => {
    const lc = makeLockCommit(cwd, forgeId, node, { leaseMs });
    if (!lc.ok) return { ok: false, reason: `could not build lock commit: ${lc.reason}` };
    if (remote) {
      // No --force: an existing ref makes this a non-fast-forward and the
      // remote rejects it atomically. That rejection IS the mutex.
      const p = git(cwd, ['push', remote, `${lc.sha}:${ref}`]);
      if (p.ok) return { ok: true, sha: lc.sha, ref, remote, leaseMs };
      return { ok: false, contended: true, reason: p.err };
    }
    // Local-only forge: same semantics without a remote. update-ref's
    // "old value must be empty" form is likewise atomic.
    const u = git(cwd, ['update-ref', ref, lc.sha, '']);
    if (u.ok) return { ok: true, sha: lc.sha, ref, remote: null, leaseMs };
    return { ok: false, contended: true, reason: u.err };
  };

  let lastResult = null;
  for (let tryIdx = 1; tryIdx <= maxAttempts; tryIdx++) {
    let r = attempt();
    if (r.ok) return tryIdx > 1 ? { ...r, retriedAttempts: tryIdx } : r;

    const holder = readLockHolder(cwd, forgeId);
    const effectiveLease = holder && holder.leaseMs ? holder.leaseMs : leaseMs;
    const age = holder && holder.at ? Date.now() - Date.parse(holder.at) : Infinity;

    // Active holder with non-expired lease:
    if (holder && Number.isFinite(age) && age < effectiveLease) {
      // If the active holder is this exact node, attempt lease renewal:
      if (String(holder.node) === String(node)) {
        const renewed = renewLock(cwd, forgeId, holder.sha, node, { leaseMs: effectiveLease });
        if (renewed.ok) return { ...renewed, reacquired: true };
      }
      lastResult = { ok: false, held: true, holder, ageMs: age, leaseMs: effectiveLease, reason: `integration lock held by ${holder.node} since ${holder.at}` };
    } else {
      // Stale / expired lease — lifecycle recovery: break expired lock, race to acquire.
      if (remote) git(cwd, ['push', remote, `:${ref}`]);
      else git(cwd, ['update-ref', '-d', ref]);
      r = attempt();
      if (r.ok) return { ...r, recovered: true, broke: holder || { node: 'unknown' } };
      lastResult = { ok: false, held: true, holder: readLockHolder(cwd, forgeId), reason: r.reason };
    }

    if (tryIdx < maxAttempts) {
      const waitTimeMs = Date.now() - startTime;
      const backoff = forgeLoop.calculateLockBackoff ? forgeLoop.calculateLockBackoff(tryIdx, { ...o, waitTimeMs }) : { delayMs: 50 };
      sleepSync(backoff.delayMs);
    }
  }

  return lastResult;
}

// Renew lease / heartbeat for active holder. Atomic compare-and-swap using `ownSha`.
function renewLock(cwd, forgeId, ownSha, node, opts) {
  const o = opts || {};
  const leaseMs = Number(o.leaseMs || o.ttlMs) > 0 ? Number(o.leaseMs || o.ttlMs) : DEFAULT_LEASE_MS;
  const remote = remoteName(cwd);
  const ref = lockRefFor(forgeId);

  if (!ownSha) return { ok: false, notOwner: true, reason: 'ownSha is required to renew lock' };

  const lc = makeLockCommit(cwd, forgeId, node, { leaseMs, seq: (o.seq || 0) + 1 });
  if (!lc.ok) return { ok: false, reason: `could not build renewal commit: ${lc.reason}` };

  if (remote) {
    const p = git(cwd, ['push', `--force-with-lease=${ref}:${ownSha}`, remote, `${lc.sha}:${ref}`]);
    if (p.ok) return { ok: true, sha: lc.sha, ref, remote, leaseMs, renewedAt: new Date().toISOString() };
    const stale = /stale info|cannot lock ref|reference already exists|but expected/i.test(String(p.err || ''));
    return { ok: false, notOwner: stale, reason: stale ? `lock was taken over by another node (lease lost): ${p.err}` : p.err };
  } else {
    const u = git(cwd, ['update-ref', ref, lc.sha, ownSha]);
    if (u.ok) return { ok: true, sha: lc.sha, ref, remote: null, leaseMs, renewedAt: new Date().toISOString() };
    const stale = /cannot lock ref|reference already exists|but expected/i.test(String(u.err || ''));
    return { ok: false, notOwner: stale, reason: stale ? `lock was taken over by another node (lease lost): ${u.err}` : u.err };
  }
}

const heartbeatLock = renewLock;

// Spawns active heartbeat loop to continuously renew lease while holder is active.
function startLockHeartbeat(cwd, forgeId, initialSha, node, opts) {
  const o = opts || {};
  const leaseMs = Number(o.leaseMs || o.ttlMs) > 0 ? Number(o.leaseMs || o.ttlMs) : DEFAULT_LEASE_MS;
  const intervalMs = Number(o.heartbeatMs) > 0 ? Number(o.heartbeatMs) : Math.max(2000, Math.floor(leaseMs / 3));

  let currentSha = initialSha;
  let active = true;
  let timer = null;

  const tick = () => {
    if (!active || !currentSha) return;
    const res = renewLock(cwd, forgeId, currentSha, node, { leaseMs });
    if (res.ok) {
      currentSha = res.sha;
    } else if (res.notOwner) {
      active = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    getSha: () => currentSha,
    isAlive: () => active,
    stop: () => {
      active = false;
      if (timer) clearInterval(timer);
    },
    renewNow: () => tick(),
  };
}

// Release ONLY the lock we actually still hold. Passing `ownSha` (the sha
// acquireLock returned) makes this a compare-and-delete instead of an
// unconditional one, and that difference is a real mutual-exclusion bug, not a
// nicety: the TTL path above deliberately BREAKS a lock older than 20 minutes,
// and the module's own comment allows a checkpoint that drives the product to
// take that long. So the sequence below is reachable in normal operation —
//   A acquires -> A is slow -> B breaks the stale lock and starts integrating
//   -> A finishes and its finally-block releases -> B's lock is destroyed
//   -> C acquires while B is still merging and pushing
// — and it puts two integrators on the branch at once, which is exactly what
// the lock exists to prevent. Driven live before this fix: nodeB and nodeC both
// held the lock simultaneously.
// A lease rejection is NOT an error to retry; it means we were superseded and
// must not touch the ref. `git push --force-with-lease=<ref>:<sha> :<ref>`
// rejects with "stale info" when the ref moved (verified against a real remote).
function releaseLock(cwd, forgeId, ownSha) {
  const remote = remoteName(cwd);
  const ref = lockRefFor(forgeId);
  let r;
  if (remote) {
    r = ownSha
      ? git(cwd, ['push', `--force-with-lease=${ref}:${ownSha}`, remote, `:${ref}`])
      : git(cwd, ['push', remote, `:${ref}`]);
    // The local ref is only the mirror readLockHolder fetched, never the lock
    // itself, so dropping it is always safe here. In the local-only branch
    // below the ref IS the lock, which is why this does not run there — an
    // unconditional delete there would silently undo the ownership check.
    git(cwd, ['update-ref', '-d', ref]);
  } else {
    // update-ref's <newvalue> <oldvalue> form is likewise a compare-and-swap.
    r = ownSha ? git(cwd, ['update-ref', '-d', ref, ownSha]) : git(cwd, ['update-ref', '-d', ref]);
  }
  if (!r.ok) {
    const stale = /stale info|cannot lock ref|reference already exists|but expected/i.test(String(r.err || ''));
    return { ok: false, notOwner: stale, reason: stale ? `lock was taken over by another node (not ours to release): ${r.err}` : r.err };
  }
  return { ok: true, reason: null };
}

// ---------- checkpoint ----------

// The ledger is committed WITH the code (see forge-ledger.cjs) so git is the
// only transport. That makes it the one file two concurrent checkpoints will
// reliably conflict on — and the one file we can resolve deterministically,
// because forge-loop.mergeLedgers is a pure union that cannot drop a finding.
function resolveLedgerConflict(cwd, forgeId) {
  const rel = forgeLedger.ledgerRelPath(forgeId);
  const ours = gitOut(cwd, ['show', `:2:${rel}`]);
  const theirs = gitOut(cwd, ['show', `:3:${rel}`]);
  if (!ours || !theirs) return { ok: false, reason: 'could not read both sides of the ledger conflict' };
  let a, b;
  try { a = JSON.parse(ours); b = JSON.parse(theirs); } catch (e) { return { ok: false, reason: `ledger conflict sides are not valid JSON: ${e.message}` }; }
  const { ledger } = forgeLoop.mergeLedgers(a, b);
  const abs = path.join(repoRoot(cwd) || cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(ledger, null, 2));
  const add = git(cwd, ['add', '--', rel]);
  return add.ok ? { ok: true, ledger } : { ok: false, reason: add.err };
}

// One full checkpoint. Returns enough for the coordinator to decide what
// happens next — in particular `needsDrive` (the merge pulled in other agents'
// code, so the integrated result has NOT been driven by anyone yet) and
// `needsResolve` (a real code conflict a human or an agent must settle; we do
// not guess at it and we do not throw away either side).
function checkpoint(cwd, opts) {
  const o = opts || {};
  const forgeId = o.forgeId;
  const branch = o.branch;
  const node = o.node || os.hostname();
  const remote = remoteName(cwd);
  const steps = [];
  // Every return from here carries `steps`, so a caller can always report what
  // the checkpoint actually managed to do before it stopped.
  if (!forgeId || !branch) return { ok: false, reason: 'checkpoint requires forgeId and branch', steps };

  const onBranch = currentBranch(cwd);
  if (onBranch !== branch) return { ok: false, reason: `not on the forge branch (on ${onBranch}, expected ${branch})`, steps };

  // 1. Commit this agent's coherent change, including the ledger.
  // The ledger is force-added: it is the forge's coordination channel, and a
  // repo that gitignores `.converge/` (this very repo already ignores
  // `.converge/executive`) would otherwise drop it from every checkpoint — the
  // branch would carry the code across machines while every node kept a private
  // ledger, which is the one failure that would look like it was working.
  const ledgerRelForAdd = forgeLedger.ledgerRelPath(forgeId);
  git(cwd, ['add', '-f', '--', ledgerRelForAdd]);
  if (isDirty(cwd) || git(cwd, ['diff', '--cached', '--quiet']).ok === false) {
    const add = git(cwd, ['add', '-A']);
    if (!add.ok) return { ok: false, reason: `git add failed: ${add.err}`, steps };
    // Transient per-machine scratch is never branch content. `.agent/` is the
    // harness's own mission/chat/gate state and a ledger lockfile is a
    // half-written temp from a concurrent writer here. Committing them was
    // observed live: a checkpoint carried `.agent/chat.log`,
    // `.agent/gate-timing.json` and two `.agent/mission-*.json` onto the shared
    // branch — files every node writes differently, so they would conflict at
    // every multi-node checkpoint while meaning nothing to anyone.
    git(cwd, ['reset', '-q', '--', '.agent', '.converge/forge/*.lock', '.converge/forge/*.tmp*']);
    const msg = String(o.message || `forge(${forgeId}): checkpoint from ${node}`).slice(0, 4000);
    const cm = git(cwd, ['commit', '-m', msg, ...(o.author ? ['--author', o.author] : [])]);
    if (!cm.ok && !/nothing to commit/i.test(cm.out + cm.err)) return { ok: false, reason: `commit failed: ${cm.err || cm.out}` };
    steps.push('commit');
  } else {
    steps.push('nothing-to-commit');
  }

  // 2. Take the integration lock. Only one node integrates at a time; everyone
  //    else keeps working locally until their own coherent change is ready.
  const lock = acquireLock(cwd, forgeId, node, { leaseMs: o.leaseMs || o.lockTtlMs, ttlMs: o.lockTtlMs });
  if (!lock.ok) return { ok: false, locked: true, holder: lock.holder, reason: lock.reason, steps };
  steps.push(lock.recovered ? `lock-acquired (recovered expired lock held by ${lock.broke ? lock.broke.node : 'unknown'})` : lock.broke ? `lock-acquired (broke stale lock held by ${lock.broke.node})` : 'lock-acquired');

  const hb = startLockHeartbeat(cwd, forgeId, lock.sha, node, { leaseMs: o.leaseMs || o.lockTtlMs || DEFAULT_LEASE_MS, heartbeatMs: o.heartbeatMs });

  try {
    let needsDrive = false;
    if (remote) {
      // 3. Fetch and merge whatever else landed while this agent was working.
      //    The branch legitimately does not exist on the remote yet on the very
      //    FIRST checkpoint of a forge — `git fetch <remote> <branch>` fails
      //    outright in that case ("couldn't find remote ref"), so ask whether it
      //    is there before treating a fetch failure as real. Without this every
      //    forge died on its own first checkpoint.
      // FETCH_HEAD, not `<remote>/<branch>`: the remote-tracking ref is only
      // updated opportunistically and depends on the clone's refspec, while
      // FETCH_HEAD is exactly what the fetch below just retrieved.
      const remoteRef = 'FETCH_HEAD';
      const onRemote = git(cwd, ['ls-remote', '--heads', remote, branch]);
      if (!onRemote.ok) return { ok: false, reason: `cannot reach remote ${remote}: ${onRemote.err}`, steps };
      const hasRemoteBranch = !!onRemote.out.trim();
      if (hasRemoteBranch) {
        const f = git(cwd, ['fetch', remote, branch]);
        if (!f.ok) return { ok: false, reason: `fetch failed: ${f.err}`, steps };
        const behind = gitOut(cwd, ['rev-list', '--count', `HEAD..${remoteRef}`]);
        if (Number(behind) > 0) {
          steps.push(`merging ${behind} commit(s) from ${remoteRef}`);
          const mg = git(cwd, ['merge', '--no-edit', remoteRef]);
          if (!mg.ok) {
            const conflicted = gitOut(cwd, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
            const ledgerRel = forgeLedger.ledgerRelPath(forgeId);
            const onlyLedger = conflicted.length > 0 && conflicted.every((p) => p === ledgerRel);
            if (onlyLedger) {
              const res = resolveLedgerConflict(cwd, forgeId);
              if (!res.ok) { git(cwd, ['merge', '--abort']); return { ok: false, reason: `ledger merge failed: ${res.reason}`, steps }; }
              const cont = git(cwd, ['commit', '--no-edit']);
              if (!cont.ok) { git(cwd, ['merge', '--abort']); return { ok: false, reason: `ledger merge commit failed: ${cont.err}`, steps }; }
              steps.push('ledger-conflict-merged');
            } else {
              // A real code conflict. Abort cleanly — the tree goes back
              // exactly as it was, nothing of either side is lost — and hand
              // the fact to the coordinator to route explicitly. We do not
              // guess, and we never pick a side.
              git(cwd, ['merge', '--abort']);
              return { ok: false, needsResolve: true, conflicted, reason: `merge conflict on ${conflicted.join(', ')} — needs explicit resolution`, steps };
            }
          }
          // The integrated result contains code nobody has driven in this
          // combination. Whether that matters is the coordinator's call, but it
          // must be TOLD, or a merge silently ships an unexercised combination.
          needsDrive = true;
        }
      }
      // 4. Publish.
      const push = git(cwd, ['push', remote, `HEAD:${branch}`]);
      if (!push.ok) return { ok: false, reason: `push failed: ${push.err}`, steps };
      steps.push('pushed');
    } else {
      steps.push('local-only (no remote configured)');
    }
    // What this checkpoint ACTUALLY changed, straight from git. The ledger
    // stores it next to the agent's own account of its work, because the two
    // disagree in practice: a round observed live reported "calc.js was not
    // modified at all" in its handoff while its own commit changed calc.js by
    // ten lines. The forge already tells every agent not to trust the previous
    // one's claims — this gives the next agent something factual to check them
    // against, at the cost of one git command.
    const changedFiles = gitOut(cwd, ['show', '--name-only', '--format=', 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean);
    return { ok: true, sha: headSha(cwd), branch, node, needsDrive, changedFiles, steps };
  } finally {
    // 5. Release, always — an exception between lock and release must not
    //    strand the whole fleet behind a lock nobody holds. But release only
    //    OUR lock: if this checkpoint ran long enough that another node broke it
    //    as stale, the ref now belongs to that node and deleting it would let a
    //    third node integrate alongside it. Being superseded is reported, not
    //    swallowed — the work is committed and will be re-integrated at the next
    //    checkpoint, and the operator needs to know the checkpoint overran the
    //    lock TTL.
    hb.stop();
    const curSha = hb.getSha();
    const rel = releaseLock(cwd, forgeId, curSha);
    steps.push(rel.ok ? 'lock-released'
      : rel.notOwner ? 'lock-NOT-released: this checkpoint overran the lock TTL and another node took it over'
      : `lock-release-failed: ${rel.reason}`);
  }
}

module.exports = {
  git, repoRoot, currentBranch, headSha, isDirty, dirtyFiles, remoteName,
  meaningfulDirtyFiles, isMeaningfullyDirty,
  ensureBranch, fastForward, checkpoint,
  acquireLock, renewLock, heartbeatLock, releaseLock, readLockHolder, startLockHeartbeat,
  lockRefFor, resolveLedgerConflict, isLockExpired,
  LOCK_TTL_MS, DEFAULT_LEASE_MS, DEFAULT_HEARTBEAT_MS,
};
