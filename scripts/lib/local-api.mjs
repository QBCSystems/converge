// The local-only dashboard helpers of scripts/dev-server.mjs: Cloudflare setup, the folder browser, the model picker,
// keys and GitHub. route() calls cloudflareRoutes and localRoutes where these routes always stood; each answers
// NEXT for a request that is not its own.

import { listDirs } from './sources.mjs';
import { modelProviders, modelList, keySettings, saveKey } from './local-run.mjs';
import { ROOT, ADMIN_KEY, httpError, send, readBody, readJson, safeEqual, requireAdmin } from './dev-context.mjs';
import { REMOTES, GH } from './git-host.mjs';
import { createProject } from './persist.mjs';
import { createPlanProgress } from './plan-progress.mjs';

const NEXT = Symbol('not a local-only route');

// Live progress of each project's plan check: the check runner's events go through applyPlanProgress, the board reads the snapshot.
const PLAN_PROGRESS = new Map();
function applyPlanProgress(project, event) {
  if (!PLAN_PROGRESS.has(project)) PLAN_PROGRESS.set(project, createPlanProgress());
  PLAN_PROGRESS.get(project).apply(event);
}
const planProgressOf = (project) => (PLAN_PROGRESS.get(project) || createPlanProgress()).snapshot();

import * as CF from './cloudflare.mjs';
import { setAsqlProvider } from './provider-store.mjs';

