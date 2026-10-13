import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgetRuns, runGoing } from './local-run.mjs';
import { folderPrefixes, folderExport, folderApply, folderBundle } from './sources.mjs';
import { PORT, DATA, PROJECT_RE, MAX_AGENTS, log, warn, randomHex, GIT_ENV, git, projects, httpError } from './dev-context.mjs';
import { GIT_DIR, REMOTES, GH, PLATFORM_TOKEN, repoUrl, repoPath, createMainRepo, createFork, mintGitToken, installHook } from './git-host.mjs';
import { helperCall } from './local-api.mjs';
import { GUARD, hasGuard, withGuard, detectTests } from './guard.mjs';
import { runFencedAsync } from '../../agents/fenced.mjs';
// The paste-ready MCP lines, the same copy the Worker returns with every agent it creates.
import { connectLines } from '../../worker/connect.mjs';

// The server's Project class (scripts/dev-server.mjs), handed in once it is defined: usePersist({ Project }).
let Project;
function usePersist(c) { ({ Project } = c); }

// ---- persistence: restarts must not cut agents off --------------------------------------------

const STATE_FILE = path.join(DATA, 'platform.json');
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {
      projects: [...projects.values()].map((p) => ({ name: p.name, main: p.main, log: p.log, keys: [...p.keys], forks: [...p.forks], gitTokens: [...p.gitTokens] })),
    };
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(out));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  }, 50);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Bring projects back: same keys, same forks, engines rebuilt from their logs. Every project is known at once, then the
 *  engines boot one after another: the server answers while they do, and a project listed only once its turn came (the
 *  dashboard opened meanwhile showed four of seven and sent you to the picker) now waits for its engine instead. */
