// converge agents as aios entities: what converge adds to the aios agent runtime.
//
// The runtime itself is aios's (intelligence/runtime/agent.mjs in the aios repository): the mind
// proposes one action per cycle and the runtime carries it out only after aios allows it, and every
// cycle is recorded in aios (cycle.record). This file is converge's part:
//   exec: the commands aios allows run inside converge-jail (Landlock: the work tree and a scratch
//   dir writable, no network)
//   network  converge:<mcp url>   publish   its converge MCP endpoint (the converge action)
//   network  git:<fork remote>    publish   pushing its own fork (commit, sync; workers only)
//   compute  cmd:project-test     execute   the project's test command (the test action)
//   compute  cmd:acceptance-checks execute  the task's acceptance checks (the check action)
//   writable paths = what the agent has CLAIMED in converge (claim/release, and after a rewind)
// plus the done gate (converge status), an operator's rewind request (status you.rewind_to), the
// Contained/Acted/Rewound reports for the dashboard, and each cycle's work tree pushed to the fork
// as refs/converge/cycles/<n> so the platform can diff any two cycles. A reviewer writes nothing.

import { normalizeAnswer } from './dsml.mjs';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { repoMap } from './repo-map.mjs';
import { aiosDir, aiosBridge, aiosControlBin, kernelHint, kernelOnPath, chownTree, AIOS_API_PROVIDERS, providerConfig } from './common.mjs';
kernelOnPath();   // an agent's `git` is aios-git
import { jailPath, shellArgv, reopenAbove } from './fenced.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // fileURLToPath: a URL's pathname is /C:/... on Windows
export const AIOS_DIR = aiosDir(ROOT);
// converge's fence for host programs (converge-engine/tools/jail.cpp, found by fenced.mjs): Landlock on Linux, Seatbelt on
// macOS. aios decides whether a command may run; the jail is what fences it while it does.
const JAIL = jailPath() || path.join(ROOT, 'engine', 'build', 'converge-jail');
const BRIDGE = aiosBridge(ROOT);
const PROVIDERS = { claude: 'claude-cli', gemini: 'gemini-cli', codex: 'codex-cli' };

/**
 * The mind an agent of this provider is bound to: the universal agent's model layer through the bridge in
 * agents/universal (the same providers, keys and hosts the universal agent uses, from ASQL), else, for an API provider,
 * aios's own API mind (its key from the service's environment). A script (--script) replays its lines.
 */
export function mindFor({ kind, model, effort = '', host = '', mind = 'bridge' }) {
  const provider = PROVIDERS[kind] || kind;
  if (mind === 'replay') return { name: 'script', model };
  if (fs.existsSync(BRIDGE)) return { name: 'bridge', provider, ...bridgeModel(provider, model), effort, host };
  if (AIOS_API_PROVIDERS.has(provider)) return { name: 'api', provider, model, effort, host };
  throw new Error(`no mind for ${provider}: the bridge is missing (${BRIDGE}): this checkout is incomplete`);
}

// aios hands the mind its model as AIOS_MODEL and refuses characters a model name usually lacks (agent.bind_mind's
// safe_mind_arg: letters, digits and . - _ : /). A model id with one (a Workers AI id, @cf/openai/gpt-oss-120b) cannot
// be handed over, so it is refused here, said, instead of letting the agent think with some other model.
const AIOS_SAFE_ARG = /^[A-Za-z0-9._:/-]{1,128}$/;
function bridgeModel(provider, model) {
  if (!model || AIOS_SAFE_ARG.test(model)) return { model };
  throw new Error(`aios cannot hand the model "${model}" to a mind (it allows only letters, digits and . - _ : /): pick a model id without other characters for ${provider}`);
}

/**
 * The control client the runtime is handed, with two things converge needs from it: the entity's id as soon as aios
 * creates it (so a stopped run can terminate it), and each cycle's model use, estimated from what the mind was sent
 * and what it answered (a mind's reply carries no token counts), appended to $CONVERGE_REGISTRY_DIR/registry-events.jsonl
 * in the universal agent's own usage format, so the swarm's meter (and its budget) still sees what the agent spends.
 */
function observedCtl(ctl, { ref, agent = '', host = '', onEntity = () => {} }) {
  const usageFile = process.env.CONVERGE_REGISTRY_DIR ? path.join(process.env.CONVERGE_REGISTRY_DIR, 'registry-events.jsonl') : '';
  let sent = 0;
  const tokens = (chars) => Math.ceil(chars / 3.5);   // over, not under: a budget must hold
  const seen = (req, r) => {
    if (req.op === 'agent.create' && r?.ok && r.entity) onEntity(r.entity);
    if (req.op === 'agent.send') sent = String(req.input || '').length;
    // A model that answers in its own tool-call markup is read as the action it names (agents/dsml.mjs), not refused as "not an action".
    if (req.op === 'cycle.run' && typeof r?.report?.answer === 'string') r.report.answer = normalizeAnswer(r.report.answer);
    if (req.op === 'cycle.run' && usageFile && ref) {
      try {
        fs.mkdirSync(path.dirname(usageFile), { recursive: true });
        fs.appendFileSync(usageFile, JSON.stringify({ t: 'usage', ref, ...(agent ? { agent } : {}), tin: tokens(sent), tout: tokens(String(r?.report?.answer || '').length), cache: 0, ok: Boolean(r?.ok), estimated: true, at: new Date().toISOString() }) + '\n');
      } catch { /* the meter misses this cycle */ }
    }
    return r;
  };
  // The model's address travels with its binding: the mind must call the host the run picked (Ollama Cloud, an
  // OpenRouter gateway, ...), never one it finds for itself in some config file.
  const withHost = (req) => (req.op === 'agent.bind_mind' && host ? { ...req, host } : req);
  return {
    call: async (req) => seen(req, await ctl.call(withHost(req))),
    must: async (req) => seen(req, await ctl.must(withHost(req))),
  };
}

