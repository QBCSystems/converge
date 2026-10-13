#!/usr/bin/env node
// A run of many agents at once, from one command, needing nobody after it starts.
//
//   CONVERGE_API_URL=... ADMIN_KEY=... node agents/swarm.mjs --project P --tasks tasks.json \
//     [--create --test-command "node --test"] [--no-warm] --agent <provider> [--model M] [--host https://...] \
//     [--dir DIR] [--record out.mp4] [--budget USD] [--balance-floor 0.5] [--max-failed N] [--stagger-ms 200] [--check-only]
//
// tasks.json: [{ "key": "short-name", "title": "...", "description": "...", "accept": ["<check>", ...] }]
//
// 1. Preflight, refusing to start on any problem: the platform answers; aios is there to run every agent as an
//    entity (its runtime, agent-control, the bridge as the mind) and converge-jail to fence its commands (with
//    --outside-aios: the universal agent is there, parses, and has a working sandbox); the provider's key exists (and for DeepSeek the balance is
//    above the floor); every task's checks fail on the project's current main without a syntax error
//    (a check that already passes proves nothing, one that cannot run is broken).
// 2. Creates the project (--create) and the tasks (resumable: DIR/swarm.json remembers them), warms
//    the project's runners, starts the recording (--record).
// 3. One `converge run` per task, each in its own process group, the model pinned (no fallback to
//    another provider), each agent an aios entity (converge run's runAios). Each run continues its own stopped agent (converge run --resumes).
// 4. Every 15 s: tasks landed (from the platform), runs alive, and every 30 s the balance. A run
//    whose task has landed stops (so the swarm ends when every task has landed). Stops
//    every run (its whole process group) when the spending reaches 65% of --budget (the provider's
//    balance lags about a minute, so the margin keeps the run under the budget), when the balance
//    reaches the floor, or when more than --max-failed runs ended without their task landing. Spending
//    is metered from the agents' own usage (any model, priced by the agent's pricing.cjs), and for
//    DeepSeek also read from the balance; the higher counts. Writes
//    DIR/status.json each time.
//
// tasks.json entries may carry "workstream": the planner's grouping (agents/plan.mjs). With --leads, each
// workstream of 2+ tasks also gets a lead: a reviewer scoped to its tasks that reviews as changes arrive and reports.
//
// --rules rules.json: { "maxTries": 3, "pauseAt": 0.4, "minHandedIn": 4 }. A task whose changes were sent back
// maxTries times is escalated (its run stops; the dashboard asks the owner); a workstream where pauseAt or more of
// the last 15 minutes' hand-ins came back is paused (its runs stop). DIR/control.json { "resume": [...], "drop":
// [...], "retire": [...] } (task keys, or "ws:<name>"; a retire of "<key>#<n>" retires only blocking check n of the task)
// is read every round: resume relaunches, drop gives up, retire stops running the blocking checks and relaunches. A
// resume or retire starts the task's count of tries again. While something waits on
// the owner the swarm stays up (30 minutes at most), so a resume still has somewhere to go.
//
// --unsandboxed: the agents run on this machine with no OS sandbox (only where there is none to give them); the
// checks are not tried here (the platform that handed the run over tried them, fenced, and still checks every
// change, fenced, before it lands).
// --checks-tried: the agents are fenced as usual (bubblewrap on Linux, Seatbelt on macOS), and the checks are not
// tried again here (the platform that handed the run over already tried them).
// 5. When every run has ended: stops the recording (it encodes what it captured), writes DIR/report.json
//    and prints it.
import { spawn, spawnSync } from 'node:child_process';
import { runFenced, runFencedAsync, seatbeltWorks, SANDBOX_EXEC, jailPath } from './fenced.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCannotPass } from './check-guard.mjs';
import { runPlanChecks } from './check-progress.mjs';
import { checkTask } from './task-check.mjs';
import { universalAgentPath, aiosMissing, providerConfig, killGroup, processTable, cloneFromDisk, mainMoved } from './common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIVERSAL_AGENT = universalAgentPath(ROOT);
// staggerMs: between two agents' starts. 1.5 s each put the twentieth agent 30 s behind the first; the starts are a
// clone from this machine's own store and a process each.
const opts = { balanceFloor: 0.5, staggerMs: 200 };
for (let i = 2; i < process.argv.length; i++) {
  const m = /^--([a-z-]+)$/.exec(process.argv[i]);
  if (!m) continue;
  const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (['create', 'checkOnly', 'noWarm', 'unsandboxed', 'checksTried', 'leads', 'continue', 'outsideAios', 'inAios', 'overOk'].includes(k)) opts[k] = true;
  else opts[k] = process.argv[++i];
}
const API = (process.env.CONVERGE_API_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (m) => { console.error(`swarm: ${m}`); process.exit(1); };
if (!opts.project || !opts.tasks) fail('usage: node agents/swarm.mjs --project P --tasks tasks.json [...] (see the header)');
if (!API || !ADMIN_KEY) fail('set CONVERGE_API_URL and ADMIN_KEY');
// No provider is assumed: the agents run on the one named.
if (!opts.agent) fail('say which provider the agents run on: --agent <provider> [--model M]');
const tasks = JSON.parse(fs.readFileSync(opts.tasks, 'utf8'));
if (!Array.isArray(tasks) || !tasks.length || tasks.some((t) => !t.key || !t.title)) fail(`${opts.tasks}: a JSON array of { key, title, description, accept } please`);
if (new Set(tasks.map((t) => t.key)).size !== tasks.length) fail('task keys must be unique');
// Where the swarm stops, as a share of --budget. The provider's balance trails real spending by 1-3
// minutes and calls in flight finish after the stop: with 24 agents a stop at 80% ($1.64 of $2) still
// ended at $2.03, so the margin is a third of the budget.
// With the live meter (every call priced as it is made, pricing.cjs) the swarm runs to the budget itself, less about a
// cent per running agent for the calls still in flight. Only without it (the balance alone) is the margin needed.
const STOP_AT = 0.65;
const stopLine = (alive) => (pricing ? Math.max(budget * 0.5, budget - 0.01 * Math.max(1, alive)) : budget * STOP_AT);
const DIR = path.resolve(opts.dir || path.join(os.tmpdir(), 'converge-swarm', opts.project));
// A --rules file that cannot be read is an error, not a run without the owner's rules (maxTries, pauseAt).
const RULES = (() => { if (!opts.rules) return null; try { return JSON.parse(fs.readFileSync(opts.rules, 'utf8')); } catch (e) { fail(`--rules ${opts.rules}: ${e.message}`); } })();
const wsOf = (t) => String(t.workstream || '').trim();
fs.mkdirSync(DIR, { recursive: true });
const maxFailed = opts.maxFailed !== undefined ? Number(opts.maxFailed) : Math.max(3, Math.ceil(tasks.length * 0.2));
const floor = Number(opts.balanceFloor);
let budget = opts.budget !== undefined ? Number(opts.budget) : null;   // lowered by preflight when the balance cannot cover it
if (budget !== null && !(budget > 0)) fail('--budget takes a positive number of dollars');

// What the agents spent, metered, whatever the model: every agent of this swarm writes its usage
// (the universal agent's registry events: provider/model and tokens per call) under DIR/usage,
// priced by the agent's own pricing table (pricing.cjs next to it). DeepSeek's balance is read as
// well and the higher of the two counts; for any other provider the meter is the budget's measure.
const USAGE_DIR = path.join(DIR, 'usage');
process.env.CONVERGE_REGISTRY_DIR = USAGE_DIR;
let pricing = null;
try { pricing = createRequire(import.meta.url)(path.join(path.dirname(UNIVERSAL_AGENT), 'pricing.cjs')); } catch { /* no table: no meter */ }
function metered() {
  if (!pricing) return null;
  let text = '';
  try { text = fs.readFileSync(path.join(USAGE_DIR, 'registry-events.jsonl'), 'utf8'); } catch { return 0; }
  let usd = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.t !== 'usage') continue;
    const ref = String(ev.ref || ''); const cut = ref.indexOf('/');
    const c = pricing.costOf(cut > 0 ? ref.slice(0, cut) : ref, cut > 0 ? ref.slice(cut + 1) : '', Number(ev.tin) || 0, Number(ev.tout) || 0, Number(ev.cache) || 0);
    usd += Number(c && typeof c === 'object' ? c.usd : c) || 0;   // { usd, estimated, free }
  }
  return +usd.toFixed(4);
}
const spentNow = (startBalance, bal) => {
  const byBalance = startBalance !== null && bal !== null ? startBalance - bal : null;
  const m = metered();
  if (byBalance === null && m === null) return null;
  return +Math.max(byBalance || 0, m || 0).toFixed(2);
};

