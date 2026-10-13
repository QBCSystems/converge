import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { initRuns } from './local-run.mjs';
import { importSource, remotes as remoteStore } from './sources.mjs';
import { githubLocal } from './github-local.mjs';
import { PORT, DATA, HOOK_KEY, log, warn, randomHex, sha256, git, gitAsync, projects, httpError, send, safeEqual } from './dev-context.mjs';
import { saveState } from './persist.mjs';

// ---- git host (stands in for Artifacts) ---------------------------------------------------------

const GIT_DIR = path.join(DATA, 'git');
const REMOTES = remoteStore(DATA);
const GH = githubLocal(DATA); // a GitHub App of the owner's own: scripts/lib/github-local.mjs // each project's way back (url, token): scripts/lib/sources.mjs
initRuns(DATA);
// The platform's own git credential (the engine uses it for every repo); agents get per-fork tokens.
const PLATFORM_TOKEN = `pt_${crypto.randomBytes(20).toString('hex')}`;
const repoUrl = (name) => `http://127.0.0.1:${PORT}/git/${name}.git`;
const withToken = (url, token) => (token ? url.replace(/^(https?:\/\/)/, `$1x:${encodeURIComponent(token)}@`) : url);
const repoPath = (name) => path.join(GIT_DIR, `${name}.git`);

async function startGitHost({ fresh }) {
  if (fresh) fs.rmSync(GIT_DIR, { recursive: true, force: true });
  fs.mkdirSync(GIT_DIR, { recursive: true });
  log('git', `serving repositories at http://127.0.0.1:${PORT}/git/ (token-authenticated)`);
}

/**
 * Smart-HTTP git, like Artifacts: git's own http-backend behind a token check. An agent may read
 * main and its own fork and push only to its fork; the platform token (the engine's) may do anything.
 * The fork's post-receive hook still reports pushes.
 */
