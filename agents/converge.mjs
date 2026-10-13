#!/usr/bin/env node
// converge CLI: create projects and tasks, join a task as a new agent, add a reviewer.
// Talks only to the platform API (the Worker, or `npm run dev` locally). It never makes up
// credentials: every id, remote and key it prints came back from the server.
//
//   node agents/converge.mjs project  --project aios [--import <git url>]
//   node agents/converge.mjs replay   --project aios --agent A [--cycle N]   one line per cycle of that agent's acts:
//                                      cycle, verdict, action, target (with --cycle N also its reply, observation and
//                                      the files it changed)
//   node agents/converge.mjs rewind   --project aios --agent A --cycle N   ask that agent to rewind to the start of cycle N
//   node agents/converge.mjs rewind   --project aios --to <commit>         rewind main to an earlier first-parent commit
//   node agents/converge.mjs oplog    --project aios                      the operations an undo can take back (landings,
//                                      rewinds, undos, configurations), newest first, with their seq
//   node agents/converge.mjs undo     --project aios [--seq N]            take back one operation (default: the latest not
//                                      already undone), keeping everything after it; a landing is reversed by a signed commit
//   node agents/converge.mjs redo     --project aios                      take back the latest undo
//   node agents/converge.mjs state    --project aios [--at <seq>]         counts by change state and the main head
//   node agents/converge.mjs task     --project aios --title "..." [--description "..."] [--mode split|compete] [--agents N]
//                                      [--accept "<check command>"]...   the definition of done: converge runs each on every
//                                      submitted commit (jailed); a change lands only when all exit 0
//   node agents/converge.mjs join     --project aios --task t-1234abcd [--from a-stalled]   (--from: take over its work)
//   node agents/converge.mjs reviewer --project aios
//   node agents/converge.mjs clone    --project aios [--dir D]          clone the project's main (what the agents built)
//   node agents/converge.mjs seed     --project aios --dir D             bring D's HEAD in as the project's first change (a local or
//                                      private repository: only this push reaches the platform)
//   node agents/converge.mjs config   --project aios [--test-command "..."] [--timeout 1800] [--check-claims true|false] [--auto-land true|false]
//                                      [--tracks off|auto|backend/,frontend/]  merge trains on independent tracks: verified and
//                                      landed side by side when their changes touch no file in common (auto) or lie under
//                                      different ones of these prefixes
//                                      [--leases advisory|exclusive]   exclusive: a claim that collides with another is refused,
//                                      and a push that changes what its agent has not claimed is refused (or set aside)
//                                      [--signing optional|required]   required: an agent's pushed head must carry its own SSH
//                                      signature (git gpg.format=ssh; agents run here get a key), or the push is refused
//                                      [--targets release/1.x,release/2.x]   release branches changes can land on after main
//                                      (submit's targets), each verified there and sealed in that branch's own receipt chain
//   node agents/converge.mjs verify   --repo <clone of main> [--project aios | --key <hex>] [--target release/1.x]
//                                      check the signed landing receipts (--target: a release branch's own chain, on its
//                                      checked-out HEAD), each agent's signature on the head it landed, and (with --project)
//                                      that every receipt is in the engine's transparency log under a tree head it signed
//   node agents/converge.mjs witness  --project aios [--state file] [--key <hex>]   remember the log's signed tree head and
//                                      prove each later one extends it (run it from somewhere converge does not control)
//   node agents/converge.mjs status   --project aios [--json]   one screen of the project state: main head, receipts,
//                                      agents (with their aios actions/refused) and changes (state, verified, acceptance)
//   node agents/converge.mjs run      --project aios --task t-1234abcd [--agent claude|codex|gemini] [--model haiku] [--from a-stalled] [--max-cycles 60] [--script actions.jsonl] [--effort off] [--brief "what the operator needs you to know"]
//        joins the task as a new agent, clones its fork, and runs it as an aios entity: the model is bound as the
//        entity's mind and every action it takes is checked against its aios capabilities and recorded in the aios
//        ledger (agents/aios-runtime.mjs). transcript.jsonl, ledger.json and result.json land next to the clone.
//        Every --agent is an aios entity: the mind is the universal agent's model layer (agents/universal/bridge.cjs), aios's API mind, or
//        --script; each cycle is recorded (cycle.record) and the agent can be rewound (converge rewind --agent).
//        --outside-aios: the universal agent's own loop instead (a machine with no aios): not decided, recorded or rewindable.
//        --role reviewer: a reviewer for that task (no fork; reviews with contenders/diff/pick, lands or holds)
//
// Common: --api <url> (env CONVERGE_API_URL, default http://127.0.0.1:8787), --admin-key (env ADMIN_KEY), --json

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_IDENT, kernelOnPath } from './common.mjs';
kernelOnPath();   // the CLI's own git (clone, push, sync) is aios-git
import { connectLines, cloneCommand } from '../worker/connect.mjs';
import { cmd, opts, fail, call, need, mcp, gitAuth } from './cli-common.mjs';
import { run } from './run.mjs';
import { splitSignature, sshsigVerify, canonicalKey, leafHash, verifyInclusion, verifyConsistency, checkTreeHead } from './transparency.mjs';