const load = async (rel) => {
  const file = path.join(AIOS_DIR, rel);
  if (!fs.existsSync(file)) throw new Error(`aios not found: ${file} (${kernelHint(ROOT)})`);
  return import(pathToFileURL(file).href);
};
const runtime = await load('intelligence/runtime/agent.mjs');
const control = await load('intelligence/runtime/control.mjs');
export const { AiosControl } = control;
export const { alertsFor, clip } = runtime;

/**
 * The local agent-control service, shared by every agent on this machine. The mind processes it starts inherit its
 * environment, so the providers go into it, from ASQL, for the start. A service that is already running keeps the
 * providers it started with: restart it to pick up a key added since.
 */
export async function ensureService(dataDir) {
  // The mind may only talk: CONVERGE_PERMS=readonly makes a CLI provider run with no tools at all.
  const minds = fs.existsSync(BRIDGE) ? { bridge: `CONVERGE_PERMS=readonly CONVERGE_CLAUDE_NATIVE_TOOLS=0 ${process.execPath} ${BRIDGE}` } : {};
  process.env.CONVERGE_PROVIDERS_JSON = JSON.stringify(await providerConfig());
  try { return await control.ensureService({ dataDir, bin: aiosControlBin(ROOT), minds }); }
  finally { delete process.env.CONVERGE_PROVIDERS_JSON; }
}

const PROTOCOL = `{"action":"test"}                                         run the project's test command on your work tree
{"action":"check"}                                        run the task's acceptance checks (its definition of done) on your work tree
{"action":"sync"}                                        merge the latest main into your work tree (do this when your change conflicts)
{"action":"commit","message":"..."}                      git add -A, commit, and push your fork (also pushes commits you made yourself)
{"action":"converge","tool":"status","arguments":{}}    call a converge tool (listed below)
{"action":"hold","task_id":"...","reason":"..."}         (reviewers) decide not to land a task, and say why
You can write only paths you have claimed with the converge claim tool; claim first. done is refused while your change has checks pending or failing.`;

// Converge's own secrets and machinery, worth a human's eye if a mind reaches for them.
const ALERTS = [
  [/ENGINE_SHARED_KEY|ADMIN_KEY|mcp_key|gt_[0-9a-f]{8,}/, 'credentials'],
  [/\.converge|converge-jail|bridge\.cjs/, 'the platform itself'],
];

// Where the kernel has no Landlock (Cloudflare's container VMs, where a hosted run's agents work) and this runs as
// root, converge-jail runs the command as an unprivileged uid of its own instead (--fallback-uid; agents/fenced.mjs
// does the same for checks): files are fenced by ordinary permissions, so that uid is given the writable directories
// (and the right to pass through, not list, the directories above them), and everything else stays root's.
const FALLBACK_UID = 61999;
let fallbackUid = null;
function jailFallbackUid() {
  if (fallbackUid !== null) return fallbackUid;
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return (fallbackUid = 0);
  const abi = Number(String(spawnSync(JAIL, ['--abi'], { encoding: 'utf8' }).stdout || '').trim()) || 0;
  return (fallbackUid = abi >= 4 ? 0 : FALLBACK_UID);
}
function giveToFallbackUid(uid, dirs) {
  for (const d of dirs) {
    if (!d || /^\/(dev|proc|sys)(\/|$)/.test(d) || !fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) continue;
    // Each time: files the runtime wrote (as root) since the last command must be the command's to change too.
    chownTree(uid, d);
    for (let up = path.dirname(d); up !== path.dirname(up); up = path.dirname(up)) {
      try { const m = fs.statSync(up).mode & 0o777; if (!(m & 0o001)) fs.chmodSync(up, m | 0o001); } catch { /* not ours to change */ }
    }
  }
}

