#!/usr/bin/env node
// Agents on the Mac itself: the local platform hands a run whose agents are subscription CLIs
// (Claude Code, Gemini CLI, Codex, Cursor) to this helper, which runs agents/swarm.mjs here, with the owner's own
// CLI logins. Each agent is an aios entity: its CLI is only the mind (through the bridge, with no tools of its
// own), aios decides every action against the agent's capabilities and records each cycle (so it can be rewound),
// and every command it is allowed runs inside converge-jail (Landlock on Linux, Seatbelt on a Mac, agents/fenced.mjs).
// Without aios and the jail here, no run starts. Every change still goes through the platform, which checks it,
// fenced, before it lands.
//
//   node scripts/host-agents.mjs     (scripts/local.sh starts it; env HOST_AGENTS_TOKEN, HOST_AGENTS_PORT=8786)
//
//   GET  /info                 the CLIs installed here
//   GET  /models?provider=     a CLI's models, as the CLI here lists them (the dashboard's model picker)
//   POST /runs                 { id, project, tasks, provider, model, api, admin_key }  starts a swarm (CLIs: no budget, not metered)
//   GET  /runs/:id             its status.json and report.json, and whether it is still running
//   POST /runs/:id/stop        stops it (every agent: the swarm's own SIGTERM)
//   POST /bundle               { paths: [...] }  folders here, as one git bundle (history + uncommitted work; several
//                              become subfolders of one project), for a new project
//   POST /dirs                 { path }  one level of the folder browser (subfolders, never above home)
//   POST /folder/apply         { exp, bundles? }  what landed, back into a folder project's folder(s) (sources.mjs)
//   POST /keys                 { provider, key|null, model?, host? }  an API key into ~/.converge/config.json (backed up
//                              first; the universal agent uses the same file)
//   GET  /cloudflare           the Cloudflare account as set (never the token), the last check and the deploy job
//   POST /cloudflare           { account_id?, api_token?, worker_url?, admin_key? }  saves them (null removes)
//   POST /cloudflare/check     checks the token and what is deployed;  POST /cloudflare/deploy { fresh_keys? }
//   GET  /cloudflare/log       the deploy's log;  GET /cloudflare/creds  the Worker's URL and admin key (the platform's proxy)
//   POST /cloudflare/workers-ai { on }  Workers AI as a model provider (the same token), in ~/.converge/config.json
// Listens on 127.0.0.1 only; every request carries X-Host-Token.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { folderPath, bundleFolders, listDirs, folderApply } from './lib/sources.mjs';
import { leadReport } from './lib/local-run.mjs';
import * as CF from './lib/cloudflare.mjs';
import { modelsOf } from './lib/models.mjs';
import { setAsqlProvider, dropAsqlModel } from './lib/provider-store.mjs';
import { agentDir, readAgentLog } from './lib/agent-log.mjs';
import { findUniversalAgent, aiosMissing, killGroup, kernelOnPath } from '../agents/common.mjs';
kernelOnPath();   // git is aios-git, the shell aios-sh, for every agent this starts
import { jailPath } from '../agents/fenced.mjs';

// Every agent started here is an aios entity (agents/converge.mjs runAios): aios decides each action and converge-jail
// (Landlock on Linux, Seatbelt on a Mac) fences each command it runs. What this machine lacks for that, [] = ready.
const aiosHere = (provider) => aiosMissing({ root: ROOT, provider, jail: jailPath() });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HOST_AGENTS_PORT || 8786);
const TOKEN = process.env.HOST_AGENTS_TOKEN || '';
const DIR = path.join(os.homedir(), '.converge-local', 'host-runs');
const UA = findUniversalAgent(ROOT);
if (!TOKEN) { console.error('host-agents: set HOST_AGENTS_TOKEN'); process.exit(1); }

