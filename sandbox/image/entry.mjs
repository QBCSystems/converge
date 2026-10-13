// One run's container on Cloudflare: a supervisor that listens FIRST, then sets the run up, and plans and starts
// the run's agents when converge's sandbox Worker hands it the request (POST /__sandbox/launch).
//
// Listening first matters: the platform stops a container whose port does not open in time, and the
// set-up below (a clone over the network) can take a while. Until it is ready the port answers 503 with how far
// set-up has got; if set-up fails it answers 500 with why (x-sandbox-error), so the reason reaches the dashboard
// instead of the container just disappearing.
//
//   SANDBOX_PROJECT  the run's project on converge               SANDBOX_TOKEN     the token that administers only it
//   CONVERGE_URL     where converge is                           AI_BASE / AI_MODEL  the model, through the AI proxy
//   SANDBOX_AI_TOKEN the run's token for the AI proxy            SANDBOX_BOX_TOKEN what the sandbox Worker presents
//   SANDBOX_BUDGET, SANDBOX_AGENTS  the run's caps               SANDBOX_STAGE     boot | clone: stop there (diagnosis)
//
// A run is planned and run by converge itself, as on a machine (scripts/lib/local-run.mjs): agents/plan.mjs splits the
// request into tasks with checks, the swarm's preflight tries every check on main (fenced), and agents/swarm.mjs
// --in-aios runs one agent per task, each an aios entity (agents/converge.mjs run -> runEntity). The mind proposes
// each action, aios (the kernel's agent-control) decides it against the entity's capabilities and records the cycle,
// converge-jail fences each command. The mind is the universal agent's model layer through its bridge, pointed at
// the AI proxy (AI_BASE, the run's token), which meters every call against the run's budget cap.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';

const env = process.env;
const PORT = 8080;   // what the platform connects to (SandboxBox.defaultPort)
let recent = '';
let phase = 'booting';
let failure = '';
let ready = false;
let finished = null;   // how the run's swarm ended (its report.json): the run is over then, not when the container sleeps

const log = (...a) => {
  const l = redact(`${new Date().toISOString().slice(11, 19)} [sandbox] ${a.join(' ')}\n`);
  recent = (recent + l).slice(-6000);
  process.stdout.write(l);
};
// Never show a credential: git's auth header, Artifacts tokens, converge tokens.
const redact = (t) => String(t)
  .replace(/(Authorization:\s*(Basic|Bearer)\s+)[A-Za-z0-9+/=._-]+/gi, '$1<redacted>')
  .replace(/art_v\d+_[A-Za-z0-9_?=.-]+/g, '<token>')
  .replace(/\b\d{9,12}\.[0-9a-f]{64}\b/g, '<token>');
function fail(message) {
  failure = redact(message);
  log('FAILED', failure.split('\n')[0]);
}
process.on('uncaughtException', (e) => fail(e && e.stack || e));
process.on('unhandledRejection', (e) => fail(e && e.stack || e));

