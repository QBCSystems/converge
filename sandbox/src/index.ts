// converge-sandbox: runs converge's agent teams on Cloudflare, one container per run, and the public sandbox.
//
//   a run started from converge's dashboard ─► converge ─► this Worker ─► SandboxBox (a Durable Object + one container:
//       sandbox/image/entry.mjs plans the request with agents/plan.mjs and runs agents/swarm.mjs on it)
//                                                                     └─► /__ai/<run>/v1  Workers AI, metered and capped
//   the container ─► converge (admin of its ONE project, by a token that expires)
//
// The public sandbox: a visitor picks a demo, converge makes a throwaway project forked from it and a token that
// administers that project alone, and the visitor lands on converge's own dashboard for it. A run they start there
// comes back here like any other, held to the session's caps (SESSION_AI_USD in all, at most 3 agents, one at a time).
//
// What a container can do: write inside itself, reach converge, the AI proxy, package registries and the model
// providers' APIs. It holds no admin key, no account token and no one else's key.
import { Container } from '@cloudflare/containers';
// Required for outbound handlers (a sandbox calling converge and the AI proxy in-process).
export { ContainerProxy } from '@cloudflare/containers';
import { DurableObject } from 'cloudflare:workers';
import { landingPage } from './pages.ts';

export interface Env {
  BOX: DurableObjectNamespace<SandboxBox>;
  LIMITS: DurableObjectNamespace<Limits>;
  CONVERGE: Fetcher;           // service binding to the converge Worker
  CONVERGE_URL: string;
  ADMIN_KEY: string;          // secret: converge's admin key (creates sessions, signs the session tokens)
  AI_TOKEN: string;           // secret: a Cloudflare API token that can only run Workers AI
  ACCOUNT_ID: string;
  SANDBOX_ENABLED?: string;
  SANDBOX_TEMPLATES?: string;  // the converge projects a session may start from, comma-separated (the same list converge has): none unless set
  SESSION_AI_USD?: string;
  DAILY_AI_USD?: string;
  SESSIONS_PER_IP_HOUR?: string;
  SESSIONS_PER_HOUR?: string;   // all addresses together (default 60): a botnet's many addresses still hit this
}

/** Models offered free on Workers AI: tool-calling, answered fast at low reasoning effort. Prices per M tokens. */
export const MODELS = [
  { id: '@cf/openai/gpt-oss-120b', in: 0.35, out: 0.75 },
  { id: '@cf/zai-org/glm-5.3-flash', in: 0.15, out: 0.5 },
  { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', in: 0.44, out: 1.32 },
  { id: '@cf/moonshotai/kimi-k2.7-code', in: 0.95, out: 4 },
];
export const DEFAULT_MODEL = MODELS[0].id;
const templatesOf = (env: Env) => (env.SANDBOX_TEMPLATES || '').split(',').map((x) => x.trim()).filter(Boolean);
const MAX_AI_BODY = 2 << 20;   // a chat request's JSON, bytes: room for a long conversation, not for abuse
const SESSION_SECONDS = 3600;

// ---- small helpers -------------------------------------------------------------------------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const bearer = (req: Request) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
/** The admin key in X-Admin-Key, compared in constant time; never true when the key is unset. */
const isAdmin = (env: Env, req: Request) => !!env.ADMIN_KEY && same(req.headers.get('x-admin-key') || '', env.ADMIN_KEY);
/** Text from inside a container or another Worker, before it reaches a page or a log: no credential in it. */
const clean = (t: string) => String(t).replace(/(Authorization:\s*(Basic|Bearer)\s+)[A-Za-z0-9+/=._-]+/gi, '$1<redacted>').replace(/art_v\d+_[A-Za-z0-9_?=.-]+/g, '<token>').replace(/\b\d{9,12}\.[0-9a-f]{64}\b/g, '<token>')
  .replace(/\b(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<token>').replace(/(\/\/)[^\/@\s"'<>]+@/g, '$1');

/** A run's token for the AI proxy alone (a run's converge token is for its project, made by converge). */
async function aiTokenFor(env: Env, id: string, exp: number): Promise<string> {
  return `${exp}.${await hmacHex(env.ADMIN_KEY, `ai|${id}|${exp}`)}`;
}
async function aiTokenValid(env: Env, token: string, id: string): Promise<boolean> {
  if (!env.ADMIN_KEY) return false;   // an unset key would sign for anyone
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m || Number(m[1]) < Math.floor(Date.now() / 1000)) return false;
  return same(m[2], await hmacHex(env.ADMIN_KEY, `ai|${id}|${m[1]}`));
}