// Gemini CLI is discontinued: Antigravity's CLI (agy) replaces it.
const CLIS = [['claude-cli', 'claude', 'Claude Code'], ['antigravity-cli', 'agy', 'Antigravity'], ['codex-cli', 'codex', 'Codex'], ['cursor-cli', 'cursor-agent', 'Cursor']];
function info() {
  const clis = CLIS.map(([provider, bin, label]) => {
    const where = spawnSync('sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim() || [path.join(os.homedir(), '.local', 'bin', bin)].find((f) => fs.existsSync(f)) || '';
    return where ? { provider, bin: where, label } : null;
  }).filter(Boolean);
  const missing = aiosHere('claude-cli');
  return { clis, universal_agent: Boolean(UA), aios: !missing.length, aios_missing: missing, host: os.hostname() };
}

const AGENT_CONFIG = path.join(os.homedir(), '.converge', 'config.json');
/** A provider's key (null removes it, and its models when `models` is []) and models into ASQL and the agent's config, backed up
 *  first. `keepKey`: change only the models. */
async function setAgentProvider(provider, key, models, keepKey = false) {
  try { await setAsqlProvider(provider, key, models, keepKey); } catch (e) { console.error('asql:', e.message); }
  let c = {}; try { c = JSON.parse(fs.readFileSync(AGENT_CONFIG, 'utf8')); } catch { /* a new one */ }
  fs.mkdirSync(path.dirname(AGENT_CONFIG), { recursive: true });
  if (fs.existsSync(AGENT_CONFIG)) { fs.copyFileSync(AGENT_CONFIG, `${AGENT_CONFIG}.bak-converge`); fs.chmodSync(`${AGENT_CONFIG}.bak-converge`, 0o600); }
  c.apiKeys = c.apiKeys || {};
  if (!keepKey) { if (key) c.apiKeys[provider] = String(key).trim(); else delete c.apiKeys[provider]; }
  if (!key && !keepKey && provider === 'cloudflare') c.models = (c.models || []).filter((m) => m.provider !== provider);
  // The models to run with it (the picker lists the agent config's models), unless listed already.
  for (const m of models) {
    if (!(c.models || []).some((x) => x.provider === provider && x.model === m.model)) c.models = [...(c.models || []), { provider, model: m.model, ...(m.host ? { host: m.host } : {}) }];
  }
  fs.writeFileSync(AGENT_CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
}
/** Removes one model from the list (Keys → Providers). */
async function dropAgentModel(provider, model) {
  try { await dropAsqlModel(provider, model); } catch (e) { console.error('asql:', e.message); }
  let c = {}; try { c = JSON.parse(fs.readFileSync(AGENT_CONFIG, 'utf8')); } catch { return; }
  fs.copyFileSync(AGENT_CONFIG, `${AGENT_CONFIG}.bak-converge`); fs.chmodSync(`${AGENT_CONFIG}.bak-converge`, 0o600);
  c.models = (c.models || []).filter((m) => !(m.provider === provider && m.model === model));
  fs.writeFileSync(AGENT_CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
}

const runs = new Map(); // id -> { pid, dir, exited }
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const safe = (s) => /^[A-Za-z0-9._-]{1,80}$/.test(String(s || ''));

http.createServer(async (req, res) => {
  try {
    const given = String(req.headers['x-host-token'] || '');
    if (given.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/info') return send(res, 200, info());
    if (req.method === 'GET' && url.pathname === '/agentlog') {
      // An agent's log, for the dashboard's live view of an agent running on this Mac.
      const agent = String(url.searchParams.get('agent') || '');
      if (!/^a-[0-9a-f]{4,16}$/.test(agent)) return send(res, 400, { error: 'agent' });
      let dirs = []; try { dirs = fs.readdirSync(DIR).map((d) => path.join(DIR, d)); } catch { /* none yet */ }
      const dir = agentDir(dirs, agent);
      return send(res, 200, dir ? readAgentLog(dir, Number(url.searchParams.get('after') ?? -1)) : { entries: [], total: 0, missing: true });
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      // A CLI's models as the Mac's own CLI lists them (the picker, for agents on the Mac).
      try { return send(res, 200, await modelsOf(UA, String(url.searchParams.get('provider') || ''), { fresh: url.searchParams.get('fresh') === '1' })); }
      catch (e) { return send(res, e.status || 500, { error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/keys') {
      let raw = ''; for await (const c of req) raw += c;
      const b = JSON.parse(raw || '{}');
      const provider = String(b.provider || '');
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(provider) || /-cli$/.test(provider)) return send(res, 400, { error: 'provider: an API provider name' });
      if (b.drop_model) { await dropAgentModel(provider, String(b.drop_model)); console.log(`keys: ${provider} model ${b.drop_model} removed`); return send(res, 200, { ok: true }); }
      await setAgentProvider(provider, b.key || null, (b.key || b.keep_key) && b.model ? [{ model: String(b.model), host: b.host ? String(b.host) : '' }] : [], Boolean(b.keep_key));
      console.log(`keys: ${provider} ${b.keep_key ? 'model added' : b.key ? 'set' : 'removed'}${b.model ? ` (model ${b.model})` : ''}`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/cloudflare')) {
      let raw = ''; if (req.method === 'POST') for await (const c of req) raw += c;
      const b = JSON.parse(raw || '{}');
      try {
        if (req.method === 'GET' && url.pathname === '/cloudflare') return send(res, 200, CF.status(ROOT));
        if (req.method === 'GET' && url.pathname === '/cloudflare/log') return send(res, 200, { log: CF.log(), job: CF.status(ROOT).job });
        if (req.method === 'GET' && url.pathname === '/cloudflare/creds') return send(res, 200, CF.creds());
        if (req.method === 'POST' && url.pathname === '/cloudflare') { CF.save(b); return send(res, 200, CF.status(ROOT)); }
        if (req.method === 'POST' && url.pathname === '/cloudflare/check') { await CF.check(ROOT); return send(res, 200, CF.status(ROOT)); }
        if (req.method === 'POST' && url.pathname === '/cloudflare/deploy') { CF.deploy(ROOT, b); return send(res, 200, CF.status(ROOT)); }
        if (req.method === 'POST' && url.pathname === '/cloudflare/workers-ai') {
          const c = CF.read();
          if (b.on && !(c.api_token && c.account_id)) return send(res, 400, { error: 'connect the Cloudflare account first' });
          await setAgentProvider('cloudflare', b.on ? c.api_token : null, b.on ? CF.WORKERS_AI_MODELS.map((m) => ({ model: m, host: CF.workersAiHost(c.account_id) })) : []);
          CF.markWorkersAi(b.on);
          return send(res, 200, CF.status(ROOT));
        }
      } catch (e) { return send(res, e.status || 500, { error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/folder/apply') {
      // What landed, into the owner's folder(s) here. A git folder needs main as a bundle: asked for when missing.
      let raw = ''; for await (const c of req) raw += c;
      const b = JSON.parse(raw || '{}');
      const need = [];
      try {
        const report = folderApply(b.exp, (f) => {
          const got = b.bundles?.[f.prefix];
          if (!got) { need.push(f.prefix); throw Object.assign(new Error('bundle needed'), { needBundle: true }); }
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-in-'));
          fs.writeFileSync(path.join(tmp, 'main.bundle'), Buffer.from(got.data, 'base64'));
          return { file: path.join(tmp, 'main.bundle'), ref: got.ref };
        });
        return send(res, 200, { report, need_bundle: [] });
      } catch (e) {
        if (e.needBundle) {
          // Apply the plain folders now; the git ones once their bundles come.
          const plain = b.exp.folders.filter((f) => !need.includes(f.prefix) && !fs.existsSync(path.join(folderPath(f.path), '.git')));
          const report = plain.length ? folderApply({ ...b.exp, folders: plain }) : [];
          const gitOnes = b.exp.folders.filter((f) => fs.existsSync(path.join(folderPath(f.path), '.git'))).map((f) => f.prefix);
          return send(res, 200, { report, need_bundle: gitOnes });
        }
        return send(res, e.status || 500, { error: String(e.message || e) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/dirs') {
      let raw = ''; for await (const c of req) raw += c;
      try { return send(res, 200, listDirs(JSON.parse(raw || '{}').path || '')); }
      catch (e) { return send(res, e.status || 500, { error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/bundle') {
      let raw = ''; for await (const c of req) raw += c;
      const b = JSON.parse(raw || '{}');
      const paths = (Array.isArray(b.paths) ? b.paths : [b.path]).map(String).filter(Boolean);
      let file;
      try { file = bundleFolders(paths.map((p) => folderPath(p)), os.tmpdir()); }
      catch (e) { return send(res, e.status || 500, { error: String(e.message || e) }); }
      console.log(`bundle: ${paths.join(', ')} (${fs.statSync(file).size} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return fs.createReadStream(file).on('close', () => fs.rmSync(path.dirname(file), { recursive: true, force: true })).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/runs') {
      let raw = ''; for await (const c of req) raw += c;
      const b = JSON.parse(raw || '{}');
      if (!safe(b.id) || !safe(b.project) || !/^[a-z]+-cli$/.test(String(b.provider)) || !Array.isArray(b.tasks) || !b.tasks.length) return send(res, 400, { error: 'id, project, provider (a CLI) and tasks are required' });
      const missing = aiosHere(String(b.provider));
      if (missing.length) return send(res, 503, { error: `on the host, agents cannot run as aios entities: ${missing.join('; ')}` });
      const dir = path.join(DIR, `${b.project}-${b.id}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(b.tasks, null, 1));
      if (b.rules) fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(b.rules));
      const out = fs.openSync(path.join(dir, 'swarm.out'), 'a');
      const child = spawn(process.execPath, [path.join(ROOT, 'agents', 'swarm.mjs'), '--project', b.project, '--tasks', path.join(dir, 'tasks.json'),
        '--agent', b.provider, ...(b.model ? ['--model', String(b.model)] : []), '--dir', dir, '--no-warm', '--checks-tried',
        ...(b.rules ? ['--rules', path.join(dir, 'rules.json')] : []), ...(b.leads ? ['--leads'] : []), ...(b.effort ? ['--effort', String(b.effort)] : [])],
      { cwd: ROOT, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, CONVERGE_API_URL: String(b.api || 'http://127.0.0.1:8787'), ADMIN_KEY: String(b.admin_key || 'local'), ...(UA ? { UNIVERSAL_AGENT: UA } : {}) } });
      fs.closeSync(out);
      const run = { pid: child.pid, dir, exited: false };
      child.on('exit', () => { run.exited = true; });
      child.unref();
      runs.set(b.id, run);
      console.log(`run ${b.id}: ${b.tasks.length} tasks on ${b.provider} for ${b.project} (pid ${child.pid}); output in ${dir}/swarm.out`);
      return send(res, 200, { ok: true, dir });
    }
    const m = url.pathname.match(/^\/runs\/([A-Za-z0-9._-]+)(\/stop|\/control)?$/);
    if (m) {
      const r = runs.get(m[1]);
      if (!r) return send(res, 404, { error: 'no such run here' });
      if (req.method === 'POST' && m[2] === '/control') { let raw = ''; for await (const c of req) raw += c; fs.writeFileSync(path.join(r.dir, 'control.json'), raw || '{}'); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && m[2]) { killGroup(r.pid, 'SIGTERM'); return send(res, 200, { ok: true }); }
      if (req.method === 'GET' && !m[2]) {
        const status = read(path.join(r.dir, 'status.json'));
        if (status?.leads) status.leads = status.leads.map((l) => ({ ...l, report: leadReport(path.join(r.dir, l.key)) }));
        return send(res, 200, { status, report: read(path.join(r.dir, 'report.json')), swarm: read(path.join(r.dir, 'swarm.json')), tasks: read(path.join(r.dir, 'tasks.json')), exited: r.exited });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '127.0.0.1', () => console.log(`host-agents on 127.0.0.1:${PORT} · CLIs here: ${info().clis.map((c) => c.label).join(', ') || 'none'}`));