// ---- 1. listen at once ------------------------------------------------------------------------------------
const RUNS = '/work/runs';   // one folder per launch: the plan, plan-log.jsonl, swarm.out, each agent's folder
let launching = false;
const authorized = (req) => !!env.SANDBOX_BOX_TOKEN && (req.headers.authorization || '') === `Bearer ${env.SANDBOX_BOX_TOKEN}`;
const answer = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  if (failure) {
    res.writeHead(500, { 'content-type': 'application/json', 'x-sandbox-error': '1' });
    return res.end(JSON.stringify({ error: `${failure}\n${recent}`.slice(-3000) }));
  }
  if (ready && env.SANDBOX_MODE === 'push') return answer(res, 200, { pushed: true });
  if (!ready) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2', 'x-sandbox-starting': '1' });
    return res.end(JSON.stringify({ phase, log: recent.slice(-1500) }));
  }
  if (!authorized(req)) return answer(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET' && req.url === '/') return answer(res, 200, { phase: 'ready', ...(finished ? { finished } : {}) });   // SandboxBox.status(), runPhase()
  // What is happening inside this run's container (for the owner and for support): the supervisor's log, and for
  // each launch the planner's log, the swarm's output and each agent's log and result.
  if (req.method === 'GET' && req.url === '/__sandbox/logs') {
    const tail = (f, n) => { try { return fs.readFileSync(f, 'utf8').slice(-n); } catch { return '(none)'; } };
    let text = `== sandbox\n${recent.slice(-2000)}\n`;
    try {
      for (const run of fs.readdirSync(RUNS).sort().slice(-2)) {
        const dir = path.join(RUNS, run);
        text += `\n== run ${run}: plan-log.jsonl\n${tail(path.join(dir, 'plan-log.jsonl'), 1500)}\n`;
        text += `\n== run ${run}: swarm.out\n${tail(path.join(dir, 'swarm.out'), 2500)}\n`;
        // each agent's own output (swarm writes <agent>.log next to the folders): why one stopped before it logged
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.log')).sort()) text += `\n== ${run}/${f}\n${tail(path.join(dir, f), 2500)}\n`;
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory() && x.name !== 'plan')) {
          text += `\n== ${run}/${e.name}/universal-agent.log\n${tail(path.join(dir, e.name, 'universal-agent.log'), 1800)}\n`;
          // the aios entity's result (converge run writes it next to the clone): cycles, actions, refusals
          if (fs.existsSync(path.join(dir, e.name, 'result.json'))) text += `\n== ${run}/${e.name}/result.json\n${tail(path.join(dir, e.name, 'result.json'), 1200)}\n`;
        }
      }
    } catch { text += '\n(no run yet)\n'; }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(text.replace(/[A-Za-z0-9_-]{40,}/g, '<token>'));
  }
  if (req.method === 'POST' && req.url === '/__sandbox/launch') {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 64_000) req.destroy(); });
    req.on('end', async () => {
      let b;
      try { b = JSON.parse(raw || '{}'); } catch { return answer(res, 400, { error: 'body must be JSON' }); }
      if (launching) return answer(res, 409, { error: 'this run is already starting' });
      launching = true;
      try { answer(res, 200, await launch(b)); }
      catch (e) { log('launch failed:', String(e && e.message || e).split('\n')[0]); answer(res, e.status || 502, { error: redact(String(e && e.message || e)).slice(0, 600) }); }
      finally { launching = false; }
    });
    return;
  }
  answer(res, 404, { error: 'not found' });
});
await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));
// Which build this is, first: a container log then says which image it came from.
const BUILD = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 12);
log('listening on', PORT, '| node', process.version, '| uid', process.getuid && process.getuid(), '| entry', BUILD);

// ---- diagnosis: make the requests named in SANDBOX_PROBE (comma separated), log each result, then idle ----------------
if (env.SANDBOX_PROBE) {
  (async () => {
    await new Promise((r) => setTimeout(r, 3000));
    for (const u of env.SANDBOX_PROBE.split(',').filter(Boolean)) {
      const t0 = Date.now();
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
        log('probe', u, '->', r.status, `${Date.now() - t0}ms`, (await r.text()).slice(0, 60).replace(/\s+/g, ' '));
      } catch (e) { log('probe', u, 'FAILED', `${Date.now() - t0}ms`, String(e && e.cause && e.cause.code || e && e.message || e)); }
    }
    log('probe done');
  })();
  await new Promise(() => {});
}

