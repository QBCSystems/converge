// Cloudflare from the dashboard, run by the Mac helper (scripts/host-agents.mjs): the owner's account and API token,
// a check of what is there, and a deploy (the same scripts as by hand: scripts/runner-image.sh, sandbox/scripts/sandbox-image.sh,
// scripts/provision.sh) with its log. Kept in ~/.converge-local/cloudflare.json (0600) on the Mac; the token and the
// Worker's keys never go to a browser. The deployed Worker's admin key lets the local platform show its projects too
// (scripts/dev-server.mjs, /cloud/...).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STATE = path.join(os.homedir(), '.converge-local');
const FILE = path.join(STATE, 'cloudflare.json');
const LOG = path.join(STATE, 'cloudflare-deploy.log');
const API = 'https://api.cloudflare.com/client/v4';
const err = (status, message) => Object.assign(new Error(message), { status });
const WRANGLER_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/wrangler/wrangler-dist/cli.js');

let wranglerCache = { at: 0, val: { logged_in: false, accounts: [], auth_type: '', checking: true } };
let wranglerAsking = null;

const parseWhoami = (stdout) => {
  try {
    const parsed = JSON.parse(stdout || '{}');
    return { logged_in: Boolean(parsed.loggedIn), accounts: parsed.accounts || [], auth_type: parsed.authType || (parsed.loggedIn ? 'OAuth' : '') };
  } catch { return { logged_in: false, accounts: [], auth_type: '' }; }
};

