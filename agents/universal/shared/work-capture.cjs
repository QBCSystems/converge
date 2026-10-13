// work-capture.cjs — make a working tree's uncommitted work durable as a REAL
// git commit, without touching HEAD, the index, or the working tree.
//
// WHY THIS EXISTS. A fleet build node edits files for 20 minutes, gets killed at
// its hard deadline, and every edit is left as dirty state in the machine's
// worktree with nothing recorded anywhere (watched live: 249 tool steps, 12
// files edited — flight.js, camera.js, game.js, dragons.js, world.js,
// weather.js, combat.js, combat-logic.js, tame.js, index.html — mission
// canceled, "nothing was finally verified or committed"). The work survived
// only because the operator happened to be looking at that machine. On any
// other node it is indistinguishable from a mission that did nothing.
//
// The naive fixes are both wrong:
//   `git add -A && git commit`  mutates the operator's index and branch — a
//                               harness must never write to the branch a human
//                               is working on.
//   `git stash`                 mutates the working tree (reverts the edits!),
//                               which is catastrophic mid-mission.
//
// So we build the commit out of plumbing against a THROWAWAY INDEX. HEAD, the
// real index and every file on disk are untouched; what appears is one new
// commit object reachable from a private ref under refs/converge-agent/capture/. The
// operator's `git status` is byte-identical before and after.
//
// The same commit is then exportable as an incremental `git bundle` — a single
// self-contained, verifiable file carrying just the new objects — which is how
// a node's work travels home over the existing relay with no shared remote, no
// push credentials, and no new infrastructure.
'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAPTURE_REF_PREFIX = 'refs/converge-agent/capture';
// A capture must never become the slow thing that causes the timeout it exists
// to survive. Every git call here is bounded and the whole capture is bounded.
const GIT_TIMEOUT_MS = 20000;
// Bundles ride the relay as base64 inside a JSON frame. 8 MiB of raw objects is
// far past any plausible source edit (the 12-file case above is single-digit
// KiB) and still safely inside the frame budget. Past it we keep the commit and
// the metadata and drop only the bytes — a capture that reports honestly beats
// a capture that kills the socket.
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

function git(cwd, args, { timeout = GIT_TIMEOUT_MS, env, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer,
      // A commit object needs an identity. On a fleet node there may be no
      // user.name/user.email configured at all, and `commit-tree` then fails
      // with "empty ident name" — which would make capture silently useless on
      // exactly the unattended machines it matters most for. Supply one; the
      // real authorship lives in the mission id in the message.
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'converge capture',
        GIT_AUTHOR_EMAIL: 'converge-capture@localhost',
        GIT_COMMITTER_NAME: 'converge capture',
        GIT_COMMITTER_EMAIL: 'converge-capture@localhost',
        // Never let a capture stop to ask a human anything.
        GIT_TERMINAL_PROMPT: '0',
        ...(env || {}),
      },
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || ''),
        killed: !!(err && err.killed),
      });
    });
  });
}

// Buffer-returning variant — a bundle is binary and must not go through a utf8
// decode on the way to base64.
function gitBuf(cwd, args, { timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], {
      timeout, maxBuffer: MAX_BUNDLE_BYTES * 2, encoding: 'buffer',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        buf: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
        err: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || ''),
      });
    });
  });
}

// Is `dir` inside a git work tree, and where is its root? Returns { ok, root }.
// A non-repo is a completely normal answer (a machine whose workdir is a plain
// directory) — never an error to escalate.
async function repoRoot(dir) {
  const r = await git(dir, ['rev-parse', '--show-toplevel']);
  if (r.code !== 0) return { ok: false, root: '', reason: 'not a git repository' };
  const root = r.out.trim();
  return root ? { ok: true, root } : { ok: false, root: '', reason: 'no work tree' };
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch { /* already gone */ } }