// ---- the project's own test command, read from what the repository is -----------------------------------------
// Only when the project has none: converge then runs it on every change, so one task cannot quietly break another.
function detectTestCommand(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.test || '';
      if (t && !/no test specified/.test(t)) return 'npm test';
    } catch { /* not JSON */ }
  }
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt') || (has('tests') && fs.readdirSync(path.join(dir, 'tests')).some((f) => f.endsWith('.py')))) return 'python3 -m unittest discover -s tests -t .';
  if (has('Makefile') && /^test:/m.test(fs.readFileSync(path.join(dir, 'Makefile'), 'utf8'))) return 'make test';
  return '';
}
async function adoptTestCommand({ converge, token, project, work }) {
  try {
    const st = await getJson(`${converge}/api/projects/${encodeURIComponent(project)}/state`, { 'X-Admin-Key': token }, 2);
    if ((st.state || st).project?.test_command) return;
    const cmd = detectTestCommand(work);
    if (!cmd) return log('no test command found in the repository: the tasks\' own checks gate each change');
    const r = await fetch(`${converge}/api/projects/${encodeURIComponent(project)}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': token }, body: JSON.stringify({ test_command: cmd }) });
    log(r.ok ? `the project's tests: ${cmd}` : `could not set the test command (${r.status})`);
  } catch (e) { log('test command detection skipped:', String(e && e.message || e)); }
}

// ---- an empty project's first commit, landed through converge ----------------------------------------------------
async function startEmptyProject({ converge, token, project }) {
  log('the project is empty: landing its first commit');
  const api = async (p, body) => {
    const r = await fetch(`${converge}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': token }, body: JSON.stringify(body) });
    const t = await r.text(); if (!r.ok) throw new Error(`${p}: ${r.status} ${t.slice(0, 200)}`); return JSON.parse(t);
  };
  const task = await api(`/api/projects/${encodeURIComponent(project)}/tasks`, { title: 'Start the project', description: 'The first commit: a README, how the project is built (AGENTS.md), and an empty test setup.', mode: 'split', agents: 1, accept: [] });
  const a = task.agents[0];
  const mcp = async (name, args) => {
    const r = await fetch(a.mcp_url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${a.mcp_key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json(); if (j.error) throw new Error(`${name}: ${j.error.message}`); return JSON.parse(j.result?.content?.[0]?.text || '{}');
  };
  const dir = '/work/first';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const g = (...x) => execFileSync('git', ['-C', dir, ...x], { encoding: 'utf8' });
  g('init', '-q', '-b', task.main_branch || 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${project}\n\nStarted on converge. Agents build it from requests; every change is checked before it lands on main.\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.agent/\n.converge/\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), [
    '# How this project is built', '',
    'Nothing yet: the first request decides the language and layout. Whoever adds the first code also writes down here how to build it and run its tests.', '',
    '## Checks that prove a task is done', '',
    'A check is one shell command that runs the real code on real input and fails until the task is done: run the program, call the function, run its tests. Never grep the source or test that a file exists.', '',
  ].join('\n'));
  g('add', '-A');
  execFileSync('git', ['-C', dir, '-c', 'user.name=converge', '-c', 'user.email=converge@sandbox.invalid', 'commit', '-q', '-m', 'Start the project: README and AGENTS.md'], { stdio: 'ignore' });
  const auth = ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x:${a.token}`).toString('base64')}`];
  execFileSync('git', ['-C', dir, ...auth, 'push', '-q', a.remote, `HEAD:refs/heads/${task.main_branch || 'main'}`], { stdio: 'ignore', timeout: 120_000 });
  await mcp('claim', { paths: ['README.md', 'AGENTS.md', '.gitignore'], summary: 'the first commit' });
  await mcp('submit', { summary: 'Start the project: a README and AGENTS.md (how a check proves a task done).' });
  for (let i = 0; i < 60; i++) {
    const st = await mcp('status', {});
    const state = st.state || st.you?.change?.state;
    if (state === 'landed') {
      log('first commit landed');
      return;
    }
    if (state === 'conflicted') throw new Error('the first commit could not land (conflicted)');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('the first commit did not land within two minutes');
}

// ---- bring home: push converge's main to a new branch on GitHub, then answer 200 -----------------------------------
if (env.SANDBOX_MODE === 'push') {
  try {
    phase = 'pushing to GitHub';
    const basic = (t, user = 'x-access-token') => `Authorization: Basic ${Buffer.from(`${user}:${t}`).toString('base64')}`;
    const dir = '/work/push.git';
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync('git', ['-c', `http.extraHeader=${basic(env.PUSH_SRC_TOKEN, 'x')}`, 'clone', '-q', '--bare', env.PUSH_SRC, dir], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    const commit = env.PUSH_COMMIT || execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', dir, '-c', `http.extraHeader=${basic(env.PUSH_DST_TOKEN)}`, 'push', '-q', env.PUSH_DST, `${commit}:refs/heads/${env.PUSH_BRANCH}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    log('pushed', commit.slice(0, 12), 'to', env.PUSH_BRANCH);
    ready = true;
  } catch (e) { fail(e && (e.stderr ? `${e.message}\n${e.stderr}` : e.stack) || e); }
  await new Promise(() => {});
}

