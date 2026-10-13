#!/usr/bin/env node
// Local converge platform: the same HTTP API, WebSocket stream and MCP endpoint as the Cloudflare
// Worker, backed by local equivalents of its pieces so agents can do real work on one machine:
//
//   Worker + Durable Object  -> this process (one serialized event log per project, version checks,
//                               409 -> reset replay, exactly like worker/project.ts)
//   Container                -> one converge-engine process per project
//   Artifacts repos + tokens -> bare repos served by `git http-backend` (token-checked: own fork push, main read)
//   Artifacts push events    -> a post-receive hook in every fork that reports the push here
//
// Usage: npm run dev   (env: CONVERGE_PORT, CONVERGE_HOST, CONVERGE_DATA, ADMIN_KEY, VIEW_KEY,
//                       CONVERGE_LEASE_MS, CONVERGE_DEMO=1, CONVERGE_RESET=1)
// State (projects, keys, event logs, repos) persists in CONVERGE_DATA (default ~/.converge/local) across restarts;
// CONVERGE_RESET=1 wipes it. What lands on a folder project's main is written back into its folder, unless that is switched off for it.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { freePort, waitFor } from './lib/dev-helpers.mjs';
import { startLocalRun, listRuns, stopLocalRun, runOptions, controlRun, continueLocalRun, agentLog, haltAgent, runPlan, onRunEnded } from './lib/local-run.mjs';
import { previewToken, servePreview } from './lib/preview.mjs';
import { checkRemote, pushToRemote } from './lib/sources.mjs';
import { engineBin, kernelHint, kernelName, kernelOnPath } from '../agents/common.mjs';
kernelOnPath();   // git is aios-git, the shell aios-sh, for everything this process starts
// Shared state and helpers (one instance each), and the sections that live beside this file:
import { assertSafeBind, assertLocalRequest, ROOT, PORT, HOST, DEFAULT_DATA, DATA_FROM, DATA, ADMIN_KEY, ENGINE_KEY, HOOK_KEY, log, warn, randomHex, sha256, gitAsync, git, projects, httpError, send, readBody, readJson, bearer, safeEqual, requireAdmin, requireView, decodeName } from './lib/dev-context.mjs';
import { REMOTES, GH, PLATFORM_TOKEN, withToken, repoPath, startGitHost, serveGit, mintGitToken, whenPacked } from './lib/git-host.mjs';
import { saveHandover, loadHandover, deleteHandovers } from './lib/handover-store.mjs';
import { usePersist, saveState, loadState, restore, quarantineOrphans, getProject, configureProject, readMeta, setMeta, projectInfo, writeBackOn, folderSync, syncFolder, refreshFromFolder, guardProject, deleteProject, createProject, createTask, retireChecks, joinTask, addReviewer } from './lib/persist.mjs';
import { NEXT, cloudCreds, isLocalAdmin, cloudflareRoutes, localRoutes } from './lib/local-api.mjs';
import { seed } from './lib/demo-seed.mjs';
import { getAsql } from './lib/asql.mjs';
import { parseTiming, recordTiming, readTimeline, deleteTimeline } from './lib/timeline.mjs';
import { rememberRefused, recall, deletePlanMemory } from './lib/plan-memory.mjs';
import { refreshIndex, lookup, deleteIndex, indexBuilt } from './lib/code-index.mjs';
import { ensureAsql } from './lib/asql-server.mjs';
import { track, reapOrphans } from './lib/dev-children.mjs';
import { encryptStored } from './lib/provider-store.mjs';
import { authRoutes, principalFor } from './lib/auth/http.mjs';
import { applyMigrations } from './lib/auth/schema.mjs';

// The engine, always built on the kernel: $CONVERGE_ENGINE_BIN, else this machine's kernel/<os>-<arch>/bin (prebuilt).
const ENGINE_BIN = engineBin('converge-engine', ROOT) || path.join(ROOT, 'kernel', kernelName(), 'bin', 'converge-engine');
const UI_DIR = path.join(ROOT, 'ui');
const LEASE_MS = Number(process.env.CONVERGE_LEASE_MS || 20 * 60 * 1000); // claim lease (aios fleet heartbeat rule)
const SWEEP_MS = Math.min(30_000, Math.max(1000, LEASE_MS / 4));

// ---- projects (stand in for Durable Object + Container) -----------------------------------------


/** An engine starts from its events every time (replayed into a clean data dir), but its git cache (<data>/.git) is
 *  kept: without it the first push after every restart fetched all of main again (a quarter of a gigabyte for
 *  converge itself, close to a minute) while every request to that project waited. Kept: the objects (content
 *  addressed, so never wrong) and the remote-tracking refs (only what the fetch tells the server it already has).
 *  Rebuilt by the replay like everything else: local branches and notes (HEAD only names the branch). */
function resetEngineData(dataDir) {
  const gitDir = path.join(dataDir, '.git');
  const keep = fs.existsSync(path.join(gitDir, 'objects'));
  if (keep) {
    for (const e of fs.readdirSync(dataDir)) if (e !== '.git') fs.rmSync(path.join(dataDir, e), { recursive: true, force: true });
    for (const e of fs.readdirSync(gitDir)) if (!['objects', 'refs', 'config', 'packed-refs', 'HEAD'].includes(e)) fs.rmSync(path.join(gitDir, e), { recursive: true, force: true });
    for (const e of fs.readdirSync(path.join(gitDir, 'refs'), { withFileTypes: true })) if (e.name !== 'remotes') fs.rmSync(path.join(gitDir, 'refs', e.name), { recursive: true, force: true });
    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      const lines = fs.readFileSync(packed, 'utf8').split('\n');
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#') || !l) { if (l) out.push(l); continue; }
        if (l.startsWith('^')) continue;   // a peeled line: kept with its ref below
        if (/^[0-9a-f]{40} refs\/remotes\//.test(l)) { out.push(l); if (lines[i + 1]?.startsWith('^')) out.push(lines[i + 1]); }
      }
      fs.writeFileSync(packed, out.length ? out.join('\n') + '\n' : '');
    }
  } else {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });
}


/** Converge's main, pushed to the linked GitHub repository's branch (link.base): a plain push, never forced, so work the
 *  repository has that converge does not is never overwritten: that push is refused, and said (bring it in first). */
const repoSync = new Map(); // project -> { at, state: syncing|done|failed, head, error }
async function writeBackRepo(name) {
  const link = GH.link(name);
  if (!link?.write_back) return null;
  const p = getProject(name);
  const head = git(repoPath(name), 'rev-parse', p.main.branch || 'main');
  repoSync.set(name, { at: Date.now(), state: 'syncing', head });
  try {
    const token = await GH.tokenFor(link.installation_id, link.repo);
    await pushToRemote(repoPath(name), p.main.branch || 'main', { url: `https://github.com/${link.repo}.git`, token }, { branch: link.base || 'main' });
    repoSync.set(name, { at: Date.now(), state: 'done', head });
    log('github', `${name}: ${link.repo} ${link.base || 'main'} is now converge's main (${head.slice(0, 8)})`);
  } catch (e) {
    const why = /rejected|non-fast-forward|fetch first/i.test(e.message) ? `${link.repo} ${link.base || 'main'} has commits converge's main does not: bring them into converge first (nothing was overwritten)` : e.message;
    repoSync.set(name, { at: Date.now(), state: 'failed', head, error: why });
    throw httpError(409, why);
  }
  return repoSync.get(name);
}