/** Runs a program aios allowed, inside converge-jail: the paths and network the request names, nothing else. */
export function jailedExec({ command, cwd, env, readOnly, readWrite, network, timeoutMs }) {
  if (!fs.existsSync(JAIL)) return Promise.resolve({ code: 'failed', out: `${JAIL} is missing: ${kernelHint(ROOT)}` });
  const uid = jailFallbackUid();
  if (uid) giveToFallbackUid(uid, readWrite);
  // The shell is aios-sh, from the kernel folder: readable inside the fence like /usr is.
  const sh = Array.isArray(command) ? '' : shellArgv('')[0];
  const shDir = path.isAbsolute(sh) && !/^\/(usr|bin|lib|lib64)\//.test(sh) && !readOnly.some((p) => sh.startsWith(p + path.sep)) ? [path.dirname(sh)] : [];
  const args = [...readWrite.flatMap((p) => ['--rw', p]), ...[...readOnly, ...shDir].flatMap((p) => ['--ro', p]), ...(network ? ['--connect', '443'] : []),
    ...(uid ? ['--fallback-uid', String(uid)] : []), '--',
    ...(Array.isArray(command) ? command : shellArgv(command))];
  // Windows: the runtime hands a command PATH, HOME and TMPDIR (Unix names). Programs there look for TEMP/TMP,
  // USERPROFILE and SystemRoot: without them node fell back to the user's own temp folder, which the fence does not
  // let it write (EPERM mkdtemp). And every folder above the work tree must be readable from inside the fence (node
  // looks at each parent of a script it loads): a hidden label left on one of them failed every node command.
  if (process.platform === 'win32') {
    env = { ...env, TEMP: env.TMPDIR || env.TEMP, TMP: env.TMPDIR || env.TMP, USERPROFILE: env.HOME || env.USERPROFILE,
      SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
      windir: process.env.windir, ProgramData: process.env.ProgramData, APPDATA: env.HOME ? path.join(env.HOME, 'AppData', 'Roaming') : process.env.APPDATA,
      LOCALAPPDATA: env.HOME ? path.join(env.HOME, 'AppData', 'Local') : process.env.LOCALAPPDATA,
      // The work tree was made by converge (elevated: owned by Administrators); the fenced command runs as the user, so
      // git refused it as "dubious ownership". The fence is what guards it: git is told to trust it.
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
    reopenAbove([cwd, ...readWrite]);
  }
  return new Promise((resolve) => {
    const child = spawn(JAIL, args, { cwd, env, windowsHide: true });
    let out = '';
    const add = (d) => { out += d; if (out.length > 800_000) out = out.slice(-400_000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, sig) => { clearTimeout(timer); resolve({ code: sig ? `killed (${sig})` : code, out }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 'failed', out: err.message }); });
  });
}

// The map of the code on main, shown to the agent so it stops guessing at other agents' code.
// Recomputed from the work tree whenever the header is built or main is brought in (sync).
function codeMapSection(dir) {
  try { return `=== the code on main (files and what they define) ===\n${repoMap(dir)}`; } catch { return '=== the code on main (files and what they define) ==='; }
}

const basicAuth = (token) => (token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x:${token}`).toString('base64')}`] : []);
const SAFE = (repo) => ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo];

/** The sentence in an action's output that says it was refused (a command's own output may come first, the refusal last). */
export const refusalLine = (obs) => String(obs || '').split('\n').map((l) => l.trim())
  .find((l) => /^(refused by aios|refused and (reverted|restored)|the \.git directory)|is outside your work tree/.test(l)) || '';

// The code map lives in one note, replaced (never added again) whenever main is brought in.
const CODE_MAP_HEAD = '=== the code on main';
function refreshCodeMap(ctx, repo) {
  for (let i = ctx.notes.length - 1; i >= 0; i--) if (String(ctx.notes[i]).startsWith(CODE_MAP_HEAD)) ctx.notes.splice(i, 1);
  ctx.notes.push(`${codeMapSection(repo)}\n(main as merged into your work tree just now)`);
}

// The project's own instructions for agents, as the repository states them (the planner reads these too).
function projectInstructions(repo) {
  const out = [];
  let left = 6000;
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'CONVERGE.md']) {
    let text = '';
    try { text = fs.readFileSync(path.join(repo, f), 'utf8').trim(); } catch { continue; }
    if (!text || left <= 0) continue;
    const cut = text.length > left ? `${text.slice(0, left)}\n... (${text.length - left} more characters: read ${f} for the rest)` : text;
    left -= cut.length;
    out.push(`--- ${f}\n${cut}`);
  }
  return out.length ? `=== the project's instructions for agents ===\n${out.join('\n\n')}\n\n` : '';
}

/**
 * What a worker hands to whoever continues its task, rewritten after every cycle (so a stop, a crash or running out
 * of cycles all leave it): its notes, the file ranges it read, and its last steps. <dir>/handover.json.
 */
function writeHandover(dir, state) {
  try { fs.writeFileSync(path.join(dir, 'handover.json'), JSON.stringify(state, null, 1)); } catch { /* the platform still has it */ }
}

/** Sends the latest handover to the platform (ASQL), off the agent's path: one request at a time, the newest wins. */
function handoverSender(send) {
  let pending = null, busy = null;
  const pump = () => {
    if (busy || !pending) return busy;
    const body = pending;
    pending = null;
    busy = Promise.resolve().then(() => send(body)).catch(() => { /* the run folder's copy remains */ }).finally(() => { busy = null; pump(); });
    return busy;
  };
  return { post(body) { pending = body; pump(); }, async flush() { while (busy || pending) { pump(); await busy; } } };
}

