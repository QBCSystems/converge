/**
 * Converge Worker: public HTTP API, MCP endpoint and Artifacts push-event consumer.
 *
 *   GET  /api/projects                      the account's projects and their origins    admin
 *   POST /api/projects                      {name, import_url?, template?}              admin
 *   DELETE /api/projects/:p                 for good: its state, repos, GitHub link     admin
 *   POST /api/projects/:p/tasks             {title, description, mode, agents}          admin
 *   POST /api/projects/:p/tasks/:t/agents   join an existing task (own fork + key)      admin
 *   POST /api/projects/:p/reviewers                                                     admin
 *   GET  /api/projects/:p/state             [?at=<seq>]                                 view
 *   GET  /api/projects/:p/agents/:a/cycles                                              view
 *   GET  /api/projects/:p/agents/:a/cycles/diff?from=<n>&to=<n>                         view
 *   GET  /api/projects/:p/changes/:c/diff                                              view
 *   GET  /api/projects/:p/sql?q=SELECT…     the live state in ASQL (inside aios), read-only view
 *   GET  /api/projects/:p/jail              the jail's self-check, run on a runner      admin
 *   POST /api/projects/:p/agents/:a/rewind  {cycle}                                     admin
 *   POST /api/projects/:p/rewind            {commit}                                    admin
 *   POST /api/projects/:p/undo              {seq}                                       admin
 *   GET  /api/projects/:p/runs              its runs on Cloudflare (converge-sandbox)       view
 *   GET  /api/projects/:p/ws                (WebSocket; key as subprotocol, or ?key=)  view
 *   POST /mcp/:p                            MCP Streamable HTTP, Bearer <mcp key>
 *
 * Queue consumer: converge-artifacts-events, for Artifacts push events. Each repository converge creates
 * (main and every agent fork) is subscribed to the queue when CF_ACCOUNT_ID and CF_EVENTS_API_TOKEN are
 * set (subscribePushes); the platform also fetches a worker's fork on status and submit, so a push is
 * recorded without the subscription too.
 */

import { Project } from './project.ts';
import { createProjectRepo, createProjectFromTemplate, createAgentFork, deleteProjectRepos, ensurePushSubscription, forkName, mainReadAccess, PUSH_QUEUE } from './artifacts.ts';
import type { ProjectOrigin } from './project.ts';
import { extractMcpKey, generateId, isValidProjectName, redactSecrets, runToken, sandboxSessionToken, verifyAdminKey, verifySandboxToken, verifySessionToken, verifyViewKey } from './auth.ts';

export { Project };
export { Runner } from './runner.ts';
export { GitHubLink } from './github.ts';
export { RunnerWatch } from './watch.ts';
import type { RunnerWatch } from './watch.ts';
import { IDLE_MS } from './watch.ts';
import { GitHubLink, makeState, checkState, manifest, convertManifest } from './github.ts';
import { connectLines } from './connect.mjs';

const MAX_AGENTS_PER_TASK = 16;
// What a run or sandbox token (held by an agent's container, not a person) may add: agents per task, and in all.
const TOKEN_AGENTS_PER_TASK = 6;
const TOKEN_AGENTS_PER_PROJECT = 32;
// A request body larger than this is refused before it is parsed (task descriptions, audit batches).
const MAX_BODY_BYTES = 1 << 20;

/** The Project DO's RPC surface, as the Worker uses it (explicit: the inferred RPC type is too deep). */
interface ProjectRpc {
  exists(): Promise<boolean>;
  hasTask(taskId: string): Promise<boolean>;
  createProject(name: string, repo: import('./artifacts.ts').RepoCredentials, origin?: ProjectOrigin): Promise<void>;
  origin(): Promise<ProjectOrigin | null>;
  destroy(): Promise<{ busy: true } | { busy: false; forks: string[] }>;
  addAgent(role: string, agentId: string, fork?: import('./artifacts.ts').RepoCredentials): Promise<{ agent_id: string; mcp_key: string }>;
  createTask(t: import('./project.ts').CreateTaskParam): Promise<{ task_id: string; main_branch: string }>;
  joinTask(taskId: string, agent: import('./project.ts').TaskAgentParam, takeoverOf?: string): Promise<{ main_branch: string }>;
  isWorker(agentId: string): Promise<boolean>;
  onPush(p: { agent: string; ref: string; commit: string }): Promise<void>;
  getProjectState(): Promise<any>;
  stateAt(at: number): Promise<any>;
  rewindAgent(agentId: string, cycle: number): Promise<any>;
  cycleDiff(agentId: string, from: number, to: number): Promise<any>;
  changeDiff(changeId: string): Promise<{ diff: string }>;
  jailReport(): Promise<Record<string, unknown>>;
  readSql(q: string): Promise<any>;
  agentCycles(agentId: string): Promise<any>;
  rewindMain(commit: string): Promise<any>;
  undo(seq: number): Promise<any>;
  configure(cfg: Record<string, unknown>): Promise<void>;
  audit(events: unknown[]): Promise<{ recorded: number }>;
  readLog(sub: string, search: string): Promise<{ status: number; body: any }>;
  setAgentKey(agentId: string, key: string): Promise<{ events: number }>;
  handleMcp(mcpKey: string, body: string): Promise<{ status: number; body: string }>;
  waitFor(mcpKey: string, changeId: string, timeoutMs: number): Promise<{ woke: boolean } | null>;
  timings(): Promise<any>;
  sweepNow(): Promise<any>;
  warmRunners(): Promise<{ warm: number; of: number }>;
  agentCount(): Promise<number>;
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  PROJECT: DurableObjectNamespace;
  ARTIFACTS?: Artifacts;
  ADMIN_KEY?: string;
  VIEW_KEY?: string;
  /** Demo projects a sandbox session may start from, comma-separated. */
  SANDBOX_TEMPLATES?: string;
  ENGINE_SHARED_KEY?: string;
  ENGINE_URL?: string;
  RUNNER: DurableObjectNamespace<import('./runner.ts').Runner>;
  /** "true" only for local development: lets requests through when no keys are configured. */
  ALLOW_INSECURE?: string;
  /** Claim lease in ms (default 20 min). */
  LEASE_MS?: string;
  ASSETS?: Fetcher;
  /** Service binding to converge-sandbox: starts a run's agents in a container on Cloudflare. */
  SANDBOX?: Fetcher;
  /** The GitHub App link: its keys, and which project came from which repository. */
  GITHUB: DurableObjectNamespace<GitHubLink>;
  /** Notes each runner's last use; the cron stops the idle ones. */
  RUNNERWATCH: DurableObjectNamespace<RunnerWatch>;
  /** Push events: the account id and an API token (Event Subscriptions write, Queues read) to subscribe each new repository to the queue. */
  CF_ACCOUNT_ID?: string;
  CF_EVENTS_API_TOKEN?: string;
  /** The Artifacts namespace of the ARTIFACTS binding (wrangler.jsonc); default "converge". */
  ARTIFACTS_NAMESPACE?: string;
}