async function restore(saved) {
  const back = [];
  for (const sp of saved.projects) {
    if (!fs.existsSync(repoPath(sp.name))) continue;
    const p = new Project(sp.name);
    // Remote URLs may predate the current transport or port: point them all at this server.
    const base = `http://127.0.0.1:${PORT}/git/`;
    const fixAll = (s) => s.replace(/git:\/\/127\.0\.0\.1:\d+\//g, base).replace(/http:\/\/127\.0\.0\.1:\d+\/git\//g, base);
    p.main = { ...sp.main, url: fixAll(sp.main.url) };
    p.keys = new Map(sp.keys);
    p.forks = new Map(sp.forks.map(([a, u]) => [a, fixAll(u)]));
    p.gitTokens = new Map(sp.gitTokens || []);
    p.log = JSON.parse(fixAll(JSON.stringify(sp.log)));
    for (const agent of p.forks.keys()) installHook(`${p.name}--${agent}`);
    projects.set(p.name, p);
    back.push(p);
  }
  for (const p of back) {
    // One project whose engine will not start (its data removed meanwhile, a slow boot) is that project's problem:
    // the others still come back, and its engine is started again on the next request for it.
    try {
      await p.serial(() => p.ensureEngine());
      log('restore', `${p.name}: ${p.log.length} events, ${p.keys.size} keys, ${p.forks.size} forks`);
      guardProject(p).catch((e) => warn('guard', `${p.name}: ${e.message}`));
    } catch (e) { warn('restore', `${p.name}: its engine did not start (${e.message}); tried again on the next request for it`); }
  }
}

/** Every project's checks start with converge's guard (scripts/lib/guard.mjs: each changed file must still parse), then
 *  its own tests when it has any that pass on main as it is (tried here, fenced, in a checkout of main; a suite that
 *  fails or takes over 3 minutes on main is left out and said, since it would hold every change). A test command the
 *  owner set themselves is left as it is. Without any of this a change that broke a file nothing tested landed. */
async function guardProject(p, { owner = false } = {}) {
  const st = await p.serial(() => p.call('GET', '/v1/state'));
  const now = st.project?.test_command || '';
  if (owner || (now && !hasGuard(now))) return;   // the owner's own command
  if (!now) { await configureProject(p, { test_command: GUARD }); log('guard', `${p.name}: every change's files must still parse (converge's guard)`); }
  if (now && now !== GUARD) return;               // the guard and tests already
  const dir = fs.mkdtempSync(path.join(DATA, 'seed', `tests-${p.name}-`));
  try {
    git(DATA, 'clone', '-q', '--shared', repoPath(p.name), path.join(dir, 'main'));
    const tests = detectTests(path.join(dir, 'main'));
    if (!tests) return;
    const t0 = Date.now();
    const r = await runFencedAsync(tests, path.join(dir, 'main'), { timeoutMs: 180_000 });
    if (r.status === 0 && !r.timedOut) {
      await configureProject(p, { test_command: withGuard(tests) });
      log('guard', `${p.name}: its own tests (${tests}) pass on main in ${((Date.now() - t0) / 1000).toFixed(0)}s: every change runs them after the guard`);
    } else warn('guard', `${p.name}: its tests (${tests}) ${r.timedOut ? 'take over 3 minutes' : `fail on main (exit ${r.status})`}: left out, or every change would be held. Set a test command that passes in the project's settings.`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Repos left by projects we no longer know (e.g. from before persistence) would block re-creating them. */
function quarantineOrphans() {
  const known = new Set();
  for (const p of projects.values()) {
    known.add(`${p.name}.git`);
    for (const a of p.forks.keys()) known.add(`${p.name}--${a}.git`);
  }
  // A repo of an unknown project that others still read objects from (deleteProject keeps those) stays where it is:
  // moved, its borrowers' alternates would point at nothing and their history would be gone.
  const orphans = fs.readdirSync(GIT_DIR).filter((f) => f.endsWith('.git') && !known.has(f)
    && !liveBorrowersOutside(path.join(GIT_DIR, f), (b) => b.startsWith(path.resolve(GIT_DIR, f) + path.sep) || b === path.resolve(GIT_DIR, f)).length);
  if (!orphans.length) return;
  const dest = path.join(DATA, 'orphaned-repos', String(Date.now()));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of orphans) fs.renameSync(path.join(GIT_DIR, f), path.join(dest, f));
  warn('git', `moved ${orphans.length} repos of unknown projects to ${dest}`);
}

function getProject(name) {
  const p = projects.get(name);
  if (!p) throw httpError(404, `no project "${name}"; create it with POST /api/projects`);
  return p;
}

/** Partial update: only the fields given change (test_command, test_timeout_s, check_claims, auto_land, tracks, targets, leases, signing). */
async function configureProject(p, body) {
  const cfg = {};
  if (body.test_command !== undefined) {
    if (typeof body.test_command !== 'string') throw httpError(400, 'test_command must be a string ("" turns verification off)');
    cfg.test_command = body.test_command;
  }
  if (body.test_timeout_s !== undefined) cfg.test_timeout_s = Number(body.test_timeout_s) || 900;
  for (const k of ['check_claims', 'auto_land']) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'boolean') throw httpError(400, `${k} must be true or false`);
      cfg[k] = body[k];
    }
  }
  if (body.tracks !== undefined) {
    if (typeof body.tracks !== 'string') throw httpError(400, 'tracks must be a string: "" (one train line), "auto", or path prefixes "backend/,frontend/"');
    cfg.tracks = body.tracks;
  }
  if (body.leases !== undefined) {
    if (!['advisory', 'exclusive'].includes(body.leases)) throw httpError(400, 'leases is advisory or exclusive');
    cfg.leases = body.leases;
  }
  if (body.signing !== undefined) {
    if (!['optional', 'required'].includes(body.signing)) throw httpError(400, 'signing is optional or required');
    cfg.signing = body.signing;
  }
  if (body.targets !== undefined) {
    if (!Array.isArray(body.targets) || body.targets.some((t) => typeof t !== 'string')) throw httpError(400, 'targets must be a list of release branch names');
    cfg.targets = body.targets;
  }
  if (!Object.keys(cfg).length) throw httpError(400, 'nothing to configure: test_command, test_timeout_s, check_claims, auto_land, tracks, targets, leases, signing');
  return p.serial(async () => p.record((await p.call('POST', '/v1/configure', cfg)).events));
}

