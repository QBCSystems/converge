#!/usr/bin/env node
// A plain request split into converge tasks, each with checks that fail until it is done: what
// agents/swarm.mjs takes as --tasks. One model call; nothing here runs a check (swarm's preflight
// runs them fenced, and refuses a check that already passes or cannot run).
//
//   CONVERGE_API_URL=... ADMIN_KEY=... node agents/plan.mjs --project P --request "..." --agent ollama --model M \
//     [--host https://...] [--effort low] [--agents 3] [--out tasks.json] [--feedback problems.txt]
//
// The plan is made by the provider and model the agents will run on (--agent, --model, --host: swarm.mjs's own),
// called through the universal agent's providers.cjs, as the agents call it. No other provider is ever used:
// one that cannot plan is an error, said.
//
// --feedback: why an earlier plan was refused (swarm's preflight: a broken check, one that already passes);
// the model gets those reasons and answers with a corrected plan.
//
// The key is the provider's in ASQL (apiKeys, else one of its accounts), or PLAN_API_KEY; a
// subscription CLI signs in on its own. Prints the tasks as JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { universalAgentPath, missingUniversalAgent, providerConfig, cloneFromDisk, thinkingBudget, commitOf, mainCommitNow } from './common.mjs';

const opts = { agents: '3', model: '', host: '', effort: '' };
for (let i = 2; i < process.argv.length; i++) {
  const m = /^--([a-z-]+)$/.exec(process.argv[i]);
  if (m) opts[m[1]] = process.argv[++i];
}
const API = (process.env.CONVERGE_API_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// What the planner does, step by step, for whoever opens the run while it plans (the run's plan-log.jsonl beside --out):
// what it was given, each model call and its whole answer, and what came of it.
const planLogFile = () => (opts.out ? path.join(path.dirname(opts.out), 'plan-log.jsonl') : '');
function planLog(kind, text, extra = {}) {
  const f = planLogFile();
  if (!f) return;
  try { fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), by: 'planner', kind, text, ...extra }) + '\n'); } catch { /* the log misses this step */ }
}
const fail = (m) => { planLog('failed', m); console.error(`plan: ${m}`); process.exit(1); };
if (!opts.project || !opts.request) fail('usage: node agents/plan.mjs --project P --request "..." [--agents N] [--out tasks.json]');
if (!API || !ADMIN_KEY) fail('set CONVERGE_API_URL and ADMIN_KEY');
const max = Math.min(Math.max(Number(opts.agents) || 3, 1), 200);
// One model call writes the whole plan: a plan of a hundred tasks takes minutes to write, and the providers' default
// two minutes for a call cut it off ("claude-cli timed out after 120s"). Two minutes, and nine seconds a task beyond
// the first ten, a quarter of an hour at most; a time the caller set stands.
if (!process.env.AGENT_CALL_TIMEOUT) process.env.AGENT_CALL_TIMEOUT = String(Math.min(900_000, 120_000 + Math.max(0, max - 10) * 9_000));
if (!opts.agent) fail('say which provider plans: --agent <provider> (the one the agents run on), with its --model');
const subscription = /-cli$/.test(opts.agent);
if (!subscription && !opts.model) fail(`say which ${opts.agent} model plans: --model`);
const key = process.env.PLAN_API_KEY || await (async () => {
  try {
    const c = await providerConfig();
    const a = (c.accounts || []).find((x) => x.provider === opts.agent && (x.apiKey || x.key));
    return c.apiKeys?.[opts.agent] || a?.apiKey || a?.key || '';
  } catch { return ''; }
})();
if (!subscription && !key) fail(`no ${opts.agent} key: add it in the dashboard (Settings, keys), or set PLAN_API_KEY`);
const UNIVERSAL_AGENT = universalAgentPath();
let providers;
try { providers = createRequire(UNIVERSAL_AGENT)(path.join(path.dirname(UNIVERSAL_AGENT), 'providers.cjs')); }
catch (e) { fail(fs.existsSync(UNIVERSAL_AGENT) ? `cannot load providers.cjs next to ${UNIVERSAL_AGENT}: ${e.message}` : missingUniversalAgent()); }
let pricing = null;
try { pricing = createRequire(UNIVERSAL_AGENT)(path.join(path.dirname(UNIVERSAL_AGENT), 'pricing.cjs')); } catch { /* no table: no pricing */ }
const who = `${opts.agent}${opts.model ? ` ${opts.model}` : ''}`;