// ---- Cloudflare: the account and the deploy live with the host helper (scripts/lib/cloudflare.mjs) or directly
// in-process on host; the deployed Worker's projects are reached through /cloud/... here, with its admin key put in ----
async function helperCall(p, body, method = body ? 'POST' : 'GET') {
  if (!process.env.HOST_AGENTS_URL) {
    if (p === '/cloudflare/creds') return CF.creds();
    if (p === '/cloudflare') return method === 'POST' ? (CF.save(body), CF.status(ROOT)) : CF.status(ROOT);
    if (p === '/cloudflare/check') return (await CF.check(ROOT), CF.status(ROOT));
    if (p === '/cloudflare/deploy') return (CF.deploy(ROOT, body), CF.status(ROOT));
    if (p === '/cloudflare/log') return { log: CF.log(), job: CF.status(ROOT).job };
    if (p === '/cloudflare/oauth') return CF.startWranglerLogin();
    if (p === '/cloudflare/oauth-logout') return CF.wranglerLogout();
    if (p === '/cloudflare/workers-ai') {
      const c = CF.read();
      if (body?.on && !(c.api_token && c.account_id)) throw httpError(400, 'connect the Cloudflare account first');
      await setAsqlProvider('cloudflare', body?.on ? c.api_token : null, body?.on ? CF.WORKERS_AI_MODELS.map((m) => ({ model: m, host: CF.workersAiHost(c.account_id) })) : []);
      CF.markWorkersAi(body?.on);
      return CF.status(ROOT);
    }
    throw httpError(404, 'Not Found');
  }
  const r = await fetch(`${process.env.HOST_AGENTS_URL}${p}`, { method, headers: { 'X-Host-Token': process.env.HOST_AGENTS_TOKEN || '', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
    .catch(() => { throw httpError(503, 'the host helper is not answering (scripts/local.sh starts it)'); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(r.status >= 400 && r.status < 500 ? r.status : 502, j.error || `the host helper answered ${r.status}`);
  return j;
}
const CLOUD = { at: 0, url: '', key: '' };
async function cloudCreds() {
  if (Date.now() - CLOUD.at < 15_000) return CLOUD;
  const j = await helperCall('/cloudflare/creds').catch(() => ({}));
  return Object.assign(CLOUD, { at: Date.now(), url: j.worker_url || '', key: j.admin_key || '' });
}
const isLocalAdmin = (k) => Boolean(ADMIN_KEY && k && safeEqual(String(k), ADMIN_KEY));
async function proxyCloud(req, res, url) {
  const c = await cloudCreds();
  if (!c.url) throw httpError(404, 'no Cloudflare Worker connected (Keys → Cloudflare)');
  const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
  // This platform's admin is the owner: their requests carry the Worker's admin key. Anything else goes as it came.
  for (const h of ['x-admin-key', 'x-view-key', 'authorization']) {
    const v = req.headers[h];
    if (!v) continue;
    headers[h] = isLocalAdmin(String(v).replace(/^Bearer\s+/i, '')) ? (h === 'authorization' ? `Bearer ${c.key}` : c.key) : v;
  }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const r = await fetch(`${c.url}${url.pathname.slice('/cloud'.length)}${url.search}`, { method: req.method, headers, body, signal: AbortSignal.timeout(60_000) })
    .catch((e) => { throw httpError(502, `the Worker did not answer: ${e.message}`); });
  res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function cloudflareRoutes(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  if (pathname.startsWith('/cloud/')) return proxyCloud(req, res, url);
  if (pathname === '/api/cloudflare' || pathname.startsWith('/api/cloudflare/')) {
    requireAdmin(req);
    const sub = pathname.slice('/api/cloudflare'.length);
    if (!['', '/check', '/deploy', '/log', '/workers-ai', '/oauth', '/oauth-logout'].includes(sub)) throw httpError(404, 'Not Found');
    const j = await helperCall(`/cloudflare${sub}`, method === 'POST' ? await readJson(req) : undefined, method);
    CLOUD.at = 0; // a new account, key or deploy: ask again
    return send(res, 200, j);
  }
  return NEXT;
}

async function localRoutes(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  // ---- The folder browser for a new project: one level per call, on the owner's machine (through the host helper
  // when the platform runs in a container), never above the home folder ----
  if (method === 'GET' && pathname === '/api/folders') {
    requireAdmin(req);
    const at = url.searchParams.get('path') || '';
    if (!process.env.HOST_AGENTS_URL) return send(res, 200, listDirs(at));
    const r = await fetch(`${process.env.HOST_AGENTS_URL}/dirs`, { method: 'POST', headers: { 'X-Host-Token': process.env.HOST_AGENTS_TOKEN || '', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: at }), signal: AbortSignal.timeout(15_000) })
      .catch(() => { throw httpError(503, 'the host helper is not answering (scripts/local.sh starts it)'); });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status === 404 || r.status === 400 || r.status === 403 ? r.status : 502, j.error || `the host helper answered ${r.status}`);
    return send(res, 200, j);
  }

  // ---- The plan check's live progress: the snapshot of the reducer, for the board ----
  if (method === 'GET' && pathname === '/api/plan-progress') {
    requireAdmin(req);
    return send(res, 200, { progress: planProgressOf(url.searchParams.get('project') || '') });
  }

  // ---- The model picker: the providers a run can use, and each one's models listed live by the provider ----
  if (method === 'GET' && pathname === '/api/models/providers') { requireAdmin(req); return send(res, 200, await modelProviders(ROOT)); }
  if (method === 'GET' && pathname === '/api/models') {
    requireAdmin(req);
    const provider = url.searchParams.get('provider') || '';
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(provider)) throw httpError(400, 'provider');
    return send(res, 200, await modelList(ROOT, provider, url.searchParams.get('where') === 'mac' ? 'mac' : 'container', url.searchParams.get('fresh') === '1'));
  }

  // ---- Keys: API keys for the providers and the CLIs' logins (saved through the host helper; never sent back) ----
  if (method === 'GET' && pathname === '/api/keys') { requireAdmin(req); return send(res, 200, await keySettings()); }
  if (method === 'POST' && pathname === '/api/keys') { requireAdmin(req); await saveKey(await readJson(req)); return send(res, 200, await keySettings()); }

  // ---- GitHub: the owner's own GitHub App (one-click manifest flow), installed on the repositories they pick ----
  const ghBack = (q) => send(res, 302, undefined, { Location: `/?github=${q}` });
  if (method === 'GET' && pathname === '/api/github/status') { requireAdmin(req); return send(res, 200, GH.status()); }
  if (method === 'POST' && pathname === '/api/github/setup') { requireAdmin(req); return send(res, 200, GH.setup(`http://${req.headers.host}`)); }
  // One trip: GitHub creates the app, then straight on to installing it (where the repositories are picked), then back
  // here with the installation, whose repositories the dashboard brings in without asking for them again.
  if (method === 'GET' && pathname === '/api/github/created') {
    try { await GH.created(url.searchParams.get('state') || '', url.searchParams.get('code') || ''); } catch (e) { return ghBack(e.message === 'expired' ? 'expired' : `failed&why=${encodeURIComponent(String(e.message).slice(0, 160))}`); }
    const install = GH.status().install_url;
    return install ? send(res, 302, undefined, { Location: install }) : ghBack('created');
  }
  if (method === 'GET' && pathname === '/api/github/installed') {
    const id = /^\d{1,20}$/.test(url.searchParams.get('installation_id') || '') ? url.searchParams.get('installation_id') : '';
    return ghBack(`installed${id ? `&installation_id=${id}` : ''}`);
  }
  if (method === 'GET' && pathname === '/api/github/repos') { requireAdmin(req); return send(res, 200, await GH.repos()); }
  if (method === 'POST' && pathname === '/api/github/import') {
    requireAdmin(req);
    const b = await readJson(req);
    const repo = String(b.repo || '');
    const installation = Number(b.installation_id);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !installation) throw httpError(400, 'repo (owner/name) and installation_id are required');
    const already = GH.projectFor(repo);
    if (already) return send(res, 200, { project: already, repo, existing: true });
    const name =String(b.name || '').trim() || repo.split('/')[1].toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const token = await GH.tokenFor(installation, repo);
    const p = await createProject(name, { kind: 'git', url: `https://github.com/${repo}.git`, token, github: repo });
    REMOTES.set(name, null); // the link below gets fresh tokens; the clone's one-hour token is not kept
    GH.setLink(name, { installation_id: installation, repo, base: p.main.branch || 'main' });
    return send(res, 201, { project: name, repo, branch: p.main.branch });
  }
  return NEXT;
}

export { NEXT, applyPlanProgress, planProgressOf, helperCall, CLOUD, cloudCreds, isLocalAdmin, proxyCloud, cloudflareRoutes, localRoutes };