// What each project is (where its main came from), for the projects page: DATA/project-meta.json.
const META_FILE = path.join(DATA, 'project-meta.json');
const readMeta = () => { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; } };
function setMeta(name, m) { const all = readMeta(); if (m) all[name] = m; else delete all[name]; fs.writeFileSync(META_FILE, JSON.stringify(all)); }
function projectInfo(name) {
  const m = readMeta()[name];
  if (m) return m;
  // Made before this was kept: what can still be told.
  const gh = GH.link(name);
  if (gh) return { kind: 'github', detail: gh.repo };
  const r = REMOTES.get(name);
  if (r) return { kind: 'git', detail: r.url };
  if (name === 'converge-demo') return { kind: 'demo', detail: 'the seeded demo' };
  return { kind: 'unknown', detail: '' };
}
function sourceMeta(source) {
  if (!source) return { kind: 'empty', detail: 'started with a README' };
  if (source.kind === 'folders' || source.kind === 'folder') { const ps = source.kind === 'folders' ? source.paths : [source.path]; return { kind: 'folder', detail: ps.join(', '), paths: ps, ...(source.write_back === false ? { write_back_off: true } : {}) }; }
  if (source.github) return { kind: 'github', detail: source.github };
  return { kind: 'git', detail: String(source.url || '') };
}

/** What lands on a folder project's main is written back into its folder: that is what pointing a project at a folder
 *  means. Only an explicit choice stops it (the folder's "Write results to the folder" switch turned off, or
 *  write_back: false in the create request), recorded as write_back_off. */
const writeBackOn = (meta) => meta?.kind === 'folder' && meta.write_back_off !== true;

/** Sends what landed since the last sync back to a folder project's folder(s): through the Mac helper when the
 *  platform runs in a container, else here. Git folders get the branch "converge" (asked for on a second pass). */
