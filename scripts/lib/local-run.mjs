// "Start a run" on the local platform: the request planned into tasks (agents/plan.mjs, one model call),
// then agents/swarm.mjs runs them here, in the background, its output under DATA/runs/<project>-<id>/.
// The agents are fenced (bubblewrap on Linux, Seatbelt on macOS: agents/fenced.mjs) and so are the checks
// (converge-jail: Landlock on Linux, Seatbelt on macOS), so runs work here on either.
//
// Planning and the agents both use the model picked for the run, and no other. An API provider spends the owner's
// key for it (~/.converge/config.json); the run's budget caps the agents' spending (the planning call is not counted in it).
import fs from 'node:fs';
import { rememberLanded, rememberRefused } from './plan-memory.mjs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { modelsOf, readAgentConfig } from './models.mjs';
import { swarmCheckArgs } from './swarm-args.mjs';
import { readAsql, setAsqlProvider, dropAsqlModel } from './provider-store.mjs';
import { findUniversalAgent, missingUniversalAgent, httpError, killGroup, providerConfig } from '../../agents/common.mjs';
import { agentDir, readAgentLog, agentSummary } from './agent-log.mjs';
import { agentSandbox } from '../../agents/fenced.mjs';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Subscription CLIs, as agents: run here with your own logins, or through scripts/host-agents.mjs.
const CLIS = [
  { provider: 'claude-cli', bin: 'claude', label: 'Claude Code', login: () => cliLogin('claude-cli', 'claude', ['auth', 'status'], (r) => { try { return JSON.parse(r.stdout).loggedIn === true; } catch { return false; } }), how: 'sign in with `claude auth login` where it runs' },
  // Gemini CLI is discontinued; Antigravity's CLI (agy) runs on the Mac (its install and login live there).
  { provider: 'codex-cli', bin: 'codex', label: 'Codex', login: () => cliLogin('codex-cli', 'codex', ['login', 'status'], (r) => /logged in/i.test(r.stdout + r.stderr)) || fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json')), how: 'sign in with `codex login` where it runs' },
  { provider: 'cursor-cli', bin: 'cursor-agent', label: 'Cursor', login: () => cliLogin('cursor-cli', 'cursor-agent', ['status'], (r) => /\blogged in\b/i.test(r.stdout + r.stderr) && !/not logged in/i.test(r.stdout + r.stderr)), how: 'sign in with `cursor-agent login` where it runs' },
];
// No login is copied anywhere: a CLI runs with its own sign-in where it is installed, and is asked for it by its own
// status command (the CLI knows where it keeps its login: a keychain, a file, a token). Answers are kept for a short
// while: the picker asks for every CLI each time it draws.
const LOGINS = new Map(); // provider -> { at, ok }
function cliLogin(provider, bin, args, isIn) {
  const hit = LOGINS.get(provider);
  if (hit && Date.now() - hit.at < 30_000) return hit.ok;
  let ok = false;
  try {
    const r = runCli(bin, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    ok = r.status === 0 && Boolean(isIn(r));
  } catch { /* not runnable: not signed in as far as anything can tell */ }
  LOGINS.set(provider, { at: Date.now(), ok });
  return ok;
}
// A run's agents outlive this server on Linux and macOS (their own process group). On Windows a detached process has no
// console, so every program it starts (git, node, the jail) opened a window of its own: there it shares this one, hidden.
const DETACH = process.platform !== 'win32';
const HOST = { url: process.env.HOST_AGENTS_URL || '', token: process.env.HOST_AGENTS_TOKEN || '' };

// The API providers a key can be set for under Keys (the ones the universal agent speaks), where to get a key, and
// the model to list with it when there is an obvious one.
export const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', keys: 'https://platform.deepseek.com/api_keys', model: 'deepseek-v4-flash' },
  { id: 'anthropic', label: 'Anthropic', keys: 'https://console.anthropic.com/settings/keys', model: 'claude-sonnet-5-5' },
  { id: 'openai', label: 'OpenAI', keys: 'https://platform.openai.com/api-keys', model: '' },
  { id: 'gemini', label: 'Google Gemini', keys: 'https://aistudio.google.com/apikey', model: '' },
  { id: 'openrouter', label: 'OpenRouter', keys: 'https://openrouter.ai/keys', model: '', host: 'https://openrouter.ai/api/v1' },
  { id: 'fireworks', label: 'Fireworks', keys: 'https://fireworks.ai/account/api-keys', model: '', host: 'https://api.fireworks.ai/inference/v1' },
  { id: 'nebius', label: 'Nebius AI Studio', keys: 'https://tokenfactory.nebius.com', model: 'nvidia/llama-3.1-nemotron-70b-instruct', host: 'https://api.studio.nebius.ai/v1' },
  { id: 'xai', label: 'xAI', keys: 'https://console.x.ai', model: '', host: 'https://api.x.ai/v1' },
  { id: 'ollama', label: 'Ollama Cloud', keys: 'https://ollama.com/settings/keys', model: '', host: 'https://ollama.com' },
  { id: 'cloudflare', label: 'Cloudflare Workers AI', keys: '', model: '', managed: 'cloudflare' }, // the Cloudflare tab's token and account
];

/** Keys → Providers and CLI logins: what is set in ASQL (never the keys themselves). */
export async function keySettings() {
  let c = {};
  // converge's own keys only (ASQL): never another tool's config file, so a fresh start has no keys until you add them.
  try { c = await readAsql(); } catch { /* ASQL down: no keys */ }
  const providers = PROVIDERS.map((p) => ({ ...p, has_key: Boolean(c.apiKeys?.[p.id]), accounts: (c.accounts || []).filter((a) => a.provider === p.id).length,
    models: (c.models || []).filter((m) => m.provider === p.id).map((m) => m.model) }));
  const clis = CLIS.filter((k) => here(k.bin)).map((k) => ({ id: k.provider, label: k.label, ready: Boolean(k.login()), how: k.how }));
  return { providers, clis, mac: (await hostClis()).map((k) => k.label) };
}
/** Saves a key (or a CLI login) through ASQL / host helper. */
export async function saveKey(b) {
  if (b.cli) throw err(400, 'CLI logins are not stored: sign the CLI in where it runs');
  const known = PROVIDERS.find((p) => p.id === b.provider);
  if (!known) throw err(400, 'unknown provider');
  if (known.id === 'cloudflare') throw err(400, 'Workers AI is set up under Keys → Cloudflare');
  if (HOST.url) {
    try {
      return await host('/keys', { provider: known.id, key: b.key || null, model: b.model || (b.keep_key ? '' : known.model) || '', host: known.host || '', ...(b.keep_key ? { keep_key: true } : {}), ...(b.drop_model ? { drop_model: String(b.drop_model) } : {}) });
    } catch (e) {
      if (e.status !== 503) throw e;
    }
  }
  if (b.drop_model) {
    await dropAsqlModel(known.id, String(b.drop_model));
  } else {
    const models = (b.key || b.keep_key) && b.model ? [{ model: String(b.model), host: known.host || '' }] : [];
    await setAsqlProvider(known.id, b.key || null, models, Boolean(b.keep_key));
  }
  return { ok: true };
}
async function host(pathname, body) {
  if (!HOST.url) throw err(503, 'no helper for agents on the host (scripts/local.sh starts it)');
  const r = await fetch(`${HOST.url}${pathname}`, { method: body ? 'POST' : 'GET', headers: { 'X-Host-Token': HOST.token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw err(r.status === 404 ? 404 : 502, j.error || `the host helper answered ${r.status}`);
  return j;
}
let hostInfo = { at: 0, clis: [] };
async function hostClis() {
  if (Date.now() - hostInfo.at < 30_000) return hostInfo.clis;
  try { hostInfo = { at: Date.now(), clis: (await host('/info')).clis || [] }; } catch { hostInfo = { at: Date.now(), clis: [] }; }
  return hostInfo.clis;
}
// Where a CLI is installed, or '' when it is not. Windows has no `command -v`: `where` finds it, and an npm-installed CLI
// is a .cmd there (claude.cmd, codex.cmd), which only a shell can start.
const WHERE = new Map();
function whereIs(bin) {
  if (WHERE.has(bin)) return WHERE.get(bin);
  let at = '';
  if (process.platform === 'win32') {
    const r = spawnSync('where.exe', [bin], { encoding: 'utf8', windowsHide: true });
    const hits = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    at = hits.find((p) => /\.(exe|cmd|bat)$/i.test(p)) || '';
  } else {
    const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
    at = r.status === 0 ? String(r.stdout).trim() : '';
  }
  WHERE.set(bin, at);
  return at;
}
const here = (bin) => Boolean(whereIs(bin));
/** Runs an installed CLI with fixed arguments (no user input reaches them), through cmd.exe when it is a .cmd/.bat. */
function runCli(bin, args, opts) {
  const at = whereIs(bin) || bin;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(at)) {
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[`"${at}"`, ...args].join(' ')}"`], { ...opts, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawnSync(at, args, { ...opts, windowsHide: true });
}

/** The models a run may use: ASQL's list for the API providers with a key or a
 *  free-account pool here, then the subscription CLIs in this container and on the Mac. None is a default: a run
 *  uses the one its owner picked.
 *  One that cannot run yet says why (`missing`). */
export async function runOptions() {
  let c = {};
  // converge's own keys only (ASQL): never another tool's config file, so a fresh start has no keys until you add them.
  try { c = await readAsql(); } catch { /* ASQL down: no keys */ }
  const usable = (p) => p && !/-cli$/.test(p) && (c.apiKeys?.[p] || (c.accounts || []).some((a) => a.provider === p));
  const seen = new Set();
  const list = [];
  const add = (m) => {
    const id = `${m.provider}/${m.model}`;
    if (!m.model || !usable(m.provider) || seen.has(id)) return;
    seen.add(id);
    const free = (c.accounts || []).some((a) => a.provider === m.provider && a.free);
    list.push({ id, provider: m.provider, model: m.model, host: m.host || c.providers?.[m.provider]?.host || PROVIDERS.find((x) => x.id === m.provider)?.host || '', where: 'container', group: 'API models', label: `${m.model.split('/').pop()} · ${m.provider}${free ? ' (free accounts)' : ''}` });
  };
  for (const m of c.models || []) add(m);
  for (const k of CLIS) {
    if (!here(k.bin)) continue;
    list.push({ id: `${k.provider}@container`, provider: k.provider, model: '', host: '', where: 'container', group: 'Subscription CLIs, in the container', label: `${k.label} · in the container`, missing: k.login() ? '' : k.how });
  }
  for (const k of await hostClis()) {
    const meta = CLIS.find((x) => x.provider === k.provider);
    list.push({ id: `${k.provider}@mac`, provider: k.provider, model: '', host: '', where: 'mac', group: `Subscription CLIs (host machine, ${fenceNote()})`, label: `${meta?.label || k.label} · Host`, missing: '' });
  }
  return list;
}
const err = httpError;

/** The model picker's left side: every provider a run could use, where it runs, and whether it can run now. */
export async function modelProviders(root) {
  let c = {};
  try { c = await readAsql(); } catch { /* ASQL down: no keys */ }
  const out = [];
  const known = new Set();
  for (const p of PROVIDERS) {
    known.add(p.id);
    const key = Boolean(c.apiKeys?.[p.id]);
    const free = (c.accounts || []).filter((a) => a.provider === p.id).length;
    out.push({ id: p.id, label: p.label, kind: 'api', where: 'container', ready: key || free > 0, note: key ? 'your key' : free ? `${free} free accounts` : p.managed ? 'turn on under Keys → Cloudflare' : 'needs a key (Keys → Providers)' });
  }
  // Providers the agent config knows that converge has no row for (a gateway, a local server): usable all the same.
  for (const id of new Set([...Object.keys(c.apiKeys || {}), ...(c.models || []).map((m) => m.provider)])) {
    if (!id || known.has(id) || /-cli$/.test(id)) continue;
    known.add(id);
    out.push({ id, label: id, kind: 'api', where: 'container', ready: Boolean(c.apiKeys?.[id] || (c.accounts || []).some((a) => a.provider === id)), note: 'from your agent config' });
  }
  for (const k of CLIS) {
    if (!here(k.bin)) continue;
    const ok = Boolean(k.login());
    out.push({ id: k.provider, label: k.label, kind: 'cli', where: 'container', ready: ok, note: ok ? 'subscription · sandboxed in the container' : k.how });
  }
  for (const k of await hostClis()) out.push({ id: k.provider, label: CLIS.find((x) => x.provider === k.provider)?.label || k.label, kind: 'cli', where: 'mac', ready: true, note: `subscription · on host machine (${fenceNote()})` });
  return { providers: out, default: null }; // no model is chosen for the owner
}
/** The models one provider serves now (live), for the picker's right side. */
export async function modelList(root, provider, where = 'container', fresh = false) {
  if (where === 'mac') return host(`/models?provider=${encodeURIComponent(provider)}${fresh ? '&fresh=1' : ''}`);
  return modelsOf(universalAgent(root), provider, { fresh });
}

const universalAgent = findUniversalAgent;
// Agents started here, and those the host helper starts, get this machine's fence (Seatbelt or bubblewrap).
const fenceNote = () => (agentSandbox().ok ? `sandboxed (${agentSandbox().kind})` : 'unsandboxed');

/** swarm.mjs --check-only: the problems its preflight found (none: the plan can run). */
async function preflight(args, root, env, signal) {
  try { await run(process.execPath, args, { cwd: root, env, timeout: 300_000, maxBuffer: 8 << 20, signal }); return []; }
  catch (e) {
    const text = String(e.stderr || '') + String(e.stdout || '');
    const lines = text.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4));
    return lines.length ? lines : [text.trim().split('\n').pop() || String(e.message)];
  }
}

// The runs this server started, per project, newest last: what the dashboard shows above the work (the request,
// how far it has got, what it has spent). Spending and the end come from swarm.mjs's own status.json and report.json.
const RUNS = new Map(); // project -> [{ id, request, phase, agents, budget, tasks, dropped, error, started, ended, dir }]
let HISTORY = ''; // DATA/runs/history.json: the conversation survives a restart

/** Loads the runs of earlier lives of this server; one that was under way then has ended with it. */
export function initRuns(dataDir) {
  HISTORY = path.join(dataDir, 'runs', 'history.json');
  try {
    for (const [project, list] of Object.entries(JSON.parse(fs.readFileSync(HISTORY, 'utf8')))) {
      RUNS.set(project, list.map((r) => ({ ...r, abort: new AbortController(), pid: 0, exited: r.where === 'mac' ? Boolean(r.exited) : true, // a run on the Mac outlives this container
        phase: ['planning', 'checking the plan', 'replanning'].includes(r.phase) ? 'failed' : r.phase,
        error: ['planning', 'checking the plan', 'replanning'].includes(r.phase) ? 'the server restarted while planning' : r.error })));
    }
  } catch { /* none yet */ }
}
/** Whether a run is over. Its stored phase stays "running" after the swarm finishes: the report (or the process
 *  having exited) is what says so, as the run list works it out. */
const hasEnded = (r) => Boolean(r.exited || r.endedAt || r.report || (r.dir && fs.existsSync(path.join(r.dir, 'report.json'))));

/** What the planner is doing now, for the dashboard while there are no tasks yet: the newest line of the run's plan log. */
function lastPlanStep(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, 'plan-log.jsonl'), 'utf8').trim().split('\n');
    return String(JSON.parse(lines[lines.length - 1]).text || '').slice(0, 200);
  } catch { return ''; }
}