/**
 * Subscribe a new repository's push events to the queue. Never fails the request: without the token, or
 * if the API refuses, the fork is still fetched on status and submit, so the push is recorded anyway.
 */
async function subscribePushes(env: Env, repo: string): Promise<void> {
  const cfg = env.CF_ACCOUNT_ID && env.CF_EVENTS_API_TOKEN
    ? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_EVENTS_API_TOKEN, namespace: env.ARTIFACTS_NAMESPACE || 'converge', queue: PUSH_QUEUE }
    : undefined;
  try {
    await ensurePushSubscription(cfg, repo);
  } catch (err: any) {
    console.warn(`push subscription for ${repo} not made (status/submit fetch still records pushes):`, redactSecrets(String(err?.message || err), [env.CF_EVENTS_API_TOKEN]));
  }
}

const open = (env: Env) => env.ALLOW_INSECURE === 'true';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key, X-View-Key, X-MCP-Key, Mcp-Session-Id, Mcp-Protocol-Version',
};

/** The projects new projects and sandbox sessions may start from (SANDBOX_TEMPLATES, comma-separated): none unless set. */
const templateNames = (env: Env) => (env.SANDBOX_TEMPLATES || '').split(',').map((x) => x.trim()).filter(Boolean);
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
/** A view others may see (agents' observations, diffs): any credential an agent printed is cut out first. */
const shown = (env: Env, data: unknown) =>
  new Response(redactSecrets(JSON.stringify(data), [env.ADMIN_KEY, env.VIEW_KEY, env.ENGINE_SHARED_KEY]), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });

/** The caller's address for rate limits: an IPv6 client holds a whole /64, so that is the unit. */
function clientNet(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

/**
 * A template's test command worth copying: a placeholder that checks nothing (`true`, `:`, `exit 0`) is not one. A copy
 * then starts with none, and the first run's container reads the real one from the repository itself (package.json's
 * test script -> `npm test`, Cargo.toml, go.mod, ...: detectTestCommand in sandbox/image/entry.mjs) and configures it.
 */
function copiedTestCommand(tc: unknown): string {
  const t = typeof tc === 'string' ? tc.trim() : '';
  return /^(true|:|exit 0|\/bin\/true)?$/.test(t) ? '' : t;
}

/** The project settings a request carries (test_command, test_timeout_s, check_claims, auto_land, tracks, targets, leases, signing). */
function projectConfig(b: any): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (b.test_command !== undefined) {
    if (typeof b.test_command !== 'string') throw new HttpError(400, 'test_command must be a string');
    cfg.test_command = b.test_command;
  }
  if (b.test_timeout_s !== undefined) cfg.test_timeout_s = Number(b.test_timeout_s) || 900;
  for (const k of ['check_claims', 'auto_land']) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
      cfg[k] = b[k];
    }
  }
  if (b.tracks !== undefined) {
    if (typeof b.tracks !== 'string') throw new HttpError(400, 'tracks must be a string: "", "auto", or path prefixes');
    cfg.tracks = b.tracks;
  }
  if (b.leases !== undefined) {
    if (!['advisory', 'exclusive'].includes(b.leases)) throw new HttpError(400, 'leases is advisory or exclusive');
    cfg.leases = b.leases;
  }
  if (b.signing !== undefined) {
    if (!['optional', 'required'].includes(b.signing)) throw new HttpError(400, 'signing is optional or required');
    cfg.signing = b.signing;
  }
  if (b.targets !== undefined) {
    if (!Array.isArray(b.targets) || b.targets.some((t: unknown) => typeof t !== 'string')) throw new HttpError(400, 'targets must be a list of branch names');
    cfg.targets = b.targets;
  }
  return cfg;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function projectName(raw: string): string {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'Malformed project name in URL');
  }
  if (!isValidProjectName(name)) throw new HttpError(400, 'Invalid project name');
  return name;
}

const stubFor = (env: Env, name: string) => env.PROJECT.get(env.PROJECT.idFromName(name)) as unknown as ProjectRpc;

async function requireProject(env: Env, name: string) {
  const stub = stubFor(env, name);
  if (!(await stub.exists())) throw new HttpError(404, `no project "${name}"; create it with POST /api/projects`);
  return stub;
}

/** Map an Artifacts or Durable Object failure to a status the caller can act on. */
function statusFor(err: any): number {
  if (err instanceof HttpError) return err.status;
  switch (err?.code) {
    case 'ALREADY_EXISTS':
      return 409;
    case 'NOT_FOUND':
      return 404;
    case 'INVALID_REPO_NAME':
    case 'INVALID_INPUT':
    case 'INVALID_URL':
      return 400;
    case 'REMOTE_AUTH_REQUIRED':
    case 'UPSTREAM_UNAVAILABLE':
      return 502;
    default:
      return 500;
  }
}