// ---- Worker ------------------------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // The deployment's own addresses are set in wrangler.jsonc; until they are, say so rather than fail somewhere deeper.
    if (/[<>]/.test(`${env.CONVERGE_URL}${env.ACCOUNT_ID}`)) return json({ error: 'converge-sandbox is not configured: set CONVERGE_URL and ACCOUNT_ID in sandbox/wrangler.jsonc' }, 503);

    if (path.startsWith('/__ai/')) return json({ error: 'not found' }, 404);   // the proxy is reached from inside a sandbox only
    if (path === '/__sandbox/health') return json({ ok: true, enabled: env.SANDBOX_ENABLED === '1' && !!env.ADMIN_KEY });
    // Every cookie, token and session hangs off the admin key: without it, nothing is served (fail closed).
    if (!env.ADMIN_KEY) return json({ error: 'Sandbox is not configured.' }, 503);

    if (path === '/__sandbox/new' && request.method === 'POST') return newSession(request, env, url);
    if (path === '/__sandbox/run' && request.method === 'POST') return startRun(request, env, url);
    if (path === '/__sandbox/push' && request.method === 'POST') return pushToGitHub(request, env, url);
    // Admin only: what a project's latest run is doing inside its container (the supervisor's, swarm's and agents' logs).
    if (path === '/__sandbox/runlogs' && isAdmin(env, request)) {
      const id = await env.LIMITS.get(env.LIMITS.idFromName('global')).lastRun(url.searchParams.get('project') || '');
      if (!id) return json({ error: 'no run for that project' }, 404);
      return new Response(await env.BOX.get(env.BOX.idFromName(`run-${id}`)).logs(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    // Admin only (converge's GET /api/projects/:p/runs): a project's runs, newest first. Never starts a container.
    if (path === '/__sandbox/runs' && request.method === 'GET') {
      if (!isAdmin(env, request)) return json({ error: 'unauthorized' }, 401);
      return json({ runs: await listRuns(env, url.searchParams.get('project') || '') });
    }
    if (request.method === 'GET' && path === '/') return html(landingPage(env.SANDBOX_ENABLED === '1', env.CONVERGE_URL, templatesOf(env)));
    return json({ error: 'not found' }, 404);
  },
};

async function newSession(request: Request, env: Env, url: URL): Promise<Response> {
  if (env.SANDBOX_ENABLED !== '1') return json({ error: 'Sandbox is switched off for now.' }, 503);
  const templates = templatesOf(env);
  if (!templates.length) return json({ error: 'No starting projects are set up (SANDBOX_TEMPLATES).' }, 503);
  let template = templates[0];
  try {
    const b: any = await request.json();
    if (typeof b.template === 'string') template = b.template;
  } catch { /* the first */ }
  if (!templates.includes(template)) return json({ error: `template: one of ${templates.join(', ')}` }, 400);

  // One person can hold a whole IPv6 /64: count the network (the first four groups), not the single address.
  const rawIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const ip = rawIp.includes(':') ? rawIp.split(':').slice(0, 4).join(':') : rawIp;
  const limits = env.LIMITS.get(env.LIMITS.idFromName('global'));
  const admitted = await limits.admit(ip, Number(env.SESSIONS_PER_IP_HOUR) || 3, Number(env.SESSIONS_PER_HOUR) || 60);
  if (!admitted.ok) return json({ error: admitted.reason }, 429);

  const id = randomHex(8);
  // converge makes the throwaway project (a fork of the demo's main) and a token for it alone.
  const res = await env.CONVERGE.fetch(`${env.CONVERGE_URL}/api/sandbox/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': env.ADMIN_KEY },
    body: JSON.stringify({ id, template, ttl_s: SESSION_SECONDS }),
  });
  if (!res.ok) {
    // converge's answer is for our log, not the visitor's page.
    console.error('sandbox/new: converge refused', res.status, clean((await res.text()).slice(0, 300)));
    return json({ error: `could not create your project (${res.status}); please try again in a minute` }, 502);
  }
  const made: any = await res.json();
  // The visitor's board: converge's dashboard on their project, holding the session token as its key (the dashboard
  // moves a key out of the address bar into the tab's storage).
  const dashboard = `${env.CONVERGE_URL}/?project=${encodeURIComponent(made.project)}&admin_key=${encodeURIComponent(made.token)}`;
  return json({ ok: true, project: made.project, expires_at: made.expires_at, dashboard }, 201);
}

// ---- a run started from converge's dashboard (admin) -------------------------------------------------
// converge sends the project, a token for that project alone, and the request. One container plans and runs it
// (sandbox/image/entry.mjs: converge's planner and swarm), on a Workers AI model, capped at the run's budget.

async function startRun(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAdmin(env, request)) return json({ error: 'unauthorized' }, 401);
  let b: any;
  try { b = await request.json(); } catch { return json({ error: 'body must be JSON' }, 400); }
  const project = String(b.project || '');
  const req = String(b.request || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project) || !/^\d{9,12}\.[0-9a-f]{64}$/.test(String(b.token || '')) || req.length < 6) return json({ error: 'project, token and request are required' }, 400);
  const model = MODELS.some((x) => x.id === b.model) ? String(b.model) : DEFAULT_MODEL;
  const limits = env.LIMITS.get(env.LIMITS.idFromName('global'));
  // A run a sandbox visitor started (converge says so: b.session): one at a time, at most 3 agents, and all the
  // session's runs together within SESSION_AI_USD.
  const session = b.session === true;
  let agents = Math.min(Math.max(Math.round(Number(b.agents) || 3), 1), 6);
  let budget = Math.min(Math.max(Number(b.budget) || 0.5, 0.1), 2);
  if (session) {
    if (!project.startsWith('sandbox-')) return json({ error: 'a session run is for a sandbox project' }, 400);
    const earlier = (await limits.runs(project, 50)) as unknown as Array<RunRecord & { spent: number }>;
    if (earlier.some((r) => r.phase === 'starting' || r.phase === 'running')) return json({ error: 'a run is already under way in this sandbox: wait for it to finish' }, 409);
    const left = (Number(env.SESSION_AI_USD) || 0.3) - earlier.reduce((n, r) => n + (r.spent || 0), 0);
    if (left < 0.02) return json({ error: 'this sandbox has used its free allowance' }, 429);
    agents = Math.min(agents, 3);
    budget = Math.round(left * 10000) / 10000;
  }
  const id = randomHex(8);
  const expires_at = Number(b.expires_at) || Math.floor(Date.now() / 1000) + 7200;
  await limits.setCap(id, budget, project);
  const started = Date.now();
  await limits.noteRun(project, { id, request: req, agents, budget, model, started, phase: 'starting', tasks: [], error: '' });
  const cfg: SessionCfg = {
    id, project, template: '', token: String(b.token), expires_at, origin: url.origin, converge: env.CONVERGE_URL,
    // Its project's git remote (no token): the run's container clones from that host, so it goes on the allow list.
    main_remote: /^https:\/\/[^\s@]+$/.test(String(b.main_remote || '')) ? String(b.main_remote) : '',
    boxToken: randomHex(24), model, aiToken: await aiTokenFor(env, id, expires_at), run: { request: req, agents, budget },
  };
  try {
    const r = await env.BOX.get(env.BOX.idFromName(`run-${id}`)).startRun(cfg);
    // Errors come from inside the container: strip anything that looks like a credential before they reach a page.
    await limits.updateRun(id, r.ok ? { phase: 'running', tasks: (r.result?.tasks || []).slice(0, 50) } : { phase: 'failed', error: clean(r.error || '').slice(0, 400), ended: Date.now() });
    return json(r.ok ? { ok: true, run: id, model, agents, budget, ...r.result } : { error: clean(r.error || '') }, r.ok ? 200 : 502);
  } catch (e: any) {
    const error = `could not start the run: ${clean(String(e?.message || e)).slice(0, 200)}`;
    await limits.updateRun(id, { phase: 'failed', error, ended: Date.now() });
    return json({ error }, 502);
  }
}

/**
 * A project's runs in the shape the local platform's GET /runs gives (scripts/lib/local-run.mjs listRuns), so the board
 * reads both alike. The phase comes from the run's container state only (getState: nothing is started to answer).
 */
async function listRuns(env: Env, project: string): Promise<any[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project)) return [];
  const limits = env.LIMITS.get(env.LIMITS.idFromName('global'));
  const recs = (await limits.runs(project, 20)) as unknown as Array<RunRecord & { spent: number }>;   // the RPC type is too deep to infer
  return Promise.all(recs.map(async (r) => {
    let phase = r.phase;
    let error = r.error || '';
    let landed = r.landed || 0;
    let stopped = r.stopped || '';
    if (phase === 'starting' || phase === 'running') {
      const box = await env.BOX.get(env.BOX.idFromName(`run-${r.id}`)).runPhase().catch(() => null);
      if (box?.phase === 'failed') { phase = 'failed'; error = clean(box.error || '').slice(0, 400); }
      else if (box?.phase === 'ended' && phase === 'running') { phase = 'done'; landed = box.landed || 0; stopped = clean(box.stopped || '').slice(0, 200); }
      // A run whose start never answered (the request to converge-sandbox died) is over once its container is.
      else if (box?.phase === 'ended' && Date.now() - r.started > 10 * 60_000) { phase = 'failed'; error ||= 'the run did not start'; }
      if (phase !== r.phase) await limits.updateRun(r.id, { phase, error, ended: Date.now(), landed, stopped });
    }
    const ended = phase === 'done' || phase === 'failed' || phase === 'stopped';
    return {
      id: r.id, request: r.request, phase, agents: r.agents, budget: r.budget, model: r.model || '', tasks: r.tasks || [], dropped: [],
      started: r.started, resumed: 0, ended: ended ? (r.ended || Date.now()) : 0,
      spent: r.spent, landed, of: (r.tasks || []).length, minutes: ended && r.ended ? Math.round((r.ended - r.started) / 60_000) : null,
      stopped: stopped || null, error, where: 'cloudflare', metered: true,
      workstreams: {}, keys: {}, escalated: {}, paused: {}, rules: null, leads: [],
    };
  }));
}

// ---- bring home: push a project's main to a new branch on GitHub (admin, from converge) -------------------------
async function pushToGitHub(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAdmin(env, request)) return json({ error: 'unauthorized' }, 401);
  let b: any;
  try { b = await request.json(); } catch { return json({ error: 'body must be JSON' }, 400); }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(String(b.dst || '')) || /\/\.{1,2}(\/|\.git$)/.test(String(b.dst)) || !/^converge\/[\w.-]+$/.test(String(b.branch || '')) || !b.src || !b.src_token || !b.dst_token) return json({ error: 'src, src_token, dst (github), dst_token and branch are required' }, 400);
  const id = randomHex(8);
  const cfg: SessionCfg = {
    id, project: 'push', template: '', token: '', expires_at: Math.floor(Date.now() / 1000) + 900, main_remote: '', origin: url.origin, converge: env.CONVERGE_URL,
    boxToken: randomHex(24), model: DEFAULT_MODEL, push: { src: String(b.src), src_token: String(b.src_token), dst: String(b.dst), dst_token: String(b.dst_token), branch: String(b.branch), commit: String(b.commit || '') },
  };
  const box = env.BOX.get(env.BOX.idFromName(`push-${id}`));
  const r = await box.pushRun(cfg);
  // The push container's output can name the remotes it was given (with their tokens): cleaned first.
  return json(r.ok ? { ok: true } : { error: clean(r.error || '') }, r.ok ? 200 : 502);
}

// ---- the free path: Workers AI, metered and capped -------------------------------------------------------

function openAiError(status: number, message: string): Response {
  return json({ error: { message, type: 'sandbox_limit', code: status } }, status);
}

async function aiProxy(request: Request, env: Env, url: URL): Promise<Response> {
  const m = /^\/__ai\/([a-f0-9]{16})\/v1\/(models|chat\/completions)$/.exec(url.pathname);
  if (!m) return json({ error: 'not found' }, 404);
  const [, id, route] = m;
  const limits = env.LIMITS.get(env.LIMITS.idFromName('global'));
  const tok = bearer(request);
  // The run's own AI token: made for this run id, and expiring with it.
  if (!(await aiTokenValid(env, tok, id))) return openAiError(401, 'this run has ended');

  if (route === 'models' && request.method === 'GET') {
    return json({ object: 'list', data: MODELS.map((x) => ({ id: x.id, object: 'model', owned_by: 'cloudflare-workers-ai' })) });
  }
  if (route !== 'chat/completions' || request.method !== 'POST') return json({ error: 'not found' }, 404);

  // Refused before anything is spent: an allowance already used up, or a body no conversation needs.
  const pre = await limits.aiAllow(id, Number(env.SESSION_AI_USD) || 0.3, Number(env.DAILY_AI_USD) || 15);
  if (!pre.ok) return openAiError(429, pre.reason || 'the free allowance is used up');
  if (Number(request.headers.get('content-length')) > MAX_AI_BODY) return openAiError(413, 'the request is too large for the free path');
  let body: any;
  try {
    const text = await request.text();
    if (text.length > MAX_AI_BODY) return openAiError(413, 'the request is too large for the free path');
    body = JSON.parse(text);
  } catch { return openAiError(400, 'body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return openAiError(400, 'body must be a JSON object');
  // The container's agents name the model without Workers AI's leading "@" (see envFor): either form is the same model.
  const spec = MODELS.find((x) => x.id === body.model || x.id === `@${body.model}`);
  if (!spec) return openAiError(400, `${body.model}: not on the free path. Free models: ${MODELS.map((x) => x.id).join(', ')}.`);
  body.model = spec.id;
  // Workers AI wants each message's content as plain text; the universal agent (like OpenAI's own API) may send it as a list of
  // parts. Flatten the text parts (an image part cannot be served here, so it becomes a marker).
  const flat = (c: any): any => Array.isArray(c)
    ? c.map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : p?.type === 'image_url' ? '[image omitted]' : '')).filter(Boolean).join('\n')
    : (c === null || c === undefined ? '' : c);   // an assistant turn that only calls tools has content null; Workers AI wants a string
  if (Array.isArray(body.messages)) body.messages = body.messages.map((m: any) => ({ ...m, content: flat(m.content) }));
  // These models think at length by default and spend their whole output on it: ask for little.
  if (!body.reasoning_effort) body.reasoning_effort = 'low';
  body.max_tokens = Math.min(Number(body.max_tokens) || 8192, 16000);
  // Only what the reservation below accounts for: one completion, of at most max_tokens.
  delete body.max_completion_tokens;
  delete body.n;
  delete body.best_of;
  const stream = body.stream === true;
  if (stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };

  // Reserve the worst case before the call and settle to the real usage after: a client that drops the connection
  // before the final usage chunk is still charged (it used to escape the cap entirely, the model having run).
  const est = ((Math.ceil(JSON.stringify(body.messages || []).length / 3)) * spec.in + body.max_tokens * spec.out) / 1e6;
  // Checked and reserved in one step in the Limits object, so parallel calls each see the others' reservations.
  const allow = await limits.aiReserve(id, est, Number(env.SESSION_AI_USD) || 0.3, Number(env.DAILY_AI_USD) || 15);
  if (!allow.ok) return openAiError(429, allow.reason || 'the free allowance is used up');
  const settle = (actualUsd: number) => (actualUsd - est !== 0 ? limits.aiCharge(id, actualUsd - est) : Promise.resolve());
  const upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.AI_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (upstream.status >= 400) {
    // What Workers AI refused, with the shape of the first messages (no content text): for diagnosis.
    const probe = (body.messages || []).slice(0, 3).map((m: any) => ({ role: m.role, content: Array.isArray(m.content) ? `array(${m.content.map((x: any) => typeof x === 'string' ? 'str' : (x?.type || Object.keys(x || {}).join('+'))).join(',')})` : typeof m.content, keys: Object.keys(m).join(',') }));
    console.log('workers-ai refused', upstream.status, JSON.stringify(probe), (await upstream.clone().text()).slice(0, 300));
  }
  const cost = (u: any) => ((Number(u?.prompt_tokens) || 0) * spec.in + (Number(u?.completion_tokens) || 0) * spec.out) / 1e6;
  // Workers AI refused the call: nothing ran, give the reservation back.
  if (upstream.status >= 400) {
    await settle(0);
    return new Response(await upstream.text(), { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' } });
  }
  if (!stream || !upstream.body) {
    const text = await upstream.text();
    try { await settle(cost(JSON.parse(text).usage)); } catch { /* no usage reported: the reservation stands */ }
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' } });
  }
  // Streaming: the chunks go straight through; the usage the model reports at the end settles the reservation when the
  // stream finishes (no background work to outlive the response).
  const dec = new TextDecoder();
  let tail = '';
  let usage: any = null;
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      tail += dec.decode(chunk, { stream: true });
      const lines = tail.split('\n');
      tail = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try { const j = JSON.parse(line.slice(5)); if (j.usage) usage = j.usage; } catch { /* partial */ }
      }
    },
    async flush() { if (usage) await settle(cost(usage)); },   // no usage (the client left early): the reservation stands
  });
  return new Response(upstream.body.pipeThrough(meter), { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store' } });
}

// ---- what a sandbox may call, answered in-process ----------------------------------------------------------------------
// A container does not call our Workers by their public addresses (that kills it). It calls made-up hostnames; the
// platform hands those requests to these handlers, which answer through a service binding or a direct call. So the
// sandbox never touches a public Worker address, and only these two places are reachable this way.

const INTERNAL_CONVERGE = 'http://converge.internal';
const INTERNAL_AI = 'http://ai.internal';

async function toConverge(request: Request, env: Env): Promise<Response> {
  const t0 = Date.now();
  try { const r = await toConvergeInner(request, env); console.log('outbound converge', request.method, new URL(request.url).pathname, r.status, `${Date.now() - t0}ms`); return r; }
  catch (e: any) { console.log('outbound converge FAILED', clean(String(e?.stack || e)).slice(0, 400)); return new Response(JSON.stringify({ error: 'converge did not answer; try again' }), { status: 502 }); }
}
async function toConvergeInner(request: Request, env: Env): Promise<Response> {
  const src = new URL(request.url);
  const target = new URL(src.pathname + src.search, env.CONVERGE_URL);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await env.CONVERGE.fetch(new Request(target, { method: request.method, headers: request.headers, body: hasBody ? request.body : undefined, redirect: 'manual' }));
  // converge answers with its own public address (an agent's mcp_url, for one): point the sandbox back at this door.
  if ((res.headers.get('content-type') || '').includes('json')) {
    const text = (await res.text()).split(env.CONVERGE_URL).join(INTERNAL_CONVERGE);
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    return new Response(text, { status: res.status, headers });
  }
  return res;
}
async function toAi(request: Request, env: Env): Promise<Response> {
  return aiProxy(request, env, new URL(request.url));
}

// ---- guards ------------------------------------------------------------------------------------------------

export class Limits extends DurableObject<Env> {
  /** At most N new sessions per address per hour, and M from everyone together. Last hour's counts are dropped. */
  async admit(ip: string, perHour: number, allPerHour = 60): Promise<{ ok: boolean; reason?: string }> {
    const hour = Math.floor(Date.now() / 3_600_000);
    if ((await this.ctx.storage.get<number>('ip-hour')) !== hour) {
      // A new hour: the counts of earlier ones (keys sort by hour, zero-padded) go, so they never pile up.
      for (;;) {
        const old = [...(await this.ctx.storage.list({ prefix: 'ip:', end: `ip:${String(hour).padStart(10, '0')}`, limit: 128 })).keys()];
        if (!old.length) break;
        await this.ctx.storage.delete(old);
      }
      await this.ctx.storage.put('ip-hour', hour);
    }
    const key = `ip:${String(hour).padStart(10, '0')}:${ip}`;
    const allKey = `ip:${String(hour).padStart(10, '0')}:*`;
    const [mine, all] = await Promise.all([this.ctx.storage.get<number>(key), this.ctx.storage.get<number>(allKey)]);
    if ((mine || 0) + 1 > perHour) return { ok: false, reason: `That is ${perHour} sandboxes this hour from your address. Please try again later.` };
    if ((all || 0) + 1 > allPerHour) return { ok: false, reason: 'Many people are trying converge right now. Please try again later.' };
    await this.ctx.storage.put({ [key]: (mine || 0) + 1, [allKey]: (all || 0) + 1 });
    return { ok: true };
  }
  /** Free-path spending: per session and per day, in dollars. */
  /** A run's own spending cap (a dashboard run sets its budget; a visitor's session uses the default). */
  async setCap(id: string, usd: number, project = ''): Promise<void> {
    await this.ctx.storage.put(`cap:${id}`, usd);
    if (project) { await this.ctx.storage.put(`run:${id}`, project); await this.ctx.storage.put(`last:${project}`, id); }
  }
  async lastRun(project: string): Promise<string> {
    const last = await this.ctx.storage.get<string>(`last:${project}`);
    if (last) return last;
    for (const [k, v] of await this.ctx.storage.list<string>({ prefix: 'run:' })) if (v === project) return k.slice(4);
    return '';
  }
  /** A dashboard run's record (listRuns): `rr:<project>:<started, zero-padded>:<id>`, so a listing sorts by start. */
  async noteRun(project: string, rec: RunRecord): Promise<void> {
    const key = `rr:${project}:${String(rec.started).padStart(15, '0')}:${rec.id}`;
    await this.ctx.storage.put({ [key]: rec, [`rrk:${rec.id}`]: key });
  }
  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const key = await this.ctx.storage.get<string>(`rrk:${id}`);
    const rec = key ? await this.ctx.storage.get<RunRecord>(key) : undefined;
    if (key && rec) await this.ctx.storage.put(key, { ...rec, ...patch });
  }
  /** A project's latest runs, newest first, each with what it has spent on the free path so far. */
  async runs(project: string, limit = 20): Promise<Array<RunRecord & { spent: number }>> {
    const recs = [...(await this.ctx.storage.list<RunRecord>({ prefix: `rr:${project}:`, reverse: true, limit })).values()];
    const spent = await this.ctx.storage.get<number>(recs.map((r) => `s:${r.id}`));
    return recs.map((r) => ({ ...r, spent: Math.round((spent.get(`s:${r.id}`) || 0) * 10000) / 10000 }));
  }
  async aiAllow(id: string, sessionCap: number, dayCap: number): Promise<{ ok: boolean; reason?: string }> {
    const day = new Date().toISOString().slice(0, 10);
    const [s, d, cap] = await Promise.all([this.ctx.storage.get<number>(`s:${id}`), this.ctx.storage.get<number>(`d:${day}`), this.ctx.storage.get<number>(`cap:${id}`)]);
    if (cap) sessionCap = cap;
    if ((d || 0) >= dayCap) return { ok: false, reason: 'The free allowance for today is used up. Please try again tomorrow.' };
    if ((s || 0) >= sessionCap) return { ok: false, reason: 'This run has used its allowance.' };
    return { ok: true };
  }
  /** aiAllow and the charge of `usd` together (no await between them but storage, so no call slips in between). */
  async aiReserve(id: string, usd: number, sessionCap: number, dayCap: number): Promise<{ ok: boolean; reason?: string }> {
    const allow = await this.aiAllow(id, sessionCap, dayCap);
    if (allow.ok && usd > 0) await this.aiCharge(id, usd);
    return allow;
  }
  async aiCharge(id: string, usd: number): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.ctx.storage.put(`s:${id}`, ((await this.ctx.storage.get<number>(`s:${id}`)) || 0) + usd);
    await this.ctx.storage.put(`d:${day}`, ((await this.ctx.storage.get<number>(`d:${day}`)) || 0) + usd);
  }
}

// ---- one visitor's sandbox ---------------------------------------------------------------------------------------

interface RunRecord {
  id: string; request: string; agents: number; budget: number; model: string; started: number; ended?: number;
  phase: string; tasks: unknown[]; error: string; landed?: number; stopped?: string;
}

interface SessionCfg {
  id: string; project: string; template: string; token: string; expires_at: number;
  main_remote: string; origin: string; converge: string; boxToken: string; model: string; stage?: string; probe?: string;
  aiToken?: string; run?: { request: string; agents: number; budget: number };
  push?: { src: string; src_token: string; dst: string; dst_token: string; branch: string; commit: string };
}

/** What the sandbox may reach: converge, the AI proxy, package registries, and the model providers' own APIs. */
const PROVIDER_HOSTS = [
  'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'api.deepseek.com', 'openrouter.ai',
  'api.fireworks.ai', 'ollama.com', 'api.x.ai', 'api.groq.com', 'api.mistral.ai', 'api.together.xyz', 'api.cerebras.ai',
];
const REGISTRY_HOSTS = ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org'];
/** The two in-process doors (outboundByHost below): the allow list gates them too, so they must be on it. */
const INTERNAL_HOSTS = ['converge.internal', 'ai.internal'];
/** A push container (bring home) reaches GitHub, and the Artifacts host it clones from, and nothing else. */
const PUSH_HOSTS = ['github.com', 'codeload.github.com'];
/** Where every intercepted HTTPS connection's certificate comes from (interceptHttps): the container must trust it. */
const EGRESS_CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

/** The hosts one sandbox may reach: the doors, the providers and registries, and the git host of its project. */
function allowedHostsFor(cfg: SessionCfg): string[] {
  const hostOf = (u: string) => { try { return u ? new URL(u).hostname : ''; } catch { return ''; } };
  if (cfg.push) return [...PUSH_HOSTS, hostOf(cfg.push.src)].filter(Boolean);
  return [...INTERNAL_HOSTS, ...PROVIDER_HOSTS, ...REGISTRY_HOSTS, hostOf(cfg.main_remote)].filter(Boolean);
}

/**
 * What the container runs: the entry script with all its output kept in a file; if it ever ends (a crash, a
 * missing file, an out-of-memory kill) the same port keeps answering with that output and the exit code, so
 * the reason reaches the visitor and us through the platform instead of vanishing with the container.
 */
const WRAPPER = [
  'node /app/entry.mjs > /tmp/out.log 2>&1',
  'echo "[wrapper] entry.mjs ended with exit code $?" >> /tmp/out.log',
  `exec node -e "require('http').createServer((q,r)=>{r.statusCode=500;r.setHeader('x-sandbox-error','1');r.end(JSON.stringify({error:require('fs').readFileSync('/tmp/out.log','utf8').slice(-2500)}))}).listen(8080,'0.0.0.0')"`,
].join('; ');

/** Diagnosis (stage "idle", admin only): a sandbox that only answers, to see whether it stays alive on its own. */
const WRAPPER_IDLE = `exec node -e "const t0=Date.now();require('http').createServer((q,r)=>{r.statusCode=503;r.setHeader('x-sandbox-starting','1');r.end(JSON.stringify({phase:'idle',log:'alive for '+Math.round((Date.now()-t0)/1000)+'s'}))}).listen(8080,'0.0.0.0')"`;

/** Diagnosis (stage "curl", admin only): plain curl requests from inside the sandbox, results served live. */
const WRAPPER_CURL = [
  `node -e "require('http').createServer((q,r)=>{r.statusCode=503;r.setHeader('x-sandbox-starting','1');r.end(JSON.stringify({phase:'curl probe',log:require('fs').readFileSync('/tmp/out.log','utf8').slice(-900)}))}).listen(8080,'0.0.0.0')" &`,
  'sleep 2',
  `(for spec in "-4 https://api.cloudflare.com/cdn-cgi/trace" "-6 https://api.cloudflare.com/cdn-cgi/trace" "-4 http://converge.internal/health"; do echo "== curl $spec at $(date +%T)"; curl -sS -m 8 -o /dev/null -w "code=%{http_code} t=%{time_total}s\\n" $spec 2>&1; done; echo "== probes done at $(date +%T)") > /tmp/out.log 2>&1`,
  'sleep 3600',
].join('\n');

export class SandboxBox extends Container<Env> {
  // Built like the Runner, which is proven on this platform: the port 8080, the library starts and stops
  // the container, and this object owns exactly one start.
  override defaultPort = 8080;
  override sleepAfter = '30m';   // a run's agents work without inbound requests
  // Egress: no internet, except the hosts on the allow list (allowedHostsFor, set per session in begin()). With
  // interceptHttps every outbound HTTP and HTTPS request goes through the library's ContainerProxy (index.ts exports
  // it): the allow list is checked first, then outboundByHost answers converge.internal / ai.internal in-process,
  // and any other allowed host is fetched from the internet. HTTPS is re-signed by Cloudflare's CA (EGRESS_CA), which
  // envFor points node, git, curl and pip at. Live test still owed: a session starts and clones, npm/pip install,
  // a provider key answers, converge.internal / ai.internal answer, a push reaches GitHub, and any other host is 520.
  override enableInternet = false;
  override interceptHttps = true;
  override allowedHosts: string[] = [...INTERNAL_HOSTS, ...PROVIDER_HOSTS, ...REGISTRY_HOSTS];

  async begin(cfg: SessionCfg): Promise<{ ok: boolean; error?: string }> {
    await this.ctx.storage.put('cfg', cfg);
    await this.ctx.storage.delete('error');
    this.configure(cfg);
    // Started once, here, and waited for: the same way the Runner starts its container.
    try {
      const wrapper = cfg.stage === 'curl' ? WRAPPER_CURL : cfg.stage === 'idle' ? WRAPPER_IDLE : WRAPPER;
      await this.startAndWaitForPorts(8080, { portReadyTimeoutMS: 120_000 }, { entrypoint: ['sh', '-c', wrapper] });
      return { ok: true };
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 300);
      await this.ctx.storage.put('error', error);
      return { ok: false, error };
    }
  }

  /** A run: start the container, wait for its set-up, then hand it the request to plan and run. */
  async startRun(cfg: SessionCfg): Promise<{ ok: boolean; error?: string; result?: any }> {
    const started = await this.begin(cfg);
    if (!started.ok) return { ok: false, error: started.error };
    for (let i = 0; i < 90; i++) {
      const st = await this.status();
      if (st.phase === 'error') return { ok: false, error: st.error };
      if (st.phase === 'ready') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const r = await this.containerFetch('http://box/__sandbox/launch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.boxToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: cfg.run!.request, budget: cfg.run!.budget, agents: cfg.run!.agents }),
    }, 8080);
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: String(j.error || `the team did not launch (${r.status})`).slice(0, 400) };
    return { ok: true, result: { tasks: j.tasks || [], note: j.note || '' } };
  }

  /** Bring home: a container clones main and pushes it to a GitHub branch, then is thrown away. */
  async pushRun(cfg: SessionCfg): Promise<{ ok: boolean; error?: string }> {
    const started = await this.begin(cfg);
    if (!started.ok) return { ok: false, error: started.error };
    try {
      for (let i = 0; i < 120; i++) {
        const st = await this.status();
        if (st.phase === 'error') return { ok: false, error: st.error };
        if (st.phase === 'ready') return { ok: true };
        await new Promise((r) => setTimeout(r, 1500));
      }
      return { ok: false, error: 'the push did not finish within three minutes' };
    } finally {
      await this.ctx.storage.deleteAll().catch(() => {});
      await this.destroy().catch(() => {});
    }
  }

  /** Where a run stands, from the container's state alone (never starts one): failed, running, or ended. */
  async runPhase(): Promise<{ phase: 'none' | 'failed' | 'running' | 'ended'; error?: string; landed?: number; stopped?: string }> {
    const cfg = await this.ctx.storage.get<SessionCfg>('cfg');
    if (!cfg) return { phase: 'none' };
    const stored = await this.ctx.storage.get<string>('error');
    if (stored) return { phase: 'failed', error: stored };
    const st = await this.getState();
    if (st.status === 'healthy' || st.status === 'running') {
      if (cfg.expires_at * 1000 < Date.now()) return { phase: 'ended' };
      // The swarm is done once it says so (the container stays up a while after, for its logs).
      try {
        const r = await this.containerFetch('http://box/', { headers: { Authorization: `Bearer ${cfg.boxToken}` } }, 8080);
        const f = r.ok ? ((await r.json()) as any).finished : null;
        if (f) return { phase: 'ended', landed: Number(f.landed) || 0, stopped: String(f.stopped || '') };
      } catch { /* not answering this moment: still running */ }
      return { phase: 'running' };
    }
    if (st.status === 'stopped_with_code' && st.exitCode && st.exitCode !== 143) return { phase: 'failed', error: `the run's container stopped (exit code ${st.exitCode})` };
    return { phase: 'ended' };
  }

  async logs(): Promise<string> {
    const cfg = await this.ctx.storage.get<SessionCfg>('cfg');
    if (!cfg) return '(no run)';
    const st = await this.getState();
    if (st.status !== 'healthy' && st.status !== 'running') return `(the run's container is not running: ${st.status})`;   // never start a blank one
    try { return await (await this.containerFetch('http://box/__sandbox/logs', { headers: { Authorization: `Bearer ${cfg.boxToken}` } }, 8080)).text(); }
    catch (e: any) { return `(container not answering: ${String(e?.message || e)})`; }
  }

  /** The environment and the allow list for this session (set before every start). */
  private configure(cfg: SessionCfg): void {
    this.envVars = envFor(cfg);
    this.allowedHosts = allowedHostsFor(cfg);
  }

  async status(): Promise<{ phase: string; project?: string; error?: string; expires_at?: number; detail?: string; log?: string }> {
    const cfg = await this.ctx.storage.get<SessionCfg>('cfg');
    if (!cfg) return { phase: 'none' };
    if (cfg.expires_at * 1000 < Date.now()) { await this.destroy().catch(() => {}); return { phase: 'expired', project: cfg.project }; }
    const stored = await this.ctx.storage.get<string>('error');
    if (stored) return { phase: 'error', project: cfg.project, error: stored };

    const st = await this.getState();
    if (st.status === 'stopped_with_code') return { phase: 'error', project: cfg.project, error: `the sandbox stopped (exit code ${st.exitCode ?? '?'})` };
    if (st.status !== 'healthy' && st.status !== 'running') return { phase: 'starting', project: cfg.project, expires_at: cfg.expires_at };
    try {
      const r = await this.containerFetch('http://box/', { headers: { Authorization: `Bearer ${cfg.boxToken}` } }, 8080);
      // The entry script keeps answering with what went wrong rather than vanishing.
      if (r.headers.get('x-sandbox-error')) {
        const j: any = await r.json().catch(() => ({}));
        return { phase: 'error', project: cfg.project, error: String(j.error || 'the sandbox failed to start').slice(-1500) };
      }
      // Listening already, set-up not done yet: how far it has got.
      if (r.headers.get('x-sandbox-starting')) {
        const j: any = await r.json().catch(() => ({}));
        return { phase: 'starting', project: cfg.project, expires_at: cfg.expires_at, detail: String(j.phase || ''), log: String(j.log || '').slice(-900) };
      }
      if (r.ok) return { phase: 'ready', project: cfg.project, expires_at: cfg.expires_at };
    } catch { /* not answering yet */ }
    return { phase: 'starting', project: cfg.project, expires_at: cfg.expires_at };
  }

  // Why a run's container ended, for the dashboard and for us: a clean sleep is not an error.
  override async onStop(params: { exitCode: number; reason: string }): Promise<void> {
    console.log('sandbox stopped', JSON.stringify(params));
    if (params.exitCode !== 0 && params.exitCode !== 143) {
      await this.ctx.storage.put('error', `the sandbox stopped (exit ${params.exitCode}, ${params.reason})`);
    }
  }
  override onError(error: unknown): void {
    console.error('sandbox error', String((error as any)?.message || error));
  }

}

(SandboxBox as any).outboundByHost = { 'converge.internal': toConverge, 'ai.internal': toAi };

function envFor(cfg: SessionCfg): Record<string, string> {
  return {
    SANDBOX_BOX_TOKEN: cfg.boxToken,
    ...(cfg.stage ? { SANDBOX_STAGE: cfg.stage } : {}),
    ...(cfg.probe ? { SANDBOX_PROBE: cfg.probe } : {}),
    ...(cfg.push ? { SANDBOX_MODE: 'push', PUSH_SRC: cfg.push.src, PUSH_SRC_TOKEN: cfg.push.src_token, PUSH_DST: cfg.push.dst, PUSH_DST_TOKEN: cfg.push.dst_token, PUSH_BRANCH: cfg.push.branch, PUSH_COMMIT: cfg.push.commit } : {}),
    SANDBOX_PROJECT: cfg.project, SANDBOX_TOKEN: cfg.token, CONVERGE_URL: INTERNAL_CONVERGE,
    // Without the leading "@": aios hands a mind only model ids of letters, digits and . - _ : / (the AI proxy adds it back).
    AI_BASE: `${INTERNAL_AI}/__ai/${cfg.id}/v1`, AI_MODEL: cfg.model.replace(/^@/, ''),
    ...(cfg.aiToken ? { SANDBOX_AI_TOKEN: cfg.aiToken } : {}),
    // Workers AI models can think for minutes before the first byte: give the agents' calls room.
    AGENT_CALL_TIMEOUT: '300000', AGENT_CONNECT_TIMEOUT: '240000',
    SANDBOX_BUDGET: String(cfg.run?.budget || 0.5), SANDBOX_AGENTS: String(cfg.run?.agents || 3),
    CONVERGE_HOME: '/app/converge', HOME: '/root',
    // Every HTTPS connection is intercepted (SandboxBox.interceptHttps), so Cloudflare's CA is the one to trust.
    NODE_EXTRA_CA_CERTS: EGRESS_CA, GIT_SSL_CAINFO: EGRESS_CA, CURL_CA_BUNDLE: EGRESS_CA, SSL_CERT_FILE: EGRESS_CA,
    REQUESTS_CA_BUNDLE: EGRESS_CA, PIP_CERT: EGRESS_CA,
  };
}