const folderSync = new Map(); // project -> { at, state: syncing|done|failed, report, error }
// One sync of a project at a time: a landing's sync, the catch-up after a run and the dashboard's button could start
// together, and two at once fetch into the same refs/converge/main and record main's commit out of order. A call made
// while one is going waits for it, and calls made meanwhile share that one next sync: it sees all that landed by then.
const syncQueue = new Map(); // project -> { tail, next }
function syncFolder(name) {
  let q = syncQueue.get(name);
  if (!q) syncQueue.set(name, (q = { tail: Promise.resolve(), next: null }));
  if (q.next) return q.next;
  const next = q.tail.catch(() => { /* said by its caller */ }).then(() => { q.next = null; return syncFolderNow(name); });
  q.next = next; q.tail = next;
  return next;
}
async function syncFolderNow(name) {
  const meta = readMeta()[name];
  if (!writeBackOn(meta)) return null;
  const p = getProject(name);
  const gitDir = repoPath(name);
  const branch = p.main.branch || 'main';
  const paths = meta.paths || String(meta.detail || '').split(', ').filter(Boolean);
  // Older folder projects did not keep where main started: their first commit (the import) is the start.
  const from = meta.synced || git(gitDir, 'rev-list', '--max-parents=0', `refs/heads/${branch}`).split('\n').pop();
  const exp = folderExport(gitDir, branch, from, folderPrefixes(paths));
  folderSync.set(name, { at: Date.now(), state: 'syncing' });
  const bundleOf = (prefix) => {
    const tmp = fs.mkdtempSync(path.join(DATA, 'seed', 'out-'));
    const file = path.join(tmp, 'main.bundle');
    let ref = `refs/heads/${branch}`;
    if (prefix) { // a subfolder of a several-folder project: its own tree, as a commit of its own
      const tree = git(gitDir, 'rev-parse', `refs/heads/${branch}:${prefix.slice(0, -1)}`);
      const c = execFileSync('git', ['-c', 'safe.directory=*', '--git-dir', gitDir, 'commit-tree', tree, '-m', `converge: ${name} (${prefix.slice(0, -1)})`], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
      ref = 'refs/converge-export/out';
      git(gitDir, 'update-ref', ref, c);
    }
    git(gitDir, 'bundle', 'create', file, ref);
    if (prefix) git(gitDir, 'update-ref', '-d', ref);
    return { file, ref };
  };
  try {
    let report;
    if (process.env.HOST_AGENTS_URL) {
      let r = await helperCall('/folder/apply', { exp });
      if (r.need_bundle?.length) {
        const bundles = {};
        for (const prefix of r.need_bundle) { const b = bundleOf(prefix); bundles[prefix] = { ref: b.ref, data: fs.readFileSync(b.file).toString('base64') }; fs.rmSync(path.dirname(b.file), { recursive: true, force: true }); }
        const again = await helperCall('/folder/apply', { exp: { ...exp, folders: exp.folders.filter((f) => r.need_bundle.includes(f.prefix)) }, bundles });
        r = { report: [...r.report.filter((x) => !x.git), ...again.report] };
      }
      report = r.report;
    } else report = folderApply(exp, (f) => bundleOf(f.prefix));
    setMeta(name, { ...readMeta()[name], synced: exp.head, synced_at: new Date().toISOString() });
    folderSync.set(name, { at: Date.now(), state: 'done', report });
    const w = report.reduce((n, x) => n + x.written, 0), beside = report.flatMap((x) => x.beside);
    // One line per sync, saying what landed: the owner merges "converge" themselves, and this says what it brings.
    const landed = exp.landed || [];
    const what = landed.length ? `${landed.length} landing(s): ${landed.slice(0, 5).join('; ').slice(0, 240)}${landed.length > 5 ? `; and ${landed.length - 5} more` : ''}` : 'nothing new landed';
    const skipped = report.filter((x) => x.skipped).map((x) => `${x.path} (${x.skipped})`);
    log('folder', `${name}: ${what}; ${w} file(s) written${report.some((x) => x.git) ? ', branch "converge" updated' : ''}${beside.length ? `, ${beside.length} kept beside as .converge (changed in the folder meanwhile)` : ''}${skipped.length ? `, left alone: ${skipped.join(', ')}` : ''}`);
    return folderSync.get(name);
  } catch (e) { folderSync.set(name, { at: Date.now(), state: 'failed', error: String(e.message || e) }); throw e; }
}

/** The folder project's main brought up to its folder(s) as they are now, in place: one commit on main holding the
 *  folder's files, so the project keeps its tasks, their checks (every landing still runs them) and its history.
 *  Deleting and importing again lost all of that. Only between runs; changes made in converge and not yet synced
 *  back are refused here (sync first), since the folder's files would replace them. */
async function refreshFromFolder(name) {
  const meta = readMeta()[name];
  if (meta?.kind !== 'folder') throw httpError(400, 'not a folder project');
  if (runGoing(name)) throw httpError(409, 'a run is going: refresh after it ends');
  const p = getProject(name);
  const gitDir = repoPath(name);
  const branch = p.main.branch || 'main';
  const head = git(gitDir, 'rev-parse', `refs/heads/${branch}`);
  if (writeBackOn(meta) && meta.synced && meta.synced !== head) throw httpError(409, 'main has changes not written back to the folder yet: sync the folder first, then refresh');
  const paths = meta.paths || String(meta.detail || '').split(', ').filter(Boolean);
  const bundle = await folderBundle(paths, path.join(DATA, 'seed'));
  try {
    // The bundle's HEAD (one folder: the folder's own branch, whatever its name), else its main (several folders).
    const heads = git(gitDir, 'bundle', 'list-heads', bundle).split('\n').map((l) => l.split(' ')[1]).filter(Boolean);
    const ref = heads.includes('HEAD') ? 'HEAD' : heads.includes('refs/heads/main') ? 'refs/heads/main' : heads[0];
    git(gitDir, 'fetch', '-q', bundle, `+${ref}:refs/converge/refresh`);
    const tree = git(gitDir, 'rev-parse', 'refs/converge/refresh^{tree}');
    if (tree === git(gitDir, 'rev-parse', `${head}^{tree}`)) return { changed: false, head };
    const base = (/converge-folder-base: ([0-9a-f]{40,64})/.exec(git(gitDir, 'log', '-1', '--format=%B', 'refs/converge/refresh')) || [])[1];
    const msg = `Refreshed from ${paths.join(', ')}${base ? `\n\nconverge-folder-base: ${base}` : ''}`;
    const commit = execFileSync('git', ['-c', 'safe.directory=*', '--git-dir', gitDir, 'commit-tree', tree, '-p', head, '-m', msg], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
    git(gitDir, 'update-ref', `refs/heads/${branch}`, commit, head);   // only if main did not move meanwhile
    setMeta(name, { ...readMeta()[name], synced: commit, synced_at: new Date().toISOString() });
    log('folder', `${name}: main refreshed from the folder (${commit.slice(0, 8)}); tasks and their checks kept`);
    // The engine is told now: it looked for outside moves of main only on a push, at most every 30 s, so the next
    // change was compared with the old main and the folder's edit counted as the agent's ("outside your task").
    await p.serial(async () => p.record((await p.call('POST', '/v1/sweep', { main_moved: true })).events)).catch((e) => warn('folder', `${name}: the engine did not take the refreshed main yet: ${e.message}`));
    return { changed: true, head: commit };
  } finally {
    try { git(gitDir, 'update-ref', '-d', 'refs/converge/refresh'); } catch { /* not made */ }
    fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
  }
}

/**
 * The live borrowers of a bare repo's objects that `inside(dir)` does not claim. git records only the borrower's side
 * (its objects/info/alternates), so the engine (RepoCache::borrow_objects) also lists each borrower's objects directory
 * in the store's objects/info/borrowers. A listed borrower is live while its objects directory exists and its
 * alternates still name this store (RepoCache::live_borrowers): deleting the store would take its history with it.
 */
function liveBorrowersOutside(repo, inside) {
  const store = path.resolve(repo, 'objects');
  const lines = (f) => {
    try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); } catch { return []; }
  };
  return [...new Set(lines(path.join(store, 'info', 'borrowers')).map((b) => path.resolve(b)))].filter((b) =>
    !inside(b) && fs.existsSync(b) &&
    // git reads a relative alternate against the borrower's objects directory
    lines(path.join(b, 'info', 'alternates')).some((a) => path.resolve(b, a) === store));
}