// Capture everything currently in the work tree as one commit on a private ref.
//
// Returns, always resolving (never throws — a capture is a safety net and must
// not itself become a failure mode):
//   { ok, empty, ref, commit, parent, branch, root, files[], insertions,
//     deletions, bundle | null, reason }
//
// `empty: true` with `ok: true` means the tree matched HEAD — genuinely nothing
// uncommitted to preserve. That is a success, not a failure: it is the honest
// answer for a node that reported cleanly after committing its own work.
async function capture(dir, opts = {}) {
  const label = String(opts.label || 'capture');
  const missionId = String(opts.missionId || '');
  const id = String(opts.id || crypto.randomBytes(6).toString('hex'));
  const ref = String(opts.ref || `${CAPTURE_REF_PREFIX}/${id}`);
  const wantBundle = opts.bundle !== false;
  const maxBundleBytes = Number(opts.maxBundleBytes) || MAX_BUNDLE_BYTES;

  const rr = await repoRoot(dir);
  if (!rr.ok) return { ok: false, empty: false, reason: rr.reason, root: '', ref: null, commit: null, files: [], bundle: null };
  const root = rr.root;

  // HEAD may not exist yet (a fresh `git init` with no commits). That is still
  // worth capturing — a root commit with no parent — so handle it rather than
  // bailing, otherwise the very first mission on a new repo is unprotected.
  const headR = await git(root, ['rev-parse', 'HEAD']);
  const parent = headR.code === 0 ? headR.out.trim() : '';
  const branchR = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchR.code === 0 ? branchR.out.trim() : '';

  // The throwaway index. Seeded from HEAD so `add -A` computes additions,
  // modifications AND deletions relative to the committed state; an unseeded
  // index would silently record every deletion as "file never existed".
  const idxPath = path.join(os.tmpdir(), `converge-capture-${process.pid}-${id}.idx`);
  const env = { GIT_INDEX_FILE: idxPath };
  try {
    if (parent) {
      const rt = await git(root, ['read-tree', 'HEAD'], { env });
      if (rt.code !== 0) return { ok: false, empty: false, reason: `read-tree failed: ${rt.err.trim() || rt.code}`, root, ref: null, commit: null, files: [], bundle: null };
    }
    // -A from the repo root: every tracked change plus every untracked file
    // that .gitignore does not exclude. The untracked half is load-bearing —
    // in the case this module was written for, 3 of the files a mission
    // created (dragons.js, flight.js, tame.js) were untracked, so a
    // tracked-only capture would have preserved 9 of 12 files and reported
    // success.
    const add = await git(root, ['add', '-A', '--', '.'], { env, timeout: 60000 });
    if (add.code !== 0) return { ok: false, empty: false, reason: `add failed: ${add.err.trim() || add.code}`, root, ref: null, commit: null, files: [], bundle: null };

    const wt = await git(root, ['write-tree'], { env });
    if (wt.code !== 0) return { ok: false, empty: false, reason: `write-tree failed: ${wt.err.trim() || wt.code}`, root, ref: null, commit: null, files: [], bundle: null };
    const tree = wt.out.trim();

    // Nothing to preserve? Say so plainly instead of manufacturing an empty
    // commit that later reads as "work was captured".
    if (parent) {
      const headTree = await git(root, ['rev-parse', 'HEAD^{tree}']);
      if (headTree.code === 0 && headTree.out.trim() === tree) {
        return { ok: true, empty: true, reason: 'work tree matches HEAD — nothing uncommitted', root, branch, parent, ref: null, commit: null, tree, files: [], insertions: 0, deletions: 0, bundle: null };
      }
    }

    const msg = [
      `converge capture: ${label}`,
      '',
      // The message is the audit trail: it must say what this commit IS, so
      // nobody five days later mistakes a safety capture for intended history.
      'Uncommitted work captured automatically by the converge harness so it could',
      'not be lost to a deadline kill. HEAD, the index and the working tree were',
      'NOT modified to produce this commit.',
      ...(missionId ? ['', `mission: ${missionId}`] : []),
      ...(branch ? [`branch:  ${branch}`] : []),
    ].join('\n');

    const args = ['commit-tree', tree, '-m', msg];
    if (parent) args.push('-p', parent);
    const ct = await git(root, args, { env });
    if (ct.code !== 0) return { ok: false, empty: false, reason: `commit-tree failed: ${ct.err.trim() || ct.code}`, root, ref: null, commit: null, files: [], bundle: null };
    const commit = ct.out.trim();

    const ur = await git(root, ['update-ref', ref, commit]);
    if (ur.code !== 0) return { ok: false, empty: false, reason: `update-ref failed: ${ur.err.trim() || ur.code}`, root, ref: null, commit, files: [], bundle: null };

    // Diffstat straight off the commit objects — no index involved, so this is
    // exactly what the capture contains and not what the tree happens to look
    // like by the time somebody reads it.
    let files = [], insertions = 0, deletions = 0;
    const numstat = parent
      ? await git(root, ['diff', '--numstat', parent, commit])
      : await git(root, ['show', '--numstat', '--format=', commit]);
    if (numstat.code === 0) {
      for (const line of numstat.out.split('\n')) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m) continue;
        const add2 = m[1] === '-' ? 0 : parseInt(m[1], 10);
        const del2 = m[2] === '-' ? 0 : parseInt(m[2], 10);
        insertions += add2; deletions += del2;
        // Cap the path list, but say so — a truncated file list that reads as
        // complete is the same class of lie this whole module exists to stop.
        if (files.length < 200) files.push({ path: m[3], insertions: add2, deletions: del2, binary: m[1] === '-' });
      }
    }
    const filesTotal = numstat.code === 0 ? numstat.out.split('\n').filter((l) => /^(\d+|-)\t/.test(l)).length : files.length;

    let bundle = null;
    if (wantBundle) bundle = await bundleFor(root, ref, parent, { maxBundleBytes });

    return {
      ok: true, empty: false, root, branch, ref, commit, tree, parent,
      files, filesTotal, filesTruncated: filesTotal > files.length,
      insertions, deletions, bundle, capturedAt: new Date().toISOString(),
    };
  } finally {
    safeUnlink(idxPath);
  }
}