function serveGit(req, res, repoFile, rest, url) {
  const repo = repoFile.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || !fs.existsSync(repoPath(repo))) return send(res, 404, { error: 'no such repository' });
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  const token = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
  let who = null;
  if (token && safeEqual(token, PLATFORM_TOKEN)) who = { platform: true, id: 'converge' };
  else if (token) {
    for (const p of projects.values()) {
      const agent = p.gitTokens.get(sha256(token));
      if (agent) who = { project: p.name, agent, id: agent };
    }
  }
  if (!who) return send(res, 401, { error: 'git token required (see git_credentials)' }, { 'WWW-Authenticate': 'Basic realm="converge"' });
  const push = rest.startsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
  const own = who.platform || repo === `${who.project}--${who.agent}`;
  // Reviewers read everything in their project (main and every fork) and push nothing.
  const reviewer = !who.platform && [...projects.get(who.project).keys.values()].some((k) => k.agent_id === who.agent && k.role === 'reviewer');
  const readable = own || repo === who.project || (reviewer && repo.startsWith(`${who.project}--`));
  if (!readable || (push && !own)) return send(res, 403, { error: push ? 'you can only push to your own fork' : 'not your repository' });

  const env = {
    PATH: process.env.PATH,
    GIT_PROJECT_ROOT: GIT_DIR,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${repoFile}${rest}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers['content-type'] || '',
    HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '',
    GIT_PROTOCOL: req.headers['git-protocol'] || '',
    REMOTE_USER: who.id,
    REMOTE_ADDR: '127.0.0.1',
    ...(push ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.receivepack', GIT_CONFIG_VALUE_0: 'true' } : {}),
  };
  const cgi = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let headersDone = false;
  cgi.stdout.on('data', (chunk) => {
    if (headersDone) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    let end = head.indexOf('\r\n\r\n');
    let sep = 4;
    if (end < 0) { end = head.indexOf('\n\n'); sep = 2; }
    if (end < 0) return;
    const headers = {};
    let status = 200;
    for (const line of head.subarray(0, end).toString().split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200;
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    headersDone = true;
    const body = head.subarray(end + sep);
    if (body.length) res.write(body);
  });
  cgi.stderr.on('data', (d) => warn('git', String(d).trim()));
  cgi.on('close', () => (headersDone ? res.end() : send(res, 502, { error: 'git http-backend failed' })));
  return undefined;
}

/** Create `<project>` (empty `main`, or imported). Returns its default branch. */
async function createMainRepo(project, source) {
  const dest = repoPath(project);
  if (fs.existsSync(dest)) throw httpError(409, `repository ${project} already exists`);
  if (source) {
    // A folder on this machine, or any git server (with a token or ssh keys): scripts/lib/sources.mjs.
    const { remote } = await importSource(dest, source, path.join(DATA, 'seed'));
    if (remote) REMOTES.set(project, remote);
    // An import can leave every object loose (converge itself: 262 MB in 2035 files). One pack makes it quick to serve
    // over HTTP, but finding the deltas takes about a minute for a repository that size and nothing on this machine
    // needs it (agents and the engine read the store as it is): it is packed behind the import, and the loose
    // objects are left where they are (repack -a, no -d), so nothing reading the store meanwhile can miss an object
    // and nothing has to wait.
    gitAsync(dest, 'repack', '-aq').catch((e) => warn('git', `${project}: could not pack the import (it works unpacked): ${String(e.stderr || e.message || e).trim().split('\n').pop()}`));
  } else {
    const seed = path.join(DATA, 'seed', project);
    fs.rmSync(seed, { recursive: true, force: true });
    git(DATA, 'init', '-q', '-b', 'main', seed);
    fs.writeFileSync(path.join(seed, 'README.md'), `# ${project}\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'initial commit');
    git(GIT_DIR, 'clone', '--bare', '--quiet', seed, dest);
  }
  git(dest, 'config', 'receive.denyNonFastForwards', 'false');
  return git(dest, 'symbolic-ref', '--short', 'HEAD') || 'main';
}

/** Resolves once `project`'s store is not being repacked (at once when it is not). */
const packings = new Map();
const whenPacked = (project) => packings.get(project) || Promise.resolve();

/** Fork `from` (main by default) into `<project>--<agent>` with a hook that reports pushes (the Artifacts event). A
 *  local clone: git (aios-git included) hard-links the object store, so a fork costs nothing whatever main's size. Not
 *  --shared, so the fork has no alternates pointing back at main. A takeover's merge (mergeMainInto) does write one, on
 *  disk, reading main's objects in place. Asynchronous: the platform
 *  answers everyone else while a fork is made (a synchronous copy of converge itself froze it for minutes). */
async function createFork(project, agentId, from = project, branch = 'main') {
  const name = `${project}--${agentId}`;
  const dest = repoPath(name);
  await whenPacked(project);
  await gitAsync(GIT_DIR, 'clone', '--bare', '--quiet', repoPath(from), dest);
  // A takeover's fork starts from the previous agent's work, which began on an older main: the current main is merged
  // in here, where both sit on this disk, before the hook is installed (nothing is reported as a push). The agent then
  // clones it ready. Merged in its checkout instead, it had to push main's whole history back over HTTP (~270 MB for
  // converge itself, every agent at once), which outlasted the agent's patience and went nowhere.
  const merge = from !== project ? await mergeMainInto(project, dest, branch) : '';
  installHook(name);
  return { remote: repoUrl(name), merge };
}

/** Merges `project`'s main into the bare repository `dest` (its `branch`), on disk. -> '' when merged or already
 *  current, else what stopped it in plain words (a conflict leaves the fork as it was, for the agent to resolve). */
async function mergeMainInto(project, dest, branch) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-merge-'));
  const work = path.join(tmp, 'w');
  const why = (e) => String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || 'git gave no reason';
  // Main's objects are read where they are (objects/info/alternates), never copied: the fork reads them from main from
  // now on, and the merge writes only its own commit. Copying them took 25 s for converge itself, inside the project's
  // queue; this takes about 6.
  const mainObjects = path.join(repoPath(project), 'objects');
  const alternate = (objectsDir, ...dirs) => {
    const file = path.join(objectsDir, 'info', 'alternates');
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    const add = dirs.filter((d) => !have.includes(d));
    if (add.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, [...have, ...add].join('\n') + '\n'); }
  };
  try {
    alternate(path.join(dest, 'objects'), mainObjects);
    await gitAsync(tmp, 'clone', '-q', '--shared', '-b', branch, dest, work);
    alternate(path.join(work, '.git', 'objects'), path.join(dest, 'objects'), mainObjects);
    const mainHead = await gitAsync(repoPath(project), 'rev-parse', `refs/heads/${branch}`);
    try { await gitAsync(work, '-c', 'user.name=converge', '-c', 'user.email=converge@converge.local', 'merge', '--no-edit', '-q', mainHead); }
    catch (e) { return `its saved work conflicts with the current ${branch} (${why(e)})`; }
    await gitAsync(dest, 'fetch', '-q', work, `+HEAD:refs/heads/${branch}`);
    return '';
  } catch (e) {
    return `the current ${branch} could not be merged into its saved work (${why(e)})`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A fresh git token for an agent's fork (only the hash is kept). */
function mintGitToken(p, agentId) {
  const token = `gt_${randomHex(20)}`;
  for (const [h, a] of p.gitTokens) if (a === agentId) p.gitTokens.delete(h);
  p.gitTokens.set(sha256(token), agentId);
  saveState();
  return token;
}

function installHook(name) {
  // Before a push is let in: with exclusive leases, converge refuses one that changes what its agent has not claimed
  // (files, or units of a file claimed as file#Scope). Only an answer of 200 lets it in.
  fs.writeFileSync(path.join(repoPath(name), 'hooks', 'pre-receive'), `#!/bin/sh
status=0
while read old new ref; do
  case "$new" in 0000000000000000000000000000000000000000) continue;; esac
  out=$(curl -s -m 120 -w '\\n%{http_code}' -X POST -H 'Content-Type: application/json' -H 'X-Hook-Key: ${HOOK_KEY}' \\
    -d "{\\"repo\\":\\"${name}\\",\\"ref\\":\\"$ref\\",\\"commit\\":\\"$new\\"}" http://127.0.0.1:${PORT}/internal/check-push)
  code=$(printf '%s' "$out" | tail -n 1)
  if [ "$code" != 200 ]; then
    printf '%s\\n' "$out" | sed '$d'
    [ "$code" = 403 ] || echo "converge could not check this push (HTTP $code): try again"
    status=1
  fi
done
exit $status
`, { mode: 0o755 });
  const hook = path.join(repoPath(name), 'hooks', 'post-receive');
  fs.writeFileSync(hook, `#!/bin/sh
# Stands in for Artifacts' cf.artifacts.repo.pushed event: tell the platform what was pushed.
while read old new ref; do
  curl -s -m 30 -o /dev/null -X POST -H 'Content-Type: application/json' -H 'X-Hook-Key: ${HOOK_KEY}' \\
    -d "{\\"repo\\":\\"${name}\\",\\"ref\\":\\"$ref\\",\\"commit\\":\\"$new\\"}" http://127.0.0.1:${PORT}/internal/pushed
done
`, { mode: 0o755 });
}

export { GIT_DIR, REMOTES, GH, PLATFORM_TOKEN, repoUrl, withToken, repoPath, startGitHost, serveGit, createMainRepo, createFork, mintGitToken, installHook, whenPacked };