/** An import URL as a project's origin shows it: never the credentials a URL may carry. */
function showUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^/@]*@/, '//');
  }
}

function requireArtifacts(env: Env): Artifacts {
  if (!env.ARTIFACTS) throw new HttpError(500, 'the ARTIFACTS binding is not configured');
  return env.ARTIFACTS;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const mcpUrl = (name: string) => `${url.origin}/mcp/${encodeURIComponent(name)}`;
  // Main, read-only: what an agent's sync fetches and a reviewer clones (the fork token cannot read it).
  const mainFor = async (name: string) => {
    const m = await mainReadAccess(env.ARTIFACTS, name);
    return { main_remote: m.remote, main_token: m.token, main_token_expires_at: m.expiresAt };
  };
  // True once a sandbox session's token has been checked for the project this request names (below).
  let sessionAdmin = false;
  const admin = () => {
    if (sessionAdmin) return;
    if (!verifyAdminKey(request, env.ADMIN_KEY, open(env))) throw new HttpError(401, 'Unauthorized');
  };
  // The admin key itself, never a session or run token (starting runs, for one).
  const realAdmin = () => {
    if (!verifyAdminKey(request, env.ADMIN_KEY, open(env))) throw new HttpError(401, 'Unauthorized');
  };
  // Let in by a run or sandbox token alone (an agent's container), not by the admin key: held to tighter caps.
  const tokenOnly = () => sessionAdmin && !verifyAdminKey(request, env.ADMIN_KEY, open(env));
  // Whoever may administer may also watch: the admin key opens every view the view key does.
  const view = () => {
    const ok = verifyViewKey(request, env.VIEW_KEY, open(env)) || (!!env.ADMIN_KEY && (verifyViewKey(request, env.ADMIN_KEY, false) || verifyAdminKey(request, env.ADMIN_KEY, false)));
    if (!ok) throw new HttpError(401, 'Unauthorized');
  };
  const body = async (): Promise<any> => {
    if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'body must be JSON');
    }
  };

  // The GitHub App link (github.ts): its keys, and which project came from which repository.
  const ghLink = () => env.GITHUB.get(env.GITHUB.idFromName('link'));

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) return json({ ok: true });
  // What the dashboard's New project offers to start from (names only: the projects themselves stay behind their keys).
  if (method === 'GET' && url.pathname === '/api/templates') return json({ templates: templateNames(env) });

  if (method === 'GET' && url.pathname === '/api/projects') {
    // The projects on this account (admin): their main repositories, not the agents' forks.
    admin();
    const names: string[] = [];
    const repos: Record<string, { createdAt: string; description: string | null; source: string | null }> = {};
    let cursor: string | undefined;
    do {
      const page = await requireArtifacts(env).list({ limit: 200, ...(cursor ? { cursor } : {}) });
      for (const r of page.repos) if (!r.name.includes('--') && isValidProjectName(r.name)) { names.push(r.name); repos[r.name] = r; }
      cursor = page.cursor;
    } while (cursor && names.length < 2000);
    names.sort();
    // Where each came from: recorded by its Project object at creation. A project from before that was
    // recorded is inferred where it is cheap (a GitHub link; a fork of another repository is a template copy).
    const linked = await ghLink().linkedRepos().catch(() => ({} as Record<string, string>));
    const info: Record<string, ProjectOrigin> = {};
    for (let i = 0; i < names.length; i += 50) {
      await Promise.all(names.slice(i, i + 50).map(async (n) => {
        const recorded = await stubFor(env, n).origin().catch(() => null);
        const r = repos[n];
        const src = r.source || '';
        info[n] = recorded
          || (linked[n] ? { kind: 'github', detail: linked[n], created_at: r.createdAt }
            : src.startsWith('artifacts:') ? { kind: 'template', detail: src.split('/').pop() || src, created_at: r.createdAt }
            : src.startsWith('github:') ? { kind: 'github', detail: src.slice('github:'.length), created_at: r.createdAt }
            : { kind: 'unknown', detail: '', created_at: r.createdAt });
      }));
    }
    return json({ projects: names, info });
  }

  if (method === 'POST' && url.pathname === '/api/projects') {
    admin();
    const b = await body();
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) throw new HttpError(400, 'Missing project name');
    if (!isValidProjectName(name)) {
      throw new HttpError(400, 'Invalid project name: 1-64 letters, digits, dots or single dashes (no "--"), starting and ending with a letter or digit');
    }
    // sandbox-<id> is a sandbox session's (administered by its token): only /api/sandbox/new makes one.
    if (name.startsWith('sandbox-')) throw new HttpError(400, 'names starting "sandbox-" are reserved for sandbox sessions');
    const stub = stubFor(env, name);
    // Settings given with the project (test_command, ...) apply at creation, as on the dev server;
    // a bad one is refused before anything is created.
    const cfg = projectConfig(b);
    if (await stub.exists()) {
      // Creating again would overwrite the stored main token and re-run project setup, so a second create
      // only applies its settings (the README's `seed` then `project --test-command` order). A different
      // origin (import_url, template) cannot be applied to an existing main.
      if ((typeof b.import_url === 'string' && b.import_url) || (typeof b.template === 'string' && b.template)) throw new HttpError(409, `Project "${name}" already exists`);
      if (Object.keys(cfg).length) await stub.configure(cfg);
      const m = await mainReadAccess(env.ARTIFACTS, name).catch(() => null);
      return json({ project: name, existed: true, main_remote: m?.remote ?? '', view_url: `/api/projects/${encodeURIComponent(name)}/state`, ...(Object.keys(cfg).length ? { configured: cfg } : {}) });
    }
    // Start from: empty (a README), a copy of a demo project's main (template), or an import of a public git URL.
    const template = typeof b.template === 'string' && b.template ? b.template : '';
    if (template && !templateNames(env).includes(template)) throw new HttpError(400, `template: one of ${env.SANDBOX_TEMPLATES || '(none configured)'}`);
    const repo = template ? await createProjectFromTemplate(env.ARTIFACTS, name, template)
      : await createProjectRepo(env.ARTIFACTS, name, typeof b.import_url === 'string' && b.import_url ? b.import_url : undefined);
    await subscribePushes(env, name);
    const importUrl = typeof b.import_url === 'string' ? b.import_url : '';
    const origin: ProjectOrigin = template ? { kind: 'template', detail: template, created_at: new Date().toISOString() }
      : importUrl ? { kind: 'git', detail: showUrl(importUrl), created_at: new Date().toISOString() }
      : { kind: 'empty', detail: '', created_at: new Date().toISOString() };
    await stub.createProject(name, repo, origin);
    if (template && !cfg.test_command) {
      // The copy checks itself the way its template does.
      try {
        const st: any = await (await requireProject(env, template)).getProjectState();
        const tc = copiedTestCommand(st?.project?.test_command);
        if (tc) (cfg as any).test_command = tc;
      } catch { /* the done-when checks still gate */ }
    }
    if (Object.keys(cfg).length) await stub.configure(cfg);
    return json({ project: name, main_remote: repo.remote, main_branch: repo.defaultBranch, view_url: `/api/projects/${encodeURIComponent(name)}/state` }, 201);
  }

  // ---- GitHub (a GitHub App: see github.ts) ----
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${url.origin}/?github=${q}` } });
  if (method === 'GET' && url.pathname === '/api/github/status') {
    admin();
    const app = await ghLink().appPublic();
    return json({ setup: !!app, app, install_url: app ? `https://github.com/apps/${app.slug}/installations/new` : '' });
  }
  // Step 1 (once): the page posts this manifest to GitHub, which creates the app on the admin's account.
  if (method === 'POST' && url.pathname === '/api/github/setup') {
    admin();
    if (!env.ADMIN_KEY) throw new HttpError(503, 'set ADMIN_KEY first (wrangler secret put ADMIN_KEY)');
    return json({ action: `https://github.com/settings/apps/new?state=${await makeState(env.ADMIN_KEY, 'create')}`, manifest: manifest(url.origin) });
  }
  // Unauthenticated by nature (GitHub redirects the browser here), so it trusts only a state converge signed with the
  // admin key, once: without the key nothing is accepted (the app's keys would otherwise be anyone's to replace).
  if (method === 'GET' && url.pathname === '/api/github/created') {
    const nonce = await checkState(env.ADMIN_KEY || '', 'create', url.searchParams.get('state'));
    if (!nonce || !(await ghLink().useNonce(nonce))) return back('expired');
    try { await ghLink().saveApp(await convertManifest(url.searchParams.get('code') || '')); } catch (e: any) { return back(`failed&why=${encodeURIComponent(redactSecrets(String(e?.message || e)).slice(0, 160))}`); }
    return back('created');
  }
  // After someone installs the app (picking repositories on GitHub's screen). Installations are read from
  // GitHub with the app's key, so nothing from this redirect is trusted or stored.
  if (method === 'GET' && url.pathname === '/api/github/installed') return back('installed');
  if (method === 'GET' && url.pathname === '/api/github/repos') {
    admin();
    try { return json(await ghLink().repos()); } catch (e: any) { throw new HttpError(502, String(e?.message || e)); }
  }
  // A repository becomes a project: Artifacts imports it with a one-hour token for that repository alone.
  if (method === 'POST' && url.pathname === '/api/github/import') {
    admin();
    const b = await body();
    const repo = typeof b.repo === 'string' ? b.repo : '';
    const installation = Number(b.installation_id);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some((x: string) => x === '.' || x === '..' || x.endsWith('.git')) || !installation) throw new HttpError(400, 'repo (owner/name) and installation_id are required');
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : repo.split('/')[1].toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (!isValidProjectName(name) || name.startsWith('sandbox-')) throw new HttpError(400, `"${name}" is not a valid project name: pick another`);
    const stub = stubFor(env, name);
    if (await stub.exists()) throw new HttpError(409, `Project "${name}" already exists`);
    const tok = await ghLink().tokenFor(installation, undefined, undefined, repo);
    const repoInfo = await createProjectRepo(env.ARTIFACTS, name, `https://x-access-token:${tok}@github.com/${repo}.git`);
    await subscribePushes(env, name);
    await stub.createProject(name, repoInfo, { kind: 'github', detail: repo, created_at: new Date().toISOString() });
    const st: any = await stub.getProjectState().catch(() => null);
    await ghLink().linkProject(name, { installation_id: installation, repo, branch: repoInfo.defaultBranch, base: st?.project?.main_head || '' });
    return json({ project: name, repo, branch: repoInfo.defaultBranch }, 201);
  }

  // A sandbox session (the sandbox Worker, with the admin key): a throwaway project forked from a demo
  // project's main, and a token that administers that one project until it expires.
  if (method === 'POST' && url.pathname === '/api/sandbox/new') {
    admin();
    const b = await body();
    const id = typeof b.id === 'string' ? b.id : '';
    if (!/^[a-f0-9]{8,32}$/.test(id)) throw new HttpError(400, 'id: 8-32 lowercase hex characters');
    const template = typeof b.template === 'string' ? b.template : '';
    if (!templateNames(env).includes(template)) throw new HttpError(400, `template: one of ${env.SANDBOX_TEMPLATES || '(none configured)'}`);
    const name = `sandbox-${id}`;
    const stub = stubFor(env, name);
    if (await stub.exists()) throw new HttpError(409, `session ${name} already exists`);
    const repo = await createProjectFromTemplate(env.ARTIFACTS, name, template);
    await subscribePushes(env, name);
    await stub.createProject(name, repo, { kind: 'template', detail: template, created_at: new Date().toISOString() });
    // The template's own test command, so the session's checks are the demo's.
    try {
      const st: any = await (await requireProject(env, template)).getProjectState();
      const tc = copiedTestCommand(st?.project?.test_command);
      if (tc) await stub.configure({ test_command: tc, test_timeout_s: 300 });
    } catch { /* a template without a test command: acceptance checks still gate */ }
    const ttl = Math.min(Math.max(Number(b.ttl_s) || 3600, 300), 7200);
    const expires_at = Math.floor(Date.now() / 1000) + ttl;
    const token = await sandboxSessionToken(env.ADMIN_KEY || '', name, expires_at);
    return json({ project: name, template, main_branch: repo.defaultBranch, main_remote: repo.remote, token, expires_at, watch_url: `${url.origin}/?project=${name}&watch=1` }, 201);
  }

  // Stop a project's runner containers (admin): idle runners hold the account's container capacity.
  // Names are the ones the project uses: its pool <project>/0..7, each workspace's own <project>/w-<workspace> and the
  // jail check's <project>/jail-<tag> (the watchdog has noted every one that ran).
  if (method === 'POST' && url.pathname === '/api/runners/reap') {
    admin();
    const b = await body();
    const project = typeof b.project === 'string' ? b.project.trim() : '';
    if (!project) throw new HttpError(400, 'project required');
    const noted = await env.RUNNERWATCH.get(env.RUNNERWATCH.idFromName('all')).named(`${project}/`);
    const names = [...new Set([...Array.from({ length: 8 }, (_, i) => `${project}/${i}`), ...noted, ...(Array.isArray(b.extra) ? b.extra.map(String) : [])])];
    const done = await Promise.all(names.map((n) => (env.RUNNER.get(env.RUNNER.idFromName(n)) as unknown as { reap(): Promise<void> }).reap().then(() => true, () => false)));
    return json({ project, reaped: done.filter(Boolean).length, of: names.length });
  }

  // The watchdog's sweep, on demand (admin): the same thing the cron does every 5 minutes.
  if (method === 'POST' && url.pathname === '/api/runners/sweep') {
    admin();
    return json(await sweepRunners(env));
  }

  const pm = url.pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
  if (pm) {
    const name = projectName(pm[1]);
    const sub = pm[2] || '';
    // A sandbox session's token administers its own project and nothing else (see auth.ts).
    sessionAdmin = await verifySandboxToken(request, env.ADMIN_KEY, name);
    // Nothing is watched for free: every read needs the view key, the admin key, or this project's run/session token.
    const watch = () => { if (!sessionAdmin) view(); };

    // Remove the project for good: its Project object's storage, its repositories (main and every
    // agent's fork) and its GitHub link. A demo project that sandbox sessions and new projects copy (SANDBOX_TEMPLATES) stays.
    if (method === 'DELETE' && sub === '') {
      realAdmin(); // a run or session token (held by an agent's container) never gets this
      if (templateNames(env).includes(name)) throw new HttpError(403, `"${name}" is a template (SANDBOX_TEMPLATES) and cannot be deleted`);
      const artifacts = requireArtifacts(env);
      const stub = stubFor(env, name);
      let forks: string[] = [];
      if (await stub.exists()) {
        const r = await stub.destroy();
        if (r.busy) throw new HttpError(409, `"${name}" has verification runs in flight; try again when they finish`);
        forks = r.forks;
      } else if (!(await artifacts.get(name).then(() => true, (err: any) => { if (err?.code === 'NOT_FOUND') return false; throw err; }))) {
        // Neither the object nor a main repository: nothing to delete. (A repository left behind by a
        // failed creation, with no object, is still deleted below.)
        throw new HttpError(404, `no project "${name}"`);
      }
      await deleteProjectRepos(artifacts, name, forks);
      await ghLink().unlinkProject(name);
      return json({ deleted: name });
    }

    // The project's main, read-only: how its owner clones what the agents built.
    // Where the project's time goes: each serialized call's queue wait and run time.
    if (method === 'POST' && sub === '/warm') {
      realAdmin(); // a run or session token (held by an agent's container) never gets this
      return json(await (await requireProject(env, name)).warmRunners());
    }

    if (method === 'POST' && sub === '/sweep') {
      realAdmin();
      return json(await (await requireProject(env, name)).sweepNow());
    }

    if (method === 'GET' && sub === '/timings') {
      admin();
      return json(await (await requireProject(env, name)).timings());
    }

    if (method === 'GET' && sub === '/main') {
      admin();
      await requireProject(env, name);
      return json({ main_branch: 'main', ...(await mainFor(name)) });
    }

    if (method === 'POST' && sub === '/tasks') {
      admin();
      const b = await body();
      const stub = await requireProject(env, name);
      // 0 is a task that agents join later (converge run joins one agent at a time).
      const n = parseInt(b.agents, 10);
      let count = Math.min(MAX_AGENTS_PER_TASK, Math.max(0, Number.isFinite(n) ? n : 1));
      if (tokenOnly()) {
        count = Math.min(count, TOKEN_AGENTS_PER_TASK);
        if ((await stub.agentCount()) + count > TOKEN_AGENTS_PER_PROJECT) throw new HttpError(429, `at most ${TOKEN_AGENTS_PER_PROJECT} agents in a project started by a run or sandbox token`);
      }
      const agents = [];
      for (let i = 0; i < count; i++) {
        const agent_id = generateId('a');
        const fork = await createAgentFork(env.ARTIFACTS, name, agent_id);
        await subscribePushes(env, forkName(name, agent_id));
        const { mcp_key } = await stub.addAgent('worker', agent_id, fork);
        agents.push({ agent_id, role: 'worker', remote: fork.remote, token: fork.token, token_expires_at: fork.expiresAt, ...(await mainFor(name)), mcp_url: mcpUrl(name), mcp_key, connect: connectLines(agent_id, mcpUrl(name), mcp_key) });
      }
      const task = await stub.createTask({
        task_id: generateId('t'),
        title: b.title || 'Task',
        description: b.description || '',
        mode: b.mode === 'compete' ? 'compete' : 'split',
        accept: Array.isArray(b.accept) ? b.accept.filter((a: unknown) => typeof a === 'string' && a.trim()).slice(0, 20) : [],
        agents: agents.map((a) => ({ agent_id: a.agent_id, fork_remote: a.remote, fork_token: a.token })),
      });
      return json({ task_id: task.task_id, main_branch: task.main_branch, agents });
    }

    const jm = sub.match(/^\/tasks\/([^/]+)\/agents$/);
    if (method === 'POST' && jm) {
      admin();
      const b = await body();
      const stub = await requireProject(env, name);
      const taskId = decodeURIComponent(jm[1]);
      if (!(await stub.hasTask(taskId))) throw new HttpError(404, `no task ${taskId} in ${name}`);
      // from: take over a stalled worker (its fork is the checkpoint we continue from).
      const from = typeof b.from === 'string' && b.from ? b.from : '';
      if (from && !(await stub.isWorker(from))) throw new HttpError(404, `no worker ${from} in ${name}`);
      if (tokenOnly() && (await stub.agentCount()) >= TOKEN_AGENTS_PER_PROJECT) throw new HttpError(429, `at most ${TOKEN_AGENTS_PER_PROJECT} agents in a project started by a run or sandbox token`);
      const agent_id = generateId('a');
      const fork = await createAgentFork(env.ARTIFACTS, name, agent_id, from ? forkName(name, from) : name);
      await subscribePushes(env, forkName(name, agent_id));
      const { mcp_key } = await stub.addAgent('worker', agent_id, fork);
      const joined = await stub.joinTask(taskId, { agent_id, fork_remote: fork.remote, fork_token: fork.token }, from || undefined);
      return json({
        task_id: taskId,
        main_branch: joined.main_branch,
        ...(from ? { took_over_from: from } : {}),
        agent: { agent_id, role: 'worker', remote: fork.remote, token: fork.token, token_expires_at: fork.expiresAt, ...(await mainFor(name)), mcp_url: mcpUrl(name), mcp_key, connect: connectLines(agent_id, mcpUrl(name), mcp_key) },
      });
    }

    if (method === 'POST' && sub === '/config') {
      admin();
      const b = await body();
      const cfg = projectConfig(b);
      if (!Object.keys(cfg).length) throw new HttpError(400, 'nothing to configure: test_command, test_timeout_s, check_claims, auto_land, tracks, targets, leases, signing');
      await (await requireProject(env, name)).configure(cfg);
      return json({ ok: true });
    }

    if (method === 'POST' && sub === '/audit') {
      // The aios broker's report of what each contained agent tried and what aios allowed.
      admin();
      const b = await body();
      const events = Array.isArray(b.events) ? b.events.filter((e: any) => e && ['Contained', 'Acted', 'Rewound'].includes(e.type)).slice(0, 200) : [];
      if (!events.length) throw new HttpError(400, 'want {events:[{type:"Contained"|"Acted"|"Rewound",...}]}');
      return json(await (await requireProject(env, name)).audit(events));
    }

    if (method === 'POST' && sub === '/reviewers') {
      admin();
      const stub = await requireProject(env, name);
      const agent_id = generateId('a');
      const { mcp_key } = await stub.addAgent('reviewer', agent_id);
      return json({ agent_id, role: 'reviewer', ...(await mainFor(name)), mcp_url: mcpUrl(name), mcp_key, connect: connectLines(agent_id, mcpUrl(name), mcp_key) });
    }

    // The transparency log over the project's signed receipts: its signed tree head and the proofs (engine log.cpp).
    if (method === 'GET' && (sub === '/log' || /^\/log\/(inclusion|consistency|leaves)$/.test(sub))) {
      watch();
      const r = await (await requireProject(env, name)).readLog(sub, url.search);
      return json(r.body, r.status);
    }
    // The operator gives or replaces an agent's signing key (one lost or leaked).
    const keyRoute = sub.match(/^\/agents\/([^/]+)\/key$/);
    if (method === 'POST' && keyRoute) {
      admin();
      const b = await body();
      return json(await (await requireProject(env, name)).setAgentKey(keyRoute[1], String(b.key || '')));
    }

    if (method === 'GET' && sub === '/state') {
      const at = url.searchParams.get('at');
      watch();
      const stub = await requireProject(env, name);
      if (at !== null) {
        const seq = Number(at);
        if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'at must be a non-negative integer');
        return shown(env, await stub.stateAt(seq));
      }
      return shown(env, await stub.getProjectState());
    }

    const cyc = sub.match(/^\/agents\/([^/]+)\/cycles$/);
    if (method === 'GET' && cyc) {
      watch();
      return shown(env, await (await requireProject(env, name)).agentCycles(decodeURIComponent(cyc[1])));
    }

    const diffm = sub.match(/^\/agents\/([^/]+)\/cycles\/diff$/);
    if (method === 'GET' && diffm) {
      watch();
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) {
        throw new HttpError(400, 'from and to must be cycle numbers (0 = where the agent started)');
      }
      return shown(env, await (await requireProject(env, name)).cycleDiff(decodeURIComponent(diffm[1]), from, to));
    }

    if (method === 'GET' && sub === '/sql') {
      view();   // the view key itself, never a run token: one heavy query would hold the project's one-threaded engine
      const q = url.searchParams.get('q') || '';
      if (!q) throw new HttpError(400, 'q is required: one SELECT or SHOW, e.g. SHOW TABLES FROM converge');
      return shown(env, await (await requireProject(env, name)).readSql(q));
    }

    if (method === 'GET' && sub === '/jail') {
      admin();   // it starts a runner container: not for a view key, which is shared widely
      return json(await (await requireProject(env, name)).jailReport());
    }

    const chdiff = sub.match(/^\/changes\/([^/]+)\/diff$/);
    if (method === 'GET' && chdiff) {
      watch();
      return shown(env, await (await requireProject(env, name)).changeDiff(decodeURIComponent(chdiff[1])));
    }

    const rewindAgentm = sub.match(/^\/agents\/([^/]+)\/rewind$/);
    if (method === 'POST' && rewindAgentm) {
      admin();
      const b = await body();
      const cycle = Number(b.cycle);
      if (!Number.isInteger(cycle) || cycle < 1) throw new HttpError(400, 'cycle must be a positive integer');
      return json(await (await requireProject(env, name)).rewindAgent(decodeURIComponent(rewindAgentm[1]), cycle));
    }

    // The project's runs on Cloudflare (converge-sandbox keeps them), in the local platform's GET /runs shape.
    if (method === 'GET' && sub === '/runs') {
      watch();
      if (!env.SANDBOX) return json({ runs: [] });
      const r = await env.SANDBOX.fetch(`https://converge-sandbox/__sandbox/runs?project=${encodeURIComponent(name)}`, { headers: { 'X-Admin-Key': env.ADMIN_KEY || '' } });
      if (!r.ok) throw new HttpError(502, `converge-sandbox answered ${r.status}`);
      return new Response(await r.text(), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
    }

    // Start a run from the dashboard: agents planned from a plain request and run in a container on Cloudflare
    // (converge-sandbox), on a Workers AI model, holding a token for this project alone that expires. The admin key
    // starts one on any project; a sandbox visitor's session token on its own sandbox- project, held to the
    // session's caps there (converge-sandbox: one run at a time, 3 agents, the session's allowance).
    if (method === 'POST' && sub === '/runs') {
      const session = !verifyAdminKey(request, env.ADMIN_KEY, open(env)) && (await verifySessionToken(request, env.ADMIN_KEY, name));
      if (!session) realAdmin();
      if (!env.SANDBOX) throw new HttpError(503, 'runs on Cloudflare are not set up (no SANDBOX binding)');
      await requireProject(env, name);
      const b = await body();
      const req = typeof b.request === 'string' ? b.request.trim().slice(0, 2000) : '';
      if (req.length < 6) throw new HttpError(400, 'say what the agents should do');
      const expires_at = Math.floor(Date.now() / 1000) + 2 * 3600;
      const token = await runToken(env.ADMIN_KEY || '', name, expires_at);
      const r = await env.SANDBOX.fetch('https://converge-sandbox/__sandbox/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY || '' },
        // main_remote (no token): the run's sandbox may reach only that git host, the providers and the registries.
        body: JSON.stringify({ project: name, token, expires_at, session, request: req, model: b.model, agents: b.agents, budget: b.budget, main_remote: (await mainReadAccess(env.ARTIFACTS, name).catch(() => null))?.remote || '' }),
      });
      const text = await r.text();
      return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
    }

    // Bring home to GitHub: main's commits go to a new branch on the repository it came from, and a pull request opens.
    if (method === 'GET' && sub === '/github') {
      realAdmin(); // a run or session token (held by an agent's container) never gets this
      return json({ link: await ghLink().projectLink(name) });
    }
    if (method === 'POST' && sub === '/github/pr') {
      realAdmin();
      const link = await ghLink().projectLink(name);
      if (!link) throw new HttpError(404, 'this project did not come from GitHub');
      if (!env.SANDBOX) throw new HttpError(503, 'no SANDBOX binding: cannot push');
      const st: any = await (await requireProject(env, name)).getProjectState();
      const headCommit = st?.project?.main_head || '';
      if (!headCommit || headCommit === link.base) throw new HttpError(409, 'nothing has landed since the import');
      const branch = `converge/${name}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      const m = await mainFor(name);
      const tok = await ghLink().tokenFor(link.installation_id, undefined, undefined, link.repo);
      const r = await env.SANDBOX.fetch('https://converge-sandbox/__sandbox/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY || '' },
        body: JSON.stringify({ src: m.main_remote, src_token: m.main_token, dst: `https://github.com/${link.repo}.git`, dst_token: tok, branch, commit: headCommit }),
      });
      const pj: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new HttpError(502, `could not push to GitHub: ${pj.error || r.status}`);
      const landed = (st?.landings || []).filter((l: any) => l.type === 'Landed').length;
      const tasks = (st?.tasks || []).map((t: any) => `- ${t.title}`).slice(-20).join('\n');
      const pr = await ghLink().openPr(link.installation_id, link.repo, branch, link.branch,
        `converge: ${landed} change${landed === 1 ? '' : 's'} from ${name}`,
        `Changes made by agents on converge and checked before they landed (tests, each task's done-when check, scope). Each landing has a signed receipt in \`refs/notes/converge\`.\n\n${tasks}\n\nBoard: ${url.origin}/?project=${encodeURIComponent(name)}`);
      return json({ ok: true, branch, pr });
    }

    if (method === 'POST' && sub === '/rewind') {
      realAdmin(); // a run or session token (held by an agent's container) never gets this
      const b = await body();
      const commit = typeof b.commit === 'string' ? b.commit : '';
      if (!commit) throw new HttpError(400, 'commit is required');
      return json(await (await requireProject(env, name)).rewindMain(commit));
    }

    if (method === 'POST' && sub === '/undo') {
      realAdmin();
      const b = await body();
      const seq = Number(b.seq);
      if (!Number.isInteger(seq) || seq < 1) throw new HttpError(400, 'seq (the operation to take back) is required');
      return json(await (await requireProject(env, name)).undo(seq));
    }

    if (method === 'GET' && sub === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'Expected WebSocket upgrade');
      watch();
      // The object caps sockets per address and per project; it needs the address the Worker saw.
      const headers = new Headers(request.headers);
      headers.set('X-Converge-Net', clientNet(request));
      return (await requireProject(env, name)).fetch(new Request(request, { headers }));
    }
    throw new HttpError(404, 'Not Found');
  }

  // An agent waiting on its change (checks, the merge train) asks once here instead of polling status.
  const wm = url.pathname.match(/^\/mcp\/([^/]+)\/wait$/);
  if (wm && method === 'POST') {
    const key = extractMcpKey(request);
    if (!key) return json({ error: 'Unauthorized' }, 401);
    const b = await body();
    const r = await (await requireProject(env, projectName(wm[1]))).waitFor(key, String(b.change_id || ''), Number(b.timeout_ms) || 25_000);
    return r ? json(r) : json({ error: 'Unauthorized' }, 401);
  }

  const mm = url.pathname.match(/^\/mcp\/([^/]+)$/);
  if (mm) {
    // Streamable HTTP without a server-initiated stream: GET/DELETE must be 405, not 404.
    if (method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, { Allow: 'POST' });
    const name = projectName(mm[1]);
    // Bearer / X-MCP-Key only: never accept credentials from the query string or other roles' headers.
    const key = extractMcpKey(request);
    if (!key) return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized: missing Bearer token' } }, 401);
    const res = await (await requireProject(env, name)).handleMcp(key, await request.text());
    // Notifications are accepted with 202 and no body (MCP Streamable HTTP).
    if (res.status === 202 || !res.body) return new Response(null, { status: 202, headers: CORS });
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  throw new HttpError(404, 'Not Found');
}