async function api(p, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { error: text }; }
  if (!res.ok) throw new Error(`${p}: ${res.status} ${j.error || text}`.slice(0, 400));
  return j;
}

// The provider's key, from ASQL, read once at the start of the preflight.
let providerKeyValue = '';
const providerKey = () => providerKeyValue;
async function loadProviderKey() {
  try { providerKeyValue = ((await providerConfig()).apiKeys || {})[opts.agent] || ''; } catch { providerKeyValue = ''; }
}
// A balance that cannot be read is null (the meter, and the preflight's refusal, carry on without it), and said
// once per kind of failure so a budget guard leaning on it is not silently blind.
const balanceErrors = new Set();
const balanceFailed = (why) => { if (!balanceErrors.has(why)) { balanceErrors.add(why); say(`cannot read the balance: ${why}`); } return null; };
async function balance() {
  if (opts.agent !== 'deepseek') return null;
  try {
    // The address the run's calls go to (--host), not always DeepSeek's own: the balance and the spending must be one account's.
    const r = await fetch(`${String(opts.host || 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/v1$/, '')}/user/balance`, { headers: { Authorization: `Bearer ${providerKey()}` } });
    const j = await r.json();
    const n = Number((j.balance_infos || []).find((b) => b.currency === 'USD')?.total_balance ?? j.balance_infos?.[0]?.total_balance);
    return Number.isFinite(n) ? n : balanceFailed(`DeepSeek answered ${r.status} with no balance`);
  } catch (e) { return balanceFailed(e.message); }
}