export async function runEntity({ ctl: control, agent, role, repo, dir, prompt, kind, model, host = '', testCommand, branch, maxCycles, mcp, log, mind = 'bridge', audit = async () => {}, acceptChecks = [], effort = '', reviewTasks = [], onEntity, handover = null, saveHandover = null }) {
  const handoverOut = handoverSender(saveHandover || (async () => {}));
  const worker = role !== 'reviewer';
  const boundMind = mindFor({ kind, model, effort, host, mind });
  const ctl = observedCtl(control, { agent: agent.agent_id, host: boundMind.host, ref: boundMind.name === 'script' ? '' : `${boundMind.provider}/${boundMind.model || boundMind.configuredModel || ''}`, onEntity });
  const realRepo = fs.realpathSync(repo);
  const remote = worker ? execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim() : '';
  const remoteName = remote.replace(/\/\/[^@/]*@/, '//'); // the capability names the repository, never its token

  const toolsList = await fetch(agent.mcp_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${agent.mcp_key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.json()).then((r) => r.result?.tools || []);
  // The broker pushes for the agent (the commit action); git credentials are never the mind's.
  for (let i = toolsList.length - 1; i >= 0; i--) if (toolsList[i].name === 'git_credentials') toolsList.splice(i, 1);
  const toolNames = new Set(toolsList.map((t) => t.name));
  const toolDoc = toolsList.map((t) => `- ${t.name}: ${t.description}\n  arguments: ${JSON.stringify(t.inputSchema?.properties || {})}`).join('\n');

  const holds = new Map(); // task_id -> reason (reviewer)
  const opened = [];       // file ranges read (and inherited), for the handover
  const steps = [];        // one line per cycle, for the handover
  let mindName = boundMind.name;
  const reportContained = async (ctx) => {
    try {
      mindName = (await ctl.call({ op: 'entity.status', entity: ctx.entity })).mind?.intelligence || mindName;
      report([{ type: 'Contained', agent_id: agent.agent_id, entity: ctx.entity, mind: mindName, grants: [...ctx.held.values()] }]);
    } catch { /* the dashboard is told on the next report */ }
  };

  // Each cycle's work tree on the fork (cycles/0: where it started), so any two cycles can be diffed.
  let lastCycle = null; // { commit, tree }
  async function pushCycle(ctx, cycle, tree) {
    if (!worker || !tree) return;
    if (await ctx.exercise('network', `git:${remoteName}`, 'publish', `push refs/converge/cycles/${cycle}`)) return;
    let commit = lastCycle?.tree === tree ? lastCycle.commit : '';
    if (!commit) {
      const args = [...SAFE(realRepo), '-c', 'user.name=converge', '-c', `user.email=${agent.agent_id}@converge.local`, 'commit-tree', tree, '-m', `cycle ${cycle}`];
      if (lastCycle) args.push('-p', lastCycle.commit);
      commit = execFileSync('git', args, { encoding: 'utf8' }).trim();
    }
    lastCycle = { commit, tree };
    refsToPush.push(`${commit}:refs/converge/cycles/${cycle}`);
    flushRefs();
  }
  // Reporting stays off the agent's path: cycle refs and audit events go out in the background, in
  // order, batched (one push and one post for whatever piled up), and are flushed before the run ends.
  const refsToPush = [];
  let refsBusy = null;
  function flushRefs() {
    if (refsBusy || !refsToPush.length) return refsBusy;
    const batch = refsToPush.splice(0);
    refsBusy = new Promise((resolve) => execFile('git', [...basicAuth(agent.token), ...SAFE(realRepo), 'push', '-q', '--no-verify', '--force', 'origin', ...batch], () => resolve()))
      .then(() => { refsBusy = null; return flushRefs(); });
    return refsBusy;
  }
  const eventsToPost = [];
  let postBusy = null;
  function report(events) {
    eventsToPost.push(...events);
    if (!postBusy) postBusy = (async () => {
      while (eventsToPost.length) { const batch = eventsToPost.splice(0); try { await audit(batch); } catch { /* the dashboard misses these */ } }
      postBusy = null;
    })();
  }
  async function flushReports() {
    while (refsBusy || postBusy || refsToPush.length || eventsToPost.length) { flushRefs(); await Promise.all([refsBusy, postBusy]); }
  }

  /** A reviewer's tasks that have an eligible change but neither a landing nor a stated hold. */
  async function undecided() {
    const out = [];
    for (const t of reviewTasks) {
      if (holds.has(t)) continue;
      const list = await mcp(agent, 'contenders', { task_id: t }).catch(() => []);
      if (!Array.isArray(list) || list.some((c) => c.state === 'landed')) continue;
      const pick = await mcp(agent, 'pick', { task_id: t }).catch(() => ({}));
      if (pick.decision === 'ship') out.push(`task ${t} has an eligible change (${(pick.land_together || []).join(', ')}) that is not landed: land it with pick execute=true, or hold it with {"action":"hold","task_id":"${t}","reason":"..."}`);
    }
    return out;
  }

  const actions = {
    'git-network': async () => 'not run: your sandbox has no network. To bring main into your work tree use {"action":"sync"}; to push your work use {"action":"commit","message":"..."}.',
    async test(a, ctx) {
      if (!testCommand) return 'this project has no test command';
      const r = await ctx.runPoliced(testCommand, { resource: 'cmd:project-test', action: `test ${testCommand.slice(0, 200)}`, isHeavy: true, timeoutMs: 1_800_000 });
      if (r.refused) return `refused by aios: ${r.out}`;
      return `$ ${testCommand}\nexit ${r.code}\n${clip(r.out.slice(-12000), 12000)}${r.reverted.length ? `\nreverted: the tests changed ${r.reverted.join(', ')}, which you hold no write capability over` : ''}`;
    },
    async check(a, ctx) {
      if (!acceptChecks.length) return 'this task has no acceptance checks';
      // One run, in order, exactly as converge runs them: a later check may use what an earlier one
      // built. Whatever they write to the tree is undone afterwards.
      const script = acceptChecks.map((c, i) => `echo "--- check ${i + 1}"; if ( ${c} ); then echo "--- PASS ${i + 1}"; else echo "--- FAIL ${i + 1} (exit $?)"; fi`).join('\n');
      const r = await ctx.runPoliced(script, { resource: 'cmd:acceptance-checks', action: 'check', isHeavy: true, timeoutMs: 900_000, revertAll: true });
      if (r.refused) return `refused by aios: ${r.out}`;
      const failed = (r.out.match(/^--- FAIL /gm) || []).length;
      return `${failed ? `${failed} of ${acceptChecks.length} acceptance checks FAIL` : `all ${acceptChecks.length} acceptance checks pass`}\n${acceptChecks.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n${clip(r.out.slice(-8000), 8000)}`;
    },
    async hold(a, ctx) {
      // A reviewer's explicit decision not to land a task, with its reason, on record.
      if (worker) return 'only a reviewer holds a task';
      if (!reviewTasks.includes(String(a.task_id))) return `hold needs "task_id", one of ${reviewTasks.join(', ')}`;
      if (String(a.reason || '').trim().length < 20) return 'hold needs a "reason" that says what is wrong (at least a sentence)';
      holds.set(String(a.task_id), String(a.reason).slice(0, 1000));
      ctx.notes.push(`held ${a.task_id}: ${String(a.reason).slice(0, 300)}`);
      return `held ${a.task_id}`;
    },
    async sync(a, ctx) {
      // Bring main into the work tree (the sandbox has no network; this runs git itself). A clean
      // merge is committed; conflicts are left as markers to resolve, then commit.
      if (!worker) return 'a reviewer does not sync';
      if (!agent.main_remote) return 'sync is not available on this platform';
      // A merge already under way is finished by commit, not merged again: say where it stands.
      if (fs.existsSync(path.join(realRepo, '.git', 'MERGE_HEAD'))) {
        const unmerged = execFileSync('git', ['-C', realRepo, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        const marked = unmerged.filter((f) => { try { return /^(<<<<<<<|>>>>>>>) /m.test(fs.readFileSync(path.join(realRepo, f), 'utf8')); } catch { return false; } });
        return marked.length
          ? `your merge of main is not finished: conflict markers remain in ${marked.join(', ')}. Resolve them (keep both sides), then {"action":"commit","message":"Merge main"}.`
          : `your merge of main is resolved: no conflict markers remain${unmerged.length ? ` (in ${unmerged.join(', ')})` : ''}. Finish it with {"action":"commit","message":"Merge main"}, then submit.`;
      }
      const why = await ctx.exercise('network', `git:${remoteName}`, 'publish', 'sync main');
      if (why) return `refused by aios: ${why}`;
      try {
        execFileSync('git', [...basicAuth(agent.main_token || agent.token), ...SAFE(realRepo), 'fetch', '-q', agent.main_remote, branch], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) { return `sync failed: ${String(err.stderr || err.message).slice(0, 500)}`; }
      ctx.forgetReads();
      try {
        const out = execFileSync('git', [...SAFE(realRepo), '-c', 'user.name=converge', '-c', 'user.email=converge@local', 'merge', '--no-edit', 'FETCH_HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        refreshCodeMap(ctx, repo);
        return `merged main: ${out.trim().split('\n').slice(-1)[0] || 'up to date'}. Use commit to push it.`;
      } catch (err) {
        const conflicted = execFileSync('git', ['-C', realRepo, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).trim();
        return conflicted
          ? `merge conflicts in: ${conflicted.split('\n').join(', ')}. Edit those files to resolve the <<<<<<< ======= >>>>>>> markers (keep both changes where both are needed), then commit: that finishes the merge (do not sync again first).`
          : `sync failed: ${String(err.stderr || err.message).slice(0, 500)}`;
      }
    },
    async commit(a, ctx) {
      if (!worker) return 'a reviewer does not commit';
      if (!a.message) return 'commit needs "message"';
      const changed = execFileSync('git', ['-C', realRepo, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
      // Commits the agent made itself in its shell still need pushing: only this action can.
      let unpushed = 0;
      try { unpushed = Number(execFileSync('git', ['-C', realRepo, 'rev-list', '--count', `origin/${branch}..HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()) || 0; } catch { /* no upstream yet */ }
      if (!changed && !unpushed) return 'nothing to commit or push';
      const why = await ctx.exercise('network', `git:${remoteName}`, 'publish', `push ${branch}`);
      if (why) return `refused by aios: ${why}`;
      // A commit that finishes a merge of main brings main's code in: the map is refreshed after it.
      const finishesMerge = fs.existsSync(path.join(realRepo, '.git', 'MERGE_HEAD'));
      try {
        // Hooks off, whatever the work tree holds: this git runs outside the sandbox.
        if (changed) {
          execFileSync('git', [...SAFE(realRepo), 'add', '-A']);
          execFileSync('git', [...SAFE(realRepo), 'commit', '-q', '--no-verify', '-m', String(a.message)]);
        }
        // The token goes on this one command only; the clone never holds it.
        const out = execFileSync('git', [...basicAuth(agent.token), ...SAFE(realRepo), 'push', '-q', '--no-verify', 'origin', `HEAD:${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const head = execFileSync('git', ['-C', realRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        if (finishesMerge) refreshCodeMap(ctx, repo);
        return `committed and pushed ${head} to ${branch}. ${out}Submit it (or, if it is submitted, call status: converge re-checks it and status waits for the result).`;
      } catch (err) {
        return `commit/push failed: ${String(err.stderr || err.message).slice(0, 2000)}`;
      }
    },
    async converge(a, ctx) {
      const tool = String(a.tool || '');
      if (!toolNames.has(tool)) return `no converge tool "${tool}" for you; yours: ${[...toolNames].join(', ')}`;
      const why = await ctx.exercise('network', `converge:${agent.mcp_url}`, 'publish', `converge.${tool}`);
      if (why) return `refused by aios: ${why}`;
      // Arguments may come nested ("arguments") or flat beside "tool": the same intent either way.
      const { action: _a, tool: _t, arguments: nested, ...flat } = a;
      const args = nested && typeof nested === 'object' ? nested : flat;
      let result;
      try { result = await mcp(agent, tool, args); } catch (err) { return `converge ${tool} failed: ${err.message}`; }
      // Checks and the merge train take time; a mind left to poll burns a cycle per look. Wait here
      // (bounded) until the change lands or something needs the agent, then answer with that status.
      if (worker && (tool === 'submit' || tool === 'status') && (tool === 'submit' || result.state === 'submitted')) {
        const deadline = Date.now() + 900_000;
        let st = tool === 'status' ? result : await mcp(agent, 'status').catch(() => ({}));
        while (Date.now() < deadline && awaiting(st)) {
          await waitOnChange(st.change_id);
          st = await mcp(agent, 'status').catch(() => st);
        }
        if (tool === 'submit') return `${JSON.stringify(result, null, 1)}\n\nstatus once converge's checks finished:\n${JSON.stringify(st, null, 1)}`;
        result = st;
      }
      // A reviewer has nothing to judge until a contender's checks are in: wait (bounded) rather than poll.
      if (!worker && tool === 'contenders' && Array.isArray(result)) {
        const ready = (list) => list.some((c) => c.state === 'landed' || (c.state === 'submitted' && !JSON.stringify(c).includes('pending')));
        const deadline = Date.now() + 900_000;
        while (Date.now() < deadline && !ready(result)) {
          await new Promise((r) => setTimeout(r, 5000));
          result = await mcp(agent, tool, args).catch(() => result);
        }
      }
      // Pushed but never submitted: say the next step, or a mind may keep looking at status.
      if (worker && tool === 'status' && result.state === 'working' && result.head_commit) {
        let local = '';
        try { local = execFileSync('git', ['-C', realRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* no commit yet */ }
        if (local === result.head_commit) return `${JSON.stringify(result, null, 1)}\n\nnext: your work is pushed but not submitted. Submit it (converge tool submit); status alone does not.`;
      }
      // What it claims in converge is what it may write in aios.
      if (tool === 'claim' && worker && !result.error) await ctx.setWritable(args.paths);
      if (tool === 'release' && worker) await ctx.setWritable([]);
      return JSON.stringify(result, null, 1);
    },
  };

  /** Until something happens to this change (the platform holds the request), or 3s where it cannot. */
  async function waitOnChange(changeId) {
    try {
      const res = await fetch(`${agent.mcp_url}/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent.mcp_key}` },
        body: JSON.stringify({ change_id: changeId || '', timeout_ms: 25_000 }) });
      if (res.ok) { await res.json(); return; }
    } catch { /* fall through */ }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const rewind = { wanted: 0, gen: 0, busy: false };
  const rewindWatch = setInterval(() => {
    if (rewind.busy) return;
    rewind.busy = true;
    const gen = rewind.gen;
    mcp(agent, 'status').then((st) => { if (gen === rewind.gen) rewind.wanted = Number(st.you?.rewind_to) || 0; }).catch(() => {}).finally(() => { rewind.busy = false; });
  }, Number(process.env.CONVERGE_REWIND_POLL_MS) || 20_000);
  rewindWatch.unref();
  const result = await runtime.runAgent({
    ctl, label: `converge:${agent.agent_id}`, mind: boundMind, workdir: repo, scratch: dir, prompt, writer: worker, maxCycles, log,
    // The same read-only dependencies converge's own verification gets (e.g. the repo's node_modules for tsc).
    readOnly: String(process.env.CONVERGE_VERIFY_RO || '').split(':').filter(Boolean),
    heavy: { count: Number(process.env.CONVERGE_HEAVY_SLOTS) || 2, dir: path.join(process.env.CONVERGE_DATA_DIR || path.join(process.env.HOME || '/tmp', '.converge'), 'slots') },
    hooks: {
      exec: jailedExec,
      protocol: PROTOCOL,
      header: `${testCommand ? `The project's test command (converge runs it on every submitted commit; run it yourself before you submit): ${testCommand}\n` : ''}run builds, tests and inspects freely inside the sandbox\n\nconverge tools:\n${toolDoc}\n\n${projectInstructions(realRepo)}${codeMapSection(repo)}`,
      writeHint: 'Claim {path} (or its directory) with the converge claim tool first.',
      alerts: ALERTS,
      failed: /commit\/push failed|converge \w+ failed|sync failed/,
      emptyHistory: '(nothing yet: start with converge status)',
      actions,
      // {"action":"submit",...} for {"action":"converge","tool":"submit","arguments":{...}}: same intent.
      mapAction(a) {
        // A converge tool named like one of converge's actions (sync, commit, test, check) means the action.
        if (a.action === 'converge' && ['sync', 'commit', 'test', 'check'].includes(String(a.tool))) return { action: String(a.tool), ...(a.arguments || {}) };
        // The sandbox has no network: git's network commands are answered with the action that does them.
        if (a.action === 'run' && /\bgit\s+(fetch|pull|push|clone|ls-remote|remote\s+add)\b/.test(String(a.command || ''))) return { action: 'git-network', command: a.command };
        if (!toolNames.has(a.action)) return a;
        const { action, arguments: args, ...rest } = a;
        return { action: 'converge', tool: action, arguments: args || rest };
      },
      async start(ctx) {
        await ctx.grant('network', `converge:${agent.mcp_url}`, 'publish');
        if (worker) await ctx.grant('network', `git:${remoteName}`, 'publish');
        if (testCommand) await ctx.grant('compute', 'cmd:project-test', 'execute');
        if (acceptChecks.length) await ctx.grant('compute', 'cmd:acceptance-checks', 'execute');
        if (worker) {
          // A worker that takes over a task holds its predecessor's claim in converge: aios lets it write those paths
          // from its first cycle, as the claim tool would have.
          // One that continues a stopped agent claims what that agent had claimed (converge does not move a claim to
          // whoever takes over): otherwise its first write is refused and it spends cycles claiming again.
          const st = await mcp(agent, 'status').catch(() => ({}));
          if (st.you?.claim?.length) await ctx.setWritable(st.you.claim);
          else if (handover?.claim?.length) {
            const r = await mcp(agent, 'claim', { paths: handover.claim, summary: `continuing the work of ${handover.agent_id}` }).catch((e) => ({ error: e.message }));
            if (!r.error) {
              await ctx.setWritable(handover.claim);
              ctx.notes.push(`you hold ${handover.agent_id}'s claim: ${handover.claim.join(', ')}`);
            }
          }
        }
        if (handover) {
          // What the agent before it on this task learned: its notes, and the files it read, open as they are now.
          for (const n of handover.notes || []) ctx.notes.push(String(n).startsWith('(from ') ? n : `(from ${handover.agent_id}) ${n}`);
          for (const r of handover.open || []) {
            const loc = ctx.inside(r.path);
            if (loc.error || !fs.existsSync(loc.abs) || fs.statSync(loc.abs).isDirectory()) continue;
            ctx.openRange(loc.rel, r.from, r.to);
            opened.push(r);
          }
        }
        await reportContained(ctx);
        try { await pushCycle(ctx, 0, ctx.snapshotTree()); } catch { /* replay of this run starts at cycle 1 */ }
      },
      grantsChanged: reportContained,
      async beforeCycle(ctx, cycle) {
        // An operator may have asked for this agent to be rewound (converge status you.rewind_to,
        // watched in the background so a cycle does not wait on the network for it).
        const want = rewind.wanted;
        if (!want) return;
        rewind.wanted = 0;
        rewind.gen++;  // a status read already in flight predates this rewind: ignore it
        const r = await ctx.rewindTo(want);
        ctx.notes.push(r.ok ? `the operator rewound you to the start of cycle ${want}; undid ${r.undone.join(', ') || 'nothing'}` : `the operator's rewind to cycle ${want} did not happen: ${r.reason}`);
        try { await audit([{ type: 'Rewound', agent_id: agent.agent_id, cycle: want, entity: ctx.entity, ok: r.ok, reason: r.reason }]); } catch { /* reporting never stops the agent */ }
        rewind.gen++;  // reads that began before converge heard of the rewind still show the request
        rewind.wanted = 0;
        log({ cycle, action: 'rewind (operator)', observation: r.ok ? `back to the start of #${want}` : r.reason, rewind_to: want, ok: r.ok });
      },
      async afterRewind(ctx) {
        // The rewound image carries the grants it held then; converge's claim is what stands now.
        const st = await mcp(agent, 'status').catch(() => ({}));
        await ctx.setWritable(worker ? st.you?.claim || [] : []);
      },
      async doneGate() {
        if (!worker) return undecided();
        // Checks still running are waited on (bounded, as status does), not counted against the agent: aios lets a
        // writer finish after three refused dones, and a refusal should mean something is wrong, not "not yet".
        const deadline = Date.now() + 900_000;
        let st = await mcp(agent, 'status').catch(() => ({}));
        while (Date.now() < deadline && awaiting(st)) {
          await waitOnChange(st.change_id);
          st = await mcp(agent, 'status').catch(() => st);
        }
        return outstanding(st);
      },
      async afterCycle(ctx, rec) {
        if (worker) {
          if (rec.action === 'read' && rec.verdict === 'allowed') {
            const a = runtime.parseAction(rec.reply) || {};
            const loc = ctx.inside(a.path);
            if (!loc.error) {
              let lines = 0;
              try { lines = fs.readFileSync(loc.abs, 'utf8').split('\n').length; } catch { /* gone */ }
              const from = Math.max(1, Number(a.start) || 1);
              const to = Math.min(lines, Number(a.end) || from + 399, from + 599);
              if (to >= from) opened.push({ path: loc.rel.split(path.sep).join('/'), from, to });
            }
          }
          steps.push(`#${rec.cycle} ${rec.action} ${String(rec.target || '').replace(/\s+/g, ' ').slice(0, 160)} -> ${rec.verdict === 'allowed' ? String(rec.observation || '').split('\n')[0].slice(0, 160) : `${rec.verdict}: ${rec.reason.slice(0, 160)}`}`);
          const state = {
            agent_id: agent.agent_id, cycles: rec.cycle,
            notes: ctx.notes.filter((n) => !String(n).startsWith(CODE_MAP_HEAD)).slice(-40),
            open: opened.slice(-60), steps: steps.slice(-15), claim: ctx.writable,
          };
          writeHandover(dir, state);
          handoverOut.post(state);
        }
        try { await pushCycle(ctx, rec.cycle, rec.treeAfter); } catch { /* the diff for this cycle is simply missing */ }
        report([{ type: 'Acted', agent_id: agent.agent_id, entity: ctx.entity, cycle: rec.cycle, action: rec.action, target: rec.target, verdict: rec.verdict,
          checkpoint: rec.checkpoint, tree: rec.tree, reply: clip(rec.reply, 2000), observation: clip(rec.observation, 4000),
          reason: rec.verdict === 'refused' ? refusalLine(rec.observation) || rec.reason : rec.reason, alerts: rec.alerts }]);
      },
      // Landed (or superseded) ends the agent: there is nothing left for another cycle to do.
      async finishedBy(ctx, rec) {
        if (!worker || !['converge', 'commit'].includes(rec.action)) return '';
        const st = await mcp(agent, 'status').catch(() => ({}));
        return st.state === 'landed' ? `change ${st.change_id} landed` : st.state === 'superseded' ? `change ${st.change_id} superseded by another contender` : '';
      },
      async outOfCycles(ctx) {
        // Work not pushed is pushed (not submitted), so whoever takes over (--from) starts from it.
        const handover = await actions.commit({ message: `wip: ${agent.agent_id} stopped after ${ctx.history.length} cycles (handover)` }, ctx);
        if (!/^nothing to commit/.test(handover)) log({ cycle: ctx.history.length + 1, reply: '(out of cycles)', action: 'commit', observation: handover });
      },
    },
  });
  clearInterval(rewindWatch);
  await flushReports();
  await handoverOut.flush();
  return result;
}

/** A submitted change with nothing failed and nothing for the agent to do: checks pending or the train to come. */
function awaiting(st) {
  if (st.state !== 'submitted') return false;
  return outstanding(st).every((o) => o.includes('pending'));
}

/** What still stands between a worker's change and done, from converge status. */
export function outstanding(st) {
  const out = [];
  if (!st.change_id) return ['you have no change yet: claim, edit, commit, then submit'];
  // Landed, or superseded by another contender: nothing is left for this agent to wait on.
  if (st.state === 'landed' || st.state === 'superseded') return [];
  if (st.state === 'working') out.push('your change is not submitted');
  if (st.state === 'conflicted') out.push('your change conflicts with main');
  for (const k of ['verified', 'claim_check', 'evidence', 'acceptance']) {
    const v = st[k];
    if (typeof v === 'string' && v.startsWith('pending')) out.push(`${k} is still pending`);
    else if (v && typeof v === 'object' && (v.passed === false || v.reproduced === false || v.held === false)) out.push(`${k} failed`);
  }
  for (const n of st.notices || []) if (/refuted|without any claims|outside|not covered|failed/i.test(String(n))) out.push(String(n).slice(0, 240));
  // Held off the merge train (converge's own reasons: documentation removed without a claim, ...): the agent must act.
  if (st.held && !out.some((o) => o.includes(st.held))) out.push(`your change is held off the merge train: ${st.held}`);
  // Everything passed: it lands with the next merge train, which can still fail it merged with others.
  if (!out.length && st.state === 'submitted') out.push('landing is pending: call status, it waits for the merge train');
  return out;
}