/** Removes a project for good: its engine, main, every fork, its keys, runs, link and remote. */
async function deleteProject(name) {
  const p = getProject(name);
  forgetRuns(name); // refuses while a run is going
  shutdownProject(p);
  projects.delete(name);
  // The project's own repos and engine cache go with it, so their borrowing holds nothing; a repo another project (or
  // a repo kept here for one) still reads through alternates stays, or that history would be gone.
  const own = [repoPath(name), ...[...p.forks.keys()].map((a) => repoPath(`${name}--${a}`)), path.join(DATA, 'engines', name)].map((d) => path.resolve(d));
  const kept = [];
  const inside = (b) => own.some((d) => !kept.includes(d) && (b === d || b.startsWith(d + path.sep)));
  const remove = (repo) => {
    const live = liveBorrowersOutside(repo, inside);
    if (!live.length) return fs.rmSync(repo, { recursive: true, force: true });
    kept.push(path.resolve(repo));
    warn('project', `${name}: kept ${path.basename(repo)}: ${live.length} other repo(s) read its objects through alternates (${live.join(', ')})`);
  };
  // forks first: one kept for a borrower keeps main too when it borrows from main
  for (const a of p.forks.keys()) remove(repoPath(`${name}--${a}`));
  remove(repoPath(name));
  fs.rmSync(path.join(DATA, 'engines', name), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'keys', `${name}.receipt.key`), { force: true });
  REMOTES.set(name, null);
  GH.setLink(name, null);
  setMeta(name, null);
  saveState();
  log('project', `${name} deleted`);
}
function shutdownProject(p) {
  const e = p.engine;
  p.engine = null; // its exit is not a crash to restart from
  try { e?.proc.kill('SIGTERM'); } catch { /* gone */ }
  for (const ws of p.sockets) { try { ws.close(4404, 'project deleted'); } catch { /* gone */ } }
  p.sockets.clear();
}