class Project {
  constructor(name) {
    this.name = name;
    this.log = []; // the Durable Object's events table
    this.keys = new Map(); // sha256(mcp key) -> { agent_id, role }
    this.forks = new Map(); // agent_id -> fork url
    this.gitTokens = new Map(); // sha256(git token) -> agent_id
    this.sockets = new Set();
    this.queue = Promise.resolve();
    this.main = { url: '', branch: 'main' };
    this.engine = null;
  }

  get version() {
    return this.log.length ? this.log.at(-1).seq : 0;
  }

  /** Serialize everything that talks to the engine, like the DO's input queue. */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async startEngine() {
    const port = await freePort();
    const dataDir = path.join(DATA, 'engines', this.name);
    resetEngineData(dataDir);
    // The landing-receipt signing key outlives the engine's (rebuilt) data dir: receipts must stay
    // verifiable, and the chain unbroken, across restarts.
    const keyDir = path.join(DATA, 'keys');
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    // --parent: the engine stops once this server is gone, even when the server is killed outright and its own
    // shutdown (shutdownSync, stopAndExit) never runs; one left behind would keep a data dir the next server wipes.
    const proc = spawn(ENGINE_BIN, ['--port', String(port), '--data', dataDir, '--loopback', '--receipt-key', path.join(keyDir, `${this.name}.receipt.key`),
      '--parent', String(process.pid)], {
      // The repo's node_modules, read-only inside the verification jail, so project checks can run tsc.
      env: { ...process.env, ENGINE_SHARED_KEY: ENGINE_KEY, CONVERGE_VERIFY_RO: [path.join(ROOT, 'node_modules'), process.env.CONVERGE_VERIFY_RO].filter(Boolean).join(':') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    ENGINES.add(proc);
    track(proc, `engine:${this.name}`);
    // A train's verdict and time (train.cpp) and each check's timing (verify.cpp) are news, not warnings: logged as
    // [train] / [timing] and kept in ASQL's timeline (lib/timeline.mjs); anything else stays a warning.
    proc.stderr.on('data', (d) => {
      for (const line of String(d).split('\n').map((l) => l.trim()).filter(Boolean)) {
        const row = parseTiming(line);
        if (row) { recordTiming(this.name, row); log(row.step.startsWith('train') ? 'train' : 'timing', `${this.name}: ${line.replace(/^(train|timing) /, '')}`); }
        else warn(`engine:${this.name}`, line);
      }
    });
    proc.on('exit', (code, sig) => {
      ENGINES.delete(proc);
      if (this.engine?.proc !== proc || shuttingDown) return;
      warn(`engine:${this.name}`, `exited (${code ?? sig}); restarting and replaying ${this.log.length} events`);
      this.engine = null;
      this.serial(() => this.ensureEngine()).catch((e) => warn(`engine:${this.name}`, e.message));
    });
    this.engine = { proc, port };
    // An engine boots a kernel and replays its project: under load (several projects restoring at once) that is
    // well past a few seconds.
    try {
      await waitFor(async () => (await this.raw('GET', '/v1/health')).ok, `engine for ${this.name}`, 30_000);
    } catch (e) {
      // Not kept as this project's engine: the next ensureEngine starts a new one instead of talking to this one.
      this.engine = null;
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      throw e;
    }
    this.watchEdges(proc, port + 1);
  }

  // Cells, as on Cloudflare: the engine's ASQL keeps a ready/failed bit per change (the `gates` set), and a
  // bit rising is an edge. Long-poll the engine's side port (port + 1, where reads live off the main loop) and
  // sweep the moment an edge rises, so a change lands as soon as its last check passes instead of on the
  // timer. An engine that answers 404 (an old one, before edges) has none: then the timer alone drives the sweep.
  async watchEdges(proc, sidePort) {
    let seen = 0;
    while (this.engine?.proc === proc && !shuttingDown) {
      try {
        const r = await fetch(`http://127.0.0.1:${sidePort}/v1/edges?seen=${seen}&timeout_ms=30000`, { headers: { 'X-Engine-Key': ENGINE_KEY, 'X-State-Version': String(this.version) } });
        if (r.status === 404) return; // no edges in this engine: no Cells
        if (!r.ok) { await new Promise((ok) => setTimeout(ok, 2000)); continue; }
        const j = await r.json();
        if (j.fired || j.edges < seen) kickSweep();   // a gate rose (a check passed or failed) or the engine restarted: sweep now (the verdicts are logged)
        seen = j.edges;
      } catch {
        if (this.engine?.proc !== proc) return;
        await new Promise((ok) => setTimeout(ok, 2000)); // side port not up yet, or busy: try again
      }
    }
  }

  async ensureEngine() {
    if (this.engine) return;
    await this.startEngine();
    if (this.log.length) await this.replay();
  }

  raw(method, p, body, headers = {}) {
    return fetch(`http://127.0.0.1:${this.engine.port}${p}`, {
      method,
      headers: { 'X-Engine-Key': ENGINE_KEY, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async replay() {
    // `local`: where each repository is on this disk, so the engine reads its objects in place instead of fetching them.
    const forks = [...this.forks].map(([agent_id, url]) => ({ agent_id, url, local: repoPath(`${this.name}--${agent_id}`), token: PLATFORM_TOKEN }));
    const r = await this.raw('POST', '/v1/replay', { reset: true, events: this.log, remotes: { main: { url: this.main.url, local: repoPath(this.name), token: PLATFORM_TOKEN }, forks } });
    if (!r.ok) throw new Error(`engine replay failed: ${r.status} ${await r.text()}`);
  }

  /** A versioned engine call with the DO's 409 -> replay -> retry handshake. */
  async call(method, p, body) {
    await this.ensureEngine();
    const hdr = { 'X-State-Version': String(this.version) };
    let r = await this.raw(method, p, body, hdr);
    if (r.status === 409) {
      await this.replay();
      r = await this.raw(method, p, body, hdr);
    }
    const text = await r.text();
    if (!r.ok) {
      let message = text;
      try { message = JSON.parse(text).error || text; } catch { /* plain text */ }
      throw httpError(r.status === 400 || r.status === 404 ? r.status : 502, message);
    }
    return JSON.parse(text);
  }

  /** Append engine events to our log (renumbered, as the DO does) and fan them out. */
  record(events = []) {
    for (const ev of events) {
      ev.seq = this.version + 1;
      ev.at ||= Date.now();
      this.log.push(ev);
      const msg = JSON.stringify(ev);
      for (const ws of this.sockets) if (ws.readyState === 1) ws.send(msg);
    }
    for (const w of [...(this.waiters ||= new Set())]) {
      if (events.some((e) => (w.change && e.change_id === w.change) || e.agent_id === w.agent)) w.wake();
    }
    if (events.length) saveState();
    // A folder project: what lands goes back into the owner's folder (a moment later, once per burst of landings).
    if (events.some((e) => e.type === 'Landed') && readMeta()[this.name]?.kind === 'folder') {
      clearTimeout(this.folderTimer);
      this.folderTimer = setTimeout(() => syncFolder(this.name).catch((e) => warn('folder', `${this.name}: ${e.message}`)), 2000);
    }
    // A GitHub project whose owner made converge its source: main goes to the repository's branch after each landing.
    if (events.some((e) => e.type === 'Landed') && GH.link(this.name)?.write_back) {
      clearTimeout(this.repoTimer);
      this.repoTimer = setTimeout(() => writeBackRepo(this.name).catch((e) => warn('github', `${this.name}: ${e.message}`)), 2000);
    }
    return events;
  }

  addKey(agent_id, role) {
    const key = `mcp_${randomHex(16)}`;
    this.keys.set(sha256(key), { agent_id, role });
    saveState();
    return key;
  }

  async addAgentEvent(agent_id, role) {
    const ev = { type: 'AgentAdded', agent_id, role, seq: this.version + 1, at: Date.now() };
    this.record([ev]);
    await this.ensureEngine();
    await this.raw('POST', '/v1/replay', { events: [ev] });
  }
}
usePersist({ Project });

// ---- MCP ----------------------------------------------------------------------------------------

// Served here (like the Worker does), not by the engine: credentials never pass through the engine.
const CREDENTIALS_TOOL = {
  name: 'git_credentials',
  description: "Your fork's git remote and a fresh access token (basic auth: any username, the token as password; push_to has it embedded). Call it when git push or fetch is refused for authentication. Minting a new token revokes the previous one.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

async function handleMcp(p, who, body) {
  let msg;
  try { msg = JSON.parse(body); } catch { return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }; }
  if (Array.isArray(msg)) return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batching is not supported' } } };

  if (msg.method === 'tools/call' && msg.params?.name === 'git_credentials') {
    const remote = p.forks.get(who.agent_id) || '';
    const token = remote ? mintGitToken(p, who.agent_id) : '';
    const data = { remote, token, username: 'x', push_to: remote ? `git push ${withToken(remote, token)} HEAD:${p.main.branch}` : '', main_branch: p.main.branch };
    const result = remote ? { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }], ...data } : { isError: true, content: [{ type: 'text', text: 'You have no fork (reviewers do not push).' }] };
    return { status: 200, json: { jsonrpc: '2.0', id: msg.id ?? null, result } };
  }

  let res;
  try {
    res = await p.serial(async () => {
      const r = await p.call('POST', '/v1/mcp', { agent_id: who.agent_id, role: who.role, request: body });
      p.record(r.events);
      if (r.events.some((e) => e.type === 'Submitted')) kickSweep();
      return r;
    });
  } catch (err) {
    return { status: 500, json: { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: `converge engine error: ${err.message}` } } };
  }
  if (!res.reply) return { status: 202 }; // notification: accepted, no body (MCP Streamable HTTP)
  const reply = JSON.parse(res.reply);
  if (msg.method === 'tools/list' && reply.result?.tools && who.role === 'worker') reply.result.tools.push(CREDENTIALS_TOOL);
  return { status: 200, json: reply };
}

// ---- HTTP ---------------------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

/** The dashboard's version: the newest change to its files, so an open page knows when to reload itself. */
let uiVer = { at: 0, v: '' };
function uiVersion() {
  if (Date.now() - uiVer.at < 5000) return uiVer.v;
  let newest = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else newest = Math.max(newest, fs.statSync(f).mtimeMs); } };
  try { walk(path.join(ROOT, 'ui')); } catch { /* none */ }
  uiVer = { at: Date.now(), v: String(Math.floor(newest)) };
  return uiVer.v;
}

async function route(req, res) {
  assertLocalRequest(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  req.principal = await principalFor(req, url);
  const { pathname } = url;
  const method = req.method;

  if (method === 'OPTIONS') {
    return send(res, 204, undefined, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key, X-View-Key, X-MCP-Key, Mcp-Session-Id, Mcp-Protocol-Version' });
  }
  if (method === 'GET' && (pathname === '/health' || pathname === '/v1/health')) return send(res, 200, { ok: true, local: true, projects: [...projects.keys()], ui: uiVersion() });
  // Cloudflare (scripts/lib/local-api.mjs): the deployed Worker's projects, and the account and deploy.
  if ((await cloudflareRoutes(req, res, url)) !== NEXT) return undefined;

  // The app on main, for the dashboard's preview (a token from GET /api/projects/:p/preview, no key in the URL).
  const pv = pathname.match(/^\/preview\/([A-Za-z0-9_-]{20,})(\/.*)?$/);
  if (method === 'GET' && pv) return servePreview(res, pv[1], pv[2] || '/', { repoPath, branchOf: (n) => projects.get(n)?.main?.branch });

  const gm = pathname.match(/^\/git\/([^/]+\.git)(\/.*)?$/);
  if (gm) return serveGit(req, res, gm[1], gm[2] || '/', url);

  // Push notifications from the fork hooks (Artifacts events in production).
  if (method === 'POST' && pathname === '/internal/pushed') {
    if (!safeEqual(String(req.headers['x-hook-key'] || ''), HOOK_KEY)) throw httpError(401, 'Unauthorized');
    const { repo, ref, commit } = await readJson(req);
    const [project, agent] = String(repo).split('--');
    const p = getProject(project);
    if (/^0+$/.test(commit)) return send(res, 200, { ignored: 'ref deleted' });
    const events = await p.serial(async () => p.record((await p.call('POST', '/v1/push', { agent, ref, commit })).events));
    log('push', `${repo} ${ref} ${commit.slice(0, 8)} -> ${events.map((e) => e.type).join(', ')}`);
    return send(res, 200, { events: events.length });
  }

  // The fork hooks' question before a push is let in (pre-receive): does it keep to its agent's claim?
  if (method === 'POST' && pathname === '/internal/check-push') {
    if (!safeEqual(String(req.headers['x-hook-key'] || ''), HOOK_KEY)) throw httpError(401, 'Unauthorized');
    const { repo, ref, commit } = await readJson(req);
    const [project, agent] = String(repo).split('--');
    const p = getProject(project);
    // not serialized behind the project's queue: the engine only reads, and the push it judges is waiting on it
    const r = await p.call('POST', '/v1/check-push', { agent_id: agent, commit });
    if (r.ok) return send(res, 200, 'ok\n');
    log('push', `${repo} ${ref} ${String(commit).slice(0, 8)} refused: ${r.why.join('; ')}`);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end(`converge refused this push:\n${r.why.map((w) => '  ' + w).join('\n')}\nFix that (claim what it changes, or take those changes out; sign it with your key) and push again.\n`);
  }

  if (method === 'GET' && pathname === '/api/projects') {
    const who = req.principal;
    // A signed-in member who may not administer sees the projects it belongs to (requireView lets it open those).
    const names = who && !who.admin
      ? [...projects.keys()].filter((n) => who.user.memberships.some((m) => m.project === n)).sort()
      : (requireAdmin(req), [...projects.keys()].sort());
    return send(res, 200, { projects: names, info: Object.fromEntries(names.map((n) => [n, projectInfo(n)])) });
  }
  if (method === 'POST' && pathname === '/api/projects') {
    requireAdmin(req);
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw httpError(400, 'Missing project name');
    // Where main comes from: { source: { kind: 'folders', paths } | { kind: 'git', url, token?, username? } }, or import_url.
    const source = body.source && typeof body.source === 'object' ? body.source : body.import_url ? { kind: 'git', url: String(body.import_url) } : null;
    const settings = ['test_command', 'check_claims', 'auto_land'].some((k) => body[k] !== undefined);
    if (projects.has(name)) {
      // A second create only applies its settings (the README's `seed` then `project --test-command` order);
      // a different source cannot be applied to an existing main.
      if (source) throw httpError(409, `project "${name}" already exists`);
      const p = projects.get(name);
      if (settings) await configureProject(p, body);
      return send(res, 200, { project: name, existed: true, main_remote: p.main.url, main_branch: p.main.branch, view_url: `/api/projects/${encodeURIComponent(name)}/state`, ...(settings ? { configured: Object.fromEntries(['test_command', 'test_timeout_s', 'check_claims', 'auto_land'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) } : {}) });
    }
    const p = await createProject(name, source);
    if (settings) await configureProject(p, body);
    // The guard and the project's own tests, unless the owner gave a test command (in the background: tests are tried).
    guardProject(p, { owner: body.test_command !== undefined }).catch((e) => warn('guard', `${p.name}: ${e.message}`));
    // Its code index (lib/code-index.mjs), built in the background, ready before most first plans need it.
    refreshIndex(p.name, repoPath(p.name), p.main.branch || 'main').then((r) => log('index', `${p.name}: ${r.files} files indexed in ${(r.ms / 1000).toFixed(1)}s`)).catch(() => { /* ASQL down: built when asked */ });
    return send(res, 201, { project: name, main_remote: p.main.url, main_branch: p.main.branch, view_url: `/api/projects/${encodeURIComponent(name)}/state` });
  }

  // The folder browser, the model picker, keys and GitHub (scripts/lib/local-api.mjs).
  if ((await localRoutes(req, res, url)) !== NEXT) return undefined;

  // Sign-in, session check and sign-out (ASQL accounts).
  if (await authRoutes(req, res, url)) return undefined;

  const pm = pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
  if (pm) {
    const p = getProject(decodeName(pm[1]));
    const sub = pm[2] || '';
    if (method === 'DELETE' && sub === '') {
      requireAdmin(req);
      await deleteProject(p.name);
      await deleteHandovers(p.name).catch(() => { /* ASQL down: rows for a name that no longer exists */ });
      await deleteTimeline(p.name);
      await deletePlanMemory(p.name);
      await deleteIndex(p.name);
      return send(res, 200, { deleted: p.name });
    }
    if (method === 'POST' && sub === '/tasks') {
      requireAdmin(req);
      return send(res, 200, await createTask(p, req, await readJson(req)));
    }
    const retireRoute = method === 'POST' && /^\/tasks\/(t-[0-9a-f]{4,16})\/retire$/.exec(sub);
    if (retireRoute) {
      requireAdmin(req);
      return send(res, 200, await retireChecks(p, retireRoute[1], (await readJson(req)).retire));
    }
    // The files on main with their sizes: the heat map's tiles.
    if (method === 'GET' && sub === '/files') {
      requireView(req, url);
      const out = await gitAsync(repoPath(p.name), 'ls-tree', '-r', '-l', `refs/heads/${p.main.branch || 'main'}`).catch(() => '');
      const files = out.split('\n').filter(Boolean).map((l) => { const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(l); return m ? { path: m[2], size: Number(m[1]) } : null; }).filter(Boolean).slice(0, 5000);
      return send(res, 200, { files });
    }
    // How a run was planned, live while it plans: the planner's and converge's steps, then the tasks in full.
    const planm = sub.match(/^\/runs\/([0-9a-f]{8})\/plan$/);
    if (method === 'GET' && planm) { requireView(req, url); return send(res, 200, runPlan(p.name, planm[1])); }
    const ctlm = sub.match(/^\/runs\/([0-9a-f]{8})\/control$/);
    if (method === 'POST' && ctlm) { requireAdmin(req); return send(res, 200, await controlRun(p.name, ctlm[1], await readJson(req))); }
    // One agent: its log, live (view), and halting it (admin; its run goes on, its task waits for a resume).
    const agm = sub.match(/^\/agents\/(a-[0-9a-f]{4,16})\/(log|halt)$/);
    if (agm && method === 'GET' && agm[2] === 'log') { requireView(req, url); return send(res, 200, await agentLog(p.name, agm[1], Number(url.searchParams.get('after') ?? -1))); }
    if (agm && method === 'POST' && agm[2] === 'halt') { requireAdmin(req); const b = await readJson(req); return send(res, 200, await haltAgent(p.name, agm[1], String(b.task_id || ''))); }
    // A folder project's way back: its status, a sync now, and switching it off or on.
    if (sub === '/folder' && method === 'GET') { requireView(req, url); const m = readMeta()[p.name]; return send(res, 200, m?.kind === 'folder' ? { folder: true, paths: m.paths || String(m.detail).split(', '), write_back: writeBackOn(m), synced: m.synced || '', synced_at: m.synced_at || '', head: git(repoPath(p.name), 'rev-parse', `refs/heads/${p.main.branch || 'main'}`), sync: folderSync.get(p.name) || null } : { folder: false }); }
    if (sub === '/folder/refresh' && method === 'POST') { requireAdmin(req); return send(res, 200, await refreshFromFolder(p.name)); }
    if (sub === '/folder/sync' && method === 'POST') { requireAdmin(req); return send(res, 200, await syncFolder(p.name) || { state: 'off' }); }
    if (sub === '/folder' && method === 'POST') { requireAdmin(req); const b = await readJson(req); const m = readMeta()[p.name]; if (m?.kind !== 'folder') throw httpError(400, 'not a folder project'); setMeta(p.name, { ...m, write_back_off: !b.write_back }); return send(res, 200, { ok: true, write_back: Boolean(b.write_back) }); }
    // Direct draft tasks for a run: allows Antigravity or the user to save/retrieve pre-planned tasks
    if (sub === '/draft-tasks' && method === 'GET') {
      requireView(req, url);
      const m = readMeta()[p.name];
      const folderPath = m?.paths?.[0] || m?.detail;
      const projectDraftFile = folderPath ? path.join(folderPath, '.converge-tasks.json') : '';
      const localDraftFile = path.join(DATA, 'projects', p.name, 'draft-tasks.json');
      let tasks = [];
      if (projectDraftFile && fs.existsSync(projectDraftFile)) {
        try { tasks = JSON.parse(fs.readFileSync(projectDraftFile, 'utf8')); } catch {}
      } else if (fs.existsSync(localDraftFile)) {
        try { tasks = JSON.parse(fs.readFileSync(localDraftFile, 'utf8')); } catch {}
      }
      return send(res, 200, { ok: true, tasks: Array.isArray(tasks) ? tasks : (tasks.tasks || []) });
    }
    if (sub === '/draft-tasks' && method === 'POST') {
      requireAdmin(req);
      const b = await readJson(req);
      const tasks = Array.isArray(b) ? b : (Array.isArray(b.tasks) ? b.tasks : []);
      const m = readMeta()[p.name];
      const folderPath = m?.paths?.[0] || m?.detail;
      const projectDraftFile = folderPath ? path.join(folderPath, '.converge-tasks.json') : '';
      const localDraftDir = path.join(DATA, 'projects', p.name);
      const localDraftFile = path.join(localDraftDir, 'draft-tasks.json');
      if (projectDraftFile && fs.existsSync(path.dirname(projectDraftFile))) {
        fs.writeFileSync(projectDraftFile, JSON.stringify(tasks, null, 2));
      } else {
        fs.mkdirSync(localDraftDir, { recursive: true });
        fs.writeFileSync(localDraftFile, JSON.stringify(tasks, null, 2));
      }
      return send(res, 200, { ok: true, count: tasks.length });
    }
    if (sub === '/draft-tasks' && method === 'DELETE') {
      requireAdmin(req);
      const m = readMeta()[p.name];
      const folderPath = m?.paths?.[0] || m?.detail;
      const projectDraftFile = folderPath ? path.join(folderPath, '.converge-tasks.json') : '';
      const localDraftFile = path.join(DATA, 'projects', p.name, 'draft-tasks.json');
      if (projectDraftFile && fs.existsSync(projectDraftFile)) fs.rmSync(projectDraftFile, { force: true });
      if (fs.existsSync(localDraftFile)) fs.rmSync(localDraftFile, { force: true });
      return send(res, 200, { ok: true });
    }
    const contm = sub.match(/^\/runs\/([0-9a-f]{8})\/continue$/);
    if (method === 'POST' && contm) { requireAdmin(req); return send(res, 200, await continueLocalRun({ root: ROOT, port: PORT, adminKey: ADMIN_KEY, project: p.name, id: contm[1], body: await readJson(req), log })); }
    const stopm = sub.match(/^\/runs\/([0-9a-f]{8})\/stop$/);
    if (method === 'POST' && stopm) {
      requireAdmin(req);
      return send(res, 200, stopLocalRun(p.name, stopm[1]));
    }
    if (method === 'GET' && sub === '/github') {
      requireAdmin(req);
      let head = '';
      try { head = git(repoPath(p.name), 'rev-parse', `refs/heads/${p.main.branch || 'main'}`); } catch { /* empty main */ }
      return send(res, 200, { link: GH.link(p.name), write_back: repoSync.get(p.name) || null, main_head: head });
    }
    // Converge is the source: what lands on main goes to the repository's branch itself (on) or only as pull requests (off).
    if (method === 'POST' && sub === '/github/write-back') {
      requireAdmin(req);
      const link = GH.link(p.name);
      if (!link) throw httpError(404, 'this project is not linked to GitHub');
      const on = Boolean((await readJson(req)).on);
      GH.setLink(p.name, { ...link, write_back: on });
      return send(res, 200, { write_back: on, ...(on ? { sync: await writeBackRepo(p.name) } : {}) });
    }
    if (method === 'POST' && sub === '/github/link') {
      requireAdmin(req);
      const b = await readJson(req);
      if (b.unlink) { GH.setLink(p.name, null); return send(res, 200, { link: null }); }
      const repo = String(b.repo || ''), installation = Number(b.installation_id);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !installation) throw httpError(400, 'repo (owner/name) and installation_id are required');
      const tok = await GH.tokenFor(installation, repo); // the app can reach it, or this throws
      const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'converge-local', Accept: 'application/vnd.github+json' } }).then((x) => x.json());
      const link = { installation_id: installation, repo, base: r.default_branch || 'main' };
      GH.setLink(p.name, link);
      return send(res, 200, { link });
    }
    if (method === 'POST' && sub === '/github/pr') {
      requireAdmin(req);
      const link = GH.link(p.name);
      if (!link) throw httpError(404, 'this project is not linked to GitHub');
      // Nothing landed since it came from GitHub: main is GitHub's own commit, and a pull request would have no commits
      // (GitHub refuses it with a bare 422). Said so here, before a branch is pushed for nothing.
      const base = link.base || 'main';
      const ours = git(repoPath(p.name), 'rev-parse', p.main.branch || 'main');
      const theirs = await GH.branchHead(link.installation_id, link.repo, base).catch(() => '');
      if (theirs && ours === theirs) throw httpError(409, `nothing to send yet: main is still what came from ${link.repo} (${base}). Land a change first.`);
      const branch = `converge/${p.name}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      const token = await GH.tokenFor(link.installation_id, link.repo);
      await pushToRemote(repoPath(p.name), p.main.branch || 'main', { url: `https://github.com/${link.repo}.git`, token }, { branch });
      const pr = await GH.openPr(link.installation_id, link.repo, branch, link.base || 'main', `converge: ${p.name}`, 'Changes that landed on converge, each checked before it landed.');
      return send(res, 200, { pr, branch });
    }
    // The project's way back to a git server: link one (checked first), then push main to a branch or open a PR.
    if (method === 'GET' && sub === '/remote') {
      requireAdmin(req);
      const r = REMOTES.get(p.name);
      return send(res, 200, { remote: r ? { url: r.url, has_token: Boolean(r.token), github: /github\.com[/:]/.test(r.url) } : null });
    }
    if (method === 'POST' && sub === '/remote') {
      requireAdmin(req);
      const b = await readJson(req);
      if (b.unlink) { REMOTES.set(p.name, null); return send(res, 200, { remote: null }); }
      const url = String(b.url || '').trim();
      if (!/^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(url)) throw httpError(400, 'a git URL starts with https://, ssh:// or git@host:');
      const prev = REMOTES.get(p.name);
      const r = { url, token: typeof b.token === 'string' && b.token ? b.token.trim() : (prev?.url === url ? prev.token : ''), username: String(b.username || '') };
      checkRemote(r);
      REMOTES.set(p.name, r);
      return send(res, 200, { remote: { url, has_token: Boolean(r.token), github: /github\.com[/:]/.test(url) } });
    }
    if (method === 'POST' && sub === '/remote/push') {
      requireAdmin(req);
      const r = REMOTES.get(p.name);
      if (!r) throw httpError(409, 'link a git server first');
      const b = await readJson(req);
      const branch = /^[\w./-]{1,100}$/.test(String(b.branch || '')) ? String(b.branch) : `converge/${p.name}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      return send(res, 200, await pushToRemote(repoPath(p.name), p.main.branch || 'main', r, { branch, pr: Boolean(b.pr), title: String(b.title || ''), body: 'Changes that landed on converge, each checked before it landed.' }));
    }
    if (method === 'GET' && sub === '/run-options') {
      requireView(req, url);
      return send(res, 200, { local: true, models: (await runOptions()).map(({ id, label, group, missing, where, provider }) => ({ id, label, group, missing, where, provider })) });
    }
    if (method === 'GET' && sub === '/runs') {
      requireView(req, url);
      return send(res, 200, { runs: await listRuns(p.name) });
    }
    if (method === 'GET' && sub === '/preview') {
      requireView(req, url);
      return send(res, 200, { url: `/preview/${previewToken(p.name)}/`, main_head: p.main?.head || '' });
    }
    if (method === 'POST' && sub === '/runs') {
      // Locally: planned here, run in a Linux container (scripts/lib/local-run.mjs); on Cloudflare it is converge-sandbox.
      requireAdmin(req);
      return send(res, 200, await startLocalRun({ root: ROOT, dataDir: DATA, port: PORT, adminKey: ADMIN_KEY, project: p.name, body: await readJson(req), log }));
    }
    if (method === 'POST' && sub === '/config') {
      requireAdmin(req);
      await configureProject(p, await readJson(req));
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && sub === '/audit') {
      // The aios broker's report of what each contained agent tried and what aios allowed.
      requireAdmin(req);
      const body = await readJson(req);
      const events = Array.isArray(body.events) ? body.events.filter((e) => e && ['Contained', 'Acted', 'Rewound'].includes(e.type)).slice(0, 200) : [];
      if (!events.length) throw httpError(400, 'want {events:[{type:"Contained"|"Acted"|"Rewound",...}]}');
      const n = await p.serial(async () => { const r = await p.call('POST', '/v1/audit', { events }); p.record(r.events); return r.events.length; });
      return send(res, 200, { recorded: n });
    }
    const hm = sub.match(/^\/agents\/(a-[0-9a-f]{1,32})\/handover$/);
    if (hm && (method === 'PUT' || method === 'GET')) {
      // An agent's handover to whoever continues its task, kept in ASQL (scripts/lib/handover-store.mjs).
      requireAdmin(req);
      if (method === 'GET') {
        const h = await loadHandover(p.name, hm[1]).catch((e) => { throw httpError(503, `ASQL: ${e.message}`); });
        return h ? send(res, 200, h) : send(res, 404, { error: `no handover from ${hm[1]}` });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || body.agent_id !== hm[1]) throw httpError(400, 'want the handover JSON, its agent_id the agent in the path');
      await saveHandover(p.name, hm[1], body).catch((e) => { throw httpError(e.status || 503, e.status ? e.message : `ASQL: ${e.message}`); });
      return send(res, 200, { saved: hm[1] });
    }
    const jm = sub.match(/^\/tasks\/([^/]+)\/agents$/);
    if (method === 'POST' && jm) {
      requireAdmin(req);
      const body = await readJson(req);
      return send(res, 200, await joinTask(p, req, decodeName(jm[1]), typeof body.from === 'string' ? body.from : ''));
    }
    if (method === 'POST' && sub === '/reviewers') {
      requireAdmin(req);
      return send(res, 200, await addReviewer(p, req));
    }
    // Main, read: what the owner clones and the swarm's preflight checks against (as on the Worker).
    if (method === 'GET' && sub === '/main') {
      requireAdmin(req);
      await whenPacked(p.name);   // the caller may copy main's store from disk
      return send(res, 200, { main_remote: p.main.url, main_local: repoPath(p.name), main_token: PLATFORM_TOKEN, main_branch: p.main.branch || 'main' });
    }
    // The transparency log over the project's signed receipts: its signed tree head and the proofs (engine log.cpp).
    if (method === 'GET' && (sub === '/log' || /^\/log\/(inclusion|consistency|leaves)$/.test(sub))) {
      requireView(req, url);
      return send(res, 200, await p.serial(() => p.call('GET', `/v1${sub}${url.search}`)));
    }
    // The operator gives or replaces an agent's signing key (one lost or leaked).
    const keyRoute = method === 'POST' && sub.match(/^\/agents\/(a-[0-9a-f]{1,32})\/key$/);
    if (keyRoute) {
      requireAdmin(req);
      const { key } = await readJson(req);
      const events = await p.serial(async () => p.record((await p.call('POST', '/v1/agent_key', { agent_id: keyRoute[1], key: String(key || ''), by: 'operator' })).events));
      return send(res, 200, { events: events.length });
    }
    if (method === 'GET' && sub === '/state') {
      requireView(req, url);
      const at = url.searchParams.get('at');
      if (at !== null) {
        // Time travel: fold exactly the log's events with seq <= at in a fresh engine state.
        const seq = Number(at);
        if (!Number.isFinite(seq) || seq < 0) throw httpError(400, 'at must be a non-negative integer');
        const events = p.log.filter((e) => Number(e.seq) <= seq);
        return send(res, 200, await p.serial(() => p.call('POST', '/v1/fold', { events })));
      }
      return send(res, 200, await p.serial(() => p.call('GET', '/v1/state')));
    }
    // The live state in ASQL (the engine runs inside aios), read-only, as on the Worker: one SELECT or SHOW
    // (the engine refuses anything else), e.g. SHOW CELLS or SELECT type, COUNT(*) FROM converge.events GROUP BY type.
    // Main's code, indexed in ASQL (lib/code-index.mjs): where names are, which files hold the most of some words.
    // Brought up to date first (only the files whose blob changed).
    if (sub === '/code' && method === 'GET') {
      requireAdmin(req);
      const list = (k) => String(url.searchParams.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!indexBuilt(p.name)) {
        refreshIndex(p.name, repoPath(p.name), p.main.branch || 'main').catch(() => { /* ASQL down */ });
        throw httpError(503, 'the code index is being built: read the files this time');
      }
      try {
        const indexed = await refreshIndex(p.name, repoPath(p.name), p.main.branch || 'main');
        return send(res, 200, { indexed, ...(await lookup(p.name, list('names'), list('words').map((w) => w.toLowerCase()))) });
      } catch (e) { throw httpError(503, `ASQL: ${e.message}`); }
    }
    // What planning here has learned (lib/plan-memory.mjs): refused checks and why, and earlier plans that landed.
    if (sub === '/plan-memory' && method === 'GET') {
      requireAdmin(req);
      try { return send(res, 200, await recall(p.name, url.searchParams.get('request') || '')); }
      catch (e) { throw httpError(503, `ASQL: ${e.message}`); }
    }
    if (sub === '/plan-memory' && method === 'POST') {
      requireAdmin(req);
      const body = await readJson(req);
      try { await rememberRefused(p.name, body.request, Array.isArray(body.problems) ? body.problems : []); return send(res, 200, { ok: true }); }
      catch (e) { throw httpError(503, `ASQL: ${e.message}`); }
    }
    // Where its runs' time went (lib/timeline.mjs): the verifier's checks and the merge trains, newest last.
    if (method === 'GET' && sub === '/timeline') {
      requireView(req, url);
      try { return send(res, 200, await readTimeline(p.name, Math.min(Number(url.searchParams.get('limit')) || 200, 2000))); }
      catch (e) { throw httpError(503, `ASQL: ${e.message}`); }
    }
    if (method === 'GET' && sub === '/sql') {
      requireView(req, url);
      const q = url.searchParams.get('q') || '';
      if (!q) throw httpError(400, 'q is required: one SELECT or SHOW, e.g. SHOW TABLES FROM converge');
      try {
        return send(res, 200, await p.serial(() => p.call('GET', `/v1/read/sql?q=${encodeURIComponent(q)}`)));
      } catch (e) {
        if (e.status === 404) throw httpError(501, 'this engine has no ASQL (/v1/read/sql): use the engine in kernel/<os>-<arch>/ in this repository');
        throw e;
      }
    }
    if (method === 'POST' && sub === '/rewind') {
      requireAdmin(req);
      const body = await readJson(req);
      const events = await p.serial(async () => p.record((await p.call('POST', '/v1/rewind_main', { commit: body.commit, by: 'operator' })).events));
      return send(res, 200, { events: events.length });
    }
    if (method === 'POST' && sub === '/undo') {
      requireAdmin(req);
      const body = await readJson(req);
      const seq = Number(body.seq);
      if (!Number.isInteger(seq) || seq < 1) throw httpError(400, 'seq (the operation to take back) is required');
      const r = await p.serial(async () => { const out = await p.call('POST', '/v1/undo', { seq, by: 'operator' }); p.record(out.events); return out; });
      return send(res, 200, { events: r.events.length, ...(r.reply || {}) });
    }
    const rm = sub.match(/^\/agents\/([^/]+)\/rewind$/);
    if (method === 'POST' && rm) {
      requireAdmin(req);
      const body = await readJson(req);
      const events = await p.serial(async () => p.record((await p.call('POST', '/v1/rewind_agent', { agent_id: decodeName(rm[1]), cycle: body.cycle, by: 'operator' })).events));
      return send(res, 200, { events: events.length });
    }
    const cy = sub.match(/^\/agents\/([^/]+)\/cycles$/);
    if (method === 'GET' && cy) {
      // One agent's cycles in full (reply and observation included), from the log: the snapshot keeps
      // only a short window without them.
      requireView(req, url);
      const agent = decodeName(cy[1]);
      return send(res, 200, { cycles: p.log.filter((e) => e.type === 'Acted' && e.agent_id === agent).slice(-500) });
    }
    // A change's diff for the dashboard (view key), as the Worker serves it: the engine's own diff tool, asked as the board.
    const chd = sub.match(/^\/changes\/([^/]+)\/diff$/);
    if (method === 'GET' && chd) {
      requireView(req, url);
      const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diff', arguments: { change_id: decodeName(chd[1]) } } });
      const r = await p.serial(() => p.call('POST', '/v1/mcp', { agent_id: 'board', role: 'reviewer', request }));
      const result = JSON.parse(r.reply || '{}').result || {};
      if (result.isError) throw httpError(404, result.content?.[0]?.text || 'no diff');
      return send(res, 200, { diff: String(result.diff ?? JSON.parse(result.content?.[0]?.text || '{}').diff ?? '') });
    }
    const cm = sub.match(/^\/agents\/([^/]+)\/cycles\/diff$/);
    if (method === 'GET' && cm) {
      requireView(req, url);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      return send(res, 200, await p.serial(() => p.call('POST', '/v1/cycle_diff', { agent_id: decodeName(cm[1]), from, to })));
    }
    throw httpError(404, 'Not Found');
  }

  // As the Worker: an agent waiting on its change asks once instead of polling status.
  const wm = pathname.match(/^\/mcp\/([^/]+)\/wait$/);
  if (wm && method === 'POST') {
    const p = getProject(decodeName(wm[1]));
    const key = bearer(req);
    const who = key && p.keys.get(sha256(key));
    if (!who) return send(res, 401, { error: 'Unauthorized' });
    const b = JSON.parse((await readBody(req)) || '{}');
    const woke = await new Promise((resolve) => {
      const w = { agent: who.agent_id, change: String(b.change_id || ''), wake: () => { clearTimeout(t); p.waiters.delete(w); resolve(true); } };
      const t = setTimeout(() => { p.waiters.delete(w); resolve(false); }, Math.min(Math.max(Number(b.timeout_ms) || 25000, 1000), 30000));
      (p.waiters ||= new Set()).add(w);
    });
    return send(res, 200, { woke });
  }

  const mm = pathname.match(/^\/mcp\/([^/]+)$/);
  if (mm) {
    // Streamable HTTP: we offer no server-initiated stream, so GET/DELETE are 405 (not 404).
    if (method !== 'POST') return send(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
    const p = getProject(decodeName(mm[1]));
    const key = bearer(req);
    const who = key && p.keys.get(sha256(key));
    if (!who) return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized: invalid MCP key' } });
    const out = await handleMcp(p, who, await readBody(req));
    return send(res, out.status, out.json);
  }

  if (method === 'GET' || method === 'HEAD') {
    const rel = decodeName(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(UI_DIR, rel);
    if (file.startsWith(UI_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
    }
  }
  throw httpError(404, 'Not Found');
}

function startServer() {
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) warn('http', `${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) send(res, status, { error: err.message });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    try { assertLocalRequest(req); } catch (err) { return socket.end(`HTTP/1.1 ${err.status} ${err.message}\r\n\r\n`); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    // A project on the deployed Worker: its live socket, relayed (the Worker's admin key in for this platform's admin).
    const cm = url.pathname.match(/^\/cloud(\/api\/projects\/[^/]+\/ws)$/);
    if (cm) {
      cloudCreds().then((c) => {
        if (!c.url) throw httpError(404, 'no Cloudflare Worker connected');
        const k = url.searchParams.get('key') || '';
        const up = new WebSocket(`${c.url.replace(/^http/, 'ws')}${cm[1]}${k ? `?key=${encodeURIComponent(isLocalAdmin(k) ? c.key : k)}` : ''}`);
        up.on('unexpected-response', (_q, r) => socket.end(`HTTP/1.1 ${r.statusCode} upstream\r\n\r\n`));
        up.on('error', () => socket.destroy());
        up.on('open', () => wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('message', (d, bin) => up.readyState === 1 && up.send(d, { binary: bin }));
          up.on('message', (d, bin) => ws.readyState === 1 && ws.send(d, { binary: bin }));
          ws.on('close', () => up.close());
          up.on('close', () => ws.close());
        }));
      }).catch((err) => socket.end(`HTTP/1.1 ${err.status || 502} ${err.message}\r\n\r\n`));
      return;
    }
    const m = url.pathname.match(/^\/api\/projects\/([^/]+)\/ws$/);
    let p;
    try {
      if (!m) throw httpError(404, 'Not Found');
      p = getProject(decodeName(m[1]));
      req.principal = await principalFor(req, url);
      requireView(req, url);
    } catch (err) {
      socket.end(`HTTP/1.1 ${err.status || 400} ${err.message}\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      p.sockets.add(ws);
      ws.on('close', () => p.sockets.delete(ws));
      ws.on('message', (d) => String(d) === 'ping' && ws.send('pong'));
      p.serial(() => p.call('GET', '/v1/state'))
        .then((st) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'snapshot', ...st })))
        .catch((e) => warn('ws', e.message));
    });
  });
  assertSafeBind();
  return new Promise((resolve) => server.listen(PORT, HOST, () => resolve(server)));
}

// Periodic engine sweep per project: releases claims of silent agents (lease), collects the engine's own
// test runs and lands passing split-mode changes. Polls fast while test runs are in flight.
let sweepTimer = null;
/** Sweep now (a submission or a gate's edge): 100 ms only gathers what arrives together. It waited 1.5 s, on every
 *  submission and every check's verdict, before anything moved. */
function kickSweep() {
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(sweepLoop, 100);
  sweepTimer.unref();
}

async function sweepLoop() {
  clearTimeout(sweepTimer);
  let pending = 0;
  for (const p of projects.values()) {
    try {
      const res = await p.serial(async () => {
        const r = await p.call('POST', '/v1/sweep', { lease_ms: LEASE_MS });
        p.record(r.events);
        return r;
      });
      pending += res.pending || 0;
      // The engine refuses to land anything unsealed, or starts no merge train though changes wait: say
      // so once per reason, not silently every sweep.
      if (res.landing_blocked && p.blockedSaid !== res.landing_blocked) { p.blockedSaid = res.landing_blocked; warn('land', `${p.name}: nothing can land: ${res.landing_blocked}`); }
      if (res.train_blocked && p.trainSaid !== res.train_blocked) { p.trainSaid = res.train_blocked; warn('land', `${p.name}: no merge train: ${res.train_blocked}`); }
      for (const e of res.events) {
        if (e.type === 'IntentReleased') log('lease', `${p.name}: ${e.agent_id}'s claim expired after ${LEASE_MS >= 60000 ? `${Math.round(LEASE_MS / 60000)}m` : `${Math.round(LEASE_MS / 1000)}s`} of silence`);
        if (e.type === 'Verified') log('verify', `${p.name}: ${e.change_id} @ ${e.commit.slice(0, 8)} -> exit ${e.exit_code}${e.timed_out ? ' (timeout)' : ''} in ${(e.duration_ms / 1000).toFixed(1)}s`);
        if (e.type === 'Landed') log('land', `${p.name}: ${e.change_id} landed as ${e.commit.slice(0, 8)}`);
      }
      // The code index follows main, in the background: the next plan finds it current.
      if (res.events.some((e) => e.type === 'Landed')) refreshIndex(p.name, repoPath(p.name), p.main.branch || 'main').catch(() => { /* ASQL down: refreshed when asked */ });
    } catch (err) {
      warn('sweep', `${p.name}: ${err.message}`);
    }
  }
  sweepTimer = setTimeout(sweepLoop, pending ? 500 : SWEEP_MS);
  sweepTimer.unref();
}

// ---- main ---------------------------------------------------------------------------------------

let shuttingDown = false;
// Every engine this server spawned, by its process, until it exits: stopping the server stops them all (a project's
// engine, one being replaced, or one of a deleted project still finishing), never leaving one behind.
const ENGINES = new Set();
// An engine finishes its open long-polls (the edges watch: up to 30 s) before it exits on SIGTERM; past this grace
// it is killed.
const ENGINE_GRACE_MS = 3000;
// Running (a zombie, exited but not yet reaped, is not).
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z'; } catch { return true; }
};
function signalEngines(sig) {
  for (const proc of ENGINES) { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill(sig); } catch { /* gone */ } } }
}
// On a signal: SIGTERM every engine, wait for them (up to the grace), SIGKILL what is left, then exit.
async function stopAndExit(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  signalEngines('SIGTERM');
  const until = Date.now() + ENGINE_GRACE_MS;
  while (ENGINES.size && Date.now() < until) await new Promise((ok) => setTimeout(ok, 50));
  signalEngines('SIGKILL');
  while (ENGINES.size && Date.now() < until + 2000) await new Promise((ok) => setTimeout(ok, 20));
  enginesStopped = true;
  process.exit(code);
}
// Any other exit (a fatal error, process.exit elsewhere): the same, synchronously.
let enginesStopped = false;
function shutdownSync() {
  if (enginesStopped) return;
  shuttingDown = true;
  signalEngines('SIGTERM');
  const until = Date.now() + ENGINE_GRACE_MS, nap = new Int32Array(new SharedArrayBuffer(4));
  while ([...ENGINES].some((p) => alive(p.pid)) && Date.now() < until) Atomics.wait(nap, 0, 0, 50);
  for (const p of ENGINES) { if (alive(p.pid)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } }
}
process.on('exit', shutdownSync);
process.on('SIGINT', () => stopAndExit(0));
process.on('SIGTERM', () => stopAndExit(0));
process.on('SIGHUP', () => stopAndExit(0));