// What the project is now: its files and the notes that say how it is built and tested.
// With --work <dir>: the clone of main is kept there, and its path written to plan-clone.txt in the run's folder (beside
// --out), so the plan check (swarm.mjs preflight) uses it instead of cloning main again. The snapshot is kept in the run's
// folder too (plan-snapshot.json), under main's commit: planning again (try 2, 3) on the same main reads neither the
// project nor the code a second time, and a main that moved since is read afresh.
const runDir = opts.out ? path.dirname(path.resolve(opts.out)) : (opts.work || '');
function snapshot() {
  const r = spawnSync('curl', ['-sf', '-H', `X-Admin-Key: ${ADMIN_KEY}`, `${API}/api/projects/${encodeURIComponent(opts.project)}/main`], { encoding: 'utf8' });
  if (r.status !== 0) fail(`${opts.project}: the platform did not answer /main`);
  const m = JSON.parse(r.stdout);
  const auth = `http.extraHeader=Authorization: Basic ${Buffer.from(`x:${m.main_token}`).toString('base64')}`;
  // main's commit now: from the platform's repository on disk when there is one, else asked of its git server.
  const mainNow = mainCommitNow(m);
  const cache = runDir ? path.join(runDir, 'plan-snapshot.json') : '';
  if (cache && mainNow) {
    try {
      const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (c.commit === mainNow && c.request === opts.request) { planLog('step', `Read the project as it was read for the first plan (main has not moved): ${c.files.length} files`); return c; }
    } catch { /* first try */ }
  }
  if (opts.work) { fs.rmSync(path.join(opts.work, 'main'), { recursive: true, force: true }); fs.mkdirSync(opts.work, { recursive: true }); }
  const dir = opts.work || fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  try {
    planLog('step', 'Reading the project: a clone of main');
    // A whole clone: a shallow one (--depth 1) through the platform's git server ends in "expected shallow list".
    const c = cloneFromDisk(m.main_local, m.main_remote, path.join(dir, 'main')) ? { status: 0, stderr: '' }
      : spawnSync('git', ['-c', auth, 'clone', '-q', m.main_remote, path.join(dir, 'main')], { encoding: 'utf8', timeout: 120_000 });
    if (c.status !== 0) {
      // An empty project (main has no commits) is the one clone failure that is not a failure: anything else is said.
      const empty = spawnSync('git', ['-c', auth, 'ls-remote', '--heads', m.main_remote], { encoding: 'utf8', timeout: 60_000 });
      if (empty.status === 0 && !empty.stdout.trim()) { planLog('step', 'main has no commits yet: planning for an empty project'); return { files: [], notes: '(an empty project: no commits yet)' }; }
      fail(`could not read the project (git clone of main): ${String(c.stderr || '').trim().split('\n').pop().slice(0, 300) || `exit ${c.status}`}`);
    }
    const repo = path.join(dir, 'main');
    const files = spawnSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    // 1,500 characters of each: what a project is and how it is built and tested is at the top; whole notes were a
    // large part of a 40,000-character prompt.
    const notes = ['AGENTS.md', 'README.md', 'package.json', 'pyproject.toml', 'Makefile', 'Cargo.toml', 'go.mod']
      .filter((f) => fs.existsSync(path.join(repo, f)))
      .map((f) => { const body = fs.readFileSync(path.join(repo, f), 'utf8'); return `--- ${f}\n${body.length > 1500 ? `${body.slice(0, 1500)}\n(… ${body.length - 1500} more characters)` : body}`; }).join('\n\n');
    planLog('step', `Read the project: ${files.length} files and ${notes ? notes.match(/^--- \S+/gm).map((x) => x.slice(4)).join(', ') : 'no notes'}`);
    const whereAt = Date.now();
    const where = whereNamed(repo, opts.request, files);
    const whereMs = Date.now() - whereAt;
    // The files the request names (16 KB in all): a task on a file is planned from what the file holds (the table a
    // command goes in, the shape of its tests), not guessed from its name. A small one whole; of a larger one only the
    // parts around the lines its names were found on, since whole files were the largest part of the prompt.
    const named = [...new Set((String(opts.request).match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')))]
      .filter((f) => files.includes(f));
    let shown = '', budget = 16_000;
    for (const f of named) {
      if (notes.includes(`--- ${f}\n`)) continue;
      let body;
      try { body = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
      if (/\0/.test(body)) continue;
      const part = body.length < 6000 ? body : partsAround(body, whereLinesOf(where.text, f));
      if (!part || part.length > budget) continue;
      shown += `--- ${f}${part === body ? '' : ' (only the parts around the lines above; … marks what is left out)'}\n${part}\n`; budget -= part.length;
    }
    if (shown) planLog('step', `Read the files the request names: ${shown.match(/^--- \S+/gm).map((x) => x.slice(4)).join(', ')}`);
    if (where.candidates) planLog('step', `The request names no code: found the files that mention its words most: ${where.candidates.join(', ')}`, { where: where.text.slice(0, 6000), ms: whereMs });
    else if (where.text) planLog('step', `Found where the request's names are in the code${where.via ? `, from ${where.via}` : ''}: ${where.names.join(', ')} (${where.hits} line(s))`, { where: where.text.slice(0, 6000), ms: whereMs });
    else planLog('step', `Looked for the request's names in the code and found none${where.tried.length ? ` (looked for: ${where.tried.join(', ')})` : ' (the request names nothing that looks like code)'}`, where.error ? { error: where.error } : {});
    const whereFiles = (where.text.match(/^\s+([^:\s]+):\d+:/gm) || []).map((l) => l.trim().split(':')[0]);
    const near = [...named, ...(where.candidates || []), ...whereFiles];
    const snap = { commit: mainNow || commitOf(path.join(repo, '.git')), request: opts.request, files, shownFiles: filesShown(files, [...new Set(near)]), notes: shown ? `${notes}\n\n${shown}` : notes, where: where.text, copies: copiesIn(repo, [...named, ...whereFiles]) };
    // The checks of earlier work are kept with it: they are asked of the platform, and can change only when main does.
    snap.guarded = landedChecks(snap.where);
    if (cache) { try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(cache, JSON.stringify(snap)); } catch { /* read again next try */ } }
    if (opts.work && runDir) { try { fs.writeFileSync(path.join(runDir, 'plan-clone.txt'), `${path.resolve(repo)}\n`); } catch { /* the plan check clones its own */ } }
    return snap;
  } finally { if (!opts.work) fs.rmSync(dir, { recursive: true, force: true }); }
}

// Where the names the request mentions (identifiers like ADMIN_KEY or requireAdmin, file paths) are in the code: so the
// plan puts each task on the files that really hold what it changes, not on files guessed from their names.
// The same answer as whereNamed, from the platform's index of main (scripts/lib/code-index.mjs) instead of reading every
// file: used on a codebase of CONVERGE_PLAN_INDEX_MIN files or more (default 300), where reading them all was most of
// the planner's own time. null when the index cannot answer (whereNamed reads the files then).
function whereFromIndex(request, files) {
  const { names, look } = requestNames(request);
  const words = [...new Set((String(request).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []).filter((w) => !STOP.has(w)))].slice(0, 16);
  const q = `names=${encodeURIComponent(look.join(','))}&words=${encodeURIComponent(words.join(','))}`;
  const r = spawnSync('curl', ['-sf', '-H', `X-Admin-Key: ${ADMIN_KEY}`, `${API}/api/projects/${encodeURIComponent(opts.project)}/code?${q}`], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 << 20 });
  let j; try { j = r.status === 0 ? JSON.parse(r.stdout) : null; } catch { j = null; }
  if (!j) return null;
  const out = [];
  let hits = 0;
  for (const n of look) {
    const lines = whereLinesFor((j.names?.[n] || []).map((h) => `${h.path}:${h.line}:${h.text}`), WHERE_ALL - hits);
    if (!lines.length) continue;
    hits += lines.length;
    out.push(`${n}:\n${lines.map((l) => `  ${l}`).join('\n')}`);
    if (hits >= WHERE_ALL) break;
  }
  const via = `the index of main (${j.indexed?.files} files, ${j.indexed?.changed} brought up to date in ${j.indexed?.ms} ms)`;
  if (!out.length) {
    const cands = (j.candidates || []).filter((c) => files.includes(c.path));
    if (cands.length) return { names: [], tried: names, hits: 0, error: '', via, candidates: cands.map((c) => c.path),
      text: `The request names no code, so these are the files that mention its words most (file: words found; a few of its lines). The work is most likely in them:\n${cands.map((c) => `${c.path}: ${c.words.join(', ')}\n${c.lines.map((l) => `  ${c.path}:${l.line}:${String(l.text).slice(0, 160)}`).join('\n')}`).join('\n')}` };
  }
  return { names: names.filter((n) => out.some((o) => o.startsWith(`${n}:`))), tried: names, hits, text: out.join('\n'), error: '', via };
}
// The where-lines are the planner prompt's largest part after the files: per name at most 4 lines of a file, each cut
// to 160 characters, and 60 lines in all. More of the same name's uses told the model nothing the first few did not.
const WHERE_PER_FILE = 4, WHERE_ALL = 60, WHERE_WIDTH = 160;
/** A name's lines (`path:line:text`), trimmed as above to the room left of the 60. */
function whereLinesFor(lines, room) {
  const perFile = new Map();
  return lines.filter((l) => { const file = l.slice(0, l.indexOf(':')); const c = perFile.get(file) || 0; if (c >= WHERE_PER_FILE) return false; perFile.set(file, c + 1); return true; })
    .slice(0, Math.max(0, room)).map((l) => (l.length > WHERE_WIDTH ? `${l.slice(0, WHERE_WIDTH)}…` : l));
}
/** The line numbers the where-text found in one file. */
function whereLinesOf(text, file) {
  const out = [];
  for (const m of String(text || '').matchAll(/^\s+([^:\s]+):(\d+):/gm)) if (m[1] === file) out.push(Number(m[2]));
  return out;
}
/** A large file shown by its parts: 15 lines either side of each line found in it, overlapping parts merged, and "…"
 *  where lines are left out. '' when nothing was found in it: the file's name in the list is all the planner gets. */
function partsAround(body, lineNos) {
  if (!lineNos.length) return '';
  const lines = body.split('\n');
  const spans = [];
  for (const n of [...new Set(lineNos)].sort((a, b) => a - b)) {
    const from = Math.max(1, n - 15), to = Math.min(lines.length, n + 15);
    const last = spans[spans.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to); else spans.push([from, to]);
  }
  let out = spans[0][0] > 1 ? '…\n' : '';
  spans.forEach(([from, to], i) => { out += `${lines.slice(from - 1, to).join('\n')}\n${i < spans.length - 1 || to < lines.length ? '…\n' : ''}`; });
  return out;
}
function requestNames(request) {
  const words = (String(request).match(/[A-Za-z_][\w.\/-]*/g) || []).map((w) => w.replace(/[.,;:]+$/, ''))
    .flatMap((w) => (w.includes('/') && !/\.\w{1,5}$/.test(w) && !/^\w+\/\w+\//.test(w) ? w.split('/') : [w]));
  const names = [...new Set(words.filter((w) => w.length >= 4 && !/^https?/.test(w)
    && !(/^[A-Z]+$/.test(w))
    && (/[A-Z]/.test(w.slice(1)) || /_/.test(w) || /\.\w{1,5}$/.test(w) || w.includes('/'))))].slice(0, 24);
  return { names, look: names.filter((n) => !(n.includes('/') || /\.\w{1,5}$/.test(n))) };
}
function whereNamed(repo, request, files) {
  if (files.length >= (Number(process.env.CONVERGE_PLAN_INDEX_MIN) || 300)) { const w = whereFromIndex(request, files); if (w) return w; }
  const words = (String(request).match(/[A-Za-z_][\w.\/-]*/g) || []).map((w) => w.replace(/[.,;:]+$/, ''))
    // "requireAdmin/requireView" is two names, not a path: a path has a file extension or a folder in it
    .flatMap((w) => (w.includes('/') && !/\.\w{1,5}$/.test(w) && !/^\w+\/\w+\//.test(w) ? w.split('/') : [w]));
  const names = [...new Set(words.filter((w) => w.length >= 4 && !/^https?/.test(w)
    && !(/^[A-Z]+$/.test(w))   // GET, POST, HTTP: words, not names in the code (ADMIN_KEY has its underscore)
    && (/[A-Z]/.test(w.slice(1)) || /_/.test(w) || /\.\w{1,5}$/.test(w) || w.includes('/'))))].slice(0, 24);
  const out = [];
  let hits = 0, error = '';
  // Read in node, not git grep: converge's own git (kernel/linux-x64/bin, first on PATH) took 20 s to grep 15 names in a
  // 3,500-file repository, and timed out; reading the files here takes well under a second.
  const look = names.filter((n) => !(n.includes('/') || /\.\w{1,5}$/.test(n)));   // a path is in the file list already
  const all = [];
  for (const file of look.length ? files : []) {
    if (/\.min\.|(^|\/)package-lock\.json$/.test(file)) continue;
    let body;
    try { const p = path.join(repo, file); if (fs.statSync(p).size > 4 << 20) continue; body = fs.readFileSync(p, 'utf8'); } catch { continue; }   // a submodule or a dangling link: nothing to read
    if (body.includes('\0') || !look.some((n) => body.includes(n))) continue;
    body.split('\n').forEach((text, i) => { if (look.some((n) => text.includes(n))) all.push(`${file}:${i + 1}:${text}`); });
  }
  for (const n of look) {
    const lines = whereLinesFor(all.filter((l) => l.slice(l.indexOf(':')).includes(n)), Math.min(12, WHERE_ALL - hits));
    if (!lines.length) continue;
    hits += lines.length;
    out.push(`${n}:\n${lines.map((l) => `  ${l}`).join('\n')}`);
    if (hits >= WHERE_ALL) break;
  }
  // No names that look like code (or none found): the request's plain words, and the files that hold the most of them.
  // Planned from file names alone, a request about "the account cache" went to accountpool.cjs, which only had the word
  // in its name; the file that holds the code says it, many times over.
  if (!out.length) {
    const cands = candidateFiles(repo, request, files);
    if (cands.length) return { names: [], tried: names, hits: 0, error, candidates: cands.map((c) => c.file),
      text: `The request names no code, so these are the files that mention its words most (file: words found; a few of its lines). The work is most likely in them:\n${cands.map((c) => `${c.file}: ${c.words.join(', ')}\n${c.lines.map((l) => `  ${l}`).join('\n')}`).join('\n')}` };
  }
  return { names: names.filter((n) => out.some((o) => o.startsWith(`${n}:`))), tried: names, hits, text: out.join('\n'), error };
}

const STOP = new Set('about above after again against also because been before being below between both but called cannot change changes code could does doing done down during each else every file files from have having here into just make makes making more most must need needs only other over same should some such than that their them then there these they this those through under until very want what when where which while will with without would your adds added remove removed instead still already anything nothing something like'.split(' '));
/** The files that mention the request's plain words (4+ letters, not common words) most: up to 8, each with the words it
 *  holds and up to 3 of its lines that hold the most of them. A word in the file's path counts too. */
function candidateFiles(repo, request, files) {
  const words = [...new Set((String(request).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []).filter((w) => !STOP.has(w)))].slice(0, 16);
  if (!words.length) return [];
  const scored = [];
  for (const file of files) {
    if (/\.min\.|(^|\/)package-lock\.json$|\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|zip|gz|lock)$/i.test(file)) continue;
    let body;
    try { const p = path.join(repo, file); if (fs.statSync(p).size > 2 << 20) continue; body = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (body.includes('\0')) continue;
    const low = body.toLowerCase(), lowPath = file.toLowerCase();
    const found = words.filter((w) => low.includes(w) || lowPath.includes(w));
    if (found.length < Math.min(2, words.length)) continue;
    const count = found.reduce((n, w) => n + Math.min(20, low.split(w).length - 1), 0);
    scored.push({ file, found, score: found.length * 100 + count, low: body });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 8).map((c) => {
    const lines = c.low.split('\n').map((text, i) => ({ text, i, n: c.found.filter((w) => text.toLowerCase().includes(w)).length }))
      .filter((l) => l.n).sort((a, b) => b.n - a.n).slice(0, 3).sort((a, b) => a.i - b.i)
      .map((l) => `${c.file}:${l.i + 1}:${l.text.trim().slice(0, 160)}`);
    return { file: c.file, words: c.found, lines };
  });
}

/** The file names the model is shown: all of them for a small project; otherwise up to 150, nearest the work first: the
 *  files the request names or its names were found in, then the others in their folders, then the top-level ones. 400
 *  names in the repository's order were most of a 40,000-character prompt, re-read on every try, and the files the work
 *  is in could be past the cut. */
function filesShown(files, near) {
  if (files.length <= 150) return files;
  const dirs = new Set(near.map((f) => path.posix.dirname(f)));
  const have = new Set(files);
  const pick = [...new Set([...near.filter((f) => have.has(f)), ...files.filter((f) => dirs.has(path.posix.dirname(f))), ...files.filter((f) => !f.includes('/'))])];
  const shown = (pick.length ? pick : files).slice(0, 150);
  const folders = [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))];
  return [...shown, `(${files.length - shown.length} more, in: ${folders.slice(0, 40).join(', ')})`];
}

const { files, shownFiles = filesShown(files, []), notes, where, copies = '', guarded = [] } = snapshot();

// Files the request touches that main holds an exact copy of (a repository that keeps a second copy of some files, a download folder say): converge
// writes an agent's edit of the original to the copy at hand-in, so the plan works on the original only. Planned as two
// tasks (one per copy) they took twice the steps and landed two different files.
function copiesIn(repo, paths) {
  const want = new Set(paths);
  if (!want.size) return '';
  const byOid = new Map(), oidOf = new Map();
  try {
    for (const line of spawnSync('git', ['-C', repo, 'ls-tree', '-r', 'HEAD'], { encoding: 'utf8', maxBuffer: 256 << 20 }).stdout.split('\n')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (m) { oidOf.set(m[2], m[1]); byOid.set(m[1], [...(byOid.get(m[1]) || []), m[2]]); }
    }
  } catch { return ''; }
  const lines = new Set();
  for (const p of want) {
    const g = byOid.get(oidOf.get(p)) || [];
    if (g.length < 2 || g.length > 4) continue;
    const [orig, ...rest] = [...g].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
    lines.add(`${rest.join(' and ')} = exact copy of ${orig}`);
  }
  if (lines.size) planLog('step', `Found ${lines.size} file(s) kept as exact copies: ${[...lines].join('; ')}`);
  return [...lines].join('\n');
}

// The checks of earlier tasks already on main that this request may touch: converge runs every landed task's checks on
// each landing, so a request that changes or removes what one of them checks can never land unless its task retires that
// check. Relevant ones only: a check naming a file or a name the request names, or a file the request's names are in.
function landedChecks(where) {
  const r = spawnSync('curl', ['-sf', '-H', `X-Admin-Key: ${ADMIN_KEY}`, `${API}/api/projects/${encodeURIComponent(opts.project)}/state`], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status !== 0) return [];
  let st;
  try { st = JSON.parse(r.stdout); } catch { return []; }
  const landed = new Set((st.changes || []).filter((c) => c.state === 'landed').map((c) => c.task_id));
  const words = new Set([...(String(opts.request).match(/[\w./-]{4,}/g) || []).filter((w) => /[A-Z]/.test(w.slice(1)) || /_/.test(w) || /\.\w{1,5}$/.test(w) || w.includes('/')), ...(String(where || '').match(/^\s+([^:\s]+):\d+:/gm) || []).map((l) => l.trim().split(':')[0])]);
  const out = [];
  for (const t of st.tasks || []) {
    if (!landed.has(t.task_id)) continue;
    for (const c of t.accept || []) if (!out.some((o) => o.check === c) && [...words].some((w) => c.includes(w))) out.push({ task: t.title, check: c });
  }
  if (out.length) planLog('step', `Found ${out.length} check(s) of earlier work on main that this request may change`);
  return out.slice(0, 30);
}
import { systemFor } from './plan-rules.mjs';
// What planning here learned before (scripts/lib/plan-memory.mjs): checks refused in this project and why, and the
// tasks of the most similar earlier request that landed. Nothing when the platform keeps none.
const memory = (() => {
  const r = spawnSync('curl', ['-sf', '-H', `X-Admin-Key: ${ADMIN_KEY}`, `${API}/api/projects/${encodeURIComponent(opts.project)}/plan-memory?request=${encodeURIComponent(String(opts.request).slice(0, 1500))}`], { encoding: 'utf8', timeout: 10_000 });
  try { return r.status === 0 ? JSON.parse(r.stdout) : {}; } catch { return {}; }
})();
const remembered = [
  memory.refused?.length ? `Checks written for this repository before were refused for these reasons; do not write checks like them:\n${memory.refused.map((w) => `- ${w}`).join('\n')}` : '',
  memory.similar?.tasks?.length ? `An earlier request here like this one ("${String(memory.similar.request).slice(0, 300)}") was planned into these tasks, and their checks landed (a reference for checks that work in this repository, not a plan to copy):\n${memory.similar.tasks.map((t) => `- ${t.title}: ${(t.accept || []).join(' && ').slice(0, 300)}`).join('\n')}` : '',
].filter(Boolean).join('\n\n');
if (remembered) planLog('step', `Remembered from earlier planning here: ${memory.refused?.length || 0} refused check(s)${memory.similar ? `, and a similar request that landed (similarity ${memory.similar.score})` : ''}`);
const rememberRefused = (problems) => spawnSync('curl', ['-sf', '-X', 'POST', '-H', `X-Admin-Key: ${ADMIN_KEY}`, '-H', 'content-type: application/json', '--data-binary', '@-', `${API}/api/projects/${encodeURIComponent(opts.project)}/plan-memory`], { input: JSON.stringify({ request: String(opts.request).slice(0, 2000), problems }), encoding: 'utf8', timeout: 10_000 });
const system = systemFor(max);
const feedback = opts.feedback ? fs.readFileSync(opts.feedback, 'utf8').trim() : '';
// --repair <plan.json>: the plan the feedback is about. Only its refused tasks (named "task <key>:" in the feedback) are
// asked for again, and put back in their places: a whole new plan took as long as the first (about a minute) and could
// break tasks that had checked out.
let previous = [];
if (opts.repair) { try { previous = JSON.parse(fs.readFileSync(opts.repair, 'utf8')); } catch { previous = []; } }
const refused = new Set([...feedback.matchAll(/^- task ([\w-]+):/gm)].map((m) => m[1]).filter((k) => previous.some((t) => t.key === k)));
const repairing = Array.isArray(previous) && previous.length > 0 && refused.size > 0 && refused.size < previous.length;
// A request that names no file left the planner to guess one from the file names: a change to code in
// universal-agent.cjs went to accountpool.cjs, whose name sounded closer. When the lookup found where the request's words
// are, that is said to be where the work is; when it found nothing, the planner says which file it believes holds the
// code and why, so the agent can check that first (and say it is blocked, which goes to the owner, when it is wrong).
const namesFile = (String(opts.request).match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')).some((f) => files.some((x) => x === f || x.endsWith(`/${f}`)));
const whereToLook = namesFile ? ''
  : where ? '\n\nThe request names no file: the files in the lines above are where the code it is about is. Put each task on those files, not on a file whose name only sounds like the request.'
  : '\n\nThe request names no file, and its words were not found in the code. In each task\'s description, name the file you believe holds the code it changes and say why (what in that file it changes), so its agent can check that first.';
const user = `Request:\n${opts.request}\n\nRepository files (${files.length}${shownFiles.length < files.length ? ', the ones near the work' : ''}):\n${shownFiles.join('\n') || '(none)'}\n\n${notes}`
  + (guarded.length ? `\n\nChecks of earlier work already on main (numbered). converge runs every one of them on every landing: a change that makes one fail can never land. Decide for each: once this request is done, will it still pass? If the request removes or changes what it checks (it requires something the request deletes, or forbids something the request adds), it must be retired: put its number in "retire" of the task that changes it. A check the request leaves passing is not retired.\n${guarded.map((g, i) => `${i + 1}. (from "${g.task}") ${g.check}`).join('\n')}` : '')
  + (copies ? `\n\nExact copies: converge writes every change of the original to its copy when it lands. Plan each change on the original only: never a task (or a part of one) for editing a copy; a check may still look at both.\n${copies}` : '')
  + (remembered ? `\n\n${remembered}` : '')
  + (where ? `\n\nWhere the names in the request are in the code now (file:line: text). Put each task on the files that really hold what it must change, and name those files in its description:\n${where}` : '')
  + whereToLook
  + (feedback && !repairing ? `\n\nAn earlier plan for this request was refused, because its checks were run on the repository as it is now and:\n${feedback}\n\nAnswer with the whole plan again, every check corrected: each must run without a syntax error (declare each variable once, mind the shell quoting) and must fail now, before the work is done.` : '')
  + (repairing ? `\n\nThis plan was made for the request:\n${JSON.stringify(previous.filter((t) => !refused.has(t.key)).map(({ key, title }) => ({ key, title })))}\nIts other tasks were refused, because their checks were run on the repository as it is now and:\n${feedback}\n\nAnswer with only those tasks, corrected, with the same keys (${[...refused].join(', ')}), as {"tasks":[...]}: every other task stays as it is. Each check must run without a syntax error (declare each variable once, mind the shell quoting) and must fail now, before the work is done.` : '');

// A CLI works in a folder: an empty one, so planning reads and changes nothing of this repository.
const scratch = subscription ? fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cwd-')) : '';
// A plan is one answer from what this prompt holds. Claude Code with its own tools in that empty folder looked around
// it for several turns before answering (a 4,083-character prompt billed 72,765 input tokens and took 41 s): planned
// without tools, it answers in one turn.
process.env.CONVERGE_CLAUDE_NATIVE_TOOLS = '0';
process.on('exit', () => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
// One reading of a reply: the JSON in it (possibly after the model's thinking, in a ``` fence, or with a line of prose
// around it), or null.
function readPlan(text) {
  const body = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(body); } catch { /* look for it inside */ }
  const from = body.search(/[{[]/), to = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (from < 0 || to <= from) return null;
  try { return JSON.parse(body.slice(from, to + 1)); } catch { return null; }
}
// What the model said instead of a plan, in one line, for whoever has to work out what happened.
const said = (text) => { const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\s+/g, ' ').trim(); return t ? `it said: "${t.slice(0, 240)}${t.length > 240 ? '…' : ''}"` : 'it sent nothing back (an empty answer)'; };

let totalPlanTokens = { in: 0, out: 0, cache: 0, calls: 0, usd: 0 };
function recordPlanUsage(usage) {
  if (!usage) return;
  const tin = Number(usage.in || usage.input || 0);
  const tout = Number(usage.out || usage.output || 0);
  const cache = Number(usage.cacheRead || usage.cache || 0);
  totalPlanTokens.in += tin;
  totalPlanTokens.out += tout;
  totalPlanTokens.cache += cache;
  totalPlanTokens.calls++;
  let cost = 0;
  if (pricing) {
    const c = pricing.costOf(opts.agent, opts.model || '', tin, tout, cache);
    cost = Number(c && typeof c === 'object' ? c.usd : c) || 0;
  }
  totalPlanTokens.usd += cost;
  if (opts.out) {
    const dir = path.dirname(opts.out);
    try {
      const udir = path.join(dir, 'usage');
      fs.mkdirSync(udir, { recursive: true });
      fs.appendFileSync(path.join(udir, 'registry-events.jsonl'), JSON.stringify({
        t: 'usage', ref: `${opts.agent}/${opts.model || 'default'}`,
        tin, tout, cache, ok: true, at: new Date().toISOString()
      }) + '\n');
    } catch { /* best effort */ }
    try {
      fs.writeFileSync(path.join(dir, 'plan-usage.json'), JSON.stringify({
        agent: opts.agent, model: opts.model || '',
        tokens: totalPlanTokens,
        spent_usd: +totalPlanTokens.usd.toFixed(4)
      }, null, 1));
    } catch { /* best effort */ }
  }
}

async function ask(sys, usr) {
  // A plan at low effort thinks less than an agent's step (2,048 tokens): the plan's own JSON is most of its answer, and
  // every 1,000 tokens of thinking was about 5 s before any agent started. Its checks are tried before they are used.
  { const e = opts.effort || 'low'; const t = e === 'low' && !process.env.CONVERGE_THINKING_TOKENS ? '2048' : thinkingBudget(e); if (t) process.env.MAX_THINKING_TOKENS = t; else delete process.env.MAX_THINKING_TOKENS; }
  // A reply that is not a plan is usually one bad answer from a model that gives a good one next time (a model on a free
  // tier will also answer with a limit notice when it is out of quota): asked once more, then said as it was.
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    const started = Date.now();
    planLog('ask', `Asking ${who} for the plan${attempt > 1 ? ` (attempt ${attempt})` : ''}`, { prompt_chars: sys.length + usr.length, request_excerpt: usr.slice(0, 600) });
    try {
      res = await providers.callModel({ provider: opts.agent, model: opts.model, apiKey: key, host: opts.host, effort: opts.effort || 'low',   // a plan is a short JSON: no long deliberation unless the owner picked an effort
       
        system: sys, messages: [{ role: 'user', content: usr }], tools: [], mode: 'text', ...(scratch ? { cwd: scratch } : {}) });
    } catch (e) { fail(`${who} did not answer: ${String(e.message || e).split('\n')[0].slice(0, 300)}`); }
    if (res?.usage) recordPlanUsage(res.usage);
    const text = String(res?.text || '');
    const plan = readPlan(text);
    const u = res?.usage || {};
    planLog(plan ? 'answer' : 'not-a-plan', plan ? `${who} answered with a plan` : `${who}'s answer was not a plan`, {
      ms: Date.now() - started, tokens_in: Number(u.in || u.input || 0), tokens_out: Number(u.out || u.output || 0), cached: Number(u.cacheRead || u.cache || 0), answer: text.slice(0, 20000) });
    if (plan) return plan;
    last = text;
    console.error(`plan: ${who} attempt ${attempt} was not a plan (${said(text)})`);
  }
  fail(`${who} twice answered with something that is not a plan: ${said(last)}. If that reads like a limit or quota notice, the account is out; otherwise try again, reword the request, or pick another model`);
}
// The parts of a request written as a numbered list ("1. ...", "2) ..."), each with the lines under it; [] when it is
// not one, or has fewer than two or more than `max` parts (then the planner decides how it divides).
function numberedParts(request, max) {
  const out = [];
  for (const line of String(request || '').split('\n')) {
    const m = /^\s*\d{1,2}[.)]\s+(\S.*)$/.exec(line);
    if (m) out.push(m[1]);
    else if (out.length && line.trim()) out[out.length - 1] += `\n${line.trim()}`;
  }
  return out.length >= 2 && out.length <= max ? out : [];
}
const flatten = (j) => (Array.isArray(j) ? j : Array.isArray(j.workstreams) ? j.workstreams.flatMap((w) => (w.tasks || []).map((t) => ({ ...t, workstream: String(w.name || '').trim().slice(0, 40), scope: String(w.scope || '').trim() }))) : j.tasks);

let tasks;
if (max <= 24) {
  // A plan with fewer tasks than agents runs on fewer agents. Asking again to "split finer" cost a whole second planner
  // call (30-60 s, and a third when that reply was not a plan) and split by file what belongs in one task.
  // Each task planned on its own, all at the same time: one answer holding every task took 20-30 s for five (most of
  // it the model's hidden thinking, which the CLI cannot turn off) and grows with every task; five answers of one task
  // each, asked together, took 11 s, about as long as the slowest one, however many there are. A request that is
  // already a numbered list is split by its numbers; any other, of four or more tasks, is first split by a short call.
  const parts = repairing || process.env.CONVERGE_PLAN_PARALLEL === '0' ? [] : numberedParts(opts.request, max);
  if (!parts.length && !repairing && max >= 4 && process.env.CONVERGE_PLAN_PARALLEL !== '0') {
    const split = await ask([
      `You split a software request into at most ${max} independent parts for coding agents working in parallel on one repository, one agent per part. Split as finely as the request really divides, never padding.`,
      systemFor(max).split('\n').filter((l) => /^(Split by feature|Changes to the same function|Agents work at the same time)/.test(l)).join('\n'),
      'Answer with JSON only: {"parts":[{"title":"one line","part":"everything this part must do, with every detail the request gives for it (names, values, files)"}]}',
    ].join('\n'), user);
    for (const x of (Array.isArray(split?.parts) ? split.parts : []).slice(0, max)) if (x && (x.part || x.title)) parts.push(`${x.title ? `${x.title}: ` : ''}${x.part || ''}`.trim());
    planLog('step', `Split into ${parts.length} part(s), each planned on its own at the same time`);
  } else if (parts.length) planLog('step', `The request lists ${parts.length} parts: each planned on its own, at the same time`);
  if (parts.length >= 2) {
    const one = systemFor(1);
    // Planned, then checked the moment its answer is in (agents/task-check.mjs, fenced, in a copy of main), and asked
    // again alone with the reasons when its checks are refused: a refused check no longer costs every task a second
    // planning round, and the other tasks' checks run while it is planned again.
    const repo = opts.work ? path.join(opts.work, 'main') : '';
    const checkDir = repo && fs.existsSync(path.join(repo, '.git')) ? fs.mkdtempSync(path.join(os.tmpdir(), 'plan-check-')) : '';
    if (checkDir) process.on('exit', () => fs.rmSync(checkDir, { recursive: true, force: true }));
    const { checkTask } = checkDir ? await import('./task-check.mjs') : {};
    const promptFor = (part, i) => `${user}\n\nOther agents do the other parts of this request at the same time:\n${parts.filter((_, j) => j !== i).map((x) => `- ${x.split('\n')[0].slice(0, 200)}`).join('\n')}\n\nPlan ONLY this part, as one task:\n${part}`;
    const asTask = (j, i) => {
      const t = (flatten(j) || [])[0];
      if (!t) return null;
      const { workstream, scope, ...rest } = t;
      return { ...rest, key: String(rest.key || `task-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `task-${i + 1}`, accept: (Array.isArray(rest.accept) ? rest.accept : []).map(String).filter(Boolean).slice(0, 4) };
    };
    const planned = await Promise.all(parts.map(async (part, i) => {
      let t = asTask(await ask(one, promptFor(part, i)), i);
      for (let attempt = 1; t && checkTask && attempt <= 3; attempt++) {
        const problems = await checkTask(t, i, { dir: repo, base: checkDir, onEvent: (e) => planLog('step', e.type === 'task' ? `Checking ${t.key}` : `${t.key}: check ${e.index + 1} ${e.status}${e.ms != null ? ` in ${(e.ms / 1000).toFixed(1)}s` : ''}`) });
        fs.rmSync(path.join(checkDir, `task-${i}`), { recursive: true, force: true });
        if (!problems.length) { planLog('step', `${t.key}: its checks fail on main as they should`); break; }
        if (attempt === 3) { planLog('problems', `${t.key}: its checks were still refused after ${attempt} tries`, { problems }); break; }
        planLog('problems', `${t.key}: ${problems.length} problem(s) with its checks; asking again for this task alone`, { problems });
        rememberRefused(problems);
        const again = asTask(await ask(one, `${promptFor(part, i)}\n\nYour last answer for this part was refused, because its checks were run on the repository as it is now and:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nAnswer with this one task again, every check corrected: each must run without a syntax error (mind the shell quoting) and at least one must fail now, before the work is done.`), i);
        if (again) t = { ...again, key: t.key };
      }
      return t;
    }));
    tasks = planned.filter(Boolean);
  } else if (repairing) {
    planLog('step', `Asking again for ${refused.size} refused task(s) only: ${[...refused].join(', ')}`);
    const fixed = flatten(await ask(system, user)) || [];
    const byKey = new Map(fixed.filter((t) => t && refused.has(String(t.key))).map((t) => [String(t.key), t]));
    const spare = fixed.filter((t) => t && !byKey.has(String(t.key)));
    tasks = previous.map((t) => (refused.has(t.key) ? { ...(byKey.get(t.key) || spare.shift() || t), key: t.key, ...(t.workstream ? { workstream: t.workstream, scope: t.scope } : {}) } : t));
  } else tasks = flatten(await ask(system, user));
}
else {
  // A big plan in two steps, so no single answer has to hold hundreds of tasks: first the workstreams (name, what is
  // in it, how many tasks), then each workstream's tasks, asked for at the same time.
  const plan = await ask(`You plan a large software request for a swarm of coding agents working in parallel on one repository.
Split it into 2 to 8 workstreams: coherent areas of the work (a part of the codebase or a feature), named in a word or two. Tasks in different workstreams should not touch the same code.
Give each workstream how many independent tasks it needs; together exactly ${max}.
Answer with JSON only: {"workstreams":[{"name":"short name","scope":"what is in it, which folders and files, 2-4 sentences","tasks":<number>}]}`, user);
  const ws = (plan.workstreams || []).filter((w) => w && w.name).slice(0, 8);
  if (!ws.length) fail('the model planned no workstreams');
  const total = ws.reduce((n, w) => n + (Number(w.tasks) || 1), 0);
  const lists = await Promise.all(ws.map((w) => {
    const n = Math.max(1, Math.round(((Number(w.tasks) || 1) / total) * max));
    const others = ws.filter((x) => x !== w).map((x) => `- ${x.name}: ${x.scope}`).join('\n');
    return ask(systemFor(n).replace(/^.*workstreams: 2 to 8.*$/m, 'Use one workstream.'),
      `${user}\n\nPlan only the "${w.name}" workstream: ${w.scope}\nOther agents work on these at the same time; stay out of their code:\n${others}`)
      .then((j) => flatten(j).slice(0, n).map((t) => ({ ...t, workstream: w.name, scope: String(w.scope || '').trim() })));
  }));
  tasks = lists.flat();
}
if (!Array.isArray(tasks) || !tasks.length) fail('the model planned no tasks');
const seen = new Set();
// Only checks that really are on main, word for word: anything else retires nothing.
const retireOf = (t) => {
  const r = [...new Set((Array.isArray(t.retire) ? t.retire : []).map((x) => (/^\d+$/.test(String(x).trim()) ? guarded[Number(x) - 1]?.check : guarded.find((g) => g.check === String(x))?.check)).filter(Boolean))];
  if (r.length) planLog('step', `${t.key || t.title}: retires ${r.length} earlier check(s) the request changes`);
  return r.length ? { retire: r } : {};
};
// Clean check commands if models accidentally emit JS template literals in import specifiers
const cleanCheck = (c) => String(c).replace(/(from|import)\s+`([^`]+)`/g, '$1 "$2"');
tasks = tasks.slice(0, max).map((t, i) => {
  let k = String(t.key || `task-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `task-${i + 1}`;
  while (seen.has(k)) k = `${k}-${i + 1}`;
  seen.add(k);
  return { key: k, title: String(t.title || k).slice(0, 200), description: String(t.description || '').slice(0, 2000), accept: (Array.isArray(t.accept) ? t.accept : []).map(cleanCheck).filter(Boolean).slice(0, 4), ...retireOf(t), ...(t.workstream ? { workstream: t.workstream, scope: String(t.scope || '').slice(0, 600) } : {}) };
});
// Two tasks that change the same function (or class, or method) of the same file collide: whichever lands second is
// sent back to redo its edit on top of the first (two agents rewriting one block, seen on every such plan). They are
// one task: merged here, from the repository itself, instead of asking the model again.
tasks = mergeSameCode(tasks);
function mergeSameCode(list) {
  const repo = opts.work ? path.join(opts.work, 'main') : '';
  if (!repo || !fs.existsSync(repo) || list.length < 2) return list;
  const fileSet = new Set(files);
  const filesOf = (t) => [...new Set((`${t.title} ${t.description}`.match(/[\w./-]+\.\w{1,6}\b/g) || []).map((f) => f.replace(/^\.\//, '')).filter((f) => fileSet.has(f)))];
  const namesOf = (t) => new Set([...(`${t.title} ${t.description}`.matchAll(/`([A-Za-z_$][\w$]{3,})`|\b([A-Za-z_$][\w$]{3,})\s*\(/g))].map((m) => m[1] || m[2]));
  const body = new Map();
  const declares = (f, n) => {
    if (!body.has(f)) { try { body.set(f, fs.statSync(path.join(repo, f)).size < 8 << 20 ? fs.readFileSync(path.join(repo, f), 'utf8') : ''); } catch { body.set(f, ''); } }
    const e = n.replace(/\$/g, '\\$');
    return new RegExp(`(?:function\\s*\\*?\\s+${e}\\b|\\b(?:const|let|var)\\s+${e}\\s*=\\s*(?:async\\s*)?(?:function|\\(|[\\w$]+\\s*=>)|\\bclass\\s+${e}\\b|^\\s*(?:async\\s+)?${e}\\s*\\([^)]*\\)\\s*\\{|\\bdef\\s+${e}\\b|\\bfn\\s+${e}\\b|\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${e}\\b)`, 'm').test(body.get(f));
  };
  const out = [];
  for (const t of list) {
    const f = filesOf(t), n = namesOf(t);
    // ...a name both TITLES give (what each task changes): a task that only mentions the function (a README listing every
    // export names truncate) does not change it, and merged, the two ran one after the other on one agent.
    const titled = (task, name) => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(task.title || '');
    const into = out.find((o) => o._files.some((x) => f.includes(x) && [...n].some((name) => o._names.has(name) && titled(o, name) && titled(t, name) && declares(x, name))));
    if (!into) { out.push({ ...t, _files: f, _names: n }); continue; }
    const shared = [...n].find((name) => into._names.has(name) && titled(into, name) && titled(t, name) && into._files.some((x) => f.includes(x) && declares(x, name)));
    planLog('step', `${into.key} and ${t.key} both change ${shared} in ${into._files.find((x) => f.includes(x))}: made one task, so two agents do not rewrite it at once`);
    into.title = `${into.title}; ${t.title}`.slice(0, 200);
    into.description = `${into.description}\n\nAlso, in the same change: ${t.description}`.slice(0, 4000);
    into.accept = [...new Set([...into.accept, ...t.accept])].slice(0, 6);
    if (t.retire) into.retire = [...new Set([...(into.retire || []), ...t.retire])];
    into._files = [...new Set([...into._files, ...f])];
    for (const x of n) into._names.add(x);
  }
  return out.map(({ _files, _names, ...t }) => t);
}
// Each task carries what the planner said about the other workstreams (what they hold, so its agent stays out of it):
// the agent sees it with its task (swarm.mjs), not only the planner while it wrote the tasks.
const scopes = new Map();
for (const t of tasks) if (t.workstream && !scopes.has(t.workstream)) scopes.set(t.workstream, t.scope || '');
if (scopes.size > 1) for (const t of tasks) if (t.workstream) t.stay_out = [...scopes].filter(([w]) => w !== t.workstream).map(([workstream, scope]) => ({ workstream, scope }));
const out = JSON.stringify(tasks, null, 1);
if (opts.out) fs.writeFileSync(opts.out, out);
planLog('planned', `${tasks.length} task(s): ${tasks.map((t) => t.title).join(' · ')}`, { tasks: tasks.length });
// Ended here, once the plan is written: nothing the provider's code left open keeps this going.
process.stdout.write(`${out}\n`, () => process.exit(0));