/**
 * Pull (project, agent, ref, commit) out of an Artifacts push event. Event subscriptions deliver an
 * envelope `{ type, source, payload, metadata }`; fields inside are matched leniently, and anything we
 * cannot read is logged in full so a format change shows up in `wrangler tail` instead of vanishing.
 */
export function parsePushEvent(body: any): { project: string; agent: string; ref: string; commit: string } | null {
  const src = body?.source ?? {};
  const pl = body?.payload ?? body?.data ?? {};
  const repo: unknown = pl.repo_name ?? pl.repoName ?? pl.repo ?? src.repo_name ?? src.repoName ?? src.repo ?? body?.repo_name ?? body?.repoName;
  const commit: unknown = pl.after ?? pl.new_oid ?? pl.newOid ?? pl.commit ?? pl.head ?? body?.after;
  const ref: unknown = pl.ref ?? pl.ref_name ?? pl.refName ?? 'refs/heads/main';
  if (typeof repo !== 'string' || typeof commit !== 'string' || !repo.includes('--')) return null;
  const sep = repo.indexOf('--');
  return { project: repo.slice(0, sep), agent: repo.slice(sep + 2), ref: String(ref), commit };
}

/** Stop the runners idle past IDLE_MS; returns how many it stopped of how many were idle. */
async function sweepRunners(env: Env): Promise<{ idle: number; stopped: number; tracked: number }> {
  const watch = env.RUNNERWATCH.get(env.RUNNERWATCH.idFromName('all'));
  const names = await watch.idle(IDLE_MS);
  const done = await Promise.all(names.map((n) => (env.RUNNER.get(env.RUNNER.idFromName(n)) as unknown as { reap(): Promise<void> }).reap().then(() => true, () => false)));
  await watch.forget(names.filter((_, i) => done[i]));
  if (names.length) console.log(`runner watchdog: stopped ${done.filter(Boolean).length} of ${names.length} idle runners`);
  return { idle: names.length, stopped: done.filter(Boolean).length, tracked: await watch.known() };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err: any) {
      const status = statusFor(err);
      // A failure we did not phrase ourselves (an engine, Artifacts or Durable Object error) stays in the log: its
      // text can carry internals or a credential. The caller gets a reference to find it there.
      const known = err instanceof HttpError || (status < 500 || (status !== 500 && err?.code));
      const ref = crypto.randomUUID().slice(0, 8);
      if (status >= 500) console.error(`[${ref}] ${request.method} ${new URL(request.url).pathname}:`, redactSecrets(String(err?.stack || err), [env.ADMIN_KEY, env.VIEW_KEY, env.ENGINE_SHARED_KEY]));
      const message = known ? redactSecrets(String(err?.message || 'Internal Server Error'), [env.ADMIN_KEY, env.VIEW_KEY, env.ENGINE_SHARED_KEY]) : `internal error (ref ${ref})`;
      return json({ error: message }, status);
    }
  },

  /** Every 5 minutes: stop any runner container nobody has used for 12 minutes (the platform's own sleep timer was seen not to fire). */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await sweepRunners(env);
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      let body: any = msg.body;
      try {
        if (typeof body === 'string') body = JSON.parse(body);
        if (body?.type && body.type !== 'cf.artifacts.repo.pushed') {
          msg.ack();
          continue;
        }
        const push = parsePushEvent(body);
        if (!push || /^0+$/.test(push.commit)) {
          // Main itself, a deleted branch, or a shape we do not recognise: log it, never retry forever.
          if (!push) console.warn('artifacts event ignored:', JSON.stringify(body).slice(0, 2000));
          msg.ack();
          continue;
        }
        await stubFor(env, push.project).onPush({ agent: push.agent, ref: push.ref, commit: push.commit });
        msg.ack();
      } catch (err) {
        console.error('push event failed, will retry:', err, JSON.stringify(body).slice(0, 500));
        msg.retry();
      }
    }
  },
};