/** When a run that has no end time on record ended: its report's time (the swarm writes it last), else now. Before this,
 *  an end time was taken when the run list was first read after the run ended, so the dashboard's clock showed how long
 *  until someone looked (4:18 for a run that took 63 s). */
const endedAtOnDisk = (r) => { try { return fs.statSync(path.join(r.dir, 'report.json')).mtimeMs; } catch { return Date.now(); } };

/** A project removed: its runs go too (refused while one is still going). */
/** Called with the project's name whenever a run's swarm ends (dev-server: the folder is synced then, so a landing
 *  whose own sync was missed still reaches the folder). */
const endedHooks = [];
export const onRunEnded = (fn) => endedHooks.push(fn);
const runEnded = (project) => {
  // The tasks that landed, with the request they came from: the planner's memory of what works here (lib/plan-memory.mjs).
  const r = (RUNS.get(project) || []).at(-1);
  if (r?.dir && r.request) {
    try {
      const tasks = JSON.parse(fs.readFileSync(path.join(r.dir, 'tasks.json'), 'utf8'));
      const report = JSON.parse(fs.readFileSync(path.join(r.dir, 'report.json'), 'utf8'));
      const landed = tasks.filter((t) => report.per_task?.[t.key]?.landed);
      rememberLanded(project, r.request, landed).catch(() => { /* ASQL down */ });
    } catch { /* no plan or no report */ }
  }
  for (const fn of endedHooks) { try { fn(project); } catch { /* the hook's own problem */ } }
};
/** The run going in `project` (planning, checking, running or stopping), or undefined. */
export const runGoing = (project) => (RUNS.get(project) || []).find((r) => ['planning', 'checking the plan', 'replanning', 'running', 'stopping'].includes(r.phase) && !hasEnded(r));
export function forgetRuns(project) {
  if (runGoing(project)) throw err(409, `a run is still going in ${project}: stop it first`);
  RUNS.delete(project);
  persist();
}
function persist() {
  if (!HISTORY) return;
  const out = Object.fromEntries([...RUNS].map(([p, list]) => [p, list.slice(-50).map(({ abort, pid, ...r }) => r)]));
  try { fs.mkdirSync(path.dirname(HISTORY), { recursive: true }); fs.writeFileSync(HISTORY, JSON.stringify(out)); } catch { /* best effort */ }
}