// `wrangler whoami` takes seconds (node starting wrangler, then Cloudflare's API). Asked synchronously it froze the
// whole dev server for that long every 30 s, the Settings page's Cloudflare tab sitting on "Loading…". Now it is asked
// in the background and the last answer is returned at once (checking: true until the first one is in). force (an
// explicit login/logout/check) still waits for a fresh answer.
function refreshWrangler() {
  if (wranglerAsking) return;
  let out = '';
  wranglerAsking = spawn(process.execPath, [WRANGLER_CLI, 'whoami', '--json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const timer = setTimeout(() => { try { wranglerAsking?.kill(); } catch { /* gone */ } }, 15_000);
  wranglerAsking.stdout.on('data', (d) => { out += d; });
  const done = () => { clearTimeout(timer); wranglerAsking = null; wranglerCache = { at: Date.now(), val: parseWhoami(out) }; };
  wranglerAsking.once('close', done);
  wranglerAsking.once('error', done);
}

export function wranglerStatus(force = false) {
  if (force) {
    const res = spawnSync(process.execPath, [WRANGLER_CLI, 'whoami', '--json'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    wranglerCache = { at: Date.now(), val: parseWhoami(res.stdout) };
    return wranglerCache.val;
  }
  if (Date.now() - wranglerCache.at >= 30_000) refreshWrangler();
  return wranglerCache.val;
}
refreshWrangler();   // the first answer is usually in before anyone opens Settings

export function startWranglerLogin() {
  try {
    const ch = spawn(process.execPath, [WRANGLER_CLI, 'login'], { detached: true, stdio: 'ignore' });
    ch.unref();
    return { started: true };
  } catch (e) {
    throw err(500, `Failed to launch wrangler login: ${e.message}`);
  }
}

export function wranglerLogout() {
  try {
    spawnSync(process.execPath, [WRANGLER_CLI, 'logout'], { encoding: 'utf8', timeout: 10000 });
    wranglerCache = { at: 0, val: { logged_in: false, accounts: [], auth_type: '' } };
    return wranglerStatus(true);
  } catch (e) {
    throw err(500, `Failed to logout of wrangler: ${e.message}`);
  }
}

import { readAsqlCloudflare, saveAsqlCloudflare } from './provider-store.mjs';
import { writePrivate } from './private-file.mjs';

let asqlCloudflareCache = null;

// ASQL holds the Cloudflare credentials (a token, the Worker's admin key). The 0600 file is only the fallback while ASQL is
// unreachable: it is removed as soon as ASQL has the same data.
const writeFallbackFile = (c) => {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  writePrivate(FILE, JSON.stringify(c, null, 1));
};
const keepInAsql = (c) => saveAsqlCloudflare(c).then(
  () => { try { fs.rmSync(FILE, { force: true }); } catch { /* the file is only a fallback */ } },
  (e) => { console.warn(`cloudflare: ASQL is unreachable (${e.message}); the credentials are kept in ${FILE} until it is back`); writeFallbackFile(c); },
);

export const read = () => {
  if (asqlCloudflareCache) return asqlCloudflareCache;
  try {
    asqlCloudflareCache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return asqlCloudflareCache;
  } catch {
    return {};
  }
};

// Load from ASQL into the memory cache on start; a file left by an earlier run moves into ASQL.
(async () => {
  try {
    const fromSql = await readAsqlCloudflare();
    if (fromSql && (fromSql.api_token || fromSql.account_id)) asqlCloudflareCache = Object.assign(read(), fromSql);
    else if (fromSql && fs.existsSync(FILE)) await keepInAsql(read());
  } catch { /* ASQL is not reachable: the file keeps serving */ }
})();

const write = (c) => {
  asqlCloudflareCache = c;
  keepInAsql(c);
};

let job = null; // { state: running|done|failed, step, started, ended, error }

/** What the dashboard may see: never the token or the keys. */
export function status(root) {
  const c = read();
  const wrangler = wranglerStatus();
  return {
    account_id: c.account_id || (wrangler.accounts[0]?.id || ''), account_name: c.account_name || (wrangler.accounts[0]?.name || ''), has_token: Boolean(c.api_token || wrangler.logged_in),
    wrangler,
    worker_url: c.worker_url || '', connected: Boolean(c.worker_url && c.admin_key), workers_ai: Boolean(c.workers_ai),
    keys_file: fs.existsSync(path.join(root, '.env.converge')), last_check: c.last_check || null, job,
  };
}

/** Saves what was given (null removes it). A new token or account forgets the last check. */
export function save(b) {
  const c = read();
  for (const k of ['account_id', 'api_token', 'worker_url', 'admin_key']) {
    if (b[k] === null || b[k] === '') delete c[k];
    else if (typeof b[k] === 'string') c[k] = b[k].trim().replace(/\/$/, '');
  }
  if (b.api_token !== undefined || b.account_id !== undefined) delete c.last_check;
  if (c.worker_url && !/^https:\/\//.test(c.worker_url)) throw err(400, 'the Worker URL starts with https://');
  if (c.account_id) {
    c.account_id = c.account_id.toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(c.account_id)) throw err(400, 'an account ID is 32 hex characters (dash.cloudflare.com, right side of the account home)');
  }
  write(c);
}

/** The Worker's address and admin key, for the local platform's proxy (host token only). */
export function creds() { const c = read(); return { worker_url: c.worker_url || '', admin_key: c.admin_key || '' }; }

async function cf(p, token) {
  const r = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.success !== false, status: r.status, result: j.result, errors: (j.errors || []).map((e) => e.message).join('; ') };
}
const imageAccounts = (file) => { try { return [...fs.readFileSync(file, 'utf8').matchAll(/registry\.cloudflare\.com\/([0-9a-f]{32})\//g)].map((m) => m[1]); } catch { return []; } };

/** Checks the token and the account, and what is deployed: the Worker, the sandbox Worker, the images, the keys. */
export async function check(root) {
  const c = read();
  const wrangler = wranglerStatus();
  if (!c.api_token && !wrangler.logged_in) throw err(400, 'Sign in with Cloudflare (OAuth2) or paste an API token first');
  const out = { token: false, accounts: [], account_id: c.account_id || '', subdomain: '', scripts: [], images_match: false, workers_ai: false, health: null, notes: [] };

  if (c.api_token) {
    const v = await cf('/user/tokens/verify', c.api_token);
    const va = !v.ok && c.account_id ? await cf(`/accounts/${c.account_id}/tokens/verify`, c.api_token) : null;
    out.token = v.ok || Boolean(va?.ok);
    if (!out.token) throw err(401, `Cloudflare did not accept the token${v.errors ? `: ${v.errors}` : ''}`);
    const acc = await cf('/accounts?per_page=50', c.api_token);
    out.accounts = (acc.result || []).map((a) => ({ id: a.id, name: a.name }));
  } else if (wrangler.logged_in) {
    out.token = true;
    out.accounts = wrangler.accounts;
  }

  if (!c.account_id && out.accounts.length === 1) { c.account_id = out.accounts[0].id; }
  out.account_id = c.account_id || '';
  if (!out.account_id) { out.notes.push(out.accounts.length ? 'choose the account to use' : 'choose or enter the account ID'); write(c); return out; }
  c.account_name = out.accounts.find((a) => a.id === out.account_id)?.name || c.account_name || '';

  if (c.api_token) {
    const sub = await cf(`/accounts/${out.account_id}/workers/subdomain`, c.api_token);
    out.subdomain = sub.result?.subdomain || '';
    if (!sub.ok) out.notes.push(`Workers: ${sub.errors || `HTTP ${sub.status}`} (the token needs Workers Scripts: Edit)`);
    const sc = await cf(`/accounts/${out.account_id}/workers/scripts`, c.api_token);
    out.scripts = (sc.result || []).map((s) => s.id).filter((id) => /^converge/.test(id));
    const ai = await cf(`/accounts/${out.account_id}/ai/models/search?per_page=1`, c.api_token);
    out.workers_ai = ai.ok;
    if (!ai.ok) out.notes.push('Workers AI: the token needs Workers AI: Read to use those models');
  } else {
    out.workers_ai = true;
  }

  const imgs = [...imageAccounts(path.join(root, 'wrangler.jsonc')), ...imageAccounts(path.join(root, 'sandbox', 'wrangler.jsonc'))];
  out.images_match = imgs.length > 0 && imgs.every((a) => a === out.account_id);
  if (!out.images_match) out.notes.push('container images will be built for this account (no Docker needed)');
  if (!c.worker_url && out.subdomain && out.scripts.includes('converge')) c.worker_url = `https://converge.${out.subdomain}.workers.dev`;
  if (c.worker_url) {
    try { const h = await fetch(`${c.worker_url}/health`, { signal: AbortSignal.timeout(10_000) }); out.health = h.ok ? await h.json().catch(() => ({ ok: true })) : { ok: false, status: h.status }; }
    catch (e) { out.health = { ok: false, error: String(e.message || e) }; }
  }
  c.last_check = { ...out, at: new Date().toISOString() };
  write(c);
  return out;
}

/** Deploys, in the background, step by step into the log. `fresh_keys`: the Worker exists but this Mac has no
 *  .env.converge (it was deployed from elsewhere): deploying from here gives it new admin and view keys. */
export function deploy(root, { fresh_keys = false, images = 'auto' } = {}) {
  if (job?.state === 'running') throw err(409, 'a deploy is already running');
  const c = read();
  const wrangler = wranglerStatus();
  const hasAuth = Boolean(c.api_token || wrangler.logged_in);
  const accountId = c.account_id || wrangler.accounts[0]?.id || '';
  if (!hasAuth || !accountId) throw err(400, 'Sign in with Cloudflare (OAuth2) or enter an API token & account ID first, then Check');
  const exists = (c.last_check?.scripts || []).includes('converge');
  if (exists && !fs.existsSync(path.join(root, '.env.converge')) && !fresh_keys) {
    throw err(409, 'converge is already deployed on this account from another computer, and its keys are not here. Deploying from here sets new admin and view keys (projects stay; the old keys stop working).');
  }
  const imgs = [...imageAccounts(path.join(root, 'wrangler.jsonc')), ...imageAccounts(path.join(root, 'sandbox', 'wrangler.jsonc'))];
  const build = images === true || (images === 'auto' && !(imgs.length && imgs.every((a) => a === accountId)));
  const env = { ...process.env, ...(c.api_token ? { CLOUDFLARE_API_TOKEN: c.api_token } : {}), CLOUDFLARE_ACCOUNT_ID: accountId };
  const steps = [];
  if (build) {
    // Both images are built from this repository alone (the static linux/amd64 binaries in kernel/linux-x64). No containers.
    steps.push(['the sandbox tool (a static linux/amd64 converge-jail)', 'bash', ['scripts/runner-image.sh', '--jail-only']]);
    steps.push(['the verification runner image', 'bash', ['scripts/runner-image.sh']]);
    steps.push(['the sandbox image', 'bash', ['sandbox/scripts/sandbox-image.sh']]);
  }
  steps.push(['queue, Worker and its keys', 'bash', ['scripts/provision.sh']]);
  steps.push(['the sandbox Worker', 'npx', ['--yes', 'wrangler@4', 'deploy', '--config', 'sandbox/wrangler.jsonc', '--var', `ACCOUNT_ID:${c.account_id}`, ...(c.worker_url ? ['--var', `CONVERGE_URL:${c.worker_url}`] : [])]]);

  fs.writeFileSync(LOG, `deploy ${new Date().toISOString()} to account ${c.account_id}\n`, { mode: 0o600 });
  job = { state: 'running', step: '', steps: steps.map((s) => s[0]), started: Date.now(), ended: 0, error: '' };
  const scrub = (s) => String(s).split(c.api_token).join('<token>');
  (async () => {
    for (const [label, cmd, args, extra] of steps) {
      job.step = label;
      fs.appendFileSync(LOG, `\n== ${label}\n`);
      const code = await new Promise((resolve) => {
        const ch = spawn(cmd, args, { cwd: root, env: { ...env, ...(extra || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
        const out = (d) => fs.appendFileSync(LOG, scrub(d).replace(/(ADMIN_KEY|VIEW_KEY|ENGINE_SHARED_KEY|RECEIPT_SEED)=\S+/g, '$1=<hidden>'));
        ch.stdout.on('data', out); ch.stderr.on('data', out);
        ch.on('error', (e) => { fs.appendFileSync(LOG, `${e.message}\n`); resolve(127); });
        ch.on('close', resolve);
      });
      if (code !== 0) { Object.assign(job, { state: 'failed', ended: Date.now(), error: `${label} failed (exit ${code}): see the log` }); return; }
    }
    // The Worker's keys, from the keys file provision.sh keeps, so this platform can show its projects.
    const keys = Object.fromEntries((fs.readFileSync(path.join(root, '.env.converge'), 'utf8').match(/^\w+=.*$/gm) || []).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const now = read();
    now.admin_key = keys.ADMIN_KEY || now.admin_key;
    write(now);
    try { await check(root); } catch { /* the log says what happened */ }
    Object.assign(job, { state: 'done', step: '', ended: Date.now() });
    fs.appendFileSync(LOG, `\n== done${read().worker_url ? `: ${read().worker_url}` : ''}\n`);
  })().catch((e) => Object.assign(job, { state: 'failed', ended: Date.now(), error: String(e.message || e) }));
  return job;
}

export function log(lines = 200) {
  try { return fs.readFileSync(LOG, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

/** Workers AI as a model provider: the same token, through Cloudflare's OpenAI-compatible endpoint. */
export const workersAiHost = (account) => `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
export const WORKERS_AI_MODELS = ['@cf/openai/gpt-oss-120b', '@cf/moonshotai/kimi-k2.7-code', '@cf/deepseek-ai/deepseek-v4-flash-0731', '@cf/zai-org/glm-5.3-flash'];
export function markWorkersAi(on) { const c = read(); c.workers_ai = Boolean(on); write(c); }
export const hasCmd = (bin) => spawnSync('sh', ['-lc', `command -v ${bin}`]).status === 0;