/** "SHA256:..." as OpenSSH prints a key's fingerprint. */
const keyFingerprint = (line) => `SHA256:${crypto.createHash('sha256').update(Buffer.from(String(line).split(' ')[1] || '', 'base64')).digest('base64').replace(/=+$/, '')}`;

/** A view-key read of a project route (GET, X-View-Key from the environment). */
async function viewGet(p, sub) {
  let res;
  try {
    res = await fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/${sub}`, { headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {} });
  } catch (err) {
    fail(`cannot reach ${opts.api} (${err.cause?.code || err.message}). Start it with \`npm run dev\` or pass --api.`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { fail(`${sub}: HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) fail(`${sub}: ${data.error || `HTTP ${res.status}`}`);
  return data;
}

/** Read a project's state (GET, X-View-Key from the environment); with `at`, the state folded to seq. */
async function readState(p, at) {
  let res;
  try {
    const tail = at !== undefined && at !== '' ? `state?at=${encodeURIComponent(at)}` : 'state';
    res = await fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/${tail}`, {
      headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {},
    });
  } catch (err) {
    fail(`cannot reach ${opts.api} (${err.cause?.code || err.message}). Start it with \`npm run dev\` or pass --api.`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { fail(`state: HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) fail(`state: ${data.error || `HTTP ${res.status}`}`);
  return data;
}

function printAgent(a, taskId, branch) {
  // The server's own lines when it sent them; the same function makes them here for an older server.
  const lines = a.connect || connectLines(a.agent_id, a.mcp_url, a.mcp_key);
  console.log(`\n\x1b[1m${a.agent_id}\x1b[0m (${a.role}${taskId ? `, task ${taskId}` : ''})`);
  if (a.remote) {
    console.log(`  fork        ${a.remote}`);
    console.log(`  token       ${a.token || '(none needed)'}`);
    console.log(`  clone       ${cloneCommand(a.remote, a.token, a.agent_id)}`);
    console.log(`  work        cd ${a.agent_id} && <edit> && git commit -am <message> && git push origin HEAD:${branch || 'main'}`);
  }
  console.log(`  mcp         ${a.mcp_url}`);
  console.log(`  key         ${a.mcp_key}`);
  console.log(`  claude code ${lines.claude_code}`);
  console.log(`  gemini      ${lines.gemini}`);
}

/**
 * `--import <directory>`: snapshot the working tree as it is, uncommitted work included, honouring
 * .gitignore, into a throwaway repository the platform can clone. The source repository is not touched.
 */
function snapshotWorkingTree(dir) {
  const isLocalApi = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(opts.api);
  if (!isLocalApi) fail('a local directory can only be imported into a local platform (npm run dev); for Cloudflare pass an HTTPS git URL');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let files;
  try {
    files = git(dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter((f) => f && fs.existsSync(path.join(dir, f)));
  } catch {
    fail(`${dir} is not a git working tree`);
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-import-'));
  for (const f of files) {
    const src = path.join(dir, f);
    const st = fs.lstatSync(src);
    if (st.isDirectory()) continue; // a submodule or nested repo: not part of this tree
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(src, path.join(out, f));
    fs.chmodSync(path.join(out, f), st.mode);
  }
  git(out, 'init', '-q', '-b', 'main');
  git(out, 'add', '-A');
  execFileSync('git', ['commit', '-qm', `import of ${dir} (working tree)`], { cwd: out, env: { ...process.env, ...GIT_IDENT } });
  console.error(`snapshot of ${dir}: ${files.length} files (uncommitted work included)`);
  return out;
}

/**
 * Check a repository's landing receipts (see converge-engine/src/receipt.hpp) from git alone: every commit on
 * main's first-parent line since sealing began must carry a receipt, signed by the engine's key,
 * naming that commit, in an unbroken chain (seq 1, 2, 3... each naming the previous receipt's hash).
 * `target`: a release branch's chain instead (its receipts name it); receipts of main's chain the branch inherited
 * (from before it was cut) are counted apart. `project`: its chain begins at the first receipt naming it; receipts
 * before that name another project, or none (a template or an import it started from), and are counted apart too.
 */
function verifyReceipts(repo, keyHex, target = '', project = '') {
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { g('fetch', '-q', 'origin', '+refs/notes/converge:refs/notes/converge'); } catch { /* local repo, or notes already present */ }
  const spki = (hex) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
  const commits = g('rev-list', '--first-parent', 'HEAD').trim().split('\n').reverse();
  const problems = [];
  const sealed = [];
  let unsealed = 0, inherited = 0, imported = 0;
  for (const c of commits) {
    let note = null;
    try { note = JSON.parse(g('notes', '--ref=converge', 'show', c)); } catch { /* no note */ }
    if (!note?.receipt) {
      if (sealed.length) problems.push(`${c.slice(0, 12)} is on ${target || 'main'} after sealing began but has no receipt: it did not land through converge`);
      else unsealed++;
      continue;
    }
    const r = JSON.parse(note.receipt);
    if (project && !sealed.length && r.project !== project) { imported++; continue; }   // the history it started from
    if ((r.target || '') !== target) { inherited++; continue; }   // another chain's (main's, before the branch was cut)
    const key = keyHex || note.key;
    if (keyHex && note.key !== keyHex) problems.push(`${c.slice(0, 12)}: signed by ${String(note.key).slice(0, 16)}..., not the engine key`);
    let ok = false;
    try { ok = crypto.verify(null, Buffer.from(note.receipt), spki(key), Buffer.from(note.signature, 'hex')); } catch { /* malformed */ }
    if (!ok) problems.push(`${c.slice(0, 12)}: receipt signature does not verify`);
    if (r.commit !== c) problems.push(`${c.slice(0, 12)}: receipt names commit ${String(r.commit).slice(0, 12)}`);
    const prev = sealed[sealed.length - 1];
    const prevHash = prev ? crypto.createHash('sha256').update(prev.raw).digest('hex') : '';
    if (r.seq !== sealed.length + 1) problems.push(`${c.slice(0, 12)}: receipt seq ${r.seq}, expected ${sealed.length + 1} (a landing is missing or reordered)`);
    if (r.prev !== prevHash) problems.push(`${c.slice(0, 12)}: receipt does not chain to the previous one`);
    // the agent's own signature on what landed: its head commit, signed with the key the receipt names
    let signedBy = '';
    if (r.signer) {
      let object = null;
      try { object = g('cat-file', 'commit', r.head_commit); } catch { /* not in this repository */ }
      if (object === null) problems.push(`${c.slice(0, 12)}: the receipt names a signer, but the signed head ${String(r.head_commit).slice(0, 12)} is not in this repository`);
      else {
        const { payload, signature } = splitSignature(object);
        const v = signature ? sshsigVerify(signature, payload) : { ok: false, problem: 'it carries no signature' };
        if (!v.ok) problems.push(`${c.slice(0, 12)}: ${r.agent}'s head ${String(r.head_commit).slice(0, 12)}: ${v.problem}`);
        else if (v.key !== canonicalKey(r.signer)) problems.push(`${c.slice(0, 12)}: ${r.agent}'s head is signed by another key than the receipt names`);
        else signedBy = v.key;
      }
    }
    sealed.push({ commit: c, raw: note.receipt, r, signedBy });
  }
  return { commits: commits.length, unsealed, inherited, imported, sealed, problems };
}

async function status() {
  const p = encodeURIComponent(need('project'));
  const res = await fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${p}/state`, { headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {} });
  const text = await res.text();
  let st;
  try { st = JSON.parse(text); } catch { fail(`status: HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) fail(`status: ${st.error || `HTTP ${res.status}`}`);
  if (opts.json) return console.log(JSON.stringify(st, null, 2));
  const proj = st.project || {};
  console.log(`project ${proj.name || '?'}  main ${String(proj.main_head || '').slice(0, 12)}  receipts ${proj.receipts || 0}`);
  for (const a of st.agents || []) {
    const aios = a.aios ? `  aios actions=${a.aios.actions} refused=${a.aios.refused}` : '';
    console.log(`agent ${a.agent_id} (${a.role})${aios}`);
  }
  for (const c of st.changes || []) {
    const v = c.verified ? (c.verified.exit_code === 0 && !c.verified.timed_out ? 'pass' : 'fail') : 'pending';
    console.log(`change ${c.change_id} by ${c.agent_id} ${c.state}  verified=${v}  acceptance=${c.acceptance}`);
  }
}

async function main() {
  if (cmd === 'run') return run();
  if (cmd === 'status') return status();
  if (cmd === 'replay') {
    const p = encodeURIComponent(need('project'));
    const a = encodeURIComponent(need('agent'));
    // Full cycles come from the log (the snapshot keeps only a short window without reply and result).
    const acts = (await viewGet(p, `agents/${a}/cycles`)).cycles || [];
    const picked = opts.cycle ? acts.filter((x) => Number(x.cycle) === Number(opts.cycle)) : acts;
    if (opts.cycle && !picked.length) fail(`cycle ${opts.cycle} not found for agent ${opts.agent}`);
    if (!acts.length) console.log(`no cycles recorded for ${opts.agent}`);
    for (const act of picked) {
      const c = Number(act.cycle);
      console.log(`#${c}  ${act.verdict || '?'}  ${act.action || '?'} ${act.target || ''}`);
      if (!opts.cycle) continue;
      const indent = (t) => String(t).replace(/\n/g, '\n    ');
      console.log(`  reply\n    ${indent(act.reply || '(none)')}\n  result\n    ${indent(act.observation || '(none)')}`);
      const d = await viewGet(p, `agents/${a}/cycles/diff?from=${c - 1}&to=${c}`);
      console.log(`  files changed${d.diff ? `\n${String(d.diff).replace(/^/gm, '    ')}` : ': none'}`);
    }
    return;
  }
  if (cmd === 'rewind') {
    const p = encodeURIComponent(need('project'));
    if (opts.to) {
      const r = await call(`/api/projects/${p}/rewind`, { commit: opts.to });
      return opts.json ? console.log(JSON.stringify(r)) : console.log(`rewind main to ${String(opts.to).slice(0, 12)} requested`);
    }
    const a = encodeURIComponent(need('agent'));
    const r = await call(`/api/projects/${p}/agents/${a}/rewind`, { cycle: Number(need('cycle')) });
    return opts.json ? console.log(JSON.stringify(r)) : console.log(`rewind of ${opts.agent} to cycle ${opts.cycle} requested`);
  }
  if (cmd === 'oplog' || cmd === 'undo' || cmd === 'redo') {
    const p = encodeURIComponent(need('project'));
    const st = await readState(p);
    const OPS = new Set(['Landed', 'MainRewound', 'Undone', 'ProjectConfigured']);
    const ops = (st.recent || []).filter((e) => OPS.has(e.type)).sort((a, b) => b.seq - a.seq);
    // what is taken back now: newest first, an undo that was itself undone takes nothing back
    const undone = new Set();
    for (const e of ops) if (e.type === 'Undone' && !undone.has(e.seq)) undone.add(e.target_seq);
    const describe = (e) => e.type === 'Landed' ? `landing of ${e.change_id} (${String(e.commit).slice(0, 8)})` : e.type === 'MainRewound' ? `rewind of main to ${String(e.to_commit).slice(0, 8)}`
      : e.type === 'Undone' ? `undo of #${e.target_seq}: ${e.what}` : `configuration ${JSON.stringify({ test_command: e.test_command.length > 60 ? e.test_command.slice(0, 57) + '...' : e.test_command, auto_land: e.auto_land })}`;
    if (cmd === 'oplog') {
      for (const e of ops) console.log(`#${e.seq}  ${new Date(e.at).toISOString()}  ${describe(e)}${undone.has(e.seq) ? '  (undone)' : ''}`);
      return;
    }
    let seq = opts.seq ? Number(opts.seq) : 0;
    if (!seq && cmd === 'undo') {
      // the latest operation not taken back already, as aios-git's undo walks: an undo cancels what it undid
      const skip = new Set();
      for (const e of ops) {
        if (skip.has(e.seq)) continue;
        if (e.type === 'Undone') { skip.add(e.target_seq); continue; }
        seq = e.seq;
        break;
      }
    }
    if (!seq && cmd === 'redo') {
      const skip = new Set();
      for (const e of ops) {
        if (skip.has(e.seq)) continue;
        if (e.type !== 'Undone') break;   // an operation after the undos: nothing to redo
        const t = ops.find((x) => x.seq === e.target_seq);
        if (t && t.type === 'Undone') { skip.add(e.target_seq); continue; }   // that undo was itself undone
        seq = e.seq;
        break;
      }
    }
    if (!seq) fail(cmd === 'redo' ? 'nothing to redo: the last operation was not an undo' : 'nothing to undo');
    const r = await call(`/api/projects/${p}/undo`, { seq });
    return opts.json ? console.log(JSON.stringify(r)) : console.log(`${cmd === 'redo' ? 'redid' : 'undid'} #${seq}: ${r.undid || ''}${r.commit ? ` (main ${String(r.commit).slice(0, 12)})` : ''}`);
  }
  if (cmd === 'state') {
    const p = encodeURIComponent(need('project'));
    const st = await readState(p, opts.at);
    const counts = {};
    for (const c of st.changes || []) counts[c.state] = (counts[c.state] || 0) + 1;
    if (opts.json) return console.log(JSON.stringify(st, null, 2));
    for (const [k, v] of Object.entries(counts).sort()) console.log(`change ${k} ${v}`);
    console.log(`main head ${String(st.project?.main_head || '').slice(0, 12)}${opts.at ? `  at ${opts.at}` : ''}`);
    return;
  }
  if (cmd === 'verify') {
    const repo = path.resolve(need('repo'));
    let key = opts.key || '';
    if (!key && opts.project) {
      const st = await fetch(`${opts.api.replace(/\/$/, '')}/api/projects/${encodeURIComponent(opts.project)}/state`, { headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {} }).then((r) => r.json());
      key = st.project?.receipt_key || '';
    }
    const target = opts.target || '';
    const v = verifyReceipts(repo, key, target, opts.project || '');
    // With the project: every receipt must also be in the engine's transparency log, under a tree head its key signed.
    let logged = null;
    if (opts.project && v.sealed.length) {
      try {
        const base = `${opts.api.replace(/\/$/, '')}/api/projects/${encodeURIComponent(opts.project)}/log`;
        const get = (u) => fetch(u, { headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {} }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; });
        const th = checkTreeHead(await get(base), key);
        logged = { size: th.size, root: th.root, included: 0 };
        for (const x of v.sealed) {
          const pr = await get(`${base}/inclusion?commit=${x.commit}&size=${th.size}`).catch((e) => ({ error: e.message }));
          if (pr.error) { v.problems.push(`${x.commit.slice(0, 12)}: not in the transparency log (${pr.error})`); continue; }
          if (!verifyInclusion(leafHash(x.raw), pr.index, th.size, pr.proof, th.root)) v.problems.push(`${x.commit.slice(0, 12)}: its receipt's inclusion proof does not verify against the signed tree head`);
          else logged.included++;
        }
      } catch (e) { v.problems.push(`transparency log: ${e.message}`); }
    }
    if (opts.json) return console.log(JSON.stringify({ ...v, sealed: v.sealed.map((x) => x.r), logged }));
    console.log(`${v.commits} commits on ${target || 'main'}: ${v.unsealed} from before sealing, ${v.imported ? `${v.imported} sealed by the history it started from (not checked), ` : ''}${v.sealed.length} sealed${target ? `, ${v.inherited} with main's receipts (from before the branch was cut)` : ''}${key ? ` (key ${key.slice(0, 16)}...)` : ' (key taken from each note: pass --key or --project to pin it)'}`);
    for (const x of v.sealed) console.log(`  #${x.r.seq} ${x.commit.slice(0, 12)} ${x.r.change_id} ${x.r.agent ? `by ${x.r.agent} (${x.r.decided_by})` : `by ${x.r.decided_by}`} verified=${x.r.verified ? x.r.verified.exit_code : 'none'} evidence=${x.r.evidence_held}${x.signedBy ? ` signed=${keyFingerprint(x.signedBy)}` : ''}`);
    if (logged) console.log(`transparency log: ${logged.included} of ${v.sealed.length} receipts proven in the tree of ${logged.size} (root ${logged.root.slice(0, 16)}...)`);
    for (const p of v.problems) console.log(`  PROBLEM ${p}`);
    if (v.problems.length) process.exit(2);
    return console.log('receipt chain intact');
  }
  if (cmd === 'witness') {
    // Keep the engine honest from outside: remember its signed tree head, and each time demand proof that the new
    // tree extends the one remembered. A rewritten or dropped receipt cannot pass this, whoever holds the engine's key.
    const project = need('project');
    const base = `${opts.api.replace(/\/$/, '')}/api/projects/${encodeURIComponent(project)}/log`;
    const get = (u) => fetch(u, { headers: process.env.VIEW_KEY ? { 'X-View-Key': process.env.VIEW_KEY } : {} }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; });
    const file = path.resolve(opts.state || path.join(os.homedir(), '.converge', 'witness', `${new URL(opts.api).host.replace(/[^A-Za-z0-9.-]/g, '_')}-${project}.json`));
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first look */ }
    const sth = await get(base);
    const th = checkTreeHead(sth, opts.key || saved?.key || '');
    if (saved) {
      if (th.size < saved.size) fail(`the log shrank: ${saved.size} receipts when last seen, ${th.size} now. It was rewritten.`);
      if (th.size === saved.size && th.root !== saved.root) fail(`the log was rewritten: the same ${th.size} receipts now have root ${th.root.slice(0, 16)}..., not ${saved.root.slice(0, 16)}...`);
      if (th.size > saved.size) {
        const pr = await get(`${base}/consistency?from=${saved.size}&size=${th.size}`);
        if (!verifyConsistency(saved.size, th.size, saved.root, th.root, pr.proof)) fail(`the log of ${th.size} receipts does not extend the ${saved.size} seen before (consistency proof fails): history was rewritten.`);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ size: th.size, root: th.root, at_ms: th.at_ms, key: sth.key, tree_head: sth.tree_head, signature: sth.signature }, null, 2) + '\n');
    return console.log(saved ? `${project}: ${th.size} receipts (${th.size - saved.size} new), consistent with the ${saved.size} seen before; root ${th.root.slice(0, 16)}...`
      : `${project}: ${th.size} receipts, root ${th.root.slice(0, 16)}...; remembered in ${file}`);
  }
  if (cmd === 'project') {
    let importUrl = opts.import;
    if (importUrl && fs.existsSync(importUrl) && fs.statSync(importUrl).isDirectory()) importUrl = snapshotWorkingTree(path.resolve(importUrl));
    const body = { name: need('project'), ...(importUrl ? { import_url: importUrl } : {}), ...(opts.testCommand !== undefined ? { test_command: opts.testCommand, test_timeout_s: Number(opts.timeout) || 900 } : {}) };
    // Idempotent: on an existing project the server applies the settings given (so `seed` may come first).
    const r = await call('/api/projects', body);
    if (opts.json) return console.log(JSON.stringify(r));
    return console.log(r.existed ? `project ${r.project} already exists${r.configured ? `: settings applied ${JSON.stringify(r.configured)}` : ''}` : `project ${r.project}: main ${r.main_remote ?? ''} (${r.main_branch ?? 'main'})`);
  }
  if (cmd === 'task') {
    const p = encodeURIComponent(need('project'));
    const r = await call(`/api/projects/${p}/tasks`, { title: need('title'), description: opts.description || '', mode: opts.mode === 'compete' ? 'compete' : 'split', agents: opts.agents === undefined ? 1 : Number(opts.agents), accept: opts.accept || [] });
    if (opts.json) return console.log(JSON.stringify(r));
    console.log(`task ${r.task_id} (${opts.mode}) with ${r.agents.length} agent(s)`);
    for (const a of r.agents) printAgent(a, r.task_id, r.main_branch);
    return;
  }
  if (cmd === 'warm') {
    // Start every runner container of the project now, so the first checks of a run do not wait on cold starts.
    const r = await call(`/api/projects/${encodeURIComponent(need('project'))}/warm`, {});
    return console.log(`${need('project')}: ${r.warm} of ${r.of} runners warm`);
  }
  if (cmd === 'seed') {
    // Bring a codebase in from this machine (a private or local repository: nothing needs to reach
    // it but this push): a seed task, one agent on it, the directory's HEAD pushed to that agent's
    // fork, then submitted. It lands on the project's empty main through converge's own path.
    const p = encodeURIComponent(need('project'));
    const dir = path.resolve(opts.dir || '.');
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // The project is made here if it does not exist yet (creating is idempotent), so `seed` then `project` works.
    const made = await call('/api/projects', { name: need('project') });
    if (!made.existed) console.log(`created project ${made.project}`);
    const task = await call(`/api/projects/${p}/tasks`, { title: `Seed: ${path.basename(dir)} at ${head.slice(0, 12)}`, description: 'The codebase converge starts from.', mode: 'split', agents: 0, accept: [] });
    const joined = await call(`/api/projects/${p}/tasks/${encodeURIComponent(task.task_id)}/agents`, {});
    const agent = { ...joined.agent, mcp_url: joined.agent.mcp_url.replace('//localhost', '//127.0.0.1') };
    // A new project's main already has a first commit (its README), and the codebase's history does
    // not share it: pushed as it is, the two READMEs conflict. So the seed is the codebase on top of
    // main, with the codebase's own history as its second parent (nothing of it is lost).
    const branch = joined.main_branch || 'main';
    execFileSync('git', [...gitAuth(agent.token), '-C', dir, 'fetch', '-q', agent.remote, branch], { stdio: 'inherit' });
    const base = execFileSync('git', ['-C', dir, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).trim();
    const who = GIT_IDENT;
    // The tree is the codebase laid over main: main's own files the codebase does not have (the new
    // project's README) stay, since removing documentation without evidence holds a change back.
    const index = path.join(os.tmpdir(), `converge-seed-${process.pid}.index`);
    const ix = { ...process.env, GIT_INDEX_FILE: index };
    let tree;
    try {
      execFileSync('git', ['-C', dir, 'read-tree', base], { env: ix });
      const entries = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--full-tree', head], { encoding: 'utf8', env: ix, maxBuffer: 1 << 30 });
      execFileSync('git', ['-C', dir, 'update-index', '--add', '--index-info'], { input: entries, env: ix, maxBuffer: 1 << 30 });
      tree = execFileSync('git', ['-C', dir, 'write-tree'], { encoding: 'utf8', env: ix }).trim();
    } finally { fs.rmSync(index, { force: true }); }
    const seed = execFileSync('git', ['-C', dir, 'commit-tree', tree, '-p', base, '-p', head, '-m', `Seed: ${path.basename(dir)} at ${head.slice(0, 12)}`], { encoding: 'utf8', env: { ...process.env, ...who } }).trim();
    execFileSync('git', [...gitAuth(agent.token), '-C', dir, 'push', '-q', '--force', agent.remote, `${seed}:refs/heads/${branch}`], { stdio: 'inherit' });
    // The platform sees the push when it next looks at the fork (status or submit look).
    let st = {};
    for (let i = 0; i < 30 && st.head_commit !== seed; i++) {
      st = await mcp(agent, 'status');
      if (st.head_commit !== seed) await new Promise((r) => setTimeout(r, 2000));
    }
    if (st.head_commit !== seed) fail(`the platform did not see the push of ${seed} to ${agent.agent_id}'s fork`);
    // The seed brings the whole tree: claim every top-level entry, the codebase's and main's (what it
    // replaces, e.g. the new project's README when the codebase has none), so none of it is out of scope.
    const entries = [head, base].flatMap((c) => execFileSync('git', ['-C', dir, 'ls-tree', c], { encoding: 'utf8' }).split('\n').filter(Boolean))
      .map((l) => { const [meta, name] = l.split('\t'); return meta.split(/\s+/)[1] === 'tree' ? `${name}/` : name; });
    await mcp(agent, 'claim', { paths: [...new Set(entries)], summary: 'the whole codebase, as it comes in' });
    // Where the codebase's own documentation replaces main's (its README over the new project's),
    // main's lines go: a change deleting documentation lands only with a claim backing it, one per
    // file, so each such file gets one citing the codebase's text that replaces it.
    const prose = (f) => /\.(md|markdown|txt|rst|adoc)$/.test(f) || f.startsWith('docs/');
    const claims = execFileSync('git', ['-C', dir, 'diff', '--numstat', '--no-renames', base, seed], { encoding: 'utf8', maxBuffer: 1 << 30 })
      .split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, del, f]) => del !== '-' && Number(del) > 0 && prose(f))
      .map(([, , f]) => {
        const text = execFileSync('git', ['-C', dir, 'show', `${seed}:${f}`], { encoding: 'utf8', maxBuffer: 1 << 30 });
        const excerpt = text.split('\n').map((l) => l.trim()).find((l) => l.replace(/\s/g, '').length >= 16);
        const statement = `${f} is the codebase's own ${f}, replacing main's`;
        return excerpt ? { statement, file: f, excerpt } : { statement, command: `test -f '${f.replace(/'/g, `'\\''`)}'` };
      });
    const sub = await mcp(agent, 'submit', { summary: `Seed the project with ${path.basename(dir)} at ${head}`, ...(claims.length ? { claims } : {}) });
    for (let i = 0; i < 60 && st.state !== 'landed'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      st = await mcp(agent, 'status');
    }
    if (st.state !== 'landed') fail(`the seed did not land: ${JSON.stringify(sub).slice(0, 400)}\nstatus: ${JSON.stringify(st).slice(0, 600)}`);
    return console.log(`seeded ${need('project')} with ${path.basename(dir)} at ${head.slice(0, 12)} (change ${st.change_id} landed)`);
  }
  if (cmd === 'join') {
    const p = encodeURIComponent(need('project'));
    const t = encodeURIComponent(need('task'));
    const r = await call(`/api/projects/${p}/tasks/${t}/agents`, opts.from ? { from: opts.from } : {});
    if (opts.json) return console.log(JSON.stringify(r));
    console.log(r.took_over_from ? `took over ${r.took_over_from}'s work on task ${r.task_id} (its key is revoked; your fork starts from its commits)` : `joined task ${r.task_id} as a new agent`);
    return printAgent(r.agent, r.task_id, r.main_branch);
  }
  if (cmd === 'config') {
    const p = encodeURIComponent(need('project'));
    const bool = (v, name) => (v === undefined ? undefined : v === 'true' ? true : v === 'false' ? false : fail(`--${name} takes true or false`));
    const body = {
      ...(opts.testCommand !== undefined ? { test_command: opts.testCommand } : {}),
      ...(opts.timeout !== undefined ? { test_timeout_s: Number(opts.timeout) } : {}),
      ...(opts.checkClaims !== undefined ? { check_claims: bool(opts.checkClaims, 'check-claims') } : {}),
      ...(opts.autoLand !== undefined ? { auto_land: bool(opts.autoLand, 'auto-land') } : {}),
      ...(opts.leases !== undefined ? { leases: String(opts.leases) } : {}),
      ...(opts.signing !== undefined ? { signing: String(opts.signing) } : {}),
      ...(opts.tracks !== undefined ? { tracks: opts.tracks === 'off' ? '' : String(opts.tracks) } : {}),
      ...(opts.targets !== undefined ? { targets: String(opts.targets).split(',').map((x) => x.trim()).filter(Boolean) } : {}),
    };
    if (!Object.keys(body).length) fail('give at least one of --test-command, --timeout, --check-claims, --auto-land, --tracks, --targets, --leases, --signing');
    const r = await call(`/api/projects/${p}/config`, body);
    return opts.json ? console.log(JSON.stringify(r)) : console.log(`configured ${need('project')}: ${JSON.stringify(body)}`);
  }
  if (cmd === 'clone') {
    // A plain clone of main: the token goes on the clone command only, never into the clone's config.
    const m = await call(`/api/projects/${encodeURIComponent(need('project'))}/main`, undefined, 'GET');
    const dir = opts.dir || need('project');
    execFileSync('git', [...gitAuth(m.main_token), 'clone', '-q', '--branch', m.main_branch, m.main_remote, dir], { stdio: 'inherit' });
    // The landing receipts live in git notes, which a clone does not bring: fetch them too, so `verify` works on it.
    try { execFileSync('git', ['-C', dir, ...gitAuth(m.main_token), 'fetch', '-q', m.main_remote, '+refs/notes/converge:refs/notes/converge'], { stdio: 'ignore' }); }
    catch { console.error('converge: the receipts (refs/notes/converge) could not be fetched: verify will report them missing'); }
    return console.log(`cloned ${need('project')} main into ${dir}`);
  }
  if (cmd === 'reviewer') {
    const r = await call(`/api/projects/${encodeURIComponent(need('project'))}/reviewers`, {});
    return opts.json ? console.log(JSON.stringify(r)) : printAgent(r, '', '');
  }
  fail(`usage: converge <project|task|join|reviewer|clone|seed|config|run|status> --project <name> [...]  (see the header of agents/converge.mjs)`);
}

main();