/** A lead's report: the result of its last "done" step in its universal agent's log (empty while it works). */
export function leadReport(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'universal-agent.log'), 'utf8'); } catch { return ''; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const call = /^\[[^\]]+\] \[step (\d+)\] done\(/.exec(lines[i]);
    if (!call) continue;
    const res = lines.slice(i + 1).find((l) => l.startsWith(`[`) && l.includes(`[step ${call[1]}] -> `));
    if (!res) return '';
    const start = lines.indexOf(res);
    const more = [];
    for (const l of lines.slice(start + 1)) { if (l.startsWith('[')) break; more.push(l); } // the result runs on until the next log line
    const body = [res.split(' -> ').slice(1).join(' -> '), ...more.slice(0, 12)];
    return body.join('\n').trim().slice(0, 900);
  }
  return '';
}

/** GET /api/projects/:p/runs: this project's runs, newest first, with what each has spent. */
export async function listRuns(project) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const out = [];
  for (const r of (RUNS.get(project) || []).slice().reverse()) {
    let status = r.dir ? read(path.join(r.dir, 'status.json')) : null;
    let report = r.dir ? read(path.join(r.dir, 'report.json')) : null;
    let swarm = r.dir ? read(path.join(r.dir, 'swarm.json')) : null;
    let planned = r.dir ? read(path.join(r.dir, 'tasks.json')) : null;
    if (r.where === 'mac' && r.phase === 'running' && !r.exited) {
      // A run on the Mac: its status from the helper there (gone with a Mac restart: then it has ended).
      try { const h = await host(`/runs/${r.id}`); status = h.status; report = h.report; swarm = h.swarm || swarm; planned = h.tasks || planned; if (h.exited && !report) r.exited = true; if (report) { r.report = report; persist(); } }
      catch (e) { if (e.status === 404) { r.exited = true; persist(); } }
    }
    if (r.where === 'mac') { report = report || r.report || null; }
    // The swarm's report says how it ended; a swarm that ended without one (killed) ended all the same.
    const ended = report || r.exited;
    // A Continue the swarm's preflight refused (not enough balance for the budget, agents already running...) started
    // nothing: the run is where it was, stopped and continuable, with the reason, not "failed without a report".
    const refused = ended && !report && r.continued ? refusedContinue(r.dir) : '';
    const phase = ended ? (r.stopRequested || report?.stopped || refused ? 'stopped' : report ? 'done' : 'failed') : r.stopRequested && r.phase === 'running' ? 'stopping' : r.phase;
    const feedback = r.dir && fs.existsSync(path.join(r.dir, 'feedback.txt')) ? fs.readFileSync(path.join(r.dir, 'feedback.txt'), 'utf8').trim() : (r.feedback || '');
    let planUsage = r.dir ? read(path.join(r.dir, 'plan-usage.json')) : null;
    const planSpent = Number(planUsage?.spent_usd || 0);
    const rawSpent = report?.spent_usd ?? status?.spent ?? 0;
    const totalSpent = +((rawSpent > 0 && rawSpent >= planSpent ? rawSpent : rawSpent + planSpent)).toFixed(4);
    out.push({ id: r.id, request: r.request, phase, agents: r.agents, budget: r.budget, model: r.model || '', tasks: r.tasks, dropped: r.dropped, feedback, started: r.started, resumed: r.resumed || 0, planStep: ['planning', 'checking the plan', 'replanning'].includes(phase) ? lastPlanStep(r.dir) : '', ended: ended ? (r.endedAt ||= endedAtOnDisk(r)) : 0,
      spent: totalSpent, landed: report?.landed ?? status?.landed ?? 0, of: report?.tasks ?? status?.of ?? r.tasks.length,
      plan_usage: planUsage,
      minutes: report?.minutes ?? null, stopped: r.stopRequested ? 'by you' : report?.stopped || (refused ? (/does not cover|nothing left to spend/.test(refused) ? 'Continue over budget' : 'Continue did not start') : null), error: r.error || refused || (r.exited && !report && !r.stopRequested ? 'the run ended without a report' : ''),
      where: r.where || 'container', metered: r.metered !== false,
      // task_id -> its workstream (the planner's grouping), and what waits on the owner (rules: swarm.mjs).
      workstreams: Object.fromEntries((planned || []).filter((t) => t.workstream && swarm?.tasks?.[t.key]).map((t) => [swarm.tasks[t.key], t.workstream])),
      keys: Object.fromEntries(Object.entries(swarm?.tasks || {}).map(([k, tid]) => [tid, k])),
      // task_id -> why its newest agent stopped short, in the agent's own words when it said (blocked: ...).
      why: Object.fromEntries(Object.entries(swarm?.tasks || {}).map(([k, tid]) => [tid, stoppedWhy(r.dir, k)]).filter(([, w]) => w)),
      escalated: ended ? {} : { ...ownerWaiting(r.dir, swarm, planned, status), ...(status?.escalated || {}) }, paused: ended ? {} : status?.paused || {}, dropped: status?.dropped || [], rules: r.rules || null,
      leads: (status?.leads || []).map((l) => ({ ...l, report: l.report ?? (r.dir ? leadReport(path.join(r.dir, l.key)) : '') })) });
  }
  return out;
}