async function createProject(name, source) {
  if (!PROJECT_RE.test(name)) throw httpError(400, 'invalid project name: 1-64 letters, digits, dots or single dashes, starting and ending with a letter or digit');
  if (projects.has(name)) throw httpError(409, `project "${name}" already exists`);
  // A repository under this name with no project behind it is what a create that died half way left (the server was
  // stopped during the import): it blocked the name for good ("repository already exists", then "no project"). It
  // is moved aside, not deleted, and the create goes ahead.
  if (fs.existsSync(repoPath(name))) {
    const aside = `${repoPath(name)}.orphan-${Date.now()}`;
    fs.renameSync(repoPath(name), aside);
    log('project', `${name}: a repository with no project was in the way; moved to ${path.basename(aside)}`);
  }
  const branch = await createMainRepo(name, source);
  const p = new Project(name);
  p.main = { url: repoUrl(name), branch };
  projects.set(name, p);
  try {
    await p.serial(async () => p.record((await p.call('POST', '/v1/project', { name, main_remote: p.main.url, main_local: repoPath(name), main_token: PLATFORM_TOKEN, main_branch: branch })).events));
  } catch (err) {
    projects.delete(name);
    p.engine?.proc.kill('SIGKILL');
    fs.rmSync(repoPath(name), { recursive: true, force: true });
    throw err;
  }
  const meta0 = sourceMeta(source);
  // A folder project remembers where main started, so only what the agents change goes back to the folder.
  if (meta0.kind === 'folder') { try { meta0.synced = git(repoPath(name), 'rev-parse', `refs/heads/${branch}`); } catch { /* an empty main */ } }
  setMeta(name, { ...meta0, created_at: new Date().toISOString() });
  log('project', `${name} (main: ${p.main.url} ${branch})`);
  return p;
}

const mcpUrl = (req, name) => `http://${req.headers.host}/mcp/${encodeURIComponent(name)}`;

async function createTask(p, req, { title, description, mode, agents, accept, retire }) {
  const checks = Array.isArray(accept) ? accept.filter((a) => typeof a === 'string' && a.trim()).slice(0, 20) : [];
  // Earlier tasks' checks this one deliberately changes: the merge train stops running them once it is in (engine train.cpp).
  const retired = Array.isArray(retire) ? retire.filter((a) => typeof a === 'string' && a.trim()).slice(0, 30) : [];
  // 0 is a task that agents join later (converge run joins one agent at a time).
  const n = parseInt(agents, 10);
  const count = Math.min(MAX_AGENTS, Math.max(0, Number.isFinite(n) ? n : 1));
  const taskId = `t-${randomHex(4)}`;
  return p.serial(async () => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const agent_id = `a-${randomHex(4)}`;
      const { remote } = await createFork(p.name, agent_id, p.name, p.main.branch || 'main');
      p.forks.set(agent_id, remote);
      const token = mintGitToken(p, agent_id);
      const mcp_key = p.addKey(agent_id, 'worker');
      await p.addAgentEvent(agent_id, 'worker');
      out.push({ agent_id, role: 'worker', remote, local: repoPath(`${p.name}--${agent_id}`), token, mcp_url: mcpUrl(req, p.name), mcp_key, connect: connectLines(agent_id, mcpUrl(req, p.name), mcp_key) });
    }
    const res = await p.call('POST', '/v1/task', {
      task_id: taskId,
      title: title || 'Task',
      description: description || '',
      mode: mode === 'compete' ? 'compete' : 'split',
      accept: checks,
      ...(retired.length ? { retire: retired } : {}),
      agents: out.map((a) => ({ agent_id: a.agent_id, fork_remote: a.remote, fork_local: a.local, fork_token: PLATFORM_TOKEN })),
    });
    p.record(res.events);
    return { task_id: taskId, main_branch: p.main.branch, agents: out };
  });
}

/**
 * Add one worker to an existing task: its own fork, key and identity (no borrowing).
 * With `from`, it takes over a stalled agent (aios orchestrator "recover"): the new fork starts from the
 * old agent's fork, the old agent's key is revoked, and its open change is superseded.
 */
/** The owner retires checks of earlier tasks for this task: the merge train stops running them once it lands (they test
 *  what this task deliberately changes). */