async function main() {
  if (!fs.existsSync(ENGINE_BIN)) throw new Error(`no engine at ${ENGINE_BIN}: ${kernelHint(ROOT)}`);
  fs.mkdirSync(DATA, { recursive: true });
  if (DATA_FROM === 'legacy') log('data', `data in ${DATA} (from before; the default is now ${DEFAULT_DATA}: move it there, or set CONVERGE_DATA)`);
  const saved = process.env.CONVERGE_RESET ? null : loadState();
  if (!saved) {
    fs.rmSync(path.join(DATA, 'work'), { recursive: true, force: true });
    fs.rmSync(path.join(DATA, 'seed'), { recursive: true, force: true });
  }
  // Sign-in lives in ASQL: start it from the kernel bundle when nothing serves it (stopped with the engines on exit),
  // then bring its tables up to date. A server with no ASQL still runs on its keys; password sign-in just answers 5xx.
  // What a dev server that died without stopping them left running (ASQL on 3307, engines): stopped first, so this
  // start runs its own, on this bundle's binaries.
  const reaped = reapOrphans();
  if (reaped.length) log('dev', `stopped what an earlier run left behind: ${reaped.join(', ')}`);
  // ASQL is watched like an engine: if it exits while dev runs, it is started again.
  const startAsql = async () => {
    const proc = await ensureAsql({ log, warn });
    if (!proc) return;
    ENGINES.add(proc);
    track(proc, 'asql');
    proc.once('exit', (code, sig) => {
      ENGINES.delete(proc);
      if (shuttingDown) return;
      warn('asql', `exited (${code ?? sig}); starting it again`);
      setTimeout(() => startAsql().catch((e) => warn('asql', e.message)), 500);
    });
  };
  await startAsql();
  try {
    const asql = getAsql();
    const ran = await applyMigrations(asql);
    if (ran.length) log('auth', `ASQL auth tables migrated (${ran.join(', ')})`);
    const sealed = await encryptStored();
    if (sealed) log('auth', `${sealed} stored credential(s) encrypted at rest`);

    // No account is made here: with none, the dashboard shows its first-run setup screen (GET/POST /api/setup), where
    // the first account is created and made the admin. A built-in demo/demo account was a known password on every install.
  } catch (e) { warn('auth', `ASQL is not reachable (${e.message}): password sign-in is unavailable until it is. Create users with: node scripts/auth-user.mjs`); }
  await startGitHost({ fresh: !saved });
  await startServer();
  if (saved) await restore(saved);
  quarantineOrphans();
  // A folder that is behind main (a landing whose sync was missed, a stop mid-sync) catches up now and after every run.
  const catchUp = (name) => {
    const m = readMeta()[name];
    if (!writeBackOn(m) || !projects.has(name)) return;   // not a folder project, or its sync is off
    let head = '';
    try { head = git(repoPath(name), 'rev-parse', `refs/heads/${projects.get(name).main.branch || 'main'}`); } catch { return; }
    if (m.synced !== head) syncFolder(name).catch((e) => warn('folder', `${name}: ${e.message}`));
  };
  // The same for a GitHub project whose owner made converge its source (a push of what is already there is a no-op).
  const catchUpRepo = (name) => { if (GH.link(name)?.write_back && projects.has(name)) writeBackRepo(name).catch((e) => warn('github', `${name}: ${e.message}`)); };
  const catchUpAll = (name) => { catchUp(name); catchUpRepo(name); };
  for (const name of projects.keys()) catchUpAll(name);
  onRunEnded((name) => setTimeout(() => catchUpAll(name), 3000));
  sweepLoop();
  const base = `http://${HOST}:${PORT}`;
  log('server', `converge local platform on ${base}${ADMIN_KEY ? '' : '  (no ADMIN_KEY/VIEW_KEY set: API open on loopback)'}`);

  // A fresh start has no projects: you bring your own repository in. The made-up demo project (seeded fixtures, no
  // real agents behind them) comes only on request: CONVERGE_DEMO=1.
  let seeded = null;
  if (process.env.CONVERGE_DEMO === '1' && !process.env.NO_SEED && !projects.has('converge-demo')) {
    seeded = await seed();
    log('seed', 'converge-demo: 1 landing, 3 contenders (1 conflicted), ranged claims');
  }

  console.log(`
  Dashboard  ${base}/${seeded ? `?project=converge-demo&reviewer_key=${seeded.reviewer.mcp_key}` : ''}
  API        POST ${base}/api/projects            {"name": "...", "import_url": "<git url>", "test_command": "<optional>"}
             POST ${base}/api/projects/:p/config     {"test_command", "test_timeout_s", "check_claims", "auto_land"}
             POST ${base}/api/projects/:p/tasks    {"title": "...", "mode": "split|compete", "agents": N}
             POST ${base}/api/projects/:p/tasks/:t/agents   {"from": "<stalled agent>"?}  (join: own fork + key; from = take over)
             POST ${base}/api/projects/:p/reviewers
  MCP        ${base}/mcp/:project   (Authorization: Bearer <mcp_key>)
  Git        ${base}/git/<repo>.git  (token auth: push to your own fork; the platform picks it up)
${seeded ? `  Reviewer   ${seeded.reviewer.mcp_key}\n` : ''}`);
}

main().catch((err) => {
  console.error(`\x1b[31m[fatal]\x1b[0m ${err.stack || err.message}`);
  process.exit(1);
});