// ---- the aios the agents run in: the kernel shipped in /app/converge/kernel/linux-x64 ---------------------------
const CONVERGE_HOME = env.CONVERGE_HOME || '/app/converge';
// Every HTTPS connection out of this container is re-signed by Cloudflare's CA (SandboxBox.interceptHttps). node, the system
// git and curl are pointed at it (envFor: NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, ...); aios-git, the agents' git, reads the
// system's trust store, so the CA goes in there too, or an agent cannot clone its fork.
function trustEgressCa() {
  const ca = env.NODE_EXTRA_CA_CERTS, store = '/etc/ssl/certs/ca-certificates.crt';
  if (!ca || !fs.existsSync(ca) || !fs.existsSync(store)) return;
  const pem = fs.readFileSync(ca, 'utf8').trim();
  if (fs.readFileSync(store, 'utf8').includes(pem)) return;
  fs.appendFileSync(store, `\n${pem}\n`);
  log('the egress CA is in', store);
}
async function aiosReady() {
  const { aiosMissing, kernelDir } = await import(path.join(CONVERGE_HOME, 'agents', 'common.mjs'));
  const { jailPath } = await import(path.join(CONVERGE_HOME, 'agents', 'fenced.mjs'));
  const missing = aiosMissing({ root: CONVERGE_HOME, provider: 'openai-compat', jail: jailPath() });
  if (missing.length) throw new Error(`the agents cannot run as aios entities here:\n  - ${missing.join('\n  - ')}`);
  let version = '';
  try { version = (/^aios=(\S+)/m.exec(fs.readFileSync(path.join(kernelDir(CONVERGE_HOME), 'VERSION'), 'utf8')) || [])[1]?.slice(0, 12) || ''; } catch { /* unreadable: said as unknown */ }
  log('agents run as aios entities: aios', version || '(version unknown)', '| jail', jailPath());
  // Every check runs fenced: try the fence once now, so a container that cannot run one fails here with the reason,
  // before a run is planned (and paid for).
  const { runFencedAsync } = await import(path.join(CONVERGE_HOME, 'agents', 'fenced.mjs'));
  let mode = '';
  try { mode = execFileSync(jailPath(), ['--mode'], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch (e) { mode = `unknown (${String(e.message).split('\n')[0]})`; }
  const probe = fs.mkdtempSync('/tmp/fence-probe-');
  const r = await runFencedAsync('node -e "process.exit(0)" && echo fence-ok', probe, { timeoutMs: 30_000 });
  fs.rmSync(probe, { recursive: true, force: true });
  const said = `${r.stdout}${r.stderr}`.trim().replace(/\s+/g, ' ').slice(0, 600);
  log('fence:', mode, '| probe exit', r.status, '|', said || '(no output)');
  if (r.status !== 0 || !/fence-ok/.test(r.stdout)) throw new Error(`checks cannot run fenced in this container (jail mode ${mode}): exit ${r.status}, ${said || 'no output'}`);
}

// ---- 2. set up ----------------------------------------------------------------------------------------------------
const need = (k) => { if (!env[k]) throw new Error(`${k} is not set`); return env[k]; };
const stageStop = (name) => { if (env.SANDBOX_STAGE === name) { phase = `stopped at ${name}`; fail(`stopped at stage ${name} (SANDBOX_STAGE)`); return true; } return false; };

async function getJson(url, headers = {}, tries = 8) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      const t = await r.text();
      if (r.ok) return JSON.parse(t);
      if (r.status === 401 || r.status === 404) throw new Error(`${url}: ${r.status} ${t.slice(0, 120)}`);
      throw new Error(`${url}: ${r.status}`);
    } catch (e) {
      log('fetch', url.replace(/\/\/([^/]+).*/, '//$1'), 'attempt', i + 1, 'failed:', String(e && e.message || e).slice(0, 140));
      if (i >= tries || /: (401|404) /.test(String(e.message))) throw e;
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
}

try {
  const project = need('SANDBOX_PROJECT'), token = need('SANDBOX_TOKEN'), converge = need('CONVERGE_URL').replace(/\/$/, '');
  need('AI_BASE'); need('AI_MODEL'); need('SANDBOX_AI_TOKEN'); need('SANDBOX_BOX_TOKEN');
  const work = env.SANDBOX_WORK || '/work/app';
  if (stageStop('boot')) throw new Error('stopped');
  trustEgressCa();
  await aiosReady();

  // Their project: a clone of converge's main for it (read access only; their work goes through converge).
  phase = 'getting your project';
  log('asking converge for', project);
  const main = await getJson(`${converge}/api/projects/${encodeURIComponent(project)}/main`, { 'X-Admin-Key': token });
  fs.mkdirSync(path.dirname(work), { recursive: true });
  execFileSync('git', ['config', '--global', 'user.name', 'converge'], { stdio: 'ignore' });
  execFileSync('git', ['config', '--global', 'user.email', 'converge@sandbox.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['config', '--global', '--add', 'safe.directory', '*'], { stdio: 'ignore' });
  const auth = `Authorization: Basic ${Buffer.from(`x:${main.main_token}`).toString('base64')}`;
  // A brand-new project has no main branch at all: start it through converge, as an ordinary change (a task, an
  // agent, a first commit pushed to its fork, claimed and submitted), so even the first commit is checked and signed.
  const hasMain = (() => {
    try { return execFileSync('git', ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x:${main.main_token}`).toString('base64')}`, 'ls-remote', '--heads', main.main_remote], { encoding: 'utf8', timeout: 60_000 }).trim() !== ''; }
    catch { return true; }   // unknown: let the clone say what is wrong
  })();
  if (!hasMain) { phase = 'starting your empty project'; await startEmptyProject({ converge, token, project }); }
  phase = 'cloning your project';
  log('cloning from', new URL(main.main_remote).host);
  execFileSync('git', ['-c', `http.extraHeader=${auth}`, 'clone', '-q', '--branch', main.main_branch || 'main', main.main_remote, work], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  log('cloned into', work);
  await adoptTestCommand({ converge, token, project, work });
  if (stageStop('clone')) throw new Error('stopped');

  ready = true; phase = 'ready'; log('ready for the run');
} catch (e) {
  if (!failure) fail(e && e.stack || e);
}

// ---- 3. the run: planned, its checks tried on main, its agents started (scripts/lib/local-run.mjs does the same) -----
const run = (args, opts) => new Promise((resolve, reject) => {
  execFile(process.execPath, args, { cwd: CONVERGE_HOME, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
});
/** swarm.mjs --check-only: the problems its preflight found (none: the plan can run). */
async function preflight(args, runEnv) {
  try { await run(args, { env: runEnv, timeout: 300_000 }); return []; }
  catch (e) {
    const text = String(e.stderr || '') + String(e.stdout || '');
    const lines = text.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4));
    return lines.length ? lines : [text.trim().split('\n').pop() || String(e.message)];
  }
}
const planLog = (dir, kind, text, extra = {}) => {
  try { fs.appendFileSync(path.join(dir, 'plan-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), by: 'converge', kind, text, ...extra }) + '\n'); } catch { /* the log misses one line */ }
};
const httpErr = (status, message) => Object.assign(new Error(message), { status });

async function launch(b) {
  const request = typeof b.request === 'string' ? b.request.trim() : '';
  if (request.length < 6) throw httpErr(400, 'say what the agents should do');
  const project = env.SANDBOX_PROJECT, converge = env.CONVERGE_URL.replace(/\/$/, '');
  const agents = Math.min(Math.max(Math.round(Number(b.agents) || Number(env.SANDBOX_AGENTS) || 3), 1), 6);
  const budget = Math.min(Math.max(Number(b.budget) || Number(env.SANDBOX_BUDGET) || 0.5, 0.1), 2);
  const provider = 'openai-compat', model = env.AI_MODEL, host = env.AI_BASE;
  // The only model this run may use: the one its AI proxy serves, with the run's own token. No other provider is set.
  const providers = { apiKeys: { [provider]: env.SANDBOX_AI_TOKEN }, providers: { [provider]: { host } }, models: [{ provider, model, host }] };
  const runEnv = { ...env, CONVERGE_API_URL: converge, ADMIN_KEY: env.SANDBOX_TOKEN, CONVERGE_RUN_PROVIDERS: JSON.stringify(providers) };
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, { recursive: true });
  const tasksPath = path.join(dir, 'tasks.json');
  const feedbackPath = path.join(dir, 'feedback.txt');
  const pick = ['--agent', provider, '--model', model, '--host', host];
  // Runners start on demand (--no-warm): warming them is the admin's call, and the run's token is refused it.
  const swarmArgs = (extra = []) => [path.join(CONVERGE_HOME, 'agents', 'swarm.mjs'), '--project', project, '--tasks', tasksPath,
    ...(extra.includes('--check-only') ? ['--base', path.join(dir, 'plan')] : []),
    '--in-aios', '--budget', String(budget), ...pick, '--dir', dir, '--no-warm', ...extra];

  // Planned, then every check tried on main as it is now. A plan whose checks are broken or already pass goes back to
  // the planner with the reasons, up to three tries; then the tasks still refused are left out.
  let planned = [], problems = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    phase = attempt === 1 ? 'planning' : `planning again (${problems.length} problem(s))`;
    log(phase, `"${request.slice(0, 80)}" into up to ${agents} tasks`);
    planLog(dir, 'step', attempt === 1 ? `Planning into up to ${agents} task(s) with ${model}` : `Planning again (try ${attempt}): ${problems.length} problem(s) to fix`);
    const previousPath = path.join(dir, 'tasks-refused.json');
    if (attempt > 1 && fs.existsSync(tasksPath)) fs.renameSync(tasksPath, previousPath);
    fs.rmSync(tasksPath, { force: true });
    try {
      await run([path.join(CONVERGE_HOME, 'agents', 'plan.mjs'), '--project', project, '--request', request, '--agents', String(agents), '--out', tasksPath,
        ...pick, '--work', path.join(dir, 'plan'), ...(problems.length ? ['--feedback', feedbackPath, ...(fs.existsSync(previousPath) ? ['--repair', previousPath] : [])] : [])],
      { env: runEnv, timeout: 600_000 });
      planned = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    } catch (e) {
      const why = String(e.stderr || e.message).trim().split('\n').pop().slice(0, 300);
      planLog(dir, 'failed', `Planning failed: ${why}`);
      throw httpErr(502, `planning failed: ${why}`);
    }
    phase = 'checking the plan';
    planLog(dir, 'step', 'Checking the plan: each task\'s checks must run, and fail on main as it is now');
    problems = await preflight(swarmArgs(['--check-only']), runEnv);
    if (!problems.length) { planLog(dir, 'step', 'The plan checks out'); break; }
    planLog(dir, 'problems', `${problems.length} problem(s) with the plan`, { problems });
    // Only a task's own check can be put right by planning again: anything else is refused the same on every try.
    const notThePlan = problems.find((p) => !/^task [\w-]+:/.test(p));
    if (notThePlan) throw httpErr(503, notThePlan.slice(0, 280));
    fs.writeFileSync(feedbackPath, problems.map((p) => `- ${p}`).join('\n'));
  }
  let dropped = [];
  if (problems.length) {
    const bad = new Set(problems.map((p) => /^task ([\w-]+):/.exec(p)?.[1]).filter(Boolean));
    if (!bad.size || bad.size >= planned.length) throw httpErr(502, `could not plan checks that work: ${problems[0].slice(0, 240)}`);
    dropped = planned.filter((t) => bad.has(t.key));
    planned = planned.filter((t) => !bad.has(t.key));
    fs.writeFileSync(tasksPath, JSON.stringify(planned, null, 1));
    const again = await preflight(swarmArgs(['--check-only']), runEnv);
    if (again.length) throw httpErr(502, `could not plan checks that work: ${again[0].slice(0, 240)}`);
  }
  // The planner's clone of main served the plan check; the agents clone their own.
  fs.rmSync(path.join(dir, 'plan', 'main'), { recursive: true, force: true });

  planLog(dir, 'step', `Starting ${Math.min(agents, planned.length)} agent(s) on ${planned.length} task(s)${dropped.length ? ` (left out: ${dropped.map((t) => t.key).join(', ')})` : ''}`);
  const out = fs.openSync(path.join(dir, 'swarm.out'), 'a');
  // The plan's checks were just tried (the preflight above): the swarm does not try them a second time.
  const swarm = spawn(process.execPath, [...swarmArgs(), '--checks-tried'], { cwd: CONVERGE_HOME, env: runEnv, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  swarm.on('exit', (code) => {
    let report = {};
    try { report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')); } catch { /* it ended before writing one */ }
    finished = { exit: code, landed: Number(report.landed) || 0, of: Number(report.tasks) || planned.length, stopped: String(report.stopped || '') };
    phase = 'finished';
    log(`the run's swarm finished (exit ${code}): landed ${finished.landed} of ${finished.of}${finished.stopped ? `, stopped: ${finished.stopped}` : ''}; report in ${dir}/report.json`);
  });
  phase = 'running';
  log('running', planned.length, 'task(s)', dropped.length ? `(left out ${dropped.length})` : '');
  return { tasks: planned.map((t) => t.title), dropped: dropped.map((t) => t.title), note: dropped.length ? `left out ${dropped.length} task(s) whose checks could not be made to work` : '' };
}