async function retireChecks(p, taskId, retire) {
  const checks = Array.isArray(retire) ? retire.filter((a) => typeof a === 'string' && a.trim()).slice(0, 30) : [];
  if (!checks.length) throw Object.assign(new Error('no checks to retire'), { status: 400 });
  return p.serial(async () => {
    const res = await p.call('POST', '/v1/task', { task_id: taskId, join: true, retire: checks, agents: [] });
    p.record(res.events);
    return { task_id: taskId, retired: checks.length };
  });
}

async function joinTask(p, req, taskId, from = '') {
  if (from && !p.forks.has(from)) throw httpError(404, `no worker ${from} in ${p.name}`);
  return p.serial(async () => {
    const agent_id = `a-${randomHex(4)}`;
    const { remote, merge } = await createFork(p.name, agent_id, from ? `${p.name}--${from}` : p.name, p.main.branch || 'main');
    p.forks.set(agent_id, remote);
    const token = mintGitToken(p, agent_id);
    const mcp_key = p.addKey(agent_id, 'worker');
    await p.addAgentEvent(agent_id, 'worker');
    let res;
    try {
      res = await p.call('POST', '/v1/task', { task_id: taskId, join: true, ...(from ? { takeover_of: from } : {}), agents: [{ agent_id, fork_remote: remote, fork_local: repoPath(`${p.name}--${agent_id}`), fork_token: PLATFORM_TOKEN }] });
    } catch (err) {
      p.forks.delete(agent_id);
      throw err.status === 404 ? httpError(404, `no task ${taskId} in ${p.name}`) : err;
    }
    p.record(res.events);
    if (from) {
      for (const [hash, who] of p.keys) if (who.agent_id === from) p.keys.delete(hash); // revoked: a zombie cannot come back
      for (const [hash, a] of p.gitTokens) if (a === from) p.gitTokens.delete(hash); // and cannot push either
      saveState();
      log('recover', `${p.name}: ${agent_id} took over from ${from}`);
      // Its fork starts at the predecessor's commits: no push will ever announce them (pushing the same commit changes no
      // ref, so the hook never runs), and the successor's hand-in waited on a change the platform never saw. Said here.
      try {
        const branch = p.main.branch || 'main';
        const head = git(repoPath(`${p.name}--${agent_id}`), 'rev-parse', `refs/heads/${branch}`);
        const main = git(repoPath(p.name), 'rev-parse', `refs/heads/${branch}`);
        if (head && head !== main) p.record((await p.call('POST', '/v1/push', { agent: agent_id, ref: `refs/heads/${branch}`, commit: head })).events);
      } catch (e) { log('recover', `${p.name}: ${agent_id}'s inherited commits not announced: ${e.message}`); }
    }
    return { task_id: taskId, main_branch: p.main.branch, ...(from ? { took_over_from: from, main_merge: merge || 'merged' } : {}), agent: { agent_id, role: 'worker', remote, local: repoPath(`${p.name}--${agent_id}`), main_remote: p.main.url, main_local: repoPath(p.name), token, mcp_url: mcpUrl(req, p.name), mcp_key, connect: connectLines(agent_id, mcpUrl(req, p.name), mcp_key) } };
  });
}

async function addReviewer(p, req) {
  return p.serial(async () => {
    const agent_id = `a-${randomHex(4)}`;
    const mcp_key = p.addKey(agent_id, 'reviewer');
    await p.addAgentEvent(agent_id, 'reviewer');
    const token = mintGitToken(p, agent_id); // read-only: main and every fork, for checking claims
    return { agent_id, role: 'reviewer', main_remote: p.main.url, main_local: repoPath(p.name), token, mcp_url: mcpUrl(req, p.name), mcp_key, connect: connectLines(agent_id, mcpUrl(req, p.name), mcp_key) };
  });
}

export {
  usePersist, saveState, loadState, restore, quarantineOrphans, getProject, configureProject, readMeta, setMeta, projectInfo, sourceMeta,
  writeBackOn, folderSync, syncFolder, refreshFromFolder, guardProject, deleteProject, shutdownProject, createProject, mcpUrl, createTask, retireChecks, joinTask, addReviewer,
};