// Each plan check's result as a line of the run's plan log (DIR/plan-log.jsonl) the moment it is known: the dashboard
// shows a run's newest plan-log line while it is planning, so "Checking the plan" says which check is running and how
// each came out instead of nothing for up to a minute.
const CHECK_SAID = { 'fails-on-main': 'fails on main, as it should', 'already-passes': 'already passes on main (proves nothing)', broken: 'cannot run', 'timed-out': 'timed out' };
function checkEventToPlanLog(e) {
  if (!opts.dir) return;
  const text = e.type === 'said' ? e.text : e.type === 'task' ? `Checking ${e.key}${e.copyMs != null ? ` (its copy of main took ${(e.copyMs / 1000).toFixed(1)}s)` : ''}` : `${e.key}: check ${e.index + 1} ${CHECK_SAID[e.status] || e.status}${e.ms != null ? ` in ${(e.ms / 1000).toFixed(1)}s` : ''}`;
  try { fs.appendFileSync(path.join(opts.dir, 'plan-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), by: 'converge', kind: 'step', text }) + '\n'); } catch { /* the board misses one line */ }
}

// ---- 1. preflight ----
async function preflight() {
  await loadProviderKey();
  const problems = [];
  try { if (!(await fetch(API + '/health')).ok) problems.push(`${API}/health did not answer 200`); } catch (e) { problems.push(`${API} unreachable: ${e.message}`); }
  if (opts.inAios) {
    // Every agent is an aios entity (converge run): aios decides each action and converge-jail fences each command,
    // so what must work here is aios (its runtime, agent-control, the mind) and the jail, not the universal agent's sandbox.
    for (const m of aiosMissing({ root: ROOT, provider: opts.agent, jail: jailPath() })) problems.push(m);
    if (opts.unsandboxed) say('--unsandboxed has no effect on aios entities: every command they run is fenced by converge-jail');
  } else if (!fs.existsSync(UNIVERSAL_AGENT)) problems.push(`no universal agent at ${UNIVERSAL_AGENT}`);
  else if (opts.unsandboxed) say('agents run unsandboxed on this machine (--unsandboxed): the platform still checks every change before it lands');
  else {
    const chk = spawnSync(process.execPath, ['--check', UNIVERSAL_AGENT], { encoding: 'utf8' });
    if (chk.status !== 0) problems.push(`the universal agent does not parse: ${chk.stderr.slice(0, 300)}`);
    // macOS: the whole agent runs under Seatbelt (fenced.mjs). Elsewhere the universal agent fences each command itself.
    if (process.platform === 'darwin') { if (!seatbeltWorks()) problems.push(`no working Seatbelt here (${SANDBOX_EXEC}): agents do not run unfenced`); }
    // Windows: the whole agent runs at low integrity under converge-jail (fenced.mjs), its shell aios-sh.
    else if (process.platform === 'win32') { if (!jailPath()) problems.push('no converge-jail here (kernel/win32-x64/bin): agents do not run unfenced'); }
    else try {
      const sandbox = (await import(path.join(path.dirname(UNIVERSAL_AGENT), 'shared', 'sandbox.cjs'))).default;
      if (!sandbox.detectBackend()) problems.push('the universal agent has no working sandbox here (bwrap or firejail): agents could run no commands. Install bubblewrap (Debian/Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap; Arch: sudo pacman -S bubblewrap)');
    } catch (e) { problems.push(`cannot load the universal agent's sandbox check: ${e.message}`); }
  }
  // Anything else already spending on the provider would be counted against this run's budget,
  // and is spending unseen: aios minds or universal agents left over from an earlier run.
  // Only real agent processes count (node running a mind, the bridge or the universal agent), not a shell whose
  // command line merely mentions them. aios-agent-control itself is the shared service every entity runs through: it
  // spends nothing by itself (an entity's mind is its own process, counted here).
  // Left over means converge's own: an agent with nothing above it any more (its run died), or one under a converge
  // process (another run here, the shared agent-control service). An agent another running program owns (someone's
  // own aios session and its bridge, an editor's assistant) is that program's business: said, not counted.
  const procs = new Map();
  for (const p of processTable()) procs.set(p.pid, p);
  const name = (p) => path.basename(p.args.split(/\s+/)[0]); // ps cuts comm short beside other columns
  const ours = (p) => p.args.includes(ROOT + path.sep) || /aios-agent-control/.test(p.args);
  const owner = (p) => { // the nearest program above it that is not converge's; null when there is none
    let foreign = null;
    for (let up = procs.get(p.ppid), n = 0; up && Number(up.pid) > 1 && n < 64; up = procs.get(up.ppid), n++) {
      if (ours(up)) return null;
      foreign ||= up;
    }
    return foreign;
  };
  const agentsHere = [...procs.values()].filter((p) => p.pid !== String(process.pid) && (p.comm === 'node' || name(p) === 'node') && /intelligence\/minds\/|agents\/universal\/bridge\.cjs|universal-agent\.cjs/.test(p.args));
  const others = agentsHere.filter((p) => owner(p));
  if (others.length) say(`not counted: ${others.length} agent process(es) another program runs (${others.slice(0, 3).map((p) => `${p.pid}, under ${name(owner(p))} ${owner(p).pid}`).join('; ')})`);
  const strays = agentsHere.filter((p) => !owner(p)).map((p) => `${p.pid} ${p.args}`);
  // A subscription CLI is not metered, so other agents running here (your own sessions on a Mac) do not muddle a budget.
  if (strays.length && !/-cli$/.test(opts.agent)) problems.push(`${strays.length} agent processes are already running (stop them first): ${strays.slice(0, 3).map((l) => l.trim().slice(0, 100)).join(' | ')}`);
  // A subscription CLI (claude-cli, codex-cli, ...) signs in on its own and is already paid for: no
  // key, and its calls are not metered, so a budget does not limit it (the step and failure limits do).
  const subscription = /-cli$/.test(opts.agent);
  if (!subscription && !providerKey()) problems.push(`no ${opts.agent} key: add it in the dashboard (Settings, keys)`);
  if (subscription && budget !== null) say(`${opts.agent} is a subscription: its calls are not metered, so the $${budget} budget does not limit it`);
  if (budget !== null && opts.agent !== 'deepseek' && !/-cli$/.test(opts.agent) && !pricing) problems.push(`no pricing.cjs next to ${UNIVERSAL_AGENT}: the spending of ${opts.agent} cannot be measured, so the budget cannot hold`);
  const bal = await balance();
  if (opts.agent === 'deepseek') {
    if (bal === null) problems.push('cannot read the DeepSeek balance');
    else if (bal <= floor) problems.push(`DeepSeek balance $${bal} is at or below the floor $${floor}`);
    else if (budget !== null) {
      // The budget is the run's whole cap, and its meter already holds what earlier rounds spent (a continued run): the
      // balance has to cover only what is left to spend, not the cap again.
      // More asked than the balance holds above its floor: the run spends what is there instead (less than allowed is
      // always within what the owner chose), said once; refused only when next to nothing is left.
      const spentSoFar = metered() || 0;
      const left = +(budget - spentSoFar).toFixed(2);
      const room = +(bal - floor).toFixed(2);
      if (room < left && opts.overOk) say(`over budget by $${+(left - room).toFixed(2)} (confirmed): the run spends until the balance reaches the floor $${floor}`);
      else if (room < left) {
        if (room < 0.1) problems.push(`DeepSeek balance $${bal} is $${room} above the floor $${floor}: nothing left to spend on this run`);
        else { budget = +(spentSoFar + room).toFixed(2); say(`DeepSeek balance $${bal} above the floor $${floor} covers $${room} of the $${left} asked: this run spends up to $${room} more (cap $${budget})`); }
      }
    }
    else say(`DeepSeek balance $${bal} (floor $${floor}${budget !== null ? `, budget $${budget}: the run stops at about $${stopLine(tasks.length).toFixed(2)} spent` : ''}; a task has cost about $0.02-0.05)`);
  }
  // The checks against the project's main as it is now (an empty directory for a new project).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-base-'));
  // A continued run's checks were tried when it was planned, and its tasks are waiting to be finished: cloning main and
  // running every check again only delayed the agents by a minute each time.
  if (opts.unsandboxed || opts.checksTried || opts.continue) { fs.rmSync(base, { recursive: true, force: true }); if (problems.length) fail(`preflight found ${problems.length} problem(s), nothing started:\n  - ${problems.join('\n  - ')}`); say(`preflight ok: ${tasks.length} tasks (checks ${opts.continue ? 'tried when the run was planned' : 'tried by the platform'}), model pinned to ${opts.agent}${opts.model ? `/${opts.model}` : ' (its own default)'}`); return bal; }
  try {
    const exists = !opts.create || (await api('/api/projects')).projects.includes(opts.project);
    // The planner's own clone of main (plan.mjs --work: --base, or the path it wrote to plan-clone.txt in the run's
    // folder), made moments before: used as it is while main is still at its commit, instead of cloning main again
    // with converge's own git, which is slow at clone and checkout. A main that moved since is cloned afresh.
    let planned = opts.base && fs.existsSync(path.join(opts.base, 'main', '.git')) ? path.join(opts.base, 'main') : '';
    const cloneNote = opts.dir ? path.join(opts.dir, 'plan-clone.txt') : '';
    if (!planned && cloneNote) { try { const p = fs.readFileSync(cloneNote, 'utf8').trim(); if (p && fs.existsSync(path.join(p, '.git'))) planned = p; } catch { /* no planner's clone */ } }
    const m = exists && !opts.create ? await api(`/api/projects/${encodeURIComponent(opts.project)}/main`) : null;
    const auth = m ? `Authorization: Basic ${Buffer.from(`x:${m.main_token}`).toString('base64')}` : '';
    if (planned && m) {
      if (mainMoved(m, path.join(planned, '.git'))) {
        checkEventToPlanLog({ type: 'said', text: 'main moved since it was planned: checking on a fresh clone of it' });
        fs.rmSync(planned, { recursive: true, force: true });
        if (cloneNote) fs.rmSync(cloneNote, { force: true });
        planned = '';
      }
    }
    if (!planned && m) {
      const c = cloneFromDisk(m.main_local, m.main_remote, path.join(base, 'main')) ? { status: 0, stderr: '' }
        : spawnSync('git', ['-c', `http.extraHeader=${auth}`, 'clone', '-q', m.main_remote, path.join(base, 'main')], { encoding: 'utf8' });
      if (c.status !== 0 && !/empty repository/i.test(c.stderr)) problems.push(`cannot clone ${opts.project}'s main: ${c.stderr.slice(0, 200)}`);
    }
    const dir = planned || (fs.existsSync(path.join(base, 'main')) ? path.join(base, 'main') : base);
    const srcFiles = spawnSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter((f) => /\.(c|cc|cpp|cxx|h|hpp|rs|go|java|kt|cs|swift|m|mm)$/.test(f)).length;
    const big = srcFiles > 300 ? srcFiles : 0;
    // Each task's checks in a copy of main of its own, every task at once: one after another, a plan's checks took up to a
    // minute each (a check that starts a server runs to its time limit), and a check that ends kills whatever still works
    // in its folder, so two sharing one would stop each other.
    // The project's own tests on main (below), started now and run alongside the tasks' checks: after them, they added
    // their whole run time (8 s with the guard and npm test) to every plan check.
    const projectTests = exists && !opts.create
      ? api(`/api/projects/${encodeURIComponent(opts.project)}/state`).then((st) => {
        const testCommand = String(st.project?.test_command || '').trim();
        if (!testCommand) return null;
        // In a copy of its own: run in main's folder, its files would change while the tasks' copies are taken from it.
        const own = fs.existsSync(path.join(dir, '.git')) ? path.join(base, 'project-tests') : dir;
        const copied = own === dir ? Promise.resolve(0) : new Promise((resolve) => {
          const c = process.platform === 'win32' ? spawn('git', ['clone', '-q', '--shared', dir, own], { stdio: 'ignore' })
            : spawn('cp', [...(process.platform === 'linux' ? ['--reflink=auto'] : []), '-a', dir, own], { stdio: 'ignore' });
          c.on('error', () => resolve(1));
          c.on('exit', (code) => resolve(code));
        });
        const at = Date.now();
        return copied.then((code) => (code === 0 ? runFencedAsync(testCommand, own, { timeoutMs: 300_000 }).then((r) => {
          checkEventToPlanLog({ type: 'said', text: `The project's own tests on main ${r.status === 0 ? 'pass' : `exit ${r.status}`} (${((Date.now() - at) / 1000).toFixed(1)}s)` });
          return { testCommand, r };
        }) : null));
      }).catch(() => null)
      : Promise.resolve(null);
    for (const found of await Promise.all(tasks.map((t, ti) => checkTask(t, ti, { dir, base, big, onEvent: checkEventToPlanLog })))) problems.push(...found);
    // The project's own tests gate every landing. Failing on main already, they refuse every change whatever its work
    // (seen: `node --test test/` exits 1 on Node 22, which reads a directory as a module, and the agents' correct
    // changes were all sent back for it): said now, before any agent starts, not by each agent after its work.
    const pt = await projectTests;
    if (pt && !problems.length) {
      const { testCommand, r } = pt;
      {
        if (r.fenced && (r.status !== 0 || r.timedOut)) {
          const lines = `${r.stdout}\n${r.stderr}`.trim().split('\n').map((l) => l.trim()).filter(Boolean);
          const tail = [...new Set([...lines.filter((l) => !/^# Subtest/.test(l) && /^not ok|\berror\b|Error\b|\bE[A-Z]{3,}\b/.test(l)).slice(0, 3), ...lines.slice(-2)])].join(' | ').slice(0, 400);
          problems.push(`the project's test command already fails on main, so no change could land: \`${testCommand}\` ${r.timedOut ? 'timed out' : `exits ${r.status}`} (${tail}). Fix main's tests or change the test command in the project's settings`);
        }
      }
    }
  } catch (e) { problems.push(`checking the tasks' checks: ${e.message}`); }
  fs.rmSync(base, { recursive: true, force: true });
  // The planner's clone has served its plan check. Kept only when a task's checks were refused: the plan is made again
  // and checked against it (plan.mjs reads its snapshot, not the project, while main has not moved).
  if (!problems.some((p) => /^task [\w-]+:/.test(p))) {
    const note = opts.dir ? path.join(opts.dir, 'plan-clone.txt') : '';
    let clone = opts.base ? path.join(opts.base, 'main') : '';
    if (!clone && note) { try { clone = fs.readFileSync(note, 'utf8').trim(); } catch { /* none */ } }
    if (clone) fs.rmSync(clone, { recursive: true, force: true });
    if (note) fs.rmSync(note, { force: true });
  }
  if (problems.length) fail(`preflight found ${problems.length} problem(s), nothing started:\n  - ${problems.join('\n  - ')}`);
  say(`preflight ok: ${tasks.length} tasks, ${tasks.reduce((n, t) => n + (t.accept || []).length, 0)} checks fail cleanly on main, sandbox works, model pinned to ${opts.agent}${opts.model ? `/${opts.model}` : ' (its own default)'}`);
  return bal;
}

// ---- 2. project, tasks, runners, recording ----
const statePath = path.join(DIR, 'swarm.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { project: opts.project, tasks: {} };
delete state.stopped; // a new run of the swarm starts unstopped
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 1));

async function setup() {
  if (opts.create && !(await api('/api/projects')).projects.includes(opts.project)) {
    await api('/api/projects', { name: opts.project, ...(opts.testCommand ? { test_command: opts.testCommand, test_timeout_s: 900 } : {}) });
    say(`created project ${opts.project}`);
  }
  for (const t of tasks) {
    if (state.tasks[t.key]) continue;
    const r = await api(`/api/projects/${encodeURIComponent(opts.project)}/tasks`, { title: t.title, description: withPlan(t), mode: t.mode === 'compete' ? 'compete' : 'split', agents: 0, accept: t.accept || [], ...(t.retire?.length ? { retire: t.retire } : {}) });
    state.tasks[t.key] = r.task_id;
    saveState();
  }
  say(`${tasks.length} tasks ready`);
  // --no-warm: a throwaway project (a sandbox session) does not start the account's runners up front; they start on
  // demand, a few seconds slower on the first check.
  if (opts.noWarm) { say('runners start on demand (--no-warm)'); return; }
  const w = await api(`/api/projects/${encodeURIComponent(opts.project)}/warm`, {}).catch((e) => ({ warm: 0, of: 0, error: e.message }));
  // A local platform (scripts/dev-server.mjs) runs checks on this machine: there are no runners to warm.
  if (w.error && / 404 /.test(w.error)) { say('no runners to warm: checks run on this machine'); return; }
  say(`runners warm: ${w.warm} of ${w.of}${w.error ? ` (${w.error})` : ''}`);
  // Without runners no check runs and no change lands: agents would only spend. Refuse instead.
  if (!(w.warm >= Math.ceil((Number(w.of) || 8) / 2)))
    fail(`only ${w.warm} of ${w.of} runners could start (the account's live-container cap? other projects' runners still up?): no agent was started`);
}

/** A task's description as its agent reads it: what the planner asked, then its workstream's scope and the other
 *  workstreams it must stay out of (agents/plan.mjs), so parallel agents keep to their own code. */
function withPlan(t) {
  const parts = [String(t.description || '').trim()];
  // The scope is the whole workstream's, shared by every task in it: said as the area other agents work in, so an agent
  // does not take another task's part of it as its own (each command's agent also wrote the README lines a README task
  // was writing: twice, one of them wrong).
  if (t.workstream && t.scope) parts.push(`The workstream you are part of, "${t.workstream}" (other agents work on the rest of it at the same time): ${t.scope}\nChange only what YOUR task above asks for.`);
  const others = (Array.isArray(t.stay_out) ? t.stay_out : []).filter((o) => o && o.workstream);
  if (others.length) parts.push(`Other agents are working on these at the same time; stay out of their code:\n${others.map((o) => `- ${o.workstream}${o.scope ? `: ${o.scope}` : ''}`).join('\n')}`);
  // Who else is at work right now, and on which files: each task is planned on its own (agents/plan.mjs), so without
  // this an agent knew nothing of the others until their work landed under it. converge tells it when that happens.
  const filesOf = (x) => [...new Set((`${x.title || ''} ${x.description || ''}`.match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')))].slice(0, 6);
  const mine = new Set(filesOf(t));
  const siblings = tasks.filter((x) => x !== t && x.key !== t.key && !x.lead).slice(0, 20);
  if (siblings.length) {
    parts.push(`Other agents are doing these tasks at the same time, each from main as it is now:\n${siblings.map((x) => {
      const f = filesOf(x);
      const shared = f.filter((p) => mine.has(p));
      return `- ${String(x.title || x.key).slice(0, 160)}${f.length ? ` (${f.join(', ')})` : ''}${shared.length ? ` — also changes ${shared.join(', ')}: keep to your part of ${shared.length === 1 ? 'it' : 'them'}` : ''}`;
    }).join('\n')}\nDo only your task; never do theirs or undo what theirs adds. When one lands, converge tells you what it changed.`);
  }
  return parts.filter(Boolean).join('\n\n');
}

// ---- 3. runs ----
const runs = new Map(); // key -> { child, exited, code }
// --at-once N: at most N workers running at a time; the rest wait their turn and start as others end. A hundred
// agents started together starve a small machine (each is a process tree of its own); without it, all start at once.
const atOnce = opts.atOnce !== undefined ? Math.max(1, Number(opts.atOnce) || 1) : Infinity;
const waiting = [];
const working = () => [...runs.values()].filter((r) => !r.lead && !r.exited).length;
async function startWaiting() {
  while (waiting.length && !state.stopped && working() < atOnce) {
    const t = waiting.shift();
    launch(t);
    say(`started ${t.key} (${waiting.length} waiting)`);
    await new Promise((r) => setTimeout(r, Number(opts.staggerMs)));
  }
}
function launch(t) {
  if (t.lead) return launchLead(t);
  const out = fs.openSync(path.join(DIR, `${t.key}.log`), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'agents', 'converge.mjs'), 'run', '--project', opts.project, '--task', state.tasks[t.key],
    '--agent', opts.agent, ...(opts.model ? ['--model', opts.model] : []), ...(opts.host ? ['--host', opts.host] : []), ...(opts.effort ? ['--effort', opts.effort] : []), ...(opts.inAios ? ['--in-aios'] : []), ...(t.from ? ['--from', t.from] : []), '--dir', path.join(DIR, t.from ? `${t.key}-${t.from}` : t.key)], {
    cwd: ROOT, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, CONVERGE_API_URL: API, ADMIN_KEY, ...(opts.unsandboxed ? { AGENT_SANDBOX: 'off' } : {}), ...(t.why ? { CONVERGE_RETRY_WHY: t.why.slice(0, 12000) } : {}), ...(t.why && /sent it back/.test(t.why) ? { CONVERGE_OWNER_SENT_BACK: '1' } : {}) },
  });
  fs.closeSync(out);
  const run = { child, exited: false, code: null };
  child.on('exit', (code, sig) => {
    run.exited = true; run.code = code ?? (sig ? `signal ${sig}` : null);
    nudge();
    // The owner already answered while it was exiting (pickUpOwner saw needs-owner.json early): that answer starts it again.
    if (run.then) { const next = run.then; run.then = null; pickUpOwner(t, { remove: true, answered: true }); launch(next); say(`resumed ${t.key}${next.from ? ` from ${next.from}` : ''}`); }
    else pickUpOwner(t, { remove: true });
    // Whatever its agents started in the background outlives it (detached from its process group): halted, landed,
    // failed or stopped, nothing keeps working in its folders. Again a little later, for a command that was still
    // being started as the agent went.
    sweepTask(t.key);
    setTimeout(() => { if (run.exited && runs.get(t.key) === run) sweepTask(t.key); }, 15_000).unref();
  });
  runs.set(t.key, run);
}

/** A task's own folders in the run: <key>, <key>-<agent> (a takeover), and either with -<n> (a continuation). Any folder
 *  starting "<key>-" also took in another task's ("fix" took "fix-cache"'s needs-owner.json, and escalated the wrong task). */
const taskFolder = (key) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-a-[0-9a-f]{4,16})?(-[0-9]+)?$`);

/** In whichever of the task's folders its last agent worked (a resume works in <key>-N): the newest copy of `name`. */
function newestInTask(k, name) {
  return fs.readdirSync(DIR).filter((d) => taskFolder(k).test(d)).map((d) => path.join(DIR, d, name))
    .filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
}

/** Its change breaks a check of earlier work on main, or its agent says it cannot be done as asked (run.mjs wrote
 *  needs-owner.json): the owner decides. Picked up as soon as the file is there (each watch round), not only when the
 *  agent exits, so the board says "waiting for you" at once instead of "Checks passed, landing on main". The file is
 *  removed only once the run has exited (remove): run.mjs reads it to know not to start a successor. */
function pickUpOwner(t, { remove = false, answered = false } = {}) {
  try {
    const file = newestInTask(t.key, 'needs-owner.json');
    if (!file) return;
    const at = fs.statSync(file).mtimeMs;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (remove) fs.rmSync(file);
    // state.escalated is set up after the launch: a run that asked the owner while later ones were still starting was
    // otherwise lost here (a TypeError, caught), and counted as a run that failed.
    state.escalated ||= {};
    if (answered || state.escalated[t.key]?.file_at === at || (state.resumedAt?.[t.key] || 0) > at) return;
    const agent = latestAgent(t.key);
    state.escalated[t.key] = { why: owner.why, at: Date.now(), file_at: at, task_id: state.tasks[t.key], workstream: wsOf(t), agent, blockers: owner.blockers };
    if (agent) (state.haltedFrom ||= {})[t.key] = agent;
    say(`escalated ${t.key}: ${owner.why}`);
    saveState();
  } catch { /* not waiting on the owner */ }
}

/** Stops every process working inside `inside` (a folder, or a test on one): SIGTERM, then SIGKILL for any still there. */
function sweep(inside) {
  const pids = processCwds().filter(([pid, cwd]) => pid !== process.pid && inside(cwd)).map(([pid]) => pid);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  if (pids.length) setTimeout(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }, 5_000).unref();
  return pids;
}

/** The run's folder as the system reports a process's folder: symbolic links resolved (/tmp is /private/tmp on macOS). */
function runRoot() {
  try { return fs.realpathSync(DIR); } catch { return DIR; }
}

/** A task's own folders in the run: <key>, <key>-<agent> (a takeover), and either with -<n> (a continuation). */
function sweepTask(key) {
  const root = runRoot();
  const own = taskFolder(key);
  const pids = sweep((cwd) => {
    if (!cwd.startsWith(root + path.sep)) return false;
    return own.test(cwd.slice(root.length + 1).split(path.sep)[0]);
  });
  if (pids.length) say(`${key}: stopped ${pids.length} background process(es) its agents left running`);
}
/** A workstream's lead: a reviewer over its tasks (converge run --role reviewer --lead <name>). */
function launchLead(l) {
  const ids = l.tasks.map((k) => state.tasks[k]).filter(Boolean).join(',');
  if (!ids) return;
  const out = fs.openSync(path.join(DIR, `${l.key}.log`), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'agents', 'converge.mjs'), 'run', '--project', opts.project, '--task', ids, '--role', 'reviewer', '--lead', l.workstream,
    '--agent', opts.agent, ...(opts.model ? ['--model', opts.model] : []), ...(opts.host ? ['--host', opts.host] : []), ...(opts.effort ? ['--effort', opts.effort] : []), ...(opts.inAios ? ['--in-aios'] : []), '--dir', path.join(DIR, l.key)], {
    cwd: ROOT, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, CONVERGE_API_URL: API, ADMIN_KEY, ...(opts.unsandboxed ? { AGENT_SANDBOX: 'off' } : {}) },
  });
  fs.closeSync(out);
  const run = { child, exited: false, code: null, lead: true };
  child.on('exit', (code, sig) => { run.exited = true; run.code = code ?? (sig ? `signal ${sig}` : null); nudge(); });
  runs.set(l.key, run);
}
/** The agent that last worked on task `k`: the newest agent.json run.mjs left in one of the task's folders here. */
function latestAgent(k) {
  let best = { at: 0, agent: '' };
  for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !taskFolder(k).test(d.name)) continue;
    if (!fs.existsSync(path.join(DIR, d.name, 'repo', '.git'))) continue;   // a start that never got its clone
    try {
      const f = path.join(DIR, d.name, 'agent.json');
      const at = fs.statSync(f).mtimeMs;
      const id = String(JSON.parse(fs.readFileSync(f, 'utf8')).agent_id || '');
      if (at > best.at && /^a-[0-9a-f]{4,16}$/.test(id)) best = { at, agent: id };
    } catch { /* a folder with no agent yet */ }
  }
  return best.agent;
}

function stopRun(k) {
  const r = runs.get(k);
  if (!r || r.exited) return;
  r.stopping = true;
  killGroup(r.child.pid, 'SIGTERM');
  setTimeout(() => { if (!r.exited) { killGroup(r.child.pid, 'SIGKILL'); } }, 10_000).unref();
}

function stopAll(why) {
  say(`STOPPING every run: ${why}`);
  state.stopped = why;
  saveState();
  for (const r of runs.values()) if (!r.exited) { killGroup(r.child.pid, 'SIGTERM'); }
  setTimeout(() => { for (const r of runs.values()) if (!r.exited) { killGroup(r.child.pid, 'SIGKILL'); } }, 10_000).unref();
}

// ---- rules: escalate a task that keeps coming back, pause a workstream that is mostly failing ----
async function applyRules(landed) {
  if (!RULES) return;
  let st;
  try { st = await api(`/api/projects/${encodeURIComponent(opts.project)}/state`); } catch (e) { say(`rules skipped this round: cannot read the project's state: ${e.message}`); return; }
  const keyOf = new Map(Object.entries(state.tasks).map(([k, id]) => [id, k]));
  const changeTask = new Map((st.changes || []).map((c) => [c.change_id, c.task_id]));
  const back = new Map(); const handed = new Map();
  const since = Date.now() - 15 * 60_000;
  for (const e of st.recent || []) {
    const tid = e.task_id || changeTask.get(e.change_id);
    const k = keyOf.get(tid);
    if (!k || (e.at || 0) <= (state.resumedAt?.[k] || 0)) continue; // a resume starts the count again
    // One try is one commit sent back, however many of its checks failed.
    if ((e.type === 'Verified' && e.exit_code !== 0) || e.type === 'Conflicted') { if (!back.has(k)) back.set(k, new Set()); back.get(k).add(e.commit || e.change_id); }
    if (e.type === 'Submitted' && (e.at || 0) > since) handed.set(k, (handed.get(k) || 0) + 1);
  }
  const maxTries = Number(RULES.maxTries) || 0;
  // Waiting on the owner already (needs-owner.json written, the run still exiting): not counted as tries.
  for (const t of tasks) if (runs.get(t.key) && !runs.get(t.key).exited) pickUpOwner(t);
  for (const t of tasks) {
    if (!maxTries || landed.includes(t.key) || state.escalated[t.key] || state.dropped.includes(t.key)) continue;
    if ((back.get(t.key)?.size || 0) >= maxTries) {
      state.escalated[t.key] = { why: `sent back ${back.get(t.key).size} times`, at: Date.now(), task_id: state.tasks[t.key], workstream: wsOf(t) };
      say(`escalated ${t.key}: sent back ${back.get(t.key).size} times (rule: ${maxTries})`);
      stopRun(t.key);
    }
  }
  const pauseAt = Number(RULES.pauseAt) || 0;
  if (pauseAt) {
    const byWs = new Map();
    for (const t of tasks) { const w = wsOf(t); if (!w) continue; if (!byWs.has(w)) byWs.set(w, []); byWs.get(w).push(t); }
    for (const [w, ts] of byWs) {
      if (state.paused[w]) continue;
      // A task's first try coming back is how an agent learns what the checks want, not a workstream failing: the
      // pause counts from each task's second hand-in (it once stopped a whole run 2.5 minutes in, on 3 first tries).
      // A task waiting on the owner because its agent asked (needs-owner.json: its change breaks earlier work's check, or
      // it says the task cannot be done as asked) is the owner's call, not a try that failed: its hand-ins count toward
      // neither side, here or in the tries above (it is escalated).
      const counted = ts.filter((t) => !state.escalated[t.key]?.file_at);
      const h = counted.reduce((n, t) => n + Math.max(0, (handed.get(t.key) || 0) - 1), 0);
      const b = counted.reduce((n, t) => n + Math.max(0, Math.min(back.get(t.key)?.size || 0, handed.get(t.key) || 0) - 1), 0);
      if (h >= (Number(RULES.minHandedIn) || 4) && b / h >= pauseAt) {
        state.paused[w] = { why: `${Math.round((b / h) * 100)}% of its last ${h} hand-ins came back`, at: Date.now(), tasks: ts.map((t) => t.key) };
        say(`paused ${w}: ${state.paused[w].why} (rule: ${Math.round(pauseAt * 100)}%)`);
        for (const t of ts) if (!landed.includes(t.key)) stopRun(t.key);
      }
    }
  }
  saveState();
}
/** The owner's answers from the dashboard (DIR/control.json): resume relaunches, drop gives up. */
function readControl(landed) {
  const file = path.join(DIR, 'control.json');
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); fs.rmSync(file); } catch { return; }
  const keys = (list) => (list || []).flatMap((x) => (String(x).startsWith('ws:') ? (state.paused[String(x).slice(3)]?.tasks || tasks.filter((t) => wsOf(t) === String(x).slice(3)).map((t) => t.key)) : [String(x)]));
  // What the owner wrote to the next agent (Send it back / Retire with a note): kept with the escalation for retryWhy.
  for (const [k, v] of Object.entries(c.notes || {})) if (state.escalated[k]) state.escalated[k].note = String(v);
  for (const x of c.resume || []) if (String(x).startsWith('ws:')) delete state.paused[String(x).slice(3)];
  // Halt (the owner, from an agent's details): its agent stops (and saves its work on the way out); the task waits
  // for the owner like an escalated one, and Resume starts a new agent from the halted one's saved work.
  for (const h of Array.isArray(c.halt) ? c.halt : []) {
    const k = String(h.key || h);
    const t = tasks.find((y) => y.key === k);
    if (!t || landed.includes(k)) continue;
    // Halted without naming an agent: the task's latest one, so a resume carries on from its commits (not from main).
    const agent = h.agent || latestAgent(k);
    state.escalated[k] = { why: 'halted by you', at: Date.now(), task_id: state.tasks[k], workstream: wsOf(t), agent };
    if (agent) (state.haltedFrom ||= {})[k] = agent;
    stopRun(k);
    say(`halted ${k}${h.agent ? ` (${h.agent})` : ''}`);
  }
  // Retire (the owner's answer to "this change breaks a check of earlier work"): the task retires those checks, then
  // carries on like a resume, from the agent's saved work. "<key>#<n>" retires only blocker n of the task (the owner
  // ticked some of them): the rest stay, and its agent is told to keep them passing.
  const picked = new Map();   // key -> Set of blocker indexes, or null for all
  for (const x of c.retire || []) {
    const m = /^(.*)#(\d+)$/.exec(String(x));
    if (!m) { for (const k of keys([x])) picked.set(k, null); continue; }
    if (picked.get(m[1]) === null) continue;
    picked.set(m[1], new Set([...(picked.get(m[1]) || []), Number(m[2])]));
  }
  for (const [k, only] of picked) {
    const esc = state.escalated[k];
    const chosen = (esc?.blockers || []).filter((_, i) => !only || only.has(i));
    const checks = chosen.map((b) => b.check);
    if (!checks.length) continue;
    api(`/api/projects/${encodeURIComponent(opts.project)}/tasks/${esc.task_id}/retire`, { retire: checks })
      .then(() => { say(`${k}: retired ${checks.length} earlier check(s)`); esc.retired = checks; readControlResume(k, landed, 'retire'); })
      .catch((e) => say(`${k}: could not retire: ${e.message}`));
  }
  for (const k of keys(c.resume)) readControlResume(k, landed, 'resume');
  for (const x of c.drop || []) if (String(x).startsWith('ws:')) delete state.paused[String(x).slice(3)];
  for (const k of keys(c.drop)) { delete state.escalated[k]; if (!state.dropped.includes(k)) state.dropped.push(k); stopRun(k); say(`dropped ${k}`); }
  saveState();
}
/** Resume (the owner's answer): the task starts again, from its halted agent's saved work when there is one, told why
 *  the attempt before did not land and what the owner decided (retryWhy), so it does not start over blind. */
function readControlResume(k, landed, how = 'resume') {
  const t = tasks.find((y) => y.key === k);
  if (!t || landed.includes(k)) return;
  const why = retryWhy(k, state.escalated[k], how);
  delete state.escalated[k];
  state.dropped = state.dropped.filter((d) => d !== k);
  (state.resumedAt ||= {})[k] = Date.now();
  const from = state.haltedFrom?.[k];
  if (from) delete state.haltedFrom[k];
  const next = { ...t, ...(from ? { from } : {}), why };
  const run = runs.get(k);
  if (!run || run.exited) { launch(next); say(`resumed ${k}${from ? ` from ${from}` : ''}`); }
  // Still exiting (it was picked up as waiting before its agent finished): started again the moment it has.
  else run.then = next;
  saveState();
}

/** What the next agent on task `k` is told about the attempt before: why it stopped (the escalation, with each blocking
 *  check and its output), the last feedback converge sent its agent (last-feedback.txt, run.mjs), and what the owner
 *  decided. */
function retryWhy(k, esc, how) {
  const parts = [];
  const blockers = esc?.blockers || [];
  const retired = new Set(how === 'retire' ? esc?.retired || blockers.map((b) => b.check) : []);
  const kept = blockers.filter((b) => !retired.has(b.check));
  const listOf = (bs) => bs.map((b) => `- "${b.task}": \`${b.check}\`${b.output ? `\n  It printed: ${String(b.output).slice(-400).replace(/\n/g, '\n  ')}` : ''}`).join('\n');
  if (blockers.length) parts.push(`The attempt before did not land: ${esc.why}:\n${listOf(blockers)}`);
  if (retired.size) parts.push(`The owner retired ${retired.size === 1 ? 'this check' : 'these checks'}: the earlier work ${retired.size === 1 ? 'it tests is' : 'they test is'} meant to change, so ${retired.size === 1 ? 'it no longer blocks' : 'they no longer block'} your change. Do not undo your change for ${retired.size === 1 ? 'it' : 'them'}:\n${[...retired].map((c) => `- \`${c}\``).join('\n')}`);
  if (kept.length) parts.push(`The owner sent it back to you for ${kept.length === 1 ? 'this check' : 'these checks'} instead of retiring ${kept.length === 1 ? 'it' : 'them'}: the earlier work ${kept.length === 1 ? 'it tests' : 'they test'} must keep working. Make your change so that ${kept.length === 1 ? 'it passes' : 'they pass'} as well as your task's own:\n${listOf(kept)}`);
  if (blockers.length) parts.push(kept.length ? 'Then call done.' : 'Make sure the rest of your change is done, then call done.');
  if (!blockers.length && esc?.why) {
    parts.push(`The attempt before did not land: ${esc.why === 'halted by you' ? 'the owner halted it' : esc.why}. The owner ${esc.why === 'halted by you' ? 'resumed it' : 'sent it back to you'}.`);
    // Its agent said it cannot be done: the owner answering "try again" wants it done, not the same reason again.
    if (/^its agent says it cannot be done/.test(esc.why)) parts.push('The owner wants it done as asked. Whatever the task\'s checks need that is missing (an export, a test hook, a flag they call), add it as part of your change; do not report it blocked for the same reason again.');
  }
  if (esc?.note) parts.push(`The owner says: ${esc.note}`);
  try {
    const f = newestInTask(k, 'last-feedback.txt');
    if (f) parts.push(`What converge last told the agent before you, when it handed its change in:\n${fs.readFileSync(f, 'utf8').trim().slice(-3000)}`);
  } catch { /* none written */ }
  return parts.join('\n\n');
}

// ---- 4. watch ----
// The watch wakes when a run ends (its task usually just landed, or needs a new agent), not only every 15 s: a run's
// end waited up to 15 s for anyone to notice it.
let wake = null;
function nudge() { const w = wake; wake = null; if (w) w(); }
async function landedTasks() {
  const st = await api(`/api/projects/${encodeURIComponent(opts.project)}/state`);
  const landed = new Set((st.changes || []).filter((c) => c.state === 'landed').map((c) => c.task_id));
  return Object.entries(state.tasks).filter(([, id]) => landed.has(id)).map(([k]) => k);
}

async function main() {
  const startBalance = await preflight();
  if (opts.checkOnly) return;
  await setup();
  let recorder = null;
  if (opts.record) {
    recorder = spawn(process.execPath, [path.join(ROOT, 'scripts', 'record.mjs'), API, opts.project, path.resolve(opts.record), '14400', ...(process.env.RECORD_SIZE ? process.env.RECORD_SIZE.split('x') : [])], { stdio: ['ignore', fs.openSync(path.join(DIR, 'record.log'), 'a'), 'inherit'], env: { ...process.env, ADMIN_KEY } });
    say(`recording to ${opts.record}`);
    await new Promise((r) => setTimeout(r, 6000));
  }
  const started = Date.now();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(`swarm got ${sig}`); });
  // --continue: the same tasks again after a stop. Landed ones are left alone; each other one gets a new agent that
  // takes over from the last one (its fork starts from the work saved when it stopped: converge.mjs).
  let toLaunch = tasks;
  if (opts.continue) {
    const done = new Set(await landedTasks());
    const st = await api(`/api/projects/${encodeURIComponent(opts.project)}/state`);
    // The owner's Continue answers any halt or escalation of the tasks it starts again; a dropped task stays dropped.
    toLaunch = tasks.filter((t) => !done.has(t.key) && !state.dropped?.includes(t.key)).map((t) => ({ ...t, from: (st.tasks || []).find((x) => x.task_id === state.tasks[t.key])?.agents?.at(-1) || '' }));
    say(`continuing: ${toLaunch.length} of ${tasks.length} tasks not landed yet${done.size ? ` (${done.size} landed)` : ''}`);
    for (const t of toLaunch) { if (state.escalated) delete state.escalated[t.key]; if (state.haltedFrom) delete state.haltedFrom[t.key]; }
  }
  for (const t of toLaunch) {
    if (state.stopped) break; // a stop during the launch launches nothing more
    if (budget !== null) {
      const sp = spentNow(startBalance, await balance());
      if (sp !== null && sp >= stopLine(runs.size)) { stopAll(`spent $${sp} of the $${budget} budget during the launch`); break; }
    }
    if (working() >= atOnce) { waiting.push(t); continue; }
    launch(t);
    await new Promise((r) => setTimeout(r, Number(opts.staggerMs)));
  }
  // Leads: one per workstream of two or more tasks, reviewing as its team works.
  const leads = [];
  if (opts.leads && !state.stopped) {
    const byWs = new Map();
    for (const t of tasks) { const w = wsOf(t); if (w) { if (!byWs.has(w)) byWs.set(w, []); byWs.get(w).push(t.key); } }
    for (const [w, keys] of byWs) if (keys.length >= 2) leads.push({ key: `lead-${w.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, lead: true, workstream: w, tasks: keys });
    for (const l of leads) { launchLead(l); say(`lead for ${l.workstream}: ${l.tasks.length} tasks`); }
  }
  state.escalated = state.escalated || {};
  state.paused = state.paused || {};
  state.dropped = state.dropped || [];
  saveState();
  say(`${runs.size} runs started${waiting.length ? `, ${waiting.length} waiting (--at-once ${atOnce})` : ''}${state.stopped ? ` (stopped during the launch: ${state.stopped})` : ''}`);
  let landed = [];
  let ownerWaitSince = 0;
  let bal = startBalance;
  let lastBalanceAt = 0;
  for (;;) {
    await new Promise((r) => { const t = setTimeout(r, 15_000); wake = () => { clearTimeout(t); r(); }; });
    try { landed = await landedTasks(); } catch (e) { say(`could not read the project state: ${e.message}`); }
    if (Date.now() - lastBalanceAt > 30_000) { const b = await balance(); if (b !== null) bal = b; lastBalanceAt = Date.now(); }
    const spent = spentNow(startBalance, bal);
    const alive = [...runs.values()].filter((r) => !r.exited).length;
    // Failed: a worker that ended without landing, not one a rule or the owner stopped (escalated, paused, dropped), nor a lead.
    // A task waiting on the owner says so now, not when its agent has finished exiting.
    for (const t of tasks) if (runs.get(t.key) && !runs.get(t.key).exited && !runs.get(t.key).then) pickUpOwner(t);
    const held = (k) => state.escalated?.[k] || state.dropped?.includes(k) || Object.values(state.paused || {}).some((p) => p.tasks?.includes(k));
    const failed = [...runs.entries()].filter(([k, r]) => r.exited && !r.lead && !landed.includes(k) && !held(k)).map(([k]) => k);
    const line = { at: new Date().toISOString(), minutes: +((Date.now() - started) / 60000).toFixed(1), landed: landed.length, of: tasks.length, running: alive, waiting: waiting.length, failed: failed.length, balance: bal, spent };
    fs.writeFileSync(path.join(DIR, 'status.json'), JSON.stringify({ ...line, failed_tasks: failed, escalated: state.escalated, paused: state.paused, dropped: state.dropped, leads: leads.map((l) => ({ key: l.key, workstream: l.workstream, alive: !runs.get(l.key)?.exited })) }, null, 1));
    say(`landed ${line.landed}/${line.of}  running ${alive}${waiting.length ? `  waiting ${waiting.length}` : ''}  failed ${failed.length}${bal !== null ? `  balance $${bal}` : ''}${spent !== null ? `  spent $${spent}` : ''}`);
    // A run whose task has landed has done its job: it stops (an agent keeps polishing after its
    // change lands, spending on work nobody asked for), and when every task has landed the swarm ends.
    for (const [k, r] of runs) {
      if (r.exited || r.stopping || !landed.includes(k)) continue;
      r.stopping = true;
      say(`${k} landed: its run stops`);
      killGroup(r.child.pid, 'SIGTERM');
      setTimeout(() => { if (!r.exited) { killGroup(r.child.pid, 'SIGKILL'); } }, 10_000).unref();
    }
    if (!state.stopped && budget !== null && spent !== null && spent >= stopLine(alive)) stopAll(`spent $${spent} of the $${budget} budget`);
    if (!state.stopped && bal !== null && bal <= floor) stopAll(`balance $${bal} reached the floor $${floor}`);
    if (!state.stopped && failed.length > maxFailed) stopAll(`${failed.length} runs ended without landing (more than ${maxFailed})`);
    if (!state.stopped) await applyRules(landed);
    if (!state.stopped) readControl(landed);
    // Leads have done their job when their workstream's tasks have all landed (or were given up).
    for (const [k, r] of runs) {
      if (!r.lead || r.exited || r.stopping) continue;
      const l = leads.find((x) => x.key === k);
      if (l && l.tasks.every((tk) => landed.includes(tk) || state.dropped.includes(tk))) { say(`${l.workstream} is done: its lead stops`); stopRun(k); }
    }
    if (state.stopped) waiting.length = 0;
    await startWaiting();
    const workers = [...runs.entries()].filter(([, r]) => !r.lead && !r.exited).length;
    const waitingOnOwner = !state.stopped && (Object.keys(state.escalated).length || Object.keys(state.paused).length);
    if (waitingOnOwner && !workers) {
      ownerWaitSince ||= Date.now();
      if (Date.now() - ownerWaitSince > 30 * 60_000) { stopAll('nobody answered the escalations for 30 minutes'); }
      else continue; // the dashboard may still resume something
    } else ownerWaitSince = 0;
    // Counted again: the owner's resume (readControl, above) may have just started runs the count at the top missed.
    const aliveNow = [...runs.values()].filter((r) => !r.exited).length;
    if (!aliveNow || !workers) { for (const [k, r] of runs) if (r.lead && !r.exited) stopRun(k); if (!aliveNow) break; }
  }
  // ---- 5. report ----
  // An agent may leave a server or watcher running in the background (detached from its run's process
  // group, so stopping the group misses it): anything still working inside this run's directory stops.
  const root = runRoot();
  const strays = sweep((cwd) => cwd.startsWith(root + path.sep));
  if (strays.length) say(`stopped ${strays.length} background process(es) left in the run's directory`);
  try { landed = await landedTasks(); } catch { /* the last reading stands */ }
  if (recorder) {
    recorder.kill('SIGTERM');
    await new Promise((r) => recorder.on('exit', r));
  }
  const endBalance = await balance();
  const report = {
    project: opts.project, tasks: tasks.length, landed: landed.length, minutes: +((Date.now() - started) / 60000).toFixed(1),
    not_landed: tasks.filter((t) => !landed.includes(t.key)).map((t) => ({ key: t.key, exit: runs.get(t.key)?.code, log: path.join(DIR, `${t.key}.log`) })),
    // Each task: landed or not, minutes from the run's start to its landing (or to now), how many times its change was
    // handed in and sent back, and how many agents it took (a takeover or resume is one more).
    per_task: await perTask(landed, started),
    stopped: state.stopped || null,
    spent_usd: spentNow(startBalance, endBalance),
    recording: opts.record ? path.resolve(opts.record) : null,
  };
  fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
}

async function perTask(landed, started) {
  let st = {};
  try { st = await api(`/api/projects/${encodeURIComponent(opts.project)}/state`); } catch { /* the counts below are left out */ }
  const keyOf = new Map(Object.entries(state.tasks).map(([k, id]) => [id, k]));
  const out = Object.fromEntries(tasks.map((t) => [t.key, { landed: landed.includes(t.key), minutes: null, handed_in: 0, sent_back: 0, agents: 0 }]));
  const changeTask = new Map((st.changes || []).map((c) => [c.change_id, c.task_id]));
  for (const e of st.recent || []) {
    const k = keyOf.get(e.task_id || changeTask.get(e.change_id));
    if (!k || !out[k] || (e.at || 0) < started) continue;
    if (e.type === 'Submitted') out[k].handed_in++;
    if ((e.type === 'Verified' && e.exit_code !== 0) || e.type === 'Conflicted') out[k].sent_back++;
    if (e.type === 'Landed') out[k].minutes = +(((e.at || Date.now()) - started) / 60000).toFixed(1);
  }
  for (const t of st.tasks || []) { const k = keyOf.get(t.task_id); if (k && out[k]) out[k].agents = (t.agents || []).length; }
  return out;
}

/** Every process's working directory: /proc on Linux, lsof elsewhere (macOS has no /proc). Windows has neither: none. */
function processCwds() {
  if (fs.existsSync('/proc')) {
    const out = [];
    for (const d of fs.readdirSync('/proc')) if (/^[0-9]+$/.test(d)) { try { out.push([Number(d), fs.readlinkSync(`/proc/${d}/cwd`)]); } catch { /* gone, or not ours */ } }
    return out;
  }
  if (process.platform === 'win32') { if (!processCwds.warned) say(`no way to see a process's folder on Windows: background processes an agent left in ${DIR} are not looked for`); processCwds.warned = true; return []; }
  const r = spawnSync('lsof', ['-n', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status === null) { say(`lsof could not list processes (${r.error?.message || r.signal}): background processes an agent left in ${DIR} are not looked for`); return []; }
  const out = [];
  let pid = 0;
  for (const line of String(r.stdout).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) out.push([pid, line.slice(1)]);
  }
  return out;
}

main().catch((e) => { console.error(e); stopAll(`swarm crashed: ${e.message}`); process.exitCode = 1; });