/** The tasks whose agent has asked the owner (run.mjs wrote needs-owner.json in one of the task's folders), keyed and
 *  shaped like the swarm's escalations. The swarm escalates them only on its next round, and the status file says so a
 *  round later still: until then the board said "Checks passed, landing on main" for a task that was waiting on the
 *  owner. Read from the files themselves, the board says "Needs you" as soon as the agent has asked. */
function ownerWaiting(dir, swarm, planned, status) {
  const out = {};
  let names = [];
  try { names = dir ? fs.readdirSync(dir) : []; } catch { return out; }
  const known = status?.escalated || {};
  const dropped = new Set([...(status?.dropped || []), ...(swarm?.dropped || [])]);
  for (const [k, tid] of Object.entries(swarm?.tasks || {})) {
    if (known[k] || dropped.has(k)) continue;
    // A task's folders: <key>, <key>-<agent> (a takeover), and either with -<n> (a continuation), as swarm.mjs names them.
    const own = new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-a-[0-9a-f]{4,16})?(-[0-9]+)?$`);
    let newest = null;
    for (const d of names) {
      if (!own.test(d)) continue;
      const f = path.join(dir, d, 'needs-owner.json');
      try { const at = fs.statSync(f).mtimeMs; if (!newest || at > newest.at) newest = { f, at }; } catch { /* not asking */ }
    }
    // Asked before the owner's last answer: the file waits only for its agent to exit (the swarm removes it then).
    if (!newest || (swarm?.resumedAt?.[k] || 0) > newest.at) continue;
    try {
      const o = JSON.parse(fs.readFileSync(newest.f, 'utf8'));
      const ws = String((planned || []).find((t) => t.key === k)?.workstream || '').trim();
      out[k] = { why: String(o.why || 'its agent asks you'), at: newest.at, task_id: tid, workstream: ws, blockers: Array.isArray(o.blockers) ? o.blockers : [], early: true };
    } catch { /* being written: the next poll reads it */ }
  }
  return out;
}

/** Why a task's newest agent ended without finishing (its result.json outcome), or '' when it finished or has not ended.
 *  A task's agents work in <key>, <key>-1, <key>-2... (one folder per resume): the newest result is the one that counts. */
function stoppedWhy(dir, key) {
  if (!dir) return '';
  try {
    const own = fs.readdirSync(dir).filter((d) => d === key || new RegExp(`^${key.replace(/[^\w-]/g, '')}-\\d+$`).test(d))
      .map((d) => path.join(dir, d, 'result.json')).filter((f) => fs.existsSync(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const res = own.length ? JSON.parse(fs.readFileSync(own[0], 'utf8')) : null;
    return res && !res.finished ? String(res.outcome || '').slice(0, 600) : '';
  } catch { return ''; }
}

/** POST /api/projects/:p/runs/:id/continue { add_budget }: a stopped or finished run carries on with more money: the
 *  same tasks, landed ones left alone, each other one taken over from its stopped agent's saved work. */
/** A run that failed after planning, before any agent started (something on this machine was missing): its plan is
 *  kept (tasks.json), so it starts the agents on that plan, checked again, without planning (and paying) twice. */
async function retryPlanned(r, { root, port, adminKey, project, log }) {
  const tasksPath = path.join(r.dir, 'tasks.json');
  let planned;
  try { planned = JSON.parse(fs.readFileSync(tasksPath, 'utf8')); } catch { throw err(409, 'this run has no plan to start: start it again from the composer'); }
  const pick = r.pick;
  if (!pick?.provider) throw err(409, 'this run does not say which model it used: start it again from the composer');
  const ua = universalAgent(root);
  if (!ua) throw err(503, missingUniversalAgent(root));
  const metered = r.metered !== false;
  const rulesPath = path.join(r.dir, 'rules.json');
  const swarmArgs = (extra = []) => [path.join(root, 'agents', 'swarm.mjs'), '--project', project, '--tasks', tasksPath,
    ...(extra.includes('--check-only') ? [] : [...(fs.existsSync(rulesPath) ? ['--rules', rulesPath] : []), ...(r.leads ? ['--leads'] : [])]),
    ...(r.harness === 'aios' ? ['--in-aios'] : []),
    ...(metered ? ['--budget', String(r.budget || 2)] : []), '--agent', pick.provider, ...(pick.model ? ['--model', pick.model] : []), ...(pick.host ? ['--host', pick.host] : []), ...(pick.effort ? ['--effort', pick.effort] : []), '--dir', r.dir, '--no-warm', ...extra];
  const env = { ...process.env, CONVERGE_API_URL: `http://127.0.0.1:${port}`, ADMIN_KEY: adminKey || 'local', UNIVERSAL_AGENT: ua };
  Object.assign(r, { phase: 'checking the plan', error: '', exited: false });
  persist();
  const problems = await preflight(swarmArgs(['--check-only']), root, env);
  if (problems.length) { Object.assign(r, { phase: 'failed', error: problems[0].slice(0, 300) }); persist(); throw err(503, problems[0].slice(0, 280)); }
  Object.assign(r, { phase: 'running', tasks: planned.map((t) => t.title), resumed: Date.now() });
  const out = fs.openSync(path.join(r.dir, 'swarm.out'), 'a');
  fs.writeSync(out, `\n== started on its plan (${planned.length} tasks), after a failed start\n`);
  const swarm = spawn(process.execPath, [...swarmArgs(), ...swarmCheckArgs(true)], { cwd: root, env, detached: DETACH, windowsHide: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  r.pid = swarm.pid;
  persist();
  swarm.on('exit', (code) => { r.exited = true; r.endedAt = Date.now(); persist(); log('run', `${r.id}: swarm finished (exit ${code}); report in ${r.dir}/report.json`); runEnded(project); });
  swarm.unref();
  log('run', `${r.id}: started on its plan: ${planned.length} tasks`);
  return { ok: true, run: r.id, tasks: planned.map((t) => t.title), note: 'started on the plan it already had' };
}

// The swarm stops a run when the DeepSeek balance reaches this (agents/swarm.mjs --balance-floor, its default).
const BALANCE_FLOOR = 0.5;
/** The DeepSeek account's balance in USD, or null when it cannot be read (then nothing is asked: the swarm still checks). */
async function deepseekBalance() {
  try {
    const key = ((await providerConfig()).apiKeys || {}).deepseek || '';
    if (!key) return null;
    const j = await (await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })).json();
    const n = Number((j.balance_infos || []).find((b) => b.currency === 'USD')?.total_balance ?? j.balance_infos?.[0]?.total_balance);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export async function continueLocalRun({ root, port, adminKey, project, id, body, log }) {
  const r = (RUNS.get(project) || []).find((x) => x.id === id);
  if (!r) throw err(404, 'no such run');
  if (r.where === 'mac') throw err(400, 'continuing a host run is not supported yet: start it again from the composer');
  if (r.phase === 'failed' && r.dir && !fs.existsSync(path.join(r.dir, 'swarm.json')) && fs.existsSync(path.join(r.dir, 'tasks.json'))) return retryPlanned(r, { root, port, adminKey, project, log });
  if (!r.dir || !fs.existsSync(path.join(r.dir, 'swarm.json'))) throw err(409, 'this run never started its agents: start it again from the composer');
  if (!(r.exited || fs.existsSync(path.join(r.dir, 'report.json')))) throw err(409, 'this run is still going');
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const report = read(path.join(r.dir, 'report.json'));
  const spent = Number(report?.spent_usd ?? read(path.join(r.dir, 'status.json'))?.spent ?? 0) || 0;
  const add = Math.min(Math.max(Number(body.add_budget) || 2, 0.1), 50);
  let pick = r.pick;
  if (!pick) { const o = (await runOptions()).find((x) => x.label === r.model); pick = o && { provider: o.provider, model: o.model || '', host: o.host || '' }; }
  if (!pick) throw err(503, 'the model this run used is not available any more');
  // More than the provider's balance holds above the swarm's floor: nothing starts until the owner confirms.
  if (pick.provider === 'deepseek' && !body.confirm) {
    const bal = await deepseekBalance();
    const covers = bal === null ? null : +Math.max(0, bal - BALANCE_FLOOR).toFixed(2);
    if (covers !== null && add > covers) return { ok: false, run: id, over_by: +(add - covers).toFixed(2), covers, provider: 'DeepSeek' };
  }
  const metered = r.metered !== false;
  // The meter (DIR/usage) counts the whole run, so the cap is what was spent plus what was added.
  const budget = +(spent + add).toFixed(2);
  const n = (r.continued || 0) + 1;
  if (report) fs.renameSync(path.join(r.dir, 'report.json'), path.join(r.dir, `report-${n}.json`));
  const rulesPath = path.join(r.dir, 'rules.json');
  const args = [path.join(root, 'agents', 'swarm.mjs'), '--project', project, '--tasks', path.join(r.dir, 'tasks.json'), '--continue', ...(body.confirm ? ['--over-ok'] : []),
    ...(fs.existsSync(rulesPath) ? ['--rules', rulesPath] : []), ...(r.leads ? ['--leads'] : []),
    ...(r.harness === 'aios' ? ['--in-aios'] : []),
    ...(metered ? ['--budget', String(budget)] : []), '--agent', pick.provider, ...(pick.model ? ['--model', pick.model] : []), ...(pick.host ? ['--host', pick.host] : []), ...(pick.effort ? ['--effort', pick.effort] : []), '--dir', r.dir, '--no-warm'];
  const env = { ...process.env, CONVERGE_API_URL: `http://127.0.0.1:${port}`, ADMIN_KEY: adminKey || 'local', UNIVERSAL_AGENT: universalAgent(root) };
  const out = fs.openSync(path.join(r.dir, 'swarm.out'), 'a');
  fs.writeSync(out, `\n== continued (${n}): $${add} more, cap $${budget} (spent $${spent} so far)\n`);
  const swarm = spawn(process.execPath, args, { cwd: root, env, detached: DETACH, windowsHide: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  Object.assign(r, { phase: 'running', exited: false, stopRequested: false, error: '', budget: metered ? budget : 0, pid: swarm.pid, continued: n, pick, report: null, endedAt: 0, resumed: Date.now() });
  persist();
  swarm.on('exit', (code) => { r.exited = true; r.endedAt = Date.now(); persist(); log('run', `${id}: continued swarm finished (exit ${code})`); runEnded(project); });
  swarm.unref();
  log('run', `${id}: continued with $${add} more (cap $${budget})`);
  return { ok: true, run: id, budget, added: add };
}

/** Why the swarm's preflight refused the latest Continue ("preflight found N problem(s)" after its "== continued"
 *  line in swarm.out), or '' when it did not refuse it. */
function refusedContinue(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'swarm.out'), 'utf8'); } catch { return ''; }
  const last = text.slice(text.lastIndexOf('\n== continued'));
  if (!/preflight found \d+ problem/.test(last)) return '';
  const why = last.split('\n').filter((l) => /^\s+- /.test(l)).map((l) => l.trim().slice(2)).join('; ');
  return `Continue did not start: ${why || 'its preflight found a problem'}`;
}

/** An agent's log, live (the dashboard's chat-like view of what it is doing): entries after `after`. */
export async function agentLog(project, agent, after = -1) {
  const list = RUNS.get(project) || [];
  const dir = agentDir(list.filter((r) => r.where !== 'mac' && r.dir).map((r) => r.dir), agent);
  if (dir) return { ...readAgentLog(dir, after), summary: agentSummary(dir), where: 'container' };
  // An agent on the Mac: its log is there.
  if (list.some((r) => r.where === 'mac')) { try { return { ...(await host(`/agentlog?agent=${encodeURIComponent(agent)}&after=${after}`)), where: 'mac' }; } catch { /* not there either */ } }
  return { entries: [], total: 0, missing: true };
}

/** Halt one agent (its run goes on): it stops and saves its work, and its task waits for the owner to resume it. */
export async function haltAgent(project, agent, taskId) {
  const r = (RUNS.get(project) || []).find((x) => x.phase === 'running' && !x.exited && x.dir && (() => { try { return Object.values(JSON.parse(fs.readFileSync(path.join(x.dir, 'swarm.json'), 'utf8')).tasks || {}).includes(taskId); } catch { return false; } })())
    || (RUNS.get(project) || []).find((x) => x.phase === 'running' && x.where === 'mac');
  if (!r) throw err(409, 'no run of this project is going: the agent is not running');
  let key = '';
  try { key = Object.entries(JSON.parse(fs.readFileSync(path.join(r.dir, 'swarm.json'), 'utf8')).tasks || {}).find(([, id]) => id === taskId)?.[0] || ''; } catch { /* the Mac's */ }
  if (!key) throw err(404, 'this agent\'s task is not part of the running run');
  return controlRun(project, r.id, { halt: [{ key, agent }] });
}

/** POST /api/projects/:p/runs/:id/stop: planning is abandoned; a running swarm stops every agent (its own SIGTERM). */
/** Kills a run at once: its swarm and every process started for it (agents, jails, shells, checks), found by the run
 *  folder in their command lines, so nothing it started outlives it. */
export function killRunNow(r) {
  if (r.pid) killGroup(r.pid, 'SIGKILL');
  r.abort?.abort();
  if (!r.dir) return;
  if (process.platform === 'win32') {
    const back = r.dir.replace(/\//g, '\\').replace(/'/g, "''"), fwd = r.dir.replace(/\\/g, '/').replace(/'/g, "''");   // command lines spell it either way
    const q = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains('${back}') -or $_.CommandLine.Contains('${fwd}')) -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`;
    const pids = String(spawnSync('powershell.exe', ['-NoProfile', '-Command', q], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).stdout || '').split(/\s+/).filter((x) => /^\d+$/.test(x));
    for (const pid of pids) spawnSync('taskkill', ['/T', '/F', '/PID', pid], { stdio: 'ignore', windowsHide: true });
  } else {
    spawnSync('pkill', ['-9', '-f', r.dir], { stdio: 'ignore' });
    // ...and whatever works inside it without naming it: an agent's Claude Code CLI has only its working directory in
    // the run folder, and outlived Stop (orphaned, still waiting on the model) when the agent around it was killed.
    const dir = path.resolve(r.dir);
    for (const pid of (fs.existsSync('/proc') ? fs.readdirSync('/proc') : []).filter((d) => /^[0-9]+$/.test(d))) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (Number(pid) !== process.pid && (cwd === dir || cwd.startsWith(dir + path.sep))) process.kill(Number(pid), 'SIGKILL');
      } catch { /* gone, or not ours to read */ }
    }
  }
}

export function stopLocalRun(project, id) {
  const r = (RUNS.get(project) || []).find((x) => x.id === id);
  if (!r) throw err(404, 'no such run');
  // Stop is immediate and never skipped: a stop asked before (that did not take) used to make every later Stop a no-op.
  r.stopRequested = true;
  if (r.where !== 'mac') {
    killRunNow(r);
    Object.assign(r, { phase: 'stopped', stopped: 'by you', exited: true });
    persist();
    return { ok: true, phase: 'stopped' };
  }
  persist();
  if (r.where === 'mac' && r.phase === 'running') host(`/runs/${r.id}/stop`, {}).catch((e) => {
    // Said, not swallowed: a run the host did not stop keeps running (and spending) on the Mac.
    r.error = `the host did not take the stop (its agents may still be running): ${e.message}`;
    console.error(`run ${r.id}: ${r.error}`);
    persist();
  });
  else if (r.pid) { killGroup(r.pid, 'SIGTERM'); }
  else r.abort.abort();
  return { ok: true };
}

/** POST /api/projects/:p/runs/:id/control { resume: [task key | "ws:<name>"], drop: [...] }: the owner's answer to an
 *  escalation or a paused workstream; swarm.mjs reads it on its next round. */
export async function controlRun(project, id, body) {
  const r = (RUNS.get(project) || []).find((x) => x.id === id);
  if (!r) throw err(404, 'no such run');
  // Nobody reads control.json once the swarm has finished: say so, rather than an "ok" that does nothing.
  if (hasEnded(r)) throw err(409, 'this run has ended: start the plan again to carry on');
  const clean = (l) => (Array.isArray(l) ? l : []).map(String).filter((x) => /^(ws:)?[\w .:-]{1,80}$/.test(x)).slice(0, 200);
  const c = { resume: clean(body.resume), drop: clean(body.drop), retire: (Array.isArray(body.retire) ? body.retire : []).map(String).filter((x) => /^(ws:)?[\w .:-]{1,80}(#\d{1,2})?$/.test(x)).slice(0, 200), halt: (Array.isArray(body.halt) ? body.halt : []).filter((x) => x && /^[\w.-]{1,80}$/.test(String(x.key || x))).map((x) => ({ key: String(x.key || x), agent: /^a-[0-9a-f]{4,16}$/.test(String(x.agent || '')) ? String(x.agent) : '' })).slice(0, 50) };
  // The owner's word to the next agent with a resume or retire: { <task key>: "text" }.
  if (body.notes && typeof body.notes === 'object') c.notes = Object.fromEntries(Object.entries(body.notes).filter(([k, v]) => /^[\w.-]{1,80}$/.test(k) && typeof v === 'string' && v.trim()).slice(0, 50).map(([k, v]) => [k, v.trim().slice(0, 4000)]));
  if (!c.resume.length && !c.drop.length && !c.retire.length && !c.halt.length) throw err(400, 'resume, drop, retire or halt: task keys, or "ws:<workstream>"');
  if (r.where === 'mac') return host(`/runs/${id}/control`, c);
  fs.writeFileSync(path.join(r.dir, 'control.json'), JSON.stringify(c));
  return { ok: true };
}

/** converge's own planning steps, beside the planner's (agents/plan.mjs), in the run's plan-log.jsonl: what the dashboard
 *  shows of a run while it plans. */
function planLog(dir, kind, text, extra = {}) {
  try { fs.appendFileSync(path.join(dir, 'plan-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), by: 'converge', kind, text, ...extra }) + '\n'); } catch { /* the log misses this step */ }
}

/** GET /api/projects/:p/runs/:id/plan: how the run was planned (the log, as it grows) and the tasks it got, in full. */
export function runPlan(project, id) {
  const r = (RUNS.get(project) || []).find((x) => x.id === id);
  if (!r) throw err(404, 'no such run');
  const entries = [];
  try {
    for (const line of fs.readFileSync(path.join(r.dir, 'plan-log.jsonl'), 'utf8').split('\n')) { if (line.trim()) { try { entries.push(JSON.parse(line)); } catch { /* a torn line */ } } }
  } catch { /* nothing yet */ }
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(path.join(r.dir, 'tasks.json'), 'utf8')); } catch { /* not planned yet */ }
  return { phase: r.phase, entries, tasks };
}

/** Plans the request and starts the swarm; answers once it has started, with the tasks' titles. */
// How long a plan may take: the planner's own time for its one model call (agents/plan.mjs: two minutes, and nine
// seconds a task beyond ten, a quarter of an hour at most), and two minutes around it for the clone and the checks.
export const planTimeoutMs = (agents) => Math.min(900_000, 120_000 + Math.max(0, (Number(agents) || 3) - 10) * 9_000) + 120_000;

export async function startLocalRun(opts) {
  const rec = { id: crypto.randomBytes(4).toString('hex'), request: String(opts.body?.request || '').trim().slice(0, 2000), phase: 'planning', agents: 0, budget: 0, tasks: [], dropped: [], error: '', started: Date.now(), dir: '', abort: new AbortController(), pid: 0, stopRequested: false };
  try { return await startRun(opts, rec); }
  catch (e) {
    if (rec.stopRequested) { rec.phase = 'stopped'; persist(); throw err(409, 'stopped before any agent started'); }
    rec.phase = 'failed'; rec.error = String(e.message || e).slice(0, 300); persist(); throw e;
  }
}

async function startRun({ root, dataDir, port, adminKey, project, body, log }, rec) {
  // Long enough for a real request; one longer is refused, not cut short where nobody sees it.
  const request = typeof body.request === 'string' ? body.request.trim() : '';
  if (request.length > 12_000) throw err(413, `the request is ${request.length} characters: 12000 at most`);
  if (request.length < 6) throw err(400, 'say what the agents should do');
  const fence = agentSandbox();
  if (!fence.ok) throw err(503, `agents cannot run fenced on this machine: ${fence.why}`);
  const agents = Math.min(Math.max(Math.round(Number(body.agents) || 3), 1), 200);
  const budget = Math.min(Math.max(Number(body.budget) || 2, 0.1), 50);
  // The model the run uses, planning and agents: the one picked in the dashboard. None picked: no run (never a default).
  const options = await runOptions();
  // From the model picker: { provider, model, where, effort }. Else an id from runOptions (older dashboards).
  let pick = null;
  if (body.pick && typeof body.pick === 'object') {
    const bp = body.pick;
    const prov = (await modelProviders(root)).providers.find((x) => x.id === bp.provider && x.where === (bp.where === 'mac' ? 'mac' : 'container'));
    if (!prov) throw err(400, `${bp.provider} is not available ${bp.where === 'mac' ? 'on host machine' : 'here'}`);
    if (!prov.ready) throw err(503, `${prov.label} cannot run yet: ${prov.note}`);
    const c = readAgentConfig();
    const model = String(bp.model || '').trim();
    if (prov.kind === 'api' && !model) throw err(400, `pick a ${prov.label} model`);
    pick = { id: `${bp.provider}/${model}@${prov.where}`, provider: bp.provider, model: model === 'default' ? '' : model, where: prov.where,
      // Each provider's own address, always passed explicitly (never left to the agent's default, which for Ollama
      // without a host is a local server): the model's entry, the provider's, then the provider's known address.
      host: (c.models || []).find((m) => m.provider === bp.provider && m.model === model)?.host || c.providers?.[bp.provider]?.host || (c.models || []).find((m) => m.provider === bp.provider && m.host)?.host || PROVIDERS.find((x) => x.id === bp.provider)?.host || '',
      label: `${model || 'default'} · ${prov.label}${prov.where === 'mac' ? ' (Mac)' : ''}`, missing: '' };
    const eff = String(bp.effort || '');
    if (['minimal', 'low', 'medium', 'high', 'off'].includes(eff)) pick.effort = eff;
  }
  pick ||= body.model ? options.find((o) => o.id === body.model) : null;
  if (!pick) throw err(400, options.length ? 'pick a model for this run first' : 'no model to run: add a provider key under Keys, or sign in a CLI');
  if (pick.missing) throw err(503, `${pick.label} cannot run yet: ${pick.missing}`);
  const ua = universalAgent(root);
  if (!ua) throw err(503, missingUniversalAgent(root));

  const id = rec.id;
  const metered = !/-cli$/.test(pick.provider); // a subscription CLI bills a plan: no spending to measure or cap
  Object.assign(rec, { agents, budget: metered ? budget : 0, model: pick.label, metered, pick: { id: pick.id, provider: pick.provider, model: pick.model || '', host: pick.host || '', effort: pick.effort || '' } });
  if (!RUNS.has(project)) RUNS.set(project, []);
  RUNS.get(project).push(rec);
  persist();
  const dir = path.join(dataDir, 'runs', `${project}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  rec.dir = dir;
  const env = { ...process.env, CONVERGE_API_URL: `http://127.0.0.1:${port}`, ADMIN_KEY: adminKey || 'local', UNIVERSAL_AGENT: ua };
  // Planned, then every check tried on main as it is now (swarm's own preflight, fenced, nothing started). A plan
  // whose checks are broken or already pass goes back to the planner with the reasons, up to three tries; then the
  // tasks still refused are left out, so one bad check does not stop the rest.
  const tasksPath = path.join(dir, 'tasks.json');
  const feedbackPath = path.join(dir, 'feedback.txt');
  const givenTasks = Array.isArray(body.tasks) && body.tasks.length
    ? body.tasks.slice(0, agents).map((t, i) => ({ key: String(t.key || `task-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40), title: String(t.title || t.key || `task ${i + 1}`).slice(0, 200), description: String(t.description || '').slice(0, 4000), accept: (Array.isArray(t.accept) ? t.accept : []).map(String).filter(Boolean).slice(0, 6), ...(Array.isArray(t.retire) && t.retire.length ? { retire: t.retire.map(String) } : {}) }))
    : null;
  // Rules (escalate a task that keeps failing, pause a workstream that mostly fails) and leads, from the composer.
  const rules = body.rules && typeof body.rules === 'object' ? { maxTries: Number(body.rules.maxTries) || 0, pauseAt: Number(body.rules.pauseAt) || 0, minHandedIn: 4 } : null;
  const rulesPath = path.join(dir, 'rules.json');
  if (rules && (rules.maxTries || rules.pauseAt)) fs.writeFileSync(rulesPath, JSON.stringify(rules));
  // Fallback to other models: off unless the owner allowed it (Rules): the agents stay on the model picked.
  // The agents' loop: the universal agent's (the harness: its tool calling, memory, ledgers and usage accounting, the
  // default) or aios's own (body.harness "aios": each agent an aios entity).
  const harness = body.harness === 'aios' ? 'aios' : 'universal';
  const ruleArgs = [...(fs.existsSync(rulesPath) ? ['--rules', rulesPath] : []), ...(body.rules?.leads ? ['--leads'] : [])];
  rec.rules = rules; rec.leads = Boolean(body.rules?.leads); rec.fallback = Boolean(body.rules?.fallback); rec.harness = harness;
  const swarmArgs = (extra = []) => [path.join(root, 'agents', 'swarm.mjs'), '--project', project, '--tasks', tasksPath, ...(extra.includes('--check-only') ? [] : ruleArgs),
    ...(extra.includes('--check-only') ? ['--base', path.join(dir, 'plan')] : []),   // the planner's clone of main, not another
    ...(harness === 'aios' ? ['--in-aios'] : []),   // the preflight checks the loop that will run
    ...(metered ? ['--budget', String(budget)] : []), '--agent', pick.provider, ...(pick.model ? ['--model', pick.model] : []), ...(pick.host ? ['--host', pick.host] : []), ...(pick.effort ? ['--effort', pick.effort] : []), '--dir', dir, '--no-warm', ...extra];
  let planned, problems = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    log('run', `${id}: planning "${request.slice(0, 80)}" into up to ${agents} tasks${attempt > 1 ? ` (try ${attempt}: ${problems.length} problems to fix)` : ''}`);
    try {
      // Planned by the model picked for the agents (the same provider, model, address and effort): no other is used.
      // The refused plan stays beside it: planning again asks only for its refused tasks (plan.mjs --repair).
      const previousPath = path.join(dir, 'tasks-refused.json');
      if (attempt > 1 && fs.existsSync(tasksPath)) fs.renameSync(tasksPath, previousPath);
      fs.rmSync(tasksPath, { force: true });
      // A plan given with the request (body.tasks: the self-test, or a plan kept from before) is checked like any other,
      // but not planned again: its problems end the run.
      if (givenTasks) {
        if (attempt > 1) throw err(400, `the given plan's checks were refused: ${problems[0].slice(0, 240)}`);
        fs.writeFileSync(tasksPath, JSON.stringify(givenTasks, null, 1));
        planLog(dir, 'step', `Using the ${givenTasks.length} task(s) given with the request`);
        planned = givenTasks;
      } else {
      planLog(dir, 'step', attempt === 1 ? `Planning into up to ${agents} task(s) with ${pick.label || pick.id}` : `Planning again (try ${attempt}): ${problems.length} problem(s) to fix`);
      await run(process.execPath, [path.join(root, 'agents', 'plan.mjs'), '--project', project, '--request', request, '--agents', String(agents), '--out', tasksPath,
        '--agent', pick.provider, ...(pick.model ? ['--model', pick.model] : []), ...(pick.host ? ['--host', pick.host] : []), ...(pick.effort ? ['--effort', pick.effort] : []),
        '--work', path.join(dir, 'plan'), ...(problems.length ? ['--feedback', feedbackPath, ...(fs.existsSync(previousPath) ? ['--repair', previousPath] : [])] : [])], { cwd: root, timeout: planTimeoutMs(agents), maxBuffer: 8 << 20, env, signal: rec.abort.signal });
      planned = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
      }
    } catch (e) {
      if (e.status) throw e;
      const why = String(e.stderr || e.message).trim().split('\n').pop().slice(0, 300);
      planLog(dir, 'failed', `Planning failed: ${why}`);
      throw err(502, `planning failed: ${why}`);
    }
    rec.phase = 'checking the plan';
    planLog(dir, 'step', `Checking the plan: each task's checks must run, and fail on main as it is now`);
    rec.tasks = planned.map((t) => t.title);
    problems = await preflight(swarmArgs(['--check-only']), root, env, rec.abort.signal);
    if (rec.stopRequested) throw err(409, 'stopped');
    if (!problems.length) { planLog(dir, 'step', 'The plan checks out'); break; }
    planLog(dir, 'problems', `${problems.length} problem(s) with the plan`, { problems });
    rememberRefused(project, request, problems.filter((p) => /^task [\w-]+:/.test(p))).catch(() => { /* ASQL down */ });
    // Only a task's own check can be put right by planning again. Anything else (agents already running, no key, no
    // sandbox) would be refused the same on every try: said now, not after three plans.
    const notThePlan = problems.find((p) => !/^task [\w-]+:/.test(p));
    if (notThePlan) throw err(503, notThePlan.slice(0, 280));
    rec.phase = 'replanning';
    fs.writeFileSync(feedbackPath, problems.map((p) => `- ${p}`).join('\n'));
    log('run', `${id}: the plan's checks were refused: ${problems.length} problem(s)`);
  }
  let dropped = [];
  if (problems.length) {
    const bad = new Set(problems.map((p) => /^task ([\w-]+):/.exec(p)?.[1]).filter(Boolean));
    if (!bad.size || bad.size >= planned.length) throw err(502, `could not plan checks that work: ${problems[0].slice(0, 240)}`);
    dropped = planned.filter((t) => bad.has(t.key));
    planned = planned.filter((t) => !bad.has(t.key));
    fs.writeFileSync(tasksPath, JSON.stringify(planned, null, 1));
    const again = await preflight(swarmArgs(['--check-only']), root, env);
    if (again.length) throw err(502, `could not plan checks that work: ${again[0].slice(0, 240)}`);
    log('run', `${id}: left out ${dropped.length} task(s) whose checks stayed broken: ${dropped.map((t) => t.key).join(', ')}`);
  }
  // The planner's clone of main served the plan check; the agents clone their own.
  fs.rmSync(path.join(dir, 'plan', 'main'), { recursive: true, force: true });

  if (rec.stopRequested) throw err(409, 'stopped');
  if (pick.where === 'mac') {
    // Agents on the host machine: helper runs the swarm with user CLI logins (fenced as here: Seatbelt or bubblewrap);
    // this platform still checks every change, fenced, before it lands.
    await host('/runs', { id, project, tasks: planned, provider: pick.provider, model: pick.model, effort: pick.effort || '', budget, rules: rules && (rules.maxTries || rules.pauseAt) ? rules : null, leads: rec.leads, fallback: rec.fallback, api: process.env.HOST_API_URL || `http://127.0.0.1:${port}`, admin_key: adminKey || 'local' });
    Object.assign(rec, { phase: 'running', where: 'mac', tasks: planned.map((t) => t.title), dropped: dropped.map((t) => t.title) });
    persist();
    log('run', `${id}: ${planned.length} tasks handed to host (${pick.label})`);
    return { ok: true, run: id, model: pick.id, agents, budget, tasks: planned.map((t) => t.title), dropped: dropped.map((t) => t.title), note: `agents on host machine (${fenceNote()})` };
  }
  Object.assign(rec, { phase: 'running', tasks: planned.map((t) => t.title), dropped: dropped.map((t) => t.title) });
  planLog(dir, 'step', `Starting ${Math.min(agents, planned.length)} agent(s) on ${planned.length} task(s)${dropped.length ? ` (left out: ${dropped.map((t) => t.key).join(', ')})` : ''}`);
  const out = fs.openSync(path.join(dir, 'swarm.out'), 'a');
  // The plan's checks were just tried (preflight --check-only above): the swarm does not try them a second time (20 s).
  const swarm = spawn(process.execPath, [...swarmArgs(), ...swarmCheckArgs(true)], { cwd: root, env, detached: DETACH, windowsHide: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  rec.pid = swarm.pid;
  persist();
  swarm.on('exit', (code) => { rec.exited = true; persist(); log('run', `${id}: swarm finished (exit ${code}); report in ${dir}/report.json`); runEnded(project); });
  swarm.unref();
  log('run', `${id}: ${planned.length} tasks, budget $${budget}; output in ${dir}/swarm.out`);
  return { ok: true, run: id, model: pick.id, agents, budget, tasks: planned.map((t) => t.title), dropped: dropped.map((t) => t.title),
    note: dropped.length ? `left out ${dropped.length} task(s) whose checks could not be made to work` : `output in ${dir}/swarm.out` };
}
