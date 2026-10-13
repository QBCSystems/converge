// converge run: an agent on a task, as an aios entity (see the header of agents/converge.mjs, which calls run()).

import { followSteps } from './steps.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldResume, runOutcome } from './resume.mjs';
import { agentFence, jailPath, runFenced } from './fenced.mjs';
import { universalAgentPath, missingUniversalAgent, aiosMissing, GENERATED_IGNORE, providerEnv, cloneFromDisk, sharedObjects, thinkingBudget, makeSigningKey } from './common.mjs';
import { opts, fail, call, need, mcp, gitAuth } from './cli-common.mjs';
import { collectHarnessState, restoreHarnessState, prepareResume } from './harness-state.mjs';

export function verifiedLine(verified) {
  if (verified === null || typeof verified !== 'object') return 'verified: none';
  if (verified.exit_code === 0) return 'verified: passed';
  return `verified: failed (exit ${verified.exit_code})`;
}

// An agent runs on the universal agent (agents/universal/universal-agent.cjs, the harness):
// its own loop, memory and ledgers, fenced by fenced.mjs. --in-aios (and a --script replay)
// runs it as an aios entity instead (runAios): aios decides each action, converge-jail fences each command.
// --outside-aios is the default and still accepted.
const UNIVERSAL_AGENT = universalAgentPath();
// What a worker is offered by the harness (agents/universal: AGENT_TOOLS): what agents used across every run (read, edit,
// write, run, search, find, list). Every tool's description is resent on
// every model call: the 16 offered before were 10.6k characters a call, half of them never used.
const WORKER_TOOLS = ['read_file', 'edit_file', 'write_file', 'run_command', 'search_code', 'find_files', 'list_dir', 'bulk_edit'].join(',');

// ---- run: an agent on a task, as an aios entity -------------------------------------------------

function agentPrompt(you, branch, aios = true) {
  const t = you.task || {};
  const mode = t.mode === 'compete'
    ? 'compete: several agents solve this same task; a reviewer ships the best verified one.'
    : 'split: your change lands on its own once it merges cleanly and passes verification.';
  // Ordered for the model's prompt cache: what every agent on every task shares comes first, then
  // the task (shared by its agents), and only the last lines are this agent's own. Many agents at
  // once then reuse one long cached prefix instead of each starting a new one at its first line.
  return `You work through converge on a shared repository, alongside other agents.
The converge tools (MCP server "converge": status, claim, submit, ...) are how you coordinate.
Your own fork is cloned as your work tree; every path is relative to it.
1. Call converge status to confirm the task, then claim the files (or file:START-END line ranges, or file#Scope units such as src/b.js#Store.put, as git outline <file> lists them) you will change, before editing: claim {"paths": ["src/a.js", "src/b.js:40-80"], "summary": "what you will change"}. Other agents may be changing the same files at the same time: that is expected. Add your code alongside theirs rather than restructuring shared code; converge merges both sides' additions.
2. Edit the files, then ${aios ? 'commit and push them with the commit action ({"action":"commit","message":"<what and why>"}: your sandbox has no network, the commit action pushes)' : `commit and push: git add -A && git commit -m "<what and why>" && git push origin HEAD:${branch}`}
3. Submit: submit {"summary": "what and why", "tests": {"command": "the exact command you ran"}, "claims": [{"statement": "what it shows", "file": "path", "excerpt": "exact text from that file"} or {"statement": "...", "command": "...", "expect": "text its output contains"}]}. If you ran a test or build command, pass that exact command in tests.command: converge re-runs it on a clean checkout of your commit, so it must work from scratch (include its build steps; nothing from your work tree is there). If you ran none, omit tests.
   Back every statement you make about the code with claims (file + exact excerpt, or command + expected output). If you delete or change documentation, each removed statement needs a claim proving it was wrong; if you cannot prove it, leave the text alone.
4. Call status with {"wait": true}: converge answers the moment something happens to your change (a check result, the merge train landing it, a conflict), so one call does the waiting; never sleep and poll git. Call it again if it is still on its way (it rides the merge train: ready changes land together, merged with main). If a check failed or a notice asks for something, fix it, commit, push and submit again. Finish (done) only once status shows your change landed.
If your change conflicts with main (status shows conflicts): ${aios ? '{"action":"sync"}' : `git pull --no-rebase main ${branch}`}, resolve the conflict markers, commit, push, submit again.
Rules: change only the files you claimed; never revert or rewrite other people's work you were not asked to touch; an observed fact beats an assumption, so check before you assert that something does not exist (search the whole repository, not one file). Never report a command you did not run or a result you did not see.

Your task: ${t.title}
${t.description || ''}
Mode ${mode}
${t.acceptance_checks?.length ? `Definition of done: converge runs these acceptance checks on your submitted commit, and your change cannot land until every one exits 0:\n${t.acceptance_checks.map((c) => `  $ ${c}`).join('\n')}\nRun them yourself before you submit.\n` : ''}
You are agent ${you.agent_id}; the task is ${t.task_id}.`;
}

/**
 * A worker whose change converge hands in (run's lean mode): only the coding is the model's. Ordered for the prompt
 * cache like agentPrompt: what every agent shares first, the task, then this agent's own line.
 */