// Export `ref` as an incremental bundle excluding `parent`'s history, base64'd
// for transport. Returns null when it cannot be produced or would be too big —
// the caller still has the commit sha and the ref, which is enough to fetch it
// later by other means.
async function bundleFor(root, ref, parent, { maxBundleBytes = MAX_BUNDLE_BYTES } = {}) {
  // `--not <parent>` makes this a THIN bundle: only the objects the receiver
  // doesn't already have, with `parent` recorded as a prerequisite. For a fleet
  // whose nodes share an origin the prerequisite is always already present on
  // the integrating side, so a 12-file edit travels as a few KiB instead of the
  // entire repository history.
  const args = parent
    ? ['bundle', 'create', '-', ref, '--not', parent]
    : ['bundle', 'create', '-', ref];
  const r = await gitBuf(root, args, { timeout: 60000 });
  if (r.code !== 0 || !r.buf.length) return null;
  if (r.buf.length > maxBundleBytes) {
    return { omitted: true, bytes: r.buf.length, limit: maxBundleBytes, reason: `bundle is ${r.buf.length} bytes, over the ${maxBundleBytes}-byte transport limit — commit ${ref} is still on the node` };
  }
  return {
    base64: r.buf.toString('base64'),
    bytes: r.buf.length,
    sha256: 'sha256:' + crypto.createHash('sha256').update(r.buf).digest('hex'),
    prerequisite: parent || null,
    ref,
  };
}

// Integrating side: write a received bundle to disk and fetch its ref in.
// Returns { ok, localRef, reason, missingPrerequisite }.
//
// `missingPrerequisite` is called out specifically because it is the one failure
// with an obvious operator fix (fetch the base commit first) and it must not be
// buried in a generic git error string.
async function applyBundle(dir, bundleBase64, { localRef, sha256 } = {}) {
  const rr = await repoRoot(dir);
  if (!rr.ok) return { ok: false, reason: rr.reason };
  const buf = Buffer.from(String(bundleBase64 || ''), 'base64');
  if (!buf.length) return { ok: false, reason: 'empty bundle' };
  if (sha256) {
    const got = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
    // A bundle that changed in transit must never be fetched — it would put
    // objects of unknown provenance into the integration repo.
    if (got !== sha256) return { ok: false, reason: `bundle hash mismatch (expected ${sha256}, got ${got})` };
  }
  const file = path.join(os.tmpdir(), `converge-bundle-${process.pid}-${crypto.randomBytes(6).toString('hex')}.bundle`);
  try {
    fs.writeFileSync(file, buf);
    const verify = await git(rr.root, ['bundle', 'verify', file], { timeout: 60000 });
    if (verify.code !== 0) {
      const text = `${verify.err}${verify.out}`;
      const missing = /prerequisite|does not have|Repository lacks/i.test(text);
      return { ok: false, reason: text.trim().split('\n').slice(0, 4).join(' ').slice(0, 400) || 'bundle verify failed', missingPrerequisite: missing };
    }
    const target = localRef || `refs/converge-agent/incoming/${crypto.randomBytes(6).toString('hex')}`;
    // Fetch by the ref the bundle actually names. Assuming 'HEAD' happens to
    // work for bundles built from a branch and fails silently for the private
    // refs/converge-agent/capture/* refs this module creates — so ask.
    const src = await refInBundle(rr.root, file);
    if (!src) return { ok: false, reason: 'bundle names no ref (git bundle list-heads returned nothing)' };
    const fetched = await git(rr.root, ['fetch', '--no-tags', file, `+${src}:${target}`], { timeout: 60000 });
    if (fetched.code !== 0) return { ok: false, reason: (fetched.err || fetched.out).trim().slice(0, 400) || 'fetch from bundle failed' };
    const sha = await git(rr.root, ['rev-parse', target]);
    return { ok: true, localRef: target, commit: sha.code === 0 ? sha.out.trim() : null, bytes: buf.length };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  } finally {
    safeUnlink(file);
  }
}

// Which ref does a bundle carry? `git bundle list-heads` is the only honest
// source — guessing 'HEAD' works by luck and fails silently when it doesn't.
async function refInBundle(root, file) {
  const r = await git(root, ['bundle', 'list-heads', file], { timeout: 30000 });
  if (r.code !== 0) return null;
  const line = r.out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!line) return null;
  const parts = line.split(/\s+/);
  return parts[1] || null;
}

module.exports = {
  capture, bundleFor, applyBundle, repoRoot, refInBundle,
  // Exported so the integration side runs git through the SAME bounded,
  // non-interactive, identity-supplying wrapper the capture side does, instead
  // of growing a fourth private copy of it.
  gitExec: git,
  CAPTURE_REF_PREFIX, MAX_BUNDLE_BYTES,
};