// The files a task names, as they are on main now (small ones: 8 KB each, 24 KB in all), [{ file, body }]. A worker's first
// calls were reading exactly these, one call each, each call resending everything before it.
function givenFiles(t, repo) {
  const out = [];
  let room = 24_000;
  const named = [...new Set((`${t.title || ''} ${t.description || ''}`.match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')))];
  for (const f of named) {
    let body;
    try { const full = path.join(repo, f); if (!full.startsWith(repo + path.sep) || !fs.statSync(full).isFile()) continue; body = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (body.length > 8000 || body.length > room || body.includes('\0')) continue;
    out.push({ file: f, body }); room -= body.length;
  }
  return out;
}

/** The paths a task's title and description name that are files of the repository, or new files in a directory of it. */
export function namedFiles(t, repo) {
  const named = [...new Set((`${t.title || ''} ${t.description || ''}`.match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')))];
  return named.filter((f) => {
    const full = path.resolve(repo, f);
    if (!full.startsWith(repo + path.sep)) return false;
    try { if (fs.statSync(full).isFile()) return true; } catch { /* not there yet */ }
    try { return f.includes('/') && fs.statSync(path.dirname(full)).isDirectory(); } catch { return false; }
  });
}

/**
 * A lean worker's claim, made before its model starts: the files its task names. Its peers see the reservation while it
 * works (not only once it hands in), and it is told who holds the same files. The hand-in claims again, adding the
 * files it created. Returns what to tell the agent ("" when nobody else holds them, or nothing was claimed).
 */
export async function claimAhead(agent, taskInfo, repo, claim = mcp) {
  const paths = namedFiles(taskInfo, repo);
  if (!paths.length) return '';
  const r = await claim(agent, 'claim', { paths, summary: taskInfo.title || 'its task' }).catch((e) => ({ error: e.message }));
  if (!r || r.error) return '';
  const held = [...(r.overlaps || []).map((o) => `${o.agent_id} holds ${(o.paths || []).join(', ')}${o.summary ? ` (${o.summary})` : ''}`),
    ...(r.in_flight || []).map((c) => `${c.agent_id}'s change ${c.change_id} in flight touches ${(c.scopes?.length ? c.scopes : c.files || []).join(', ')}`)];
  if (!held.length) return '';
  return `\n\nconverge has claimed ${paths.join(', ')} for you. Other agents hold the same files right now: ${held.join('; ')}. Add your code next to theirs; do not move, rename or rewrite what is there.`;
}

/** The files the task names that main holds an exact copy of elsewhere: "copy is a copy of file", converge keeps them in step. */
function copiesNamed(t, repo) {
  try {
    const named = [...new Set((`${t.title || ''} ${t.description || ''}`.match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')))];
    if (!named.length) return [];
    const byOid = new Map(), oidOf = new Map();
    for (const line of execFileSync('git', ['-C', repo, 'ls-tree', '-r', 'HEAD'], { encoding: 'utf8', maxBuffer: 256 << 20 }).split('\n')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (m) { oidOf.set(m[2], m[1]); byOid.set(m[1], [...(byOid.get(m[1]) || []), m[2]]); }
    }
    const seen = new Set(), out = [];
    for (const f of named) {
      const group = (byOid.get(oidOf.get(f)) || []);
      if (group.length < 2 || group.length > 4 || seen.has(group.join())) continue;
      seen.add(group.join());
      // The original is the shorter path (universal-agent.cjs, not site/dl/universal-agent.cjs).
      const [orig, ...rest] = [...group].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
      out.push({ orig, copies: rest });
    }
    return out;
  } catch { return []; }
}

function leanPrompt(you, repo) {
  const t = you.task || {};
  const checks = t.acceptance_checks || [];
  const copies = copiesNamed(t, repo);
  const files = givenFiles(t, repo).map(({ file, body }) => `--- ${file}\n${body}${body.endsWith('\n') ? '' : '\n'}`).join('');
  return `You are one of several coding agents changing one repository at the same time. Your work tree is a clone of its main branch; every path is relative to it.
Make the change your task asks for by editing files: look at only what you need, edit, and stop. The files your task names are below as they are now: edit them straight away, without reading them again. Other agents are adding to the same files right now: add your code next to what is there, never restructure or rewrite code your task does not need, and change nothing else.
When the change is made, call done with one sentence saying what you changed. Your checks run automatically when you call done, and if one fails you get its output: fix it and call done again. You do not need to run them yourself, and you never commit, push, claim or submit: converge does all of that and lands your change.
Edit in as few steps as you can: every step resends the whole conversation. Make all your changes to one file in ONE edit_file call (its "edits" list takes many {find, replace} pairs), and use bulk_edit for the same change across several files.
When the task's words and its checks disagree (it says to leave something out that a check needs), the checks decide: they were tried on the repository before you started and are what "done" means. Do what makes them pass, in the files your task names, and say in your done sentence what you did differently. Report blocked only when no change to those files can make them pass.
An observed fact beats an assumption: check before you say something does not exist. Never report a command you did not run or a result you did not see.
${copies.length ? copies.map((c) => `${c.copies.join(' and ')} ${c.copies.length > 1 ? 'are exact copies' : 'is an exact copy'} of ${c.orig}: edit only ${c.orig}; converge writes the same content to the copy when it hands your change in.`).join('\n') + '\n' : ''}
Your task: ${t.title}
${t.description || ''}
${checks.length ? `Done means these checks exit 0 on your change:\n${checks.map((c) => `  $ ${c}`).join('\n')}\n` : ''}${files ? `\nThe files your task names, as they are now:\n${files}` : ''}
You are agent ${you.agent_id}; the task is ${t.task_id}.`;
}

function reviewerPrompt(you, taskIds, tasks = []) {
  const ids = String(taskIds).split(',').map((t) => t.trim()).filter(Boolean);
  const brief = ids.map((id) => {
    const t = tasks.find((x) => x.task_id === id);
    if (!t) return `- ${id}`;
    return `- ${id}: ${t.title}${t.mode === 'compete' ? ' (compete)' : ''}\n  asked: ${String(t.description || '').slice(0, 900)}${t.accept?.length ? `\n  done when (acceptance checks): ${t.accept.join('  |  ')}` : ''}`;
  }).join('\n');
  // A lead (--lead <workstream>): the same review, for one workstream, kept up while its team works, ending in a report.
  const lead = opts.lead ? `You lead the "${opts.lead}" workstream: ${ids.length} tasks worked on by other agents right now. Their changes arrive while you review; call converge status with {"wait": true} between rounds instead of sleeping, and review each task's contenders as they come in, until every task below is landed or held.
When you finish, your last message is a short report for the person running this (5 lines at most): what landed, what you held and why, and the one thing most likely to need them.

` : '';
  return `${lead}You are reviewer ${you.agent_id} on a converge project. You do not edit code.
Review these tasks one at a time:
${brief}

For each: call converge contenders with its task_id and read each change with converge diff. converge has already run, on each contender's exact commit, the project's tests, the agent's reported test, its evidence claims and the task's acceptance checks: their results are in contenders; do not rebuild or re-run them. Your work tree is main: files a contender adds are not in it, read them in the diff. Judge what the checks cannot: is the change correct, does it do what the task asked, does it remove true information or add claims you cannot confirm, does it touch files the task did not ask for. Check facts against this repository yourself.
Then call converge pick with the task_id (plan) and either pick with execute=true to land it, or hold it with a reason. Finish with one line per task: landed or held, and why.
Never claim you checked something you did not check.`;
}

// Agents run as aios entities: the model is a mind that proposes actions, and agents/aios-runtime.mjs
// carries out only what the entity's aios capabilities allow (see the header of that file).

/**
 * One agent run by the universal agent. git reaches the fork (push) and main (pull) with credentials
 * from the environment, per remote; converge's MCP endpoint is its "converge" server; the project's
 * tests and the task's acceptance checks are the gate its done() must pass.
 */
// Antigravity's CLI (agy) runs MCP servers from its own global list, and the harness starts it with none of converge's.
// Wherever converge runs an agy agent (any machine, any OS), converge's server goes on that list first: the stdio bridge
// agents/mcp-bridge.mjs, registered with no address and no key (each agent's own come through its environment,
// AGENT_MCP), so it is the same entry for every agent and every run. Idempotent: added only when missing or moved.
function agyBinary() {
  const set = process.env.CONVERGE_AGY_BIN || process.env.FLEET_AGY_BIN || process.env.AGY_BIN || process.env.ANTIGRAVITY_BIN;
  if (set) return set;
  const home = os.homedir();
  const local = process.platform === 'win32'
    ? [path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy.exe'), path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy.cmd'), path.join(home, '.antigravity', 'bin', 'agy.exe')]
    : [path.join(home, '.local', 'bin', 'agy')];
  return local.find((f) => fs.existsSync(f)) || 'agy';
}
function ensureAgyBridge() {
  const agy = agyBinary();
  const bridge = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'mcp-bridge.mjs');
  let listed = '';
  try { listed = execFileSync(agy, ['mcp', 'list'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { console.error(`antigravity: agy is not usable here (${String(e.message || e).split('\n')[0]}): install it and sign in first`); return; }
  const line = listed.split('\n').find((l) => /^converge\s/.test(l)) || '';
  if (line.includes(bridge) && line.includes(process.execPath) && /enabled/.test(line)) return;
  try {
    execFileSync(agy, ['mcp', 'add', 'converge', process.execPath, bridge, 'converge'], { timeout: 20_000, stdio: 'ignore' });
    try { execFileSync(agy, ['mcp', 'enable', 'converge'], { timeout: 20_000, stdio: 'ignore' }); } catch { /* enabled already */ }
    console.error('antigravity: converge MCP bridge registered with agy');
  } catch (e) { console.error(`antigravity: could not register converge with agy: ${String(e.message || e).split('\n')[0]}`); }
}

// While an agent works, other agents' changes land on main. Its runner watches main (the platform's copy on this
// machine) and tells it, through its mailbox (AGENT_INBOX, read by the agent before each step): what landed, and when
// that touched files it is changing or its task names, exactly how (the diff). When git can bring main in under its
// work without touching its own edits (it has committed nothing of its own, and none of its uncommitted files are among
// the landed ones), its work tree is fast-forwarded too, so what it reads next is main as it is now. Before this, an
// agent saw others' work only when its own hand-in collided with it.
// The task as far as its own work goes: its description without the paragraphs the swarm adds about the others at
// work (agents/swarm.mjs withPlan: the workstream, the other workstreams, the other tasks and their files). Those name
// other tasks' files; read as this task's, they were claimed and counted as its own.
export function ownTask(task) {
  if (!task || typeof task !== 'object') return {};
  const mark = /^(The workstream you are part of|Other agents are working on these at the same time|Other agents are doing these tasks at the same time)/;
  const description = String(task.description || '').split(/\n\n+/).filter((p) => !mark.test(p.trim())).join('\n\n');
  return { ...task, description };
}

export function watchMain({ agent, joined, repo, dir, taskInfo, note }) {
  const branch = joined.main_branch || 'main';
  const local = agent.main_local && fs.existsSync(path.join(agent.main_local, 'HEAD')) ? agent.main_local : '';
  if (!local || !repo) return () => {};   // a platform elsewhere: what landed reaches the agent at its hand-in
  const inbox = path.join(dir, 'inbox.jsonl');
  const run = (args) => spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const out = (args) => { const r = run(args); return r.status === 0 ? String(r.stdout || '') : ''; };
  const headOf = () => out(['--git-dir', local, 'rev-parse', `refs/heads/${branch}`]).trim();
  const named = new Set((`${taskInfo.title || ''} ${taskInfo.description || ''}`.match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')));
  let seen = headOf();
  let busy = false;
  const tick = () => {
    if (busy) return;
    const now = headOf();
    if (!now || !seen || now === seen) { if (now && !seen) seen = now; return; }
    busy = true;
    const from = seen;
    seen = now;
    try {
      if (run(['-C', repo, 'fetch', '-q', local, branch]).status !== 0) return;
      const landed = out(['-C', repo, 'log', '--first-parent', '--format=%s', `${from}..${now}`]).split('\n').filter(Boolean);
      const files = out(['-C', repo, 'diff', '--name-only', from, now]).split('\n').filter(Boolean);
      if (!files.length) return;
      const dirty = new Set([...out(['-C', repo, 'diff', '--name-only', 'HEAD']).split('\n'), ...out(['-C', repo, 'ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean));
      const committed = new Set(out(['-C', repo, 'diff', '--name-only', `${now}...HEAD`]).split('\n').filter(Boolean));
      const mine = files.filter((f) => dirty.has(f) || committed.has(f));
      const theirsOnMine = files.filter((f) => mine.includes(f) || named.has(f));
      // Brought in under its work: only a fast-forward (nothing of its own committed), which git refuses when one of
      // its uncommitted files is in the way.
      const ancestor = run(['-C', repo, 'merge-base', '--is-ancestor', 'HEAD', now]).status === 0;
      const updated = ancestor && !files.some((f) => dirty.has(f)) && run(['-C', repo, 'merge', '-q', '--ff-only', now]).status === 0;
      const lines = [`Work by other agents just landed on main:\n${landed.map((l) => `- ${l.slice(0, 200)}`).join('\n')}\nFiles it changed: ${files.slice(0, 30).join(', ')}${files.length > 30 ? ', ...' : ''}`];
      if (updated) lines.push(`Your work tree has it now (main was brought in under your work; nothing of yours changed). Files you read before may have changed: read the lines again before you edit them.`);
      if (theirsOnMine.length) {
        lines.push(`It changed ${theirsOnMine.length === 1 ? 'a file' : 'files'} you are working on: ${theirsOnMine.join(', ')}. Keep their change: build on it, never undo or repeat it.${updated ? '' : ' Your copy does not have it yet; converge merges the two when you hand in, so keep your edits to your own lines where you can.'}`);
        const diff = out(['-C', repo, 'diff', from, now, '--', ...theirsOnMine]);
        if (diff) lines.push(`Their change to ${theirsOnMine.length === 1 ? 'it' : 'them'}:\n${diff.length > 4000 ? `${diff.slice(0, 4000)}\n... (${diff.length - 4000} more characters)` : diff}`);
      }
      if (!updated && !theirsOnMine.length) return;   // nothing of its own touched, nothing changed under it: no message
      fs.appendFileSync(inbox, `${JSON.stringify({ from: 'converge', text: lines.join('\n\n') })}\n`);
      note(`Told the agent: ${landed.length} change(s) landed on main${theirsOnMine.length ? `, touching ${theirsOnMine.join(', ')}` : ''}${updated ? '; its work tree has them now' : ''}`);
    } catch { /* the next look tries again */ } finally { busy = false; }
  };
  const timer = setInterval(tick, Number(process.env.CONVERGE_MAIN_WATCH_MS) || 1500);
  timer.unref();
  return () => clearInterval(timer);
}

async function runUniversal({ agent, joined, reviewer, repo, dir, task, kind, testCommand, acceptChecks, handover = null, saveHandover = null, lean = false, taskInfo = {} }) {
  if (!fs.existsSync(UNIVERSAL_AGENT)) fail(missingUniversalAgent());
  // Plain-words lines in the agent's log (the dashboard shows them in its panel) while it gets ready.
  const note = (text) => { try { fs.appendFileSync(path.join(dir, 'universal-agent.log'), `[${new Date().toISOString()}] converge: ${text}\n`); } catch { /* the panel misses one line */ } console.error(`  ${text}`); };
  // The harness's own state for this run (its task state; memory and ledgers are in the work tree's .converge/ and .agent/).
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  if (!reviewer && handover) {
    // What the agent before it on this task knew: its memory, ledgers, conversation and task state, put back where
    // the harness looks for them; and its claim, so its first edit is not refused.
    const n = restoreHarnessState(repo, stateDir, handover.files);
    if (n) note(`Picked up what ${handover.agent_id} knew: ${n} files of its memory, notes and conversation`);
    await inheritClaim(agent, handover);
  }
  // Saved to the platform (ASQL) while it runs, and whenever it ends: the next agent on this task starts from it.
  let saving = null;
  const snapshot = async () => {
    if (reviewer || !saveHandover) return;
    if (saving) return saving;
    saving = (async () => {
      const st = await mcp(agent, 'status').catch(() => ({}));
      const { files, skipped } = collectHarnessState(repo, stateDir);
      const body = { agent_id: agent.agent_id, harness: 'universal', at: new Date().toISOString(), claim: st.you?.claim || [], files, skipped };
      try { fs.writeFileSync(path.join(dir, 'handover.json'), JSON.stringify(body)); } catch { /* the platform has it */ }
      await saveHandover(body).catch((e) => console.error(`${agent.agent_id}: ${e.message}`));
    })().finally(() => { saving = null; });
    return saving;
  };
  const snapshots = setInterval(() => { snapshot(); }, Number(process.env.CONVERGE_HANDOVER_EVERY_MS) || 60_000);
  snapshots.unref();
  const basic = (token) => `Authorization: Basic ${Buffer.from(`x:${token}`).toString('base64')}`;
  const gitCfg = [];
  if (!reviewer && agent.remote && agent.token) gitCfg.push([`http.${agent.remote}.extraHeader`, basic(agent.token)]);
  const mainToken = agent.main_token || agent.token;
  if (agent.main_remote && mainToken) {
    gitCfg.push([`http.${agent.main_remote}.extraHeader`, basic(mainToken)]);
    try { execFileSync('git', ['-C', repo, 'remote', 'add', 'main', agent.main_remote], { stdio: 'ignore' }); } catch { /* already there */ }
  }
  // A copy converge keeps in step (keepCopiesInStep) is written at hand-in; the agent's own run of its checks comes before
  // that, so each check first writes the original over the copy once the original has changed, as the hand-in will.
  const q = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;
  const sync = (reviewer ? [] : copiesNamed(taskInfo, repo)).flatMap((c) => c.copies.map((copy) => `{ git diff --quiet HEAD -- ${q(c.orig)} || cp -f ${q(c.orig)} ${q(copy)}; } 2>/dev/null; `)).join('');
  const checks = reviewer ? [] : [
    ...(testCommand ? [{ name: 'project tests', command: sync + testCommand }] : []),
    ...acceptChecks.map((c, i) => ({ name: `acceptance check ${i + 1}`, command: sync + c })),
  ];
  const taskFile = path.join(dir, 'task.md');
  fs.writeFileSync(taskFile, task);
  // Taking over: the previous agent's conversation carries on (`resume`), with this agent's instructions as its newest
  // message and a full step budget from where it stopped. Nothing to resume: a fresh run on the task.
  const resumed = !reviewer && handover ? prepareResume(stateDir, repo, `You are continuing this task as a new agent. Your conversation above is the previous agent's: what it read, tried and found is yours now, so do not redo it. Your identity, fork and instructions from here on:\n\n${task}`, { evenDone: true }) : null;   // a predecessor that said done and was refused (or stopped after) still has the conversation worth carrying on
  note(resumed ? `Carries on ${handover.agent_id}'s conversation from step ${resumed.step}, instead of starting over` : 'Starts the task fresh: there is no earlier conversation to carry on');
  if (kind === 'antigravity-cli') ensureAgyBridge();
  const workerEffort = opts.effort || 'low';
  const env = {
    ...process.env,
    // The model providers come from ASQL (converge keeps them there); the agent reads them from here, not from a file.
    ...(await providerEnv()),
    EDIT_PROVIDER: kind,
    ...(opts.model ? { EDIT_MODEL: opts.model } : {}),
    // A provider that lives at a host of its own (Ollama Cloud, an OpenAI-compatible gateway).
    ...(opts.host ? { EDIT_API_HOST: opts.host } : {}),
    // Reasoning effort picked in the dashboard (minimal|low|medium|high|off), where the model supports it.
    // Low unless the owner picked one: a step of this loop is one tool call, and at the model's own default a single
    // edit step thought for 29,800 hidden tokens and over nine minutes before answering (converge local run, 2026-10-10).
    EDIT_EFFORT: workerEffort,
    // ...and Claude Code's hidden thinking held to it (agents/common.mjs thinkingBudget), not to the machine's environment.
    ...(thinkingBudget(workerEffort) ? { MAX_THINKING_TOKENS: thinkingBudget(workerEffort) } : {}),
    // The most one step (one tool call) may generate, reasoning included: a ceiling, not a target (a whole new file fits).
    AGENT_STEP_MAX_TOKENS: process.env.AGENT_STEP_MAX_TOKENS || '12000',
    // A step with no output for this long is a hung API request (killed, then asked again on the same model): a worker's step
    // answers in seconds, and two minutes of nothing per hang was most of a run.
    AGENT_CALL_TIMEOUT: process.env.AGENT_CALL_TIMEOUT || '60000',
    // ...and the model's first output (its first text, thinking or tool block) within 25 s: a hung request sends only
    // keep-alives, and a worker's step starts answering in seconds. Asked again on the same model (providers.cjs).
    AGENT_FIRST_OUTPUT_TIMEOUT: process.env.AGENT_FIRST_OUTPUT_TIMEOUT || '25000',
    // A worker's own short system prompt and tool descriptions (universal-agent.cjs LEAN_SYSTEM), given to Claude Code
    // in place of its own (CONVERGE_CLAUDE_OWN_SYSTEM): both were resent with every step, most of each step's input.
    ...(lean ? { AGENT_LEAN_SYSTEM: '1', CONVERGE_CLAUDE_OWN_SYSTEM: '1' } : {}),
    // One Claude Code process for the whole run of the agent, each step the next turn of it (providers.cjs
    // CONVERGE_CLAUDE_LIVE), not a new process per step: about 0.65 s a step instead of 1.5-3.6 s spent starting Claude Code.
    CONVERGE_CLAUDE_LIVE: process.env.CONVERGE_CLAUDE_LIVE || '1',
    // Its mailbox: what happens elsewhere while it works (watchMain), read before each step.
    AGENT_INBOX: path.join(dir, 'inbox.jsonl'),
    // The run spends on the model it was given and nothing else (the harness has no fallback). If the provider
    // refuses (out of credit), the agent stops.
    AGENT_MODELS: JSON.stringify([{ provider: kind, ...(opts.model ? { model: opts.model } : {}), ...(opts.host ? { host: opts.host } : {}), effort: workerEffort }]),
    // A lean worker (converge hands its change in) is given no converge tools: the status, claim, commit, push, submit
    // and wait steps were most of its model calls, and each one resent the whole conversation.
    ...(lean ? {} : { AGENT_MCP: JSON.stringify({ converge: { url: agent.mcp_url, headers: { Authorization: `Bearer ${agent.mcp_key}` } } }) }),
    AGENT_VALIDATE: JSON.stringify(checks),
    AGENT_SANDBOX: process.env.AGENT_SANDBOX || 'require',
    AGENT_YOLO: '1',
    // Claude Code with its own tools (one session for the whole task) only when asked: CONVERGE_CLAUDE_NATIVE=1. It is
    // fast but each of its internal turns resends Claude Code's own prompt and the whole session: 6 small changes cost
    // 3.5M input tokens that way (converge local run, 2026-10-10). The default is the harness's own loop, which converge
    // keeps small. Its commands are fenced by putting the whole agent in the fence (fenced.mjs).
    ...(kind === 'claude-cli' && process.env.CONVERGE_CLAUDE_NATIVE === '1' ? { CONVERGE_CLAUDE_NATIVE_TOOLS: '1', CONVERGE_PERMS: 'full', CONVERGE_MCP_FORWARD_BUNDLED: '0' } : {}),
    // A worker codes in its fork, fenced, with no network: offered the tools for that (and converge's, which always
    // stay), not the harness's browser, listings and publishing tools (UNIVERSAL_AGENT_TOOLS overrides; "all": every one).
    ...(!reviewer && process.env.UNIVERSAL_AGENT_TOOLS !== 'all' ? { AGENT_TOOLS: process.env.UNIVERSAL_AGENT_TOOLS || WORKER_TOOLS } : {}),
    AGENT_STATE_DIR: stateDir,
    // The files the prompt already holds (leanPrompt): editable without a read_file call first.
    ...(lean ? { AGENT_FILES_GIVEN: givenFiles(taskInfo, repo).map((g) => g.file).join(',') } : {}),
    // No self-review bounce before done: converge's clean-checkout checks and the merged result's verification review it.
    ...(!reviewer ? { AGENT_DIFF_REVIEW: '0' } : {}),
    // The agent's own checklist, in its state folder: unpinned, the harness folded the project's LEDGER.md (in one project
    // some 30 unrelated open items) into every step's system prompt, resent with each call.
    CONVERGE_LEDGER_FILE: path.join(stateDir, 'agent.ledger.json'),
    ...(resumed ? { AGENT_MAX_STEPS: String(resumed.step + (Number(process.env.AGENT_MAX_STEPS) || 120)) } : {}),
    GIT_CONFIG_COUNT: String(gitCfg.length),
    ...Object.fromEntries(gitCfg.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };
  const logPath = path.join(dir, 'universal-agent.log');
  const out = fs.openSync(logPath, 'a');
  // Each step the agent takes (a command, a read, an edit), reported as it finishes: the dashboard's activity.
  const stopSteps = opts.adminKey ? followSteps({ log: logPath, api: opts.api.replace(/\/$/, ''), adminKey: opts.adminKey, project: opts.project, agentId: agent.agent_id }) : null;
  // Stopped (the budget, a rule, the owner's Stop): the agent ends first, then whatever it changed is committed and
  // pushed to its own fork, NOT handed in, so the work survives and a later run (or a person) carries on from it.
  // The swarm sends SIGTERM to the whole group and SIGKILL 10 s later: saving is a commit and a local push.
  let stopping = false;
  const save = () => saveWork({ agent, joined, reviewer, repo });
  const onStop = () => { stopping = true; };
  process.once('SIGTERM', onStop);
  process.once('SIGINT', onStop);
  const startAgent = (args, extraEnv = {}) => new Promise((resolve) => {
    // On a Mac the whole agent runs under Seatbelt (no bubblewrap there to fence each command): see fenced.mjs.
    let fenced;
    try { fenced = agentFence({ cmd: process.execPath, args, env: { ...env, ...extraEnv }, workdir: repo, stateDir: dir }); }
    catch (e) { fs.writeSync(out, `converge: ${e.message}\n`); return resolve(126); }
    if (fenced.how) fs.writeSync(out, `converge: the agent runs under ${fenced.how}: it writes ${repo}, ${dir}, tmp and its own state dirs only\n`);
    note('Starting the agent');
    const child = spawn(fenced.cmd, fenced.args, { env: fenced.env, stdio: ['ignore', out, out] });
    const unwatch = reviewer ? () => {} : watchMain({ agent, joined, repo, dir, taskInfo, note });
    child.on('exit', (c) => { unwatch(); resolve(c ?? 1); });
    child.on('error', (e) => { fs.writeSync(out, `converge: cannot start the agent: ${e.message}\n`); resolve(127); });
  });
  let code = await startAgent(resumed ? [UNIVERSAL_AGENT, 'resume', resumed.id] : [UNIVERSAL_AGENT, '--workdir', repo, '--task-file', taskFile]);
  // Lean: the agent said done (its checks already passed here: the harness runs them before it accepts done), and
  // converge hands the change in itself. What comes back goes to the same agent, in its own conversation, only when
  // the agent has to act: a check that failed on converge's clean checkout, or a conflict git could not merge.
  let lastRefused = '', sameAgain = 0;
  for (let round = 1; lean && !stopping && code === 0 && round <= 4; round++) {
    const r = await handIn({ agent, joined, repo, summary: doneSummary(stateDir) || '', note, taskInfo });
    // The same commit handed in again after it was refused (the agent changed nothing): said to it plainly once, and
    // the second time the task goes to the owner with the reason, instead of more rounds of the same refusal.
    if (r.feedback) {
      let head = '';
      try { head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
      sameAgain = head && head === lastRefused ? sameAgain + 1 : 0;
      lastRefused = head;
      if (sameAgain >= 2) {
        r.owner = { why: `its agent handed in the same refused change ${sameAgain + 1} times without changing it: ${r.feedback.replace(/\s+/g, ' ').slice(0, 500)}`, blockers: [] };
        delete r.feedback;
      } else if (sameAgain === 1) r.feedback = `You called done again without changing anything since this was refused. Nothing will land until the work tree changes as it says:\n\n${r.feedback}`;
    }
    if (r.owner) {
      // The owner's call (swarm escalates the task with these checks; Retire answers it): written where the swarm looks.
      fs.writeFileSync(path.join(dir, 'needs-owner.json'), JSON.stringify(r.owner, null, 1));
      note(`Waiting for you: ${r.owner.why}: ${r.owner.blockers.map((b) => `"${b.task}": ${b.check.slice(0, 120)}`).join(' | ')}`);
      break;
    }
    if (!r.feedback) break;
    // Kept where the swarm looks (retryWhy): an agent started after this one is told what this one was last told.
    try { fs.writeFileSync(path.join(dir, 'last-feedback.txt'), r.feedback); } catch { /* the conversation has it */ }
    const again = prepareResume(stateDir, repo, r.feedback, { evenDone: true });
    if (!again) { note('Could not reopen the agent\'s conversation to send it back'); break; }
    // The reason itself, not only its first line ("converge checked your change and it cannot land yet." said nothing).
    note(`Sent back to the agent (round ${round}): ${r.feedback.replace(/^converge checked your change and it cannot land yet\.\s*/, '').replace(/\s*Fix it in the work tree, then call done again[\s\S]*$/, '').replace(/\s+/g, ' ').slice(0, 600)}`);
    code = await startAgent([UNIVERSAL_AGENT, 'resume', again.id], { AGENT_MAX_STEPS: String(again.step + 40) });
  }
  process.off('SIGTERM', onStop);
  process.off('SIGINT', onStop);
  clearInterval(snapshots);
  await snapshot();
  if (stopping) { await saveUnlessLanded({ agent, joined, reviewer, repo }); fs.closeSync(out); if (stopSteps) await stopSteps().catch(() => 0); process.exit(143); }
  // Ended without finishing (out of steps, a crash): the same save, so the agent that continues the task (a resume
  // starts from the fork) gets this one's work instead of an empty start.
  if (!reviewer) {
    const st0 = await mcp(agent, 'status').catch(() => ({}));
    if (!['landed', 'superseded', 'submitted'].includes(st0.state)) save();
  }
  fs.closeSync(out);
  if (stopSteps) await stopSteps().catch(() => 0);
  let st = await mcp(agent, 'status').catch(() => ({}));
  // An agent that ended with its change still on the merge train (it said done the moment it submitted) has not
  // failed: the train may land it in seconds. Its verdict is waited for (status wait wakes on it), so a change that
  // lands is not taken for unfinished and handed to a successor that redoes and resubmits it, and one that fails is.
  // ...unless the owner was asked about it (needs-owner.json): no verdict comes until they answer.
  const askedOwner = fs.existsSync(path.join(dir, 'needs-owner.json'));
  // A change held off the train (status.held) gets no verdict by waiting: it ended unfinished, for its successor to fix.
  for (const until = Date.now() + 10 * 60_000; !reviewer && !askedOwner && st.state === 'submitted' && !st.held && Date.now() < until;) {
    st = await mcp(agent, 'status', { wait: true }).catch(async () => { await new Promise((r) => setTimeout(r, 3000)); return st; });
  }
  return { finished: st.state === 'landed' || st.state === 'superseded' || (reviewer && code === 0), exit: code, ledger: [], alerts: [] };
}

/**
 * One agent as an aios entity (agents/aios-runtime.mjs): the mind (the universal agent's model layer through the bridge, aios's API
 * mind, or a --script) proposes one action per cycle, aios decides it against the entity's capabilities (cap.exercise,
 * on its ledger), the host carries out what was allowed (every command inside converge-jail), and every cycle is
 * recorded in aios (cycle.record) with its checkpoint and work tree, so the agent can be replayed and rewound.
 */
async function runAios({ agent, joined, reviewer, repo, dir, task, kind, testCommand, acceptChecks, p, handover = null }) {
  const missing = aiosMissing({ provider: kind, jail: jailPath(), script: Boolean(opts.script) });
  if (missing.length) fail(`${agent.agent_id}: cannot run as an aios entity here:\n  - ${missing.join('\n  - ')}\n(--outside-aios runs the universal agent on its own instead: no aios decisions, no cycle record, no rewind)`);
  // Loaded here, not at start-up: --outside-aios and every other command work without an aios checkout.
  // A work tree that borrows the platform's objects: the runtime's fence lets its commands read them (git status, diff).
  const borrowed = sharedObjects(repo);
  if (borrowed.length) process.env.CONVERGE_VERIFY_RO = [process.env.CONVERGE_VERIFY_RO, ...borrowed].filter(Boolean).join(':');
  const { ensureService, runEntity } = await import('./aios-runtime.mjs');
  const ctl = await ensureService(path.resolve(opts.data || path.join(os.homedir(), '.converge')));
  const transcript = fs.createWriteStream(path.join(dir, 'transcript.jsonl'));
  // The dashboard follows universal-agent.log (scripts/lib/agent-log.mjs): each cycle written in its step format.
  const stepLog = fs.openSync(path.join(dir, 'universal-agent.log'), 'a');
  const stamp = () => `[${new Date().toISOString()}]`;
  fs.writeSync(stepLog, `${stamp()} converge: ${agent.agent_id} runs as an aios entity (${kind}${opts.model ? ' ' + opts.model : ''}): aios decides each action, converge-jail fences each command\n`);
  let entity = '';
  let stopping = false;
  // Stopped (the budget, a rule, the owner's Stop): the entity is ended in aios (its mind stops), then whatever it
  // changed is committed and pushed to its fork, not handed in, so a later run carries on from it.
  const onStop = () => {
    if (stopping) return;
    stopping = true;
    (async () => {
      if (entity) await ctl.call({ op: 'agent.terminate', entity }).catch(() => {});
      await saveUnlessLanded({ agent, joined, reviewer, repo });
      try { fs.writeSync(stepLog, `${stamp()} converge: stopped; aios entity ${entity.slice(0, 12)} terminated\n`); } catch { /* closed */ }
      process.exit(143);
    })();
  };
  process.once('SIGTERM', onStop);
  process.once('SIGINT', onStop);
  const res = await runEntity({
    ctl, agent, role: reviewer ? 'reviewer' : 'worker', repo, dir, prompt: task, kind, host: opts.host || '', mind: opts.script ? 'replay' : 'bridge',
    // A run's own copy of the script: the replay mind keeps its position beside it (to survive a
    // rewind), and that position must start fresh with every run.
    model: opts.script ? (fs.copyFileSync(path.resolve(opts.script), path.join(dir, 'script.jsonl')), path.join(dir, 'script.jsonl')) : opts.model || (kind === 'claude' ? 'haiku' : ''),
    testCommand, branch: joined.main_branch || 'main', maxCycles: Number(opts.maxCycles) || 60, mcp,
    acceptChecks,
    effort: opts.effort || '',
    reviewTasks: reviewer ? String(opts.task).split(',').map((x) => x.trim()).filter(Boolean) : [],
    onEntity: (e) => { entity = e; },
    handover,
    // Kept by the platform (ASQL), so whoever continues this task finds it on any machine.
    saveHandover: handoverSaver(p, agent),
    // Never fatal: the dashboard missing a line must not stop the agent.
    audit: (events) => fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/audit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(opts.adminKey ? { 'X-Admin-Key': opts.adminKey } : {}) }, body: JSON.stringify({ events }),
    }).catch(() => {}),
    log: (e) => {
      transcript.write(JSON.stringify(e) + '\n');
      try {
        let args = '';
        try { const a = JSON.parse(String(e.reply || '').slice(String(e.reply || '').indexOf('{'))); delete a.action; args = JSON.stringify(a); } catch { args = ''; }
        fs.writeSync(stepLog, `${stamp()} [step ${e.cycle}] ${e.action || 'error'}(${args})\n${stamp()} [step ${e.cycle}] -> ${String(e.observation ?? e.error ?? '').slice(0, 4000)}\n`);
      } catch { /* the dashboard misses this step */ }
      if (!opts.json) console.error(`  #${e.cycle} ${e.alerts ? '[ALERT ' + e.alerts.join(',') + '] ' : ''}${e.action || 'error'}: ${String(e.observation || e.error).split('\n')[0].slice(0, 140)}`);
    },
  });
  process.off('SIGTERM', onStop);
  process.off('SIGINT', onStop);
  transcript.end();
  fs.closeSync(stepLog);
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(res.ledger, null, 1));
  return res;
}

/**
 * The handover an earlier agent on this task left, or null: from the platform (ASQL, wherever that agent ran), else
 * from its run folder (<dir>/handover.json): known when this command ran it, otherwise the folder whose agent.json
 * names it, beside this run's folder or under the default converge-runs.
 */
async function predecessorHandover(p, agentId, knownDir) {
  try {
    const r = await fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/agents/${encodeURIComponent(agentId)}/handover`, { headers: opts.adminKey ? { 'X-Admin-Key': opts.adminKey } : {} });
    if (r.ok) { const h = await r.json(); if (h.agent_id === agentId) return h; }
  } catch { /* the platform is not answering: the run folder's copy */ }
  const read = (d) => { try { const h = JSON.parse(fs.readFileSync(path.join(d, 'handover.json'), 'utf8')); return h.agent_id === agentId ? h : null; } catch { return null; } };
  if (knownDir) { const h = read(knownDir); if (h) return h; }
  const roots = [...new Set([opts.dir ? path.dirname(path.resolve(opts.dir)) : '', path.join(os.tmpdir(), 'converge-runs')].filter(Boolean))];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const d = path.join(root, n);
      try { if (JSON.parse(fs.readFileSync(path.join(d, 'agent.json'), 'utf8')).agent_id !== agentId) continue; } catch { continue; }
      const h = read(d);
      if (h) return h;
    }
  }
  return null;
}

/** Saves an agent's handover with the platform (ASQL), so whoever continues its task finds it on any machine. */
const handoverSaver = (p, agent) => (body) => fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/agents/${encodeURIComponent(agent.agent_id)}/handover`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...(opts.adminKey ? { 'X-Admin-Key': opts.adminKey } : {}) }, body: JSON.stringify(body),
}).then((r) => { if (!r.ok) throw new Error(`handover not saved: HTTP ${r.status}`); });

/**
 * A successor holds its predecessor's claim: the platform moves it on takeover (converge-engine); where it has not (an
 * engine from before that), the successor claims the same paths itself.
 */
async function inheritClaim(agent, handover) {
  if (!handover?.claim?.length) return;
  const st = await mcp(agent, 'status').catch(() => ({}));
  if (st.you?.claim?.length) return;
  await mcp(agent, 'claim', { paths: handover.claim, summary: `continuing the work of ${handover.agent_id}` }).catch(() => {});
}

/** What the agent said it did, from its last done call (its own conversation's events), or ''. */
function doneSummary(stateDir) { return toolArg(stateDir, 'done', 'summary'); }
/** Why the agent said it cannot finish (its blocked call), in its own words; '' when it did not say. */
function blockedReason(stateDir) { return toolArg(stateDir, 'blocked', 'reason'); }
/** One argument of the agent's newest call of a tool (done's summary, blocked's reason), from its task's events. */
function toolArg(stateDir, tool, key) {
  try {
    const tasks = path.join(stateDir, 'tasks');
    const newest = fs.readdirSync(tasks).map((d) => ({ d, t: fs.statSync(path.join(tasks, d)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    const lines = fs.readFileSync(path.join(tasks, newest.d, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).reverse();
    for (const l of lines) {
      const e = JSON.parse(l);
      if (e.type !== 'tool_call' || e.name !== tool) continue;
      if (typeof e.args !== 'string') return String(e.args?.[key] || '').trim();
      // An older harness cut long arguments in the events log ("...[truncated N chars total]"): read the text up to the cut.
      try { return String(JSON.parse(e.args)[key] || '').trim(); } catch { /* cut short */ }
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(e.args);
      return m ? m[1].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').replace(/\s*\.\.\.\[truncated.*$/, '').trim() : '';
    }
  } catch { /* no such call on record */ }
  return '';
}

const tail = (s, n = 1500) => { s = String(s || '').trim(); return s.length > n ? `...${s.slice(-n)}` : s; };

/**
 * A lean worker's change, handed in by converge: committed, pushed to its fork, claimed (exactly the files it changed),
 * submitted, and waited on. Returns {} when it landed (or nothing more can be done by the agent), or { feedback } when
 * the agent has to act: a check that failed on converge's clean checkout of it, or a conflict with main that git could
 * not merge. A conflict git merges cleanly is merged here and handed in again, without the agent.
 */
/** A detached worktree of HEAD with main merged in (runs `git ...authArgs -C repo fetch -q remote branch`, merges FETCH_HEAD). Returns { dir, remove }, or null when the merge fails. */
export async function mergedCheckout(repo, { authArgs = [], remote, branch } = {}) {
  try {
    execFileSync('git', [...authArgs, '-C', repo, 'fetch', '-q', remote, branch], { stdio: 'pipe' });
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).trim();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-'));
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', tmp, 'HEAD'], { stdio: 'pipe' });
    try {
      execFileSync('git', ['-C', tmp, '-c', 'user.name=converge', '-c', 'user.email=converge@local', 'merge', '-q', '--no-edit', sha], { stdio: 'pipe' });
    } catch {
      try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', tmp], { stdio: 'pipe' }); } catch {}
      return null;
    }
    return { dir: tmp, remove: () => execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', tmp], { stdio: 'pipe' }) };
  } catch { return null; }
}

/** The checks of earlier tasks on main (landed, not retired, not this task's own) that fail on this change, run here in
 *  the sandbox on the agent's work tree: [{ task, check }]. */
export async function earlierChecksBroken(repo, taskInfo, mainFetch) {
  let st;
  try {
    const res = await globalThis.fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${encodeURIComponent(opts.project)}/state`, { headers: opts.adminKey ? { 'X-Admin-Key': opts.adminKey } : {} });
    st = await res.json();
  } catch { return []; }
  const own = new Set(taskInfo.acceptance_checks || []);
  const retired = new Set((st.tasks || []).flatMap((t) => t.retire || []));
  const landed = new Set((st.changes || []).filter((c) => c.state === 'landed').map((c) => c.task_id));
  const seen = new Set(), out = [];
  const merged = await mergedCheckout(repo, mainFetch);
  const dir = merged ? merged.dir : repo;
  for (const t of st.tasks || []) {
    if (!landed.has(t.task_id) || t.task_id === taskInfo.task_id) continue;
    for (const check of t.accept || []) {
      if (own.has(check) || retired.has(check) || seen.has(check)) continue;
      seen.add(check);
      const r = runFenced(check, dir, { timeoutMs: 60_000 });
      if (r.status !== 0) out.push({ task: t.title, task_id: t.task_id, check, output: `${r.stdout}${r.stderr}`.trim().slice(-400) });
    }
  }
  if (merged) merged.remove();
  return out;
}

/** Files that are exact copies of each other on main (the same content at two paths: a download folder holding copies of
 *  the root files, say) move together: when the agent changed one and not the other, the other is written to match and
 *  committed. Agents editing both by hand took twice the steps and still left the copies different. Returns
 *  [{ from, copy }] for each copy written. */
function keepCopiesInStep(git) {
  try {
    const base = git(['merge-base', 'FETCH_HEAD', 'HEAD']).trim();
    const changed = git(['diff', '--name-only', '--diff-filter=M', `${base}..HEAD`]).split('\n').filter(Boolean);
    if (!changed.length) return [];
    const byOid = new Map(), oidOf = new Map();
    for (const line of git(['ls-tree', '-r', base], { maxBuffer: 256 << 20 }).split('\n')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (!m) continue;
      oidOf.set(m[2], m[1]);
      byOid.set(m[1], [...(byOid.get(m[1]) || []), m[2]]);
    }
    const out = [];
    const touched = new Set(git(['diff', '--name-only', `${base}..HEAD`]).split('\n').filter(Boolean));
    for (const from of changed) {
      const oid = oidOf.get(from);
      const same = (byOid.get(oid) || []).filter((p) => p !== from);
      // An empty or tiny file shared by many paths (an empty __init__.py) is not a copy of anything.
      if (!same.length || same.length > 3 || Number(git(['cat-file', '-s', oid]).trim()) < 200) continue;
      for (const copy of same) {
        if (touched.has(copy)) continue;   // the agent changed it itself: its edit stands
        fs.writeFileSync(path.join(git(['rev-parse', '--show-toplevel']).trim(), copy), git(['show', `HEAD:${from}`], { maxBuffer: 256 << 20, encoding: 'buffer' }));
        out.push({ from, copy });
        touched.add(copy);
      }
    }
    if (out.length) { git(['add', '-A']); git(['commit', '-q', '--no-verify', '-m', `Keep copies in step: ${out.map((m) => m.copy).join(', ')}`.slice(0, 200)]); }
    return out;
  } catch { return []; }
}

/** Changed files that were exact copies, on main, of a file the task names (a download folder holding copies of the root files, say). */
function copyPartners(git, files, named) {
  try {
    const base = git(['merge-base', 'FETCH_HEAD', 'HEAD']).trim();
    const oidOf = new Map();
    for (const line of git(['ls-tree', '-r', base], { maxBuffer: 256 << 20 }).split('\n')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (m) oidOf.set(m[2], m[1]);
    }
    const namedOids = new Set([...named].map((f) => oidOf.get(f)).filter(Boolean));
    return files.filter((f) => !named.has(f) && namedOids.has(oidOf.get(f)));
  } catch { return []; }
}

// Removed lines of a unified diff: '-' lines (not '---' headers), returned without the leading '-'.
export function removedDocLines(diffText) {
  return String(diffText || '').split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1));
}

// Feedback for a change that deletes documentation with no claim backing the removal: names each file and quotes its removed lines.
export function docRemovalFeedback(notices, diffOf) {
  const phrase = 'lines of documentation with no claim backing the removal from ';
  const files = [];
  for (const n of notices || []) {
    const s = String(n);
    if (!s.includes(phrase)) continue;
    const rest = s.slice(s.indexOf(phrase) + phrase.length);
    const m = /^(.*?)\.(\s|$)/.exec(rest);
    const list = (m ? m[1] : rest).split(',').map((f) => f.trim()).filter(Boolean);
    for (const f of list) if (!files.includes(f)) files.push(f);
  }
  if (!files.length) return '';
  const parts = files.map((f) => {
    const lines = removedDocLines(diffOf(f));
    return `- ${f}:\n${lines.map((l) => `  -${l}`).join('\n') || '  (no lines quoted)'}`;
  });
  return `Your change removed documentation lines with no claim backing the removal:\n${parts.join('\n')}\nPut those lines back, keeping everything that was there and adding your own changes on top.`;
}

async function handIn({ agent, joined, repo, summary, note, taskInfo = {} }) {
  const branch = joined.main_branch || 'main';
  const git = (args, o = {}) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...o });
  const mainAuth = gitAuth(agent.main_token || agent.token);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const title = (summary || 'converge: the task\'s change').split('\n')[0].slice(0, 200);
    if (git(['status', '--porcelain']).trim()) { git(['add', '-A']); git(['commit', '-q', '--no-verify', '-m', title]); }
    // Main from the platform's own copy on this machine when there is one (a local fetch, no HTTP round trip), else over HTTP.
    const local = agent.main_local && process.env.CONVERGE_CLONE !== 'http' && fs.existsSync(path.join(agent.main_local, 'HEAD'))
      && spawnSync('git', ['-C', repo, 'fetch', '-q', agent.main_local, branch], { stdio: 'ignore', timeout: 120_000 }).status === 0;
    if (!local) execFileSync('git', [...mainAuth, '-C', repo, 'fetch', '-q', agent.main_remote, branch], { stdio: 'ignore', timeout: 120_000 });
    const mirrored = keepCopiesInStep(git);
    if (mirrored.length) note(`Kept ${mirrored.length} copy file(s) in step with the agent's edit: ${mirrored.map((m) => `${m.copy} (= ${m.from})`).join(', ').slice(0, 300)}`);
    const files = git(['diff', '--name-only', 'FETCH_HEAD...HEAD']).split('\n').filter(Boolean);
    if (!files.length) return { feedback: 'You called done, but nothing in the work tree differs from main: the change is not made yet. Make it (edit the files), then call done.' };
    execFileSync('git', [...gitAuth(agent.token), '-C', repo, 'push', '-q', agent.remote, `HEAD:refs/heads/${branch}`], { stdio: 'ignore', timeout: 120_000 });
    const head = git(['rev-parse', 'HEAD']).trim();
    // Claimed: the files the task names, and files the agent created. Anything else it changed stays unclaimed, so
    // converge's scope check sends the change back to be reverted. Claiming every changed file (as this did) let an agent
    // land edits to seven files its task never mentioned.
    const named = new Set((`${taskInfo.title || ''} ${taskInfo.description || ''}`.match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')));
    const added = new Set(git(['diff', '--name-only', '--diff-filter=A', 'FETCH_HEAD...HEAD']).split('\n').filter(Boolean));
    // Copies: written here this time, or on an earlier hand-in (already committed, so not in `mirrored` now): any changed
    // file that held the same content as a claimed one on main. Left unclaimed, the copy converge itself kept in step
    // was refused as "outside your task", round after round.
    const copies = new Set([...mirrored.map((m) => m.copy), ...copyPartners(git, files, named)]);
    // ...and the task's own tests: a changed test file (under test/, tests/, __tests__/ or named *.test.*, *_test.*,
    // *.spec.*) whose name holds a named file's stem or a name the task mentions. "Update its test" names no file,
    // and the agent that did it was sent back to undo it.
    const words = new Set([...[...named].map((f) => path.basename(f).replace(/\.[^.]+$/, '')), ...((`${taskInfo.title || ''} ${taskInfo.description || ''}`.match(/[A-Za-z_][\w]{3,}/g)) || [])].map((w) => w.toLowerCase()));
    const ownTest = (f) => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.\w+$|_test\.\w+$/.test(f) && [...words].some((w) => path.basename(f).toLowerCase().includes(w));
    const claim = named.size ? files.filter((f) => named.has(f) || added.has(f) || copies.has(f) || ownTest(f)) : files;
    await mcp(agent, 'claim', { paths: claim.length ? claim : files, summary: title }).catch(() => {});
    // The platform sees a push within a moment of it (its hook): until then a submit has no change to take.
    let sub = null, why = '';
    for (let i = 0; i < 50 && !sub; i++) {
      const st = await mcp(agent, 'status').catch(() => ({}));
      if (st.head_commit === head) sub = await mcp(agent, 'submit', { summary: title }).catch((e) => { why = e.message; return null; });
      else await new Promise((r) => setTimeout(r, 200));
    }
    if (!sub) { note(`Could not hand the change in: ${why || 'the platform never saw the push'}`); return {}; }
    note(`Handed in ${head.slice(0, 8)} (${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ').slice(0, 160)}): converge is checking it`);
    // Its verdict: landed, a failure the agent must fix, or a conflict.
    let st = {};
    for (const until = Date.now() + 15 * 60_000; Date.now() < until;) {
      st = await mcp(agent, 'status', { wait: true }).catch(async () => { await new Promise((r) => setTimeout(r, 3000)); return st; });
      if (st.state === 'landed' || st.state === 'superseded') { note(`Its change ${st.state === 'landed' ? 'landed on main' : 'was superseded'}`); return {}; }
      if (st.head_commit && st.head_commit !== head) return {};   // someone else moved it on
      const failed = [];
      const v = st.verified;
      if (v && typeof v === 'object' && (v.exit_code !== 0 || v.timed_out)) failed.push(`${/converge-guard\.cjs/.test(v.command || '') ? `converge's checks of your change (every file you changed must still parse${/&&\s*\(/.test(v.command) ? ', then the project\'s own tests' : ''})` : `The project's tests (\`${v.command || 'the test command'}\`)`} failed on a clean checkout of your change${v.timed_out ? ' (timed out)' : ` (exit ${v.exit_code})`}:\n${tail(v.output_tail)}`);
      const a = st.acceptance;
      if (a && typeof a === 'object' && a.passed === false) failed.push(`The task's checks failed on a clean checkout of your change:\n${tail(a.report)}`);
      for (const n of st.notices || []) {
        const docFeedback = docRemovalFeedback([n], (file) => { try { return git(['diff', 'FETCH_HEAD...HEAD', '--', file]); } catch { return ''; } });
        if (docFeedback) failed.push(docFeedback);
        if (/touches files you did not claim/.test(n)) failed.push(`Your change edits files outside your task: ${(st.out_of_scope || []).join(', ') || (/claim:\s*(.*?)\.\s+Revert/.exec(n) || [])[1] || 'some of them'}. Undo your edits to those files (git checkout FETCH_HEAD -- <file>, or edit them back): only the files your task names, and new files you create, are yours.`);
        else if (/merged with main it failed|did not hold/.test(n)) {
          // An earlier task's check that this change breaks is not the agent's to fix when the request changes what that
          // check tests (it removes or reworks the feature): the owner decides. Sent back instead, the agent could only
          // undo the request or give up, three times over.
          const blockers = /features already on main|of landed features/.test(n) ? await earlierChecksBroken(repo, taskInfo, { authArgs: mainAuth, remote: agent.main_remote, branch }) : [];
          // ...unless the owner already answered that by sending it back: then it is the agent's to fix, told which.
          if (blockers.length && process.env.CONVERGE_OWNER_SENT_BACK === '1') {
            failed.push(`Your change still makes ${blockers.length === 1 ? 'a check' : `${blockers.length} checks`} of earlier work on main fail, and the owner wants that work kept:\n${blockers.map((b) => `- "${b.task}": \`${b.check}\`\n  It printed: ${tail(b.output, 400)}`).join('\n')}`);
            continue;
          }
          if (blockers.length) return { owner: { why: `this change makes ${blockers.length === 1 ? 'a check' : `${blockers.length} checks`} of earlier work on main fail`, blockers } };
          failed.push(n);
        }
      }
      // Held for a reason none of the above put in words (converge's own list, status.held): said as it is, never waited on.
      if (!failed.length && st.held) failed.push(`It is held off the merge train: ${st.held}.`);
      if (failed.length) return { feedback: `converge checked your change and it cannot land yet.\n\n${failed.join('\n\n')}\n\nFix it in the work tree, then call done again. converge hands it in again itself.` };
      if (st.state === 'conflicted' || st.preview?.clean === false) break;
    }
    if (st.state !== 'conflicted' && st.preview?.clean !== false) { note('No verdict on its change after 15 minutes'); return {}; }
    // A conflict with what landed meanwhile: main merged into the work, by git. Clean: handed in again, here.
    try {
      execFileSync('git', [...mainAuth, '-C', repo, 'pull', '-q', '--no-rebase', '--no-edit', agent.main_remote, branch], { stdio: 'ignore', timeout: 120_000 });
      note('Its change met newer work on main: merged it in cleanly, handing in again');
      continue;
    } catch {
      const unmerged = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      if (!unmerged.length) { try { git(['merge', '--abort']); } catch { /* nothing to abort */ } note('Could not merge main into its change'); return {}; }
      return { feedback: `Other agents' work landed on main and conflicts with your change. converge merged main into your work tree: resolve the conflict markers in ${unmerged.join(', ')}, keeping both their work and yours, then call done.` };
    }
  }
  return {};
}

/** A stop that comes after the agent's change landed (the swarm ends a run whose task is on main) is not unfinished
 *  work: said as what it is, and nothing is committed or pushed. Anything else is saved (saveWork). */
async function saveUnlessLanded(a) {
  const st = a.reviewer ? {} : await Promise.race([mcp(a.agent, 'status').catch(() => ({})), new Promise((r) => setTimeout(() => r({}), 4000))]);
  if (st.state === 'landed' || st.state === 'superseded') return console.error(`${a.agent.agent_id}: stopped after its change ${st.state === 'landed' ? 'landed on main' : 'was superseded'}: nothing left to save`);
  saveWork(a);
}

/** Whatever a stopped worker changed, committed and pushed to its own fork (not handed in). */
function saveWork({ agent, joined, reviewer, repo }) {
  if (reviewer) return;
  try {
    if (execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
      execFileSync('git', ['-C', repo, 'add', '-A']);
      execFileSync('git', ['-C', repo, 'commit', '-q', '--no-verify', '-m', 'Work in progress: stopped before it was handed in'], { stdio: 'ignore' });
    }
    execFileSync('git', [...gitAuth(agent.token), '-C', repo, 'push', '-q', agent.remote, `HEAD:refs/heads/${joined.main_branch || 'main'}`], { stdio: 'ignore', timeout: 7000 });
    console.error(`${agent.agent_id}: ended unfinished; its work is saved on its fork (not handed in)`);
  } catch (e) { console.error(`${agent.agent_id}: ended unfinished; could not save its work: ${String(e.message || e).split('\n')[0].replace(/Authorization: Basic \S+/g, 'Authorization: Basic ***')}`); }
}

async function run() {
  const kind = opts.agent || 'claude';
  const p = encodeURIComponent(need('project'));
  const t = encodeURIComponent(need('task'));
  const reviewer = opts.role === 'reviewer';
  // --resumes N (default 2): how many times a stopped worker's command continues it as a new agent
  // that takes over its work (join with { from }), with a fresh cycle budget. A reviewer is never resumed.
  const maxResumes = opts.resumes === undefined ? 2 : Math.max(0, Number(opts.resumes) || 0);
  let resumesLeft = maxResumes;
  let fromAgent = opts.from;  // the predecessor to take over from, if any
  let prevDir = '';           // its run folder, when this command ran it
  let retryWhy = process.env.CONVERGE_RETRY_WHY || '';   // why the attempt before did not land (swarm.mjs retryWhy)
  let runIndex = 0;           // 0 = the first agent, 1.. = continuations
  while (true) {
  const joined = reviewer
    ? { agent: await call(`/api/projects/${p}/reviewers`, {}), main_branch: 'main' }
    : await call(`/api/projects/${p}/tasks/${t}/agents`, fromAgent ? { from: fromAgent } : {});
  const agent = { ...joined.agent, mcp_url: joined.agent.mcp_url.replace('//localhost', '//127.0.0.1') };
  if (runIndex > 0) console.error(`continuing ${fromAgent} as ${agent.agent_id} (${runIndex} of ${maxResumes}).

[1m${agent.agent_id}[0m takes over ${fromAgent}: ${joined.took_over_from ? "its key is revoked; the fork starts from its commits" : "its work"}.`);
  else if (joined.took_over_from) console.error(`taking over ${joined.took_over_from} (--from, a handover, not a resume).`);
  // A continuation gets a directory of its own: the stopped agent's clone (and its run's files) stay as they were.
  const baseDir = path.resolve(opts.dir || path.join(os.tmpdir(), 'converge-runs', `${need('project')}-${agent.agent_id}`));
  let dir = runIndex > 0 ? `${baseDir}-${runIndex}` : baseDir;
  // A folder an earlier agent already cloned into (a task the dashboard resumed starts again here) is never reused:
  // git will not clone into it, and that agent's files stay as they were. The next free one.
  for (let n = runIndex + 1; fs.existsSync(path.join(dir, 'repo')); n++) dir = `${baseDir}-${n}`;
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  // Which agent works in this folder, from its first moment: the dashboard finds its panel by it (agent-log.mjs) and
  // shows these lines while it gets ready, in plain words, instead of nothing until the agent's first step. A resume
  // carries on from the newest one with a clone beside it (swarm.mjs latestAgent).
  try { fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ agent_id: agent.agent_id, task: decodeURIComponent(t), project: need('project') })); } catch { /* a log without a name */ }
  const progress = (text) => { try { fs.appendFileSync(path.join(dir, 'universal-agent.log'), `[${new Date().toISOString()}] converge: ${text}\n`); } catch { /* the panel misses one line */ } console.error(`  ${text}`); };
  progress(joined.took_over_from ? `${agent.agent_id} takes over from ${joined.took_over_from}` : `${agent.agent_id} joins the task`);
  if (reviewer) {
    // A read-only clone of main, so the reviewer can check claims against the real repository.
    const mainToken = agent.main_token || agent.token;
    if (agent.main_remote && mainToken) { if (!cloneFromDisk(agent.main_local, agent.main_remote, repo)) execFileSync('git', [...gitAuth(mainToken), 'clone', '-q', agent.main_remote, repo], { stdio: 'inherit' }); }
    else fs.mkdirSync(repo, { recursive: true });
  } else {
    // The token is passed per command, never written into the clone: the work tree (and so the mind)
    // must not see a credential.
    progress('Getting its copy of the code');
    const cloneStart = Date.now();
    const fromDisk = cloneFromDisk(agent.local, agent.remote, repo);
    try { if (!fromDisk) execFileSync('git', [...gitAuth(agent.token), 'clone', '-q', agent.remote, repo], { stdio: ['ignore', 'inherit', 'pipe'] }); }
    catch (e) {
      progress(`Could not get its copy of the code: ${String(e.stderr || e.message).trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || 'git gave no reason'}`);
      throw e;
    }
    progress(`Got its copy of the code in ${Math.round((Date.now() - cloneStart) / 1000)}s${fromDisk ? ' (from this machine\'s own store, nothing downloaded)' : ''}`);
    execFileSync('git', ['-C', repo, 'config', 'user.name', `converge ${agent.agent_id}`]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', `${agent.agent_id}@converge.local`]);
    // Its own signing key, beside the clone (not in it): every commit it makes is signed (git's gpg.format=ssh), and
    // converge learns the public half, so what lands can be traced to this agent's key, not only to its name.
    const signing = makeSigningKey(path.join(dir, 'signing', 'id_ed25519'), `${agent.agent_id}@converge`);
    execFileSync('git', ['-C', repo, 'config', 'gpg.format', 'ssh']);
    execFileSync('git', ['-C', repo, 'config', 'user.signingkey', signing.file]);
    // this key, whatever signing program the machine's own git configuration names
    execFileSync('git', ['-C', repo, 'config', 'gpg.ssh.program', 'ssh-keygen']);
    // only when this git can sign (aios-git does; a host git needs ssh-keygen): otherwise every commit would fail
    const canSign = spawnSync('git', ['-C', repo, 'commit-tree', '-S', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'signing check'], { encoding: 'utf8' }).status === 0;
    if (canSign) {
      execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'true']);
      await mcp(agent, 'signing_key', { public_key: signing.publicLine })
        .then(() => progress(`Signs its commits with its own key (${signing.file}.pub)`))
        .catch((e) => progress(`Its signing key was not registered: ${e.message}`));
    } else progress('Its commits are not signed: this git cannot make SSH signatures (install ssh-keygen, or use converge\'s own git)');
    // The agent's own scratch folders (the universal agent keeps its code index in .agent/ and its run notes in .converge/) are
    // never part of a change: left in, they get committed and fall outside the agent's claim, which holds back
    // a change that otherwise passes.
    try { fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), `\n.agent/\n.converge/\n${GENERATED_IGNORE.join('\n')}\n`); } catch { /* the clone has no info dir */ }
    // A repository that has them committed (its owner's own agent notes): the agent's changes to them are not part of
    // its change either, so git is told not to see them.
    try {
      const tracked = execFileSync('git', ['-C', repo, 'ls-files', '--', '.agent', '.converge'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      for (let i = 0; i < tracked.length; i += 200) execFileSync('git', ['-C', repo, 'update-index', '--skip-worktree', '--', ...tracked.slice(i, i + 200)]);
    } catch { /* nothing tracked there */ }
  }
  // Taking over saved work: it starts from main as it is now, not as it was when that work began (main may have moved
  // under it, including the very fixtures its checks use). A conflict is left for the agent to resolve, and said.
  // The server merged the current main into a takeover's fork before it was cloned (git-host.mjs createFork): what it
  // said, in plain words, and to the agent only when it could not.
  let mainMerge = '';
  if (!reviewer && joined.took_over_from) {
    const branch = joined.main_branch || 'main';
    if (!joined.main_merge || joined.main_merge === 'merged') progress(`Its copy already has the latest ${branch} merged into the saved work`);
    else {
      progress(`The latest ${branch} was not merged in: ${joined.main_merge}. The agent is told to merge it and resolve that first`);
      mainMerge = `\n\nThe current ${branch} is not merged into your saved work yet: ${joined.main_merge}. Merge it and resolve that first: \`git pull --no-rebase main ${branch}\`, then commit and push.`;
    }
  }
  const status = await mcp(agent, 'status');
  console.error(`${agent.agent_id} (${kind}${opts.model ? ' ' + opts.model : ''}) on ${status.you.task?.task_id}: ${status.you.task?.title}`);
  console.error(`  workdir    ${repo}\n  transcript ${path.join(dir, 'transcript.jsonl')}`);
  const started = Date.now();
  let tasksForReview = [];
  if (reviewer) {
    try {
      const st = await fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/state`, { headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {} }).then((r) => r.json());
      tasksForReview = st.tasks || [];
    } catch { /* ids alone, then */ }
  }
  // The harness unless the run asked for aios (--in-aios) or replays a script (the scripted mind is an aios mind).
  const inAios = Boolean(opts.inAios || opts.script);
  // Lean (the default for a harness worker): converge commits, pushes, claims, submits and waits; the model codes.
  // CONVERGE_AGENT_HANDS_IN=1 keeps the agent doing all of that itself through converge's tools.
  const lean = !reviewer && !inAios && process.env.CONVERGE_AGENT_HANDS_IN !== '1';
  const prompt = reviewer ? reviewerPrompt(status.you, decodeURIComponent(t), tasksForReview) : lean ? leanPrompt(status.you, repo) : agentPrompt(status.you, joined.main_branch || 'main', inAios);
  // Taking over (a continuation, or --from): say why, and hand over what the agent before learned. Its saved
  // handover (notes, the files it read, its last steps: aios-runtime.mjs writeHandover) goes into its successor's
  // context, so the successor does not pay to read it all again.
  let handover = '';
  const before = fromAgent && !reviewer ? await predecessorHandover(p, fromAgent, prevDir) : null;
  if (before?.files) {
    // The harness: its memory, ledgers and conversation are put back in .converge/ and .agent/ before it starts.
    handover += `\n\nYou continue the work of ${fromAgent}, which stopped without finishing. Your work tree starts from its commits, and its memory, task ledger and notes (.converge/ and .agent/) are restored: check your ledger and memory for what it already found and did before reading code again.`;
  } else if (before) {
    handover += `\n\nYou continue the work of ${fromAgent}, which stopped after ${before.cycles} cycles without finishing. Your work tree starts from its commits. Its notes are in your notes and the files it read are in "open files", as they are now: do not read them again. Its last steps:\n${(before.steps || []).join('\n')}`;
  }
  if (fromAgent && !reviewer) {
    try {
      const st = await fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/state`, { headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {} }).then((r) => r.json());
      const prev = [...(st.changes || [])].reverse().find((c) => c.agent_id === fromAgent);
      if (prev) {
        const failed = [['tests', prev.verified], ['your reported test, re-run by converge', prev.claim_check], ['acceptance checks', prev.accepted], ['evidence', prev.evidence]]
          .filter(([, v]) => v && (v.exit_code !== 0 || v.timed_out)).map(([n, v]) => `${n} FAILED (exit ${v.exit_code}):\n${String(v.output_tail || '').slice(-1500)}`);
        const onlyReport = failed.length === 1 && prev.claim_check && (prev.claim_check.exit_code !== 0 || prev.claim_check.timed_out) &&
          (!prev.verified || prev.verified.exit_code === 0) && (!prev.accepted || prev.accepted.exit_code === 0) && (!prev.evidence || prev.evidence.exit_code === 0);
        if (onlyReport) failed.push(`Everything else passed: the code is fine. Only its test REPORT did not reproduce. Do not change code: submit again with a tests.command that works on a clean checkout (including its build steps), or with no tests at all.`);
        handover += `\n\nYou are taking over from ${fromAgent}. Your fork starts from its commits (its change ${prev.change_id} was ${prev.state}). ${failed.length ? `It did not pass converge's checks:\n${failed.join('\n')}\nFix that.` : 'It did not finish.'} ${lean ? 'Its work is in your work tree: fix what failed, or finish it, then call done (converge hands it in).' : 'You now own a change at its last commit: fix what failed and commit, or if nothing failed, check and submit.'}`;
      }
    } catch { /* the prompt still says what the task is */ }
  }
  // Why the attempt before this one did not land: from the swarm (the owner's answer to an escalation, and what that
  // agent was last told), or from this command's own previous agent. Without it a retry started blind and repeated it.
  // It opens the agent's first message, ahead of the task's long instructions: at the end of them, an agent the owner
  // sent back (its change breaks an earlier task's check, and the owner chose to keep that check) missed it and made
  // the same change again.
  const retryFirst = retryWhy && !reviewer ? `Read this first. Why the attempt before yours did not land, and what to do differently:\n${retryWhy}\n\n` : '';
  let testCommand = '';
  try {
    const st = await fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/state`, { headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {} });
    testCommand = (await st.json()).project?.test_command || '';
  } catch { /* no project test command: git and read-only tools only */ }
  const acceptChecks = status.you?.task?.acceptance_checks || [];
  // Claimed before the first edit, like every other worker: a lean worker's task names its files, so its peers see
  // them held while it works. One that took over holds its predecessor's claim already.
  const ahead = lean && !status.you?.claim?.length ? await claimAhead(agent, ownTask(status.you?.task), repo) : '';
  let res;
  const task = retryFirst + prompt + ahead + handover + mainMerge + (opts.brief ? `\n\nFrom the operator: ${opts.brief}` : '');
  if (!inAios) {
    // The harness: its own loop, memory and ledgers, fenced; aios does not decide or record its actions (--in-aios does).
    console.error(`${agent.agent_id}: runs on the harness (agents/universal); --in-aios runs it as an aios entity instead`);
    res = await runUniversal({ agent, joined, reviewer, repo, dir, task, kind, testCommand, acceptChecks, handover: before?.files ? before : null, saveHandover: handoverSaver(p, agent), lean, taskInfo: ownTask(status.you?.task) });
  } else {
    res = await runAios({ agent, joined, reviewer, repo, dir, task, kind, testCommand, acceptChecks, p, handover: before });
  }
  const after = await mcp(agent, 'status');
  // Done means done by converge's measure: a worker that said done with checks outstanding (aios lets it after three
  // refusals) ended failed, with the reason, and is continued like a stopped one while resumes are left.
  let outcome = runOutcome({ finished: res.finished, state: after.state, role: reviewer ? 'reviewer' : 'worker' });
  // Waiting on the owner (an earlier check this change breaks): said as that, not as done or stopped.
  try { const o = JSON.parse(fs.readFileSync(path.join(dir, 'needs-owner.json'), 'utf8')); outcome = { done: false, reason: `waiting for you: ${o.why}` }; } catch { /* not waiting */ }
  // An agent that said why it cannot finish (blocked) is recorded with its reason, not as "stopped before it finished".
  const blocked = outcome.done ? '' : blockedReason(path.join(dir, 'state'));
  if (blocked) outcome = { done: false, reason: `blocked: ${blocked}` };
  const summary = {
    agent_id: agent.agent_id, agent: kind, model: opts.model || '', aios_entity: res.entity, cycles: res.cycles, finished: outcome.done, outcome: outcome.reason,
    outstanding: res.finished?.outstanding || [],
    refused: (res.ledger || []).filter((e) => e.kind === 'REFUSED').map((e) => e.note), exercised: (res.ledger || []).filter((e) => e.kind === 'exercised').length, alerts: res.alerts, minutes: +((Date.now() - started) / 60000).toFixed(1),
    change_id: after.change_id, state: after.state, verified: after.verified, claim_check: after.claim_check, notices: after.notices, workdir: repo,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(summary, null, 2));
  if (opts.json) console.log(JSON.stringify(summary));
  else console.log(`${agent.agent_id}: ${outcome.done ? 'done' : /^(failed|blocked)/.test(outcome.reason) ? outcome.reason : 'stopped'}${res.entity ? ` after ${res.cycles} cycles (aios entity ${res.entity.slice(0, 12)}, ${summary.exercised} actions, ${summary.refused.length} refused)` : ` (universal agent, exit ${res.exit})`}, change ${after.change_id || 'none'} ${after.state}; ${verifiedLine(after.verified)}`);
  // A stopped worker whose change has not landed is continued as a new agent (join with { from }),
  // with a fresh cycle budget, up to --resumes times. A reviewer is never resumed; nothing to do when
  // the change landed or was superseded, or when the resumes are spent.
  // An agent that says the task cannot be done as asked (blocked, with its reason) goes to the owner, not to a new agent
  // that inherits the same conversation and says the same thing (a misplanned task blocked three times over).
  if (blocked && !reviewer && after.state !== 'landed' && !fs.existsSync(path.join(dir, 'needs-owner.json'))) {
    fs.writeFileSync(path.join(dir, 'needs-owner.json'), JSON.stringify({ why: `its agent says it cannot be done as asked: ${blocked.slice(0, 600)}`, blockers: [] }, null, 1));
  }
  if (!reviewer && after.state !== 'landed' && fs.existsSync(path.join(dir, 'needs-owner.json'))) { process.exitCode = 1; break; }
  if (!shouldResume({ finished: outcome.done, state: after.state, resumesLeft, role: reviewer ? 'reviewer' : 'worker' })) {
    if (!outcome.done && !reviewer) process.exitCode = 1;
    break;
  }
  resumesLeft--;
  {
    let fb = '';
    try { fb = fs.readFileSync(path.join(dir, 'last-feedback.txt'), 'utf8').trim(); } catch { /* none sent */ }
    retryWhy = [`${agent.agent_id} ended: ${outcome.reason}.`, (after.notices || []).length ? `converge's notices on its change: ${after.notices.join(' | ').slice(0, 1500)}` : '', fb ? `What converge last told it:\n${fb.slice(-3000)}` : ''].filter(Boolean).join('\n');
  }
  fromAgent = agent.agent_id;
  prevDir = dir;
  runIndex++;
  }
}

export { run };
