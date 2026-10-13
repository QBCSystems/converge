// An agent as an aios entity, working in a directory.
//
// The model is only a mind: it is bound to the entity (agent-control, kind "external") and can do
// nothing but propose one action per cycle, as a JSON object. This runtime carries each action out,
// and only after aios says the entity holds the capability for it (cap.exercise, before every read,
// write and command). Every allowed and every refused action is a line in the aios ledger, and every
// cycle is recorded (cycle.record: what the mind said, what it got back, its checkpoint and the work
// tree) so a run can be replayed and the agent rewound to any cycle.
//
// A command is a program of the host, not of aios: aios decides whether the entity may run it, and
// the host runs it (hooks.exec), fenced however that host can fence a program. Without an exec hook
// the runtime refuses to run commands at all. Afterwards the runtime polices what it changed: a write
// to a path the entity may not write is undone and refused on the ledger, git's hooks and config are
// restored.
//
// What an agent holds (all with a TTL):
//   storage  tree:<workdir>     read          reading, listing, searching
//   storage  path:<workdir>/<p> read,write    one per writable path (setWritable); a write
//                                             anywhere else is refused and undone
//   compute  cmd:shell          execute       a command (run by the host's exec hook)
//
// A host (the program that runs agents for some purpose: a coordinator, a CI, a shell) adds its own
// actions, grants, done-gate and per-cycle reporting through `hooks`; see runAgent.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const GRANT_TTL_S = 4 * 3600;
// Each cycle the mind sees its last RECENT_FULL results in full (each up to RESULT_CHARS), one line
// for every earlier step, and "open files": everything it has read, as the files are now.
const RECENT_FULL = 4;
const OPEN_CHARS = 200_000;
const RESULT_CHARS = 16_000;

// ---- a machine-wide cap on heavy commands --------------------------------------------------------
// Builds and test suites share the machine: at most `count` at once across every agent on it.

export async function withHeavySlot(fn, { count = Number(process.env.AIOS_HEAVY_SLOTS) || 2, dir = path.join(process.env.HOME || '/tmp', '.aios', 'slots') } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (;;) {
    for (let i = 0; i < count; i++) {
      const f = path.join(dir, `slot-${i}`);
      try {
        const fd = fs.openSync(f, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        try { return await fn(); } finally { fs.rmSync(f, { force: true }); }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // A slot held by a process that no longer exists is free.
        try { process.kill(Number(fs.readFileSync(f, 'utf8')), 0); } catch { fs.rmSync(f, { force: true }); }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---- the action protocol --------------------------------------------------------------------------

const PROTOCOL = `You act ONLY by replying with exactly one JSON object (no prose, no code fence) choosing one action:
{"action":"list","path":"dir"}                          files under a directory of your work tree
{"action":"outline","path":"file"}                       functions/classes/sections with line numbers (read only the part you need)
{"action":"read","path":"file","start":1,"end":200}     numbered lines of a file (start/end optional)
{"action":"search","pattern":"regex","path":"dir"}      git grep across the work tree (path optional)
{"action":"write","path":"file","content":"..."}        create a new file (replacing an existing one needs every line of it read first)
{"action":"edit","path":"file","old":"exact text","new":"replacement"}   old must occur exactly once
{"action":"run","command":"..."}                         a shell command in your sandbox (writes only your work tree, no network)
{"action":"move","path":"old","to":"new"}               rename a file
{"action":"delete","path":"file"}                        delete a file
{"action":"rewind","to":N}                               go back to the start of cycle N: your files and your state as they were then
{"action":"note","text":"..."}                           keep a finding in your notes (always shown to you); write down what you learn from reading`;
const PROTOCOL_END = `{"action":"done","summary":"..."}                        finish
Everything you read stays in "open files" (current contents), so do not read it again: edit. Only your last few other results are shown in full; keep conclusions in notes.
Every action is checked against your capabilities in aios and recorded; a refused action tells you why. Base every statement on output you saw.`;

/** The first JSON object in a reply that names an action; a malformed one is reported as {action:'__invalid'}. */
export function parseAction(text) {
  // A mind often thinks aloud first, and its prose can contain braces (a template literal, a snippet).
  const s = String(text || '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        const cand = s.slice(start, i + 1);
        try { const v = JSON.parse(cand); if (v && typeof v.action === 'string') return withExtra(v, s.slice(i + 1)); } catch (e) {
          // A raw newline or tab inside a string is the common slip in a long edit: escape it and retry.
          try { const v = JSON.parse(escapeRaw(cand)); if (v && typeof v.action === 'string') return withExtra(v, s.slice(i + 1)); } catch { /* still not JSON */ }
          // A malformed action is reported, never skipped for one further on: running the second of
          // two actions while the mind believes the first ran is how an edit silently goes missing.
          if (/^\{\s*"action"/.test(cand)) return { action: '__invalid', error: e.message };
        }
        break;
      }
    }
    // An object cut short of its closing braces (a model that stops one token early): close it.
    if (depth > 0 && depth <= 3 && !inStr) {
      try { const v = JSON.parse(s.slice(start) + '}'.repeat(depth)); if (v && typeof v.action === 'string') return v; } catch { /* not this one */ }
    }
  }
  return null;
}
function escapeRaw(t) {
  let out = '', inStr = false, esc = false;
  for (const c of t) {
    if (inStr && !esc && c < ' ') { out += c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '\\r' : ''; continue; }
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; } else if (c === '"') inStr = true;
    out += c;
  }
  return out;
}
// Only one action runs per cycle; say so when the reply held more.
function withExtra(v, rest) {
  const more = (rest.match(/\{\s*"action"\s*:/g) || []).length;
  if (more) Object.defineProperty(v, 'ignored', { value: more, enumerable: false });
  return v;
}

// Patterns worth a human's eye when a mind proposes them. Flagged in the record, not silently
// dropped; aios's decisions and the host's fence are what actually stop them.
const ALERTS = [
  [/base64|atob\(|Buffer\.from\([^)]*['"]base64/i, 'encoded payload'],
  [/\b(curl|wget|nc|ncat|socat|ssh|scp|telnet)\b/, 'network tool'],
  [/child_process|execSync|spawnSync|\beval\(|new Function\(|subprocess|os\.system/, 'spawns code'],
  [/\.ssh\/|id_rsa|id_ed25519|\.credentials|\.netrc|\.aws\/|_API_KEY|control\.key/, 'credentials'],
  [/\/etc\/(passwd|shadow|sudoers)|\/proc\/self|\.git\/(hooks|config)|core\.(hooksPath|pager|sshCommand)/, 'system or git internals'],
  [/aios-agent-control|\.aios\//, 'the platform itself'],
];
export function alertsFor(text, extra = []) {
  const out = [];
  for (const [re, what] of [...ALERTS, ...extra]) if (re.test(text)) out.push(what);
  return out;
}

export const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n... (${s.length - n} more characters)` : s);

const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

// ---- one agent ------------------------------------------------------------------------------------

/**
 * Run one agent until it is done or out of cycles.
 *
 *   ctl        an AiosControl (control.mjs)
 *   label      the entity's label
 *   mind       {name, provider?, model?, effort?}: an external mind registered with the service
 *   workdir    the directory it works in (a git work tree: snapshots and rewinds need one)
 *   scratch    a directory of the runtime's own (commands' HOME and TMPDIR)
 *   prompt     what it is for
 *   writer     false: it may read and run, never write (a reviewer)
 *   readOnly   more paths commands may read (dependencies, toolchains), passed to hooks.exec
 *   env        more variables for commands (passed to hooks.exec with a minimal environment)
 *   heavy      {count, dir} for withHeavySlot
 *   log        called with each cycle's record
 *   hooks      what the host adds:
 *     protocol     more action lines for the mind
 *     header       more context after the protocol (a tool list, a test command)
 *     start(ctx)   once, after the entity and its base grants exist
 *     actions      {name: async (a, ctx) => observation}: the host's own actions
 *     mapAction(a, ctx)  rewrite an action before it runs (aliases)
 *     beforeCycle(ctx, cycle)  e.g. apply an operator's rewind request
 *     doneGate(ctx)  what still stands in the way of done ([] = may finish)
 *     afterCycle(ctx, record)  report the cycle (record: cycle, action, target, verdict, reason,
 *                    reply, observation, checkpoint, tree, treeAfter, alerts)
 *     exec(req)    run a host program once aios has allowed it: req = {command (a shell line or an
 *                  argv), cwd, env, readOnly, readWrite, network, timeoutMs}, answering {code, out};
 *                  the host fences it as its platform can. Without it, commands are refused.
 *     afterRewind(ctx, cycle)  re-establish host state after a rewind
 *     grantsChanged(ctx)  the entity's grants changed (ctx.held)
 *     outOfCycles(ctx)    before the entity ends without having finished
 *     finishedBy(ctx, record)  after a cycle: a summary when the work is done by the host's measure
 *                  (e.g. its change landed), ending the entity without another cycle; else nothing
 *     writeHint    appended to a refused write ("Claim it first.")
 *     alerts       more [regex, label] patterns
 *     failed       a regex: observations that mean the action failed (not refused)
 *     emptyHistory what the history says before the first cycle
 */
export async function runAgent({ ctl, label, mind, workdir, scratch, prompt, writer = true, readOnly = [], env = {}, heavy = {}, maxCycles = 60, log = () => {}, hooks = {} }) {
  const entity = (await ctl.must({ op: 'agent.create', label })).entity;
  await ctl.must({ op: 'agent.bind_mind', entity, kind: 'external', mind: mind.name,
    ...(mind.provider ? { provider: mind.provider } : {}), ...(mind.model ? { model: mind.model } : {}), ...(mind.effort ? { effort: mind.effort } : {}) });
  const held = new Map(); // capability id -> "kind resource rights"
  const grant = async (kindName, resource, rights) => {
    const cap = (await ctl.must({ op: 'cap.grant', to: entity, kind: kindName, resource, rights, ttl_s: GRANT_TTL_S })).capability;
    held.set(cap, `${kindName} ${resource} ${rights}`);
    return cap;
  };
  const exercise = async (kindName, resource, rights, action) => {
    const r = await ctl.call({ op: 'cap.exercise', entity, kind: kindName, resource, rights, action });
    return r.allowed ? null : r.error || 'refused';
  };

  const realRepo = fs.realpathSync(workdir);
  const tmp = path.join(scratch, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const isGit = fs.existsSync(path.join(realRepo, '.git'));
  await grant('storage', `tree:${realRepo}`, 'read');
  await grant('compute', 'cmd:shell', 'execute');

  // A path inside the work tree, or why not. Symlinks are resolved so a link cannot point out.
  const inside = (p) => {
    const abs = path.resolve(realRepo, String(p || '.'));
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* new dir */ } }
    if (real !== realRepo && !real.startsWith(realRepo + path.sep)) return { error: `${p} is outside your work tree` };
    if (path.relative(realRepo, real).split(path.sep)[0] === '.git') return { error: 'the .git directory is not yours to touch' };
    return { abs: real, rel: path.relative(realRepo, real) };
  };

  // ---- writable paths (each a storage capability; a path may be limited to line ranges, or name a unit of a file) ----
  const writeCaps = new Map(); // relative path ('' = whole tree) -> capability id
  const writeRanges = new Map(); // relative path -> [[start, end] | null (whole)]
  const writeScopes = new Map(); // relative path -> scopes ("Store.put") it may change, for a file claimed only by unit
  const lastParsed = new Map();  // relative path -> its last text that parsed (what a half-done edit is judged against)
  let writable = [];
  async function setWritable(paths) {
    for (const cap of writeCaps.values()) { await ctl.call({ op: 'cap.revoke', capability: cap }); held.delete(cap); }
    writeCaps.clear();
    writeRanges.clear();
    writeScopes.clear();
    writable = [...(paths || [])];
    for (const raw of writable) {
      const m = /:(\d+)-(\d+)$/.exec(String(raw));
      // "file#Scope" (a claim on one function, class or key of a file): the file is writable, and converge checks on
      // submit that the change kept to that unit
      const scoped = /^(.+\.[A-Za-z0-9]+)#[^/]+$/.exec(String(raw));
      const file = (scoped ? scoped[1] : String(raw)).replace(/:\d+-\d+$/, '').replace(/\/+$/, '');
      const loc = inside(file || '.');
      if (loc.error) continue;
      if (scoped) {
        const sc = writeScopes.get(loc.rel) || [];
        sc.push(String(raw).slice(scoped[1].length + 1));
        writeScopes.set(loc.rel, sc);
        if (!writeCaps.has(loc.rel)) writeCaps.set(loc.rel, await grant('storage', `path:${realRepo}${loc.rel ? '/' + loc.rel : ''}`, 'read,write'));
        continue;
      }
      const r = writeRanges.get(loc.rel) || [];
      r.push(m ? [Number(m[1]), Number(m[2])] : null);
      writeRanges.set(loc.rel, r);
      if (!writeCaps.has(loc.rel)) writeCaps.set(loc.rel, await grant('storage', `path:${realRepo}${loc.rel ? '/' + loc.rel : ''}`, 'read,write'));
    }
    await hooks.grantsChanged?.(ctx);
  }
  /**
   * Whether a change of file `rel` from `before` to `after` keeps to the units it is claimed by ("file#Scope"), as
   * converge checks on submit: every unit it adds, removes or changes in itself is a claimed one or inside one;
   * text outside every unit (imports, top-level statements) goes with the claim. When the new text does not parse
   * yet (an edit half done), the lines it changes must lie inside the claimed units as they were. null: it keeps to
   * them (or the file is not claimed by unit); otherwise why not.
   */
  function scopeRefusal(rel, before, after) {
    const scopes = writeScopes.get(rel);
    if (!scopes?.length || (writeRanges.get(rel) || []).includes(null)) return null;
    const dir = fs.mkdtempSync(path.join(tmp, 'scope-'));
    const a = path.join(dir, 'old'), b = path.join(dir, 'new');
    fs.writeFileSync(a, before ?? '');
    fs.writeFileSync(b, after ?? '');
    const git = (...args) => {
      try { return { code: 0, out: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
      catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') }; }
    };
    const within = (s) => s === '' || scopes.some((c) => s === c || s.startsWith(c + '.'));
    try {
      // judged against the last version that parsed: a half-done edit's text is no reference
      if (git('outline', '--as', rel, a).code !== 0 && lastParsed.has(rel)) {
        before = lastParsed.get(rel);
        fs.writeFileSync(a, before);
      }
      const ch = git('outline', '--changes', a, b, '--as', rel);
      if (ch.code === 0) {
        const bad = ch.out.split('\n').filter(Boolean).map((l) => l.slice(2)).filter((sc) => !within(sc));
        if (!bad.length) lastParsed.set(rel, after ?? '');
        return bad.length ? `it changes ${bad.map((x) => rel + '#' + x).join(', ')}, outside the units you may change (${scopes.map((x) => rel + '#' + x).join(', ')})` : null;
      }
      if (ch.code !== 3) return `${rel} is claimed by unit and its units cannot be read (${ch.code === 4 ? 'it does not parse' : 'no grammar, or git outline is missing'}): claim the whole file to change it`;
      // half an edit: the changed lines must lie in the claimed units as they were
      const units = git('outline', '--as', rel, a).out.split('\n').filter(Boolean).map((l) => l.split('\t'));
      const spans = units.filter(([, , sc]) => scopes.includes(sc)).map(([r]) => r.split('-').map(Number));
      const x = String(before ?? '').split('\n'), y = String(after ?? '').split('\n');
      let lo = 0;
      while (lo < x.length && lo < y.length && x[lo] === y[lo]) lo++;
      let tail = 0;
      while (tail < x.length - lo && tail < y.length - lo && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
      const first = lo + 1, last = Math.max(first, x.length - tail);
      if (spans.some(([s0, s1]) => first >= s0 && last <= s1)) return null;
      return `it changes lines ${first}-${last} of ${rel}, outside the units you may change (${scopes.map((x2) => rel + '#' + x2).join(', ')}${spans.length ? ': lines ' + spans.map((p) => p.join('-')).join(', ') : ''})`;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  /** The writable path that covers rel (itself or an ancestor), as the resource to exercise. */
  function writeResource(rel) {
    for (let p = rel; ; p = path.dirname(p) === '.' ? '' : path.dirname(p)) {
      if (writeCaps.has(p)) return `path:${realRepo}${p ? '/' + p : ''}`;
      if (!p) break;
    }
    return `path:${realRepo}/${rel}`; // not writable: aios refuses, and the refusal is on record
  }

  // ---- open files ----
  // Like an editor's buffers: every range the mind has read stays in its context, as the file is NOW
  // (edits show at once), until the budget closes the least recently used, which it is told.
  const readLines = new Map(); // file -> line numbers read, so a write never replaces unseen text
  const open = new Map(); // "path:from-to" -> { path, from, to, used, opened }
  let useClock = 0;
  function openRange(rel, from, to) {
    for (const r of open.values()) if (r.path === rel && from <= r.to + 1 && to >= r.from - 1) { from = Math.min(from, r.from); to = Math.max(to, r.to); }
    let opened = useClock + 1;
    for (const [k, r] of open) if (r.path === rel && from <= r.to + 1 && to >= r.from - 1) { opened = Math.min(opened, r.opened); open.delete(k); }
    open.set(`${rel}:${from}-${to}`, { path: rel, from, to, used: ++useClock, opened });
  }
  // Reading through the shell (sed -n 'A,Bp' f, cat f) opens those lines too.
  function openFromShell(command) {
    for (const part of command.split(/&&|;|\|\|/)) {
      const m = part.match(/^\s*(?:cd\s+(\S+)\s*)?$/) ? null : part.match(/^\s*sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(\S+)\s*(?:\|.*)?$/) || part.match(/^\s*cat\s+(\S+)\s*$/);
      if (!m) continue;
      const [from, to, file] = m.length === 4 ? [Number(m[1]), Number(m[2]), m[3]] : [1, 600, m[1]];
      const dir = (command.match(/^\s*cd\s+(\S+)\s*&&/) || [])[1] || '.';
      const loc = inside(path.join(dir, file.replace(/^['"]|['"]$/g, '')));
      if (loc.error || !fs.existsSync(loc.abs) || fs.statSync(loc.abs).isDirectory()) continue;
      const n = fs.readFileSync(loc.abs, 'utf8').split('\n').length;
      const lo = Math.max(1, from), hi = Math.min(n, to, lo + 599);
      if (hi < lo) continue;
      const seen = readLines.get(loc.rel) || new Set();
      for (let k = lo; k <= hi; k++) seen.add(k);
      readLines.set(loc.rel, seen);
      openRange(loc.rel, lo, hi);
    }
  }
  const shown = new Set();
  let dropped = [];
  const isShown = (rel, from, to) => [...open.values()].some((r) => r.path === rel && r.from <= from && r.to >= to && shown.has(`${r.path}:${r.from}-${r.to}`));
  function renderOpen() {
    const parts = [];
    let budget = OPEN_CHARS;
    shown.clear();
    for (const r of [...open.values()].sort((x, y) => y.used - x.used)) {
      let text;
      try { text = fs.readFileSync(path.join(realRepo, r.path), 'utf8').split('\n'); } catch { open.delete(`${r.path}:${r.from}-${r.to}`); continue; }
      const to = Math.min(r.to, text.length);
      const body = `--- ${r.path} lines ${r.from}-${to} of ${text.length}\n` + text.slice(r.from - 1, to).map((l, i) => `${r.from + i}\t${l}`).join('\n');
      if (body.length > budget) { open.delete(`${r.path}:${r.from}-${r.to}`); dropped.push(`${r.path} ${r.from}-${to}`); continue; }
      budget -= body.length;
      shown.add(`${r.path}:${r.from}-${r.to}`);
      parts.push({ opened: r.opened, body });
    }
    // Oldest first and stable, so the provider's prompt cache keeps hitting as new files open.
    return parts.sort((x, y) => x.opened - y.opened).map((p) => p.body).join('\n\n');
  }
  const forgetReads = () => readLines.clear();

  // ---- commands: aios decides (cap.exercise), the host runs them (hooks.exec) ----
  const nodePrefix = path.dirname(path.dirname(process.execPath));
  const fenceRead = ['/usr', '/lib', '/lib64', '/bin', '/etc', '/proc', '/dev', nodePrefix, ...readOnly.filter((d) => typeof d === 'string' && d.startsWith('/') && fs.existsSync(d))];
  const baseEnv = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, LANG: 'C.UTF-8', npm_config_cache: path.join(tmp, 'npm'), ...env };
  /** Runs a command line (or argv) if the entity may. {code, out, refused}. */
  async function run(command, { resource = 'cmd:shell', action, timeoutMs = 600_000, network = false, isHeavy = false } = {}) {
    const what = (action || `run ${Array.isArray(command) ? command.join(' ') : command}`).slice(0, 500);
    const why = await exercise('compute', resource, 'execute', what);
    if (why) return { code: 'refused', out: why, refused: true };
    if (!hooks.exec) return { code: 'failed', out: 'this runtime runs no host programs: its host supplies none (hooks.exec)' };
    // What the host is asked for: the program, where, with what environment, and the fence the
    // entity's grants imply (it may write its work tree and scratch dir, read the system and its
    // toolchains, and reach no network unless asked).
    const go = () => hooks.exec({ command, cwd: realRepo, env: baseEnv, readOnly: fenceRead, readWrite: [realRepo, tmp, '/dev/null'], network, timeoutMs });
    return isHeavy ? withHeavySlot(go, heavy) : go();
  }

  /** Snapshot .git/config and .git/hooks; the returned check restores them and says what changed.
   *  A host runs git itself, outside any fence, so a planted hook or config entry would run unconfined. */
  function guardGit() {
    if (!isGit) return () => '';
    const gitDir = path.join(realRepo, '.git');
    const config = fs.readFileSync(path.join(gitDir, 'config'));
    const hooksDir = path.join(gitDir, 'hooks');
    const saved = new Map();
    for (const f of fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir) : []) saved.set(f, fs.readFileSync(path.join(hooksDir, f)));
    return () => {
      const what = [];
      if (!fs.readFileSync(path.join(gitDir, 'config')).equals(config)) { fs.writeFileSync(path.join(gitDir, 'config'), config); what.push('.git/config'); }
      for (const f of fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir) : []) {
        const p = path.join(hooksDir, f);
        if (!saved.has(f)) { fs.rmSync(p, { force: true, recursive: true }); what.push(`.git/hooks/${f}`); }
        else if (!fs.readFileSync(p).equals(saved.get(f))) { fs.writeFileSync(p, saved.get(f)); what.push(`.git/hooks/${f}`); }
      }
      if (what.length) alerts.push({ cycle: -1, alerts: ['git internals'], action: what.join(', ') });
      return what.length ? `the command changed ${what.join(', ')}` : '';
    };
  }

  // Files a command touched, as git sees them (ignored build output is not the tree's content).
  const contentBefore = new Map();
  function treeState(keep = true) {
    if (!isGit) return new Map();
    const out = execFileSync('git', ['-C', realRepo, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8' });
    const m = new Map();
    for (const rec of out.split('\0').filter(Boolean)) {
      const file = rec.slice(3);
      let h = 'missing';
      let bytes = null;
      try { bytes = fs.readFileSync(path.join(realRepo, file)); h = crypto.createHash('sha256').update(bytes).digest('hex'); } catch { /* deleted */ }
      m.set(file, h);
      if (bytes && keep) contentBefore.set(file, bytes);
    }
    return m;
  }
  function changedSince(before) {
    const after = treeState(false);   // (what was there before the command stays what restore puts back)
    // A file that left the list is clean now, but committing it (a merge's files, say) does not
    // change it: what counts is its content.
    const now = (f) => {
      if (after.has(f)) return after.get(f);
      try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(realRepo, f))).digest('hex'); } catch { return 'missing'; }
    };
    return [...new Set([...after.keys(), ...before.keys()])].filter((f) => now(f) !== before.get(f));
  }
  function restore(file, before) {
    // Back to what it was before the command: its earlier uncommitted content, else the committed
    // version, else gone (it is new).
    if (before.has(file) && before.get(file) !== 'missing' && contentBefore.has(file)) {
      fs.writeFileSync(path.join(realRepo, file), contentBefore.get(file));
      return;
    }
    try { execFileSync('git', ['-C', realRepo, 'checkout', '-q', 'HEAD', '--', file], { stdio: 'ignore' }); }
    catch { fs.rmSync(path.join(realRepo, file), { force: true, recursive: true }); }
  }
  /** Every file a command changed must be one the entity may write; the rest is refused (on record) and undone. */
  async function policeWrites(before, what) {
    const bad = [];
    for (const file of changedSince(before)) {
      const why = await exercise('storage', writeResource(file), 'write', `${what.slice(0, 120)} changed ${file}`);
      if (why) { restore(file, before); bad.push(file); continue; }
      if (writeScopes.has(file)) {
        // claimed by unit: what the command did to it must keep to those units
        let old = contentBefore.has(file) ? contentBefore.get(file).toString('utf8') : '';
        if (!contentBefore.has(file)) { try { old = execFileSync('git', ['-C', realRepo, 'show', `HEAD:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* new */ } }
        let now = '';
        try { now = fs.readFileSync(path.join(realRepo, file), 'utf8'); } catch { /* deleted */ }
        const unit = scopeRefusal(file, old, now);
        if (unit) {
          await exercise('storage', `path:${realRepo}/${file}#unit`, 'write', `${what.slice(0, 120)}: ${unit}`.slice(0, 300));
          restore(file, before);
          bad.push(`${file} (${unit})`);
        }
      }
    }
    return bad;
  }
  function revertAll(before) {
    const bad = changedSince(before);
    for (const f of bad) restore(f, before);
    return bad;
  }
  /** A command whose effects on the tree are policed: unwritable changes undone, git internals restored. */
  async function runPoliced(command, opts = {}) {
    contentBefore.clear();
    const before = treeState();
    const guard = guardGit();
    const r = await run(command, opts);
    const tampered = guard();
    if (tampered) await exercise('storage', `path:${realRepo}/.git`, 'write', `${String(opts.action || command).slice(0, 120)}: ${tampered}`);
    const reverted = opts.revertAll || !writer ? revertAll(before) : await policeWrites(before, String(opts.action || `run ${command}`));
    return { ...r, reverted, tampered };
  }

  // ---- work tree snapshots (git trees, without touching HEAD or the index) ----
  function snapshotTree() {
    if (!isGit) return '';
    const tmpIndex = path.join(tmp, `index-${crypto.randomBytes(6).toString('hex')}`);
    const g = (...a) => execFileSync('git', [...SAFE_GIT, '-C', realRepo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: tmpIndex }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      try { g('read-tree', 'HEAD'); } catch { /* no HEAD yet: start empty */ }
      g('add', '-A', '--', '.');
      return g('write-tree').trim();
    } finally { fs.rmSync(tmpIndex, { force: true }); }
  }
  // The work tree back to exactly a snapshot: its files written, anything else git would see removed.
  function restoreTree(tree) {
    const tmpIndex = path.join(tmp, `index-${crypto.randomBytes(6).toString('hex')}`);
    const g = (e, ...a) => execFileSync('git', [...SAFE_GIT, '-C', realRepo, ...a], { encoding: 'utf8', env: e });
    const t = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    try {
      const want = new Set(g(t, 'ls-tree', '-r', '-z', '--name-only', tree).split('\0').filter(Boolean));
      for (const f of g(process.env, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))
        if (!want.has(f)) fs.rmSync(path.join(realRepo, f), { force: true });
      g(t, 'read-tree', tree);
      g(t, 'checkout-index', '-a', '-f');
    } finally { fs.rmSync(tmpIndex, { force: true }); }
  }

  // ---- state the cycle loop and the hooks share ----
  const history = [];
  const alerts = [];
  const notes = [];
  const trees = new Map(); // cycle -> work tree at its start (aios keeps the checkpoint: cycle.record)

  /** Back to the start of cycle `to`: the entity (aios agent.rewind by cycle), the work tree, the history. */
  async function rewindTo(to) {
    if (!Number.isInteger(to) || to < 1) return { ok: false, reason: `rewind needs "to": a cycle >= 1 (got ${to})` };
    let tree = trees.get(to);
    if (!tree) {
      const rec = await ctl.call({ op: 'cycle.records', entity, cycle: to });
      tree = rec.ok ? (rec.cycles || []).map((c) => c.tree).filter(Boolean).pop() : '';
    }
    const rw = await ctl.call({ op: 'agent.rewind', entity, cycle: to });
    if (!rw.ok) return { ok: false, reason: `rewind failed: ${rw.error} (cycles you can go back to: ${[...trees.keys()].slice(-12).join(', ') || 'none'})` };
    if (tree) restoreTree(tree);
    const undone = history.filter((h) => h.cycle >= to).map((h) => `#${h.cycle} ${h.action || '?'}`);
    while (history.length && history[history.length - 1].cycle >= to) history.pop();
    for (const k of [...trees.keys()]) if (k > to) trees.delete(k);
    forgetReads();
    // The rewound image holds the grants it held then; the host decides what stands now.
    if (hooks.afterRewind) await hooks.afterRewind(ctx, to);
    else await setWritable(writable);
    return { ok: true, reason: '', undone };
  }

  const ctx = {
    entity, ctl, workdir: realRepo, scratch, writer, held, grant, exercise, inside, setWritable, writeResource,
    run, runPoliced, guardGit, snapshotTree, restoreTree, rewindTo, forgetReads, openRange, notes, history, alerts, log,
    get writable() { return writable; },
  };

  // ---- the actions ----
  async function act(a) {
    const custom = hooks.actions?.[a.action];
    if (custom) return custom(a, ctx);
    switch (a.action) {
      case 'list': case 'read': case 'search': {
        const loc = inside(a.path || '.');
        if (loc.error) return loc.error;
        const why = await exercise('storage', `tree:${realRepo}`, 'read', `${a.action} ${loc.rel || '.'}`);
        if (why) return `refused by aios: ${why}`;
        if (a.action === 'list') {
          const r = isGit ? await run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', loc.rel || '.'], { action: `list ${loc.rel || '.'}` })
            : await run(['find', loc.rel || '.', '-type', 'f'], { action: `list ${loc.rel || '.'}` });
          return clip(r.out, 20000) || '(no files)';
        }
        if (a.action === 'search') {
          if (!a.pattern) return 'search needs "pattern"';
          const r = isGit ? await run(['git', 'grep', '-n', '-I', '-E', '-e', String(a.pattern), '--', loc.rel || '.'], { action: `search ${String(a.pattern).slice(0, 100)}` })
            : await run(['grep', '-rnIE', '-e', String(a.pattern), loc.rel || '.'], { action: `search ${String(a.pattern).slice(0, 100)}` });
          return clip(r.out, 20000) || '(no matches)';
        }
        if (!fs.existsSync(loc.abs) || fs.statSync(loc.abs).isDirectory()) return `${a.path}: not a file`;
        const lines = fs.readFileSync(loc.abs, 'utf8').split('\n');
        const from = Math.max(1, Number(a.start) || 1);
        const to = Math.min(lines.length, Number(a.end) || from + 399, from + 599);
        if (isShown(loc.rel, from, to)) {
          for (const r of open.values()) if (r.path === loc.rel && r.from <= from && r.to >= to) r.used = ++useClock;
          return `${loc.rel} ${from}-${to} is already in "open files" above, exactly as the file is now (your edits included). Do not read it again: edit it, or read a part you have not opened.`;
        }
        const seen = readLines.get(loc.rel) || new Set();
        for (let n = from; n <= to; n++) seen.add(n);
        readLines.set(loc.rel, seen);
        openRange(loc.rel, from, to);
        return `${loc.rel} (${lines.length} lines)\n` + lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n');
      }
      case 'outline': {
        const loc = inside(a.path);
        if (loc.error) return loc.error;
        const why = await exercise('storage', `tree:${realRepo}`, 'read', `outline ${loc.rel}`);
        if (why) return `refused by aios: ${why}`;
        if (!fs.existsSync(loc.abs) || fs.statSync(loc.abs).isDirectory()) return `${a.path}: not a file`;
        const src = fs.readFileSync(loc.abs, 'utf8').split('\n');
        const re = /^(#{1,4} |\s{0,4}(export |static |async |inline |virtual |template<|struct |class |enum |namespace |function |const \w+ = (async )?\(|[\w:<>,*& ]+\s+[\w:~]+\([^;]*\)\s*(const)?\s*\{?\s*$)|\s{0,2}case '\w+':)/;
        const hits = src.map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l) && l.trim().length < 200);
        return `${loc.rel} (${src.length} lines)\n` + (hits.length ? hits.slice(0, 300).map(([n, l]) => `${n}\t${l.trim()}`).join('\n') : '(no symbols found; use read)');
      }
      case 'write': case 'edit': {
        if (!writer) return 'you do not edit';
        const loc = inside(a.path);
        if (loc.error) return loc.error;
        const why = await exercise('storage', writeResource(loc.rel), 'write', `${a.action} ${loc.rel}`);
        if (why) return `refused by aios: ${why}.${hooks.writeHint ? ' ' + hooks.writeHint.replace('{path}', loc.rel) : ''}`;
        const ranges = writeRanges.get(loc.rel);
        const ranged = ranges && !ranges.includes(null) ? ranges : null;
        if (a.action === 'write') {
          if (typeof a.content !== 'string') return 'write needs "content"';
          if (ranged) return `write refused: you may change only lines ${ranged.map((r) => r.join('-')).join(', ')} of ${loc.rel}; use edit within them`;
          // Replacing a file you have only seen parts of destroys the rest: read all of it, or use edit.
          if (fs.existsSync(loc.abs)) {
            const total = fs.readFileSync(loc.abs, 'utf8').split('\n').length;
            const seen = readLines.get(loc.rel)?.size || 0;
            if (seen < total) return `write refused: ${loc.rel} exists and you have read ${seen} of its ${total} lines; replacing it would lose the rest. Use edit to change part of it.`;
          }
          const unit = scopeRefusal(loc.rel, fs.existsSync(loc.abs) ? fs.readFileSync(loc.abs, 'utf8') : '', a.content);
          if (unit) return `write refused: ${unit}`;
          fs.mkdirSync(path.dirname(loc.abs), { recursive: true });
          fs.writeFileSync(loc.abs, a.content);
          return `wrote ${loc.rel} (${a.content.split('\n').length} lines)`;
        }
        if (!fs.existsSync(loc.abs)) return `${loc.rel} does not exist; use write to create it`;
        const text = fs.readFileSync(loc.abs, 'utf8');
        const n = typeof a.old === 'string' && a.old ? text.split(a.old).length - 1 : 0;
        if (n !== 1) return `edit refused: "old" occurs ${n} times in ${loc.rel}; it must occur exactly once (read the file and copy the exact text)`;
        const first = text.slice(0, text.indexOf(a.old)).split('\n').length;
        if (ranged) {
          const last = first + a.old.split('\n').length - 1;
          if (!ranged.some(([lo, hi]) => first >= lo && last <= hi + 1))
            return `edit refused: it changes lines ${first}-${last} of ${loc.rel}, outside the lines you may change (${ranged.map((r) => r.join('-')).join(', ')})`;
        }
        const edited = text.replace(a.old, () => String(a.new ?? ''));
        const unit = scopeRefusal(loc.rel, text, edited);
        if (unit) return `edit refused: ${unit}`;
        fs.writeFileSync(loc.abs, edited);
        openRange(loc.rel, Math.max(1, first - 5), first + String(a.new ?? '').split('\n').length + 5);
        return `edited ${loc.rel}`;
      }
      case 'run': {
        // A real shell, run by the host's fence: a change to a path it may not write is undone and
        // recorded, and a change to git's config or hooks does not survive.
        const command = String(a.command || '').trim();
        if (!command) return 'run needs "command"';
        const light = /^(ls|cat|head|tail|grep|wc|pwd|test|find|diff|sed -n|git (log|show|diff|status|grep|ls-files|blame))\b/.test(command);
        const r = await runPoliced(command, { timeoutMs: 1_200_000, isHeavy: !light, action: `run ${command.slice(0, 200)}` });
        if (r.refused) return `refused by aios: ${r.out}`;
        if (r.code === 0) openFromShell(command);
        return `exit ${r.code}\n${clip(r.out.slice(-12000), 12000)}${r.reverted.length ? `\nrefused by aios and reverted: the command changed ${r.reverted.join(', ')}, which you hold no write capability over` : ''}${r.tampered ? `\nrefused and restored: ${r.tampered}` : ''}`;
      }
      case 'rewind': {
        const to = Number(a.to);
        const r = await rewindTo(to);
        if (r.ok) notes.push(`rewound to the start of #${to}; undid ${r.undone.join(', ') || 'nothing'}`);
        return r.ok ? `rewound to the start of cycle ${to} (aios entity and work tree); undid ${r.undone.length} step(s)` : r.reason;
      }
      case 'delete': case 'move': {
        if (!writer) return 'you do not edit';
        const from = inside(a.path || a.from);
        if (from.error) return from.error;
        if (!fs.existsSync(from.abs)) return `${a.path || a.from} does not exist`;
        const targets = [from];
        if (a.action === 'move') {
          const to = inside(a.to);
          if (to.error) return to.error;
          if (fs.existsSync(to.abs)) return `${to.rel} already exists`;
          targets.push(to);
        }
        for (const t of targets) {
          const why = await exercise('storage', writeResource(t.rel), 'write', `${a.action} ${from.rel}${a.to ? ' -> ' + a.to : ''}`);
          if (why) return `refused by aios: ${why}.${hooks.writeHint ? ' ' + hooks.writeHint.replace('{path}', t.rel) : ''}`;
        }
        if (a.action === 'delete') { fs.rmSync(from.abs); readLines.delete(from.rel); return `deleted ${from.rel}`; }
        fs.mkdirSync(path.dirname(targets[1].abs), { recursive: true });
        fs.renameSync(from.abs, targets[1].abs);
        if (readLines.has(from.rel)) { readLines.set(targets[1].rel, readLines.get(from.rel)); readLines.delete(from.rel); }
        return `moved ${from.rel} to ${targets[1].rel}`;
      }
      case 'note': {
        const text = String(a.text || a.note || '').trim();
        if (!text) return 'note needs "text"';
        notes.push(text.slice(0, 2000));
        if (notes.length > 40) notes.shift();
        return `noted (${notes.length} notes)`;
      }
      default:
        return `unknown action "${a.action}"`;
    }
  }

  if (hooks.start) await hooks.start(ctx);
  else await hooks.grantsChanged?.(ctx);

  // ---- the cycle loop ----
  // What is the same for every agent comes first (the protocol), then what its host shares among agents (tools,
  // project), and the prompt (this agent's task) last: a provider's prompt cache then reuses the longest prefix.
  const header = `${PROTOCOL}\n${hooks.protocol ? hooks.protocol + '\n' : ''}${PROTOCOL_END}${hooks.header ? '\n\n' + hooks.header : ''}\n\n=== your task ===\n${prompt}`;
  const failed = new RegExp(`^(not an action|not run:|edit refused|write refused|done refused|unknown action|rewind failed)${hooks.failed ? '|' + hooks.failed.source : ''}`);
  let refusalsOfDone = 0;
  let finished = null;
  for (let cycle = 1; cycle <= maxCycles && !finished; cycle++) {
    if (hooks.beforeCycle) { try { await hooks.beforeCycle(ctx, cycle); } catch { /* a host that cannot be asked does not stop the cycle */ } }
    const lines = history.map((h, i) => {
      const recent = i >= history.length - RECENT_FULL && h.action !== 'read';
      return recent
        ? `#${h.cycle} you: ${clip(h.reply, 3000)}\nresult: ${clip(h.observation, RESULT_CHARS)}`
        : `#${h.cycle} ${h.action || '?'} ${clip(h.reply.replace(/\s+/g, ' '), 160)} -> ${h.observation.split('\n')[0].slice(0, 120)}`;
    });
    const noteText = notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(none yet: use the note action to keep what you learn)';
    const openText = renderOpen();
    const closed = dropped.length ? `\n(closed to stay within your window, re-read only what you will edit: ${dropped.join(', ')})` : '';
    dropped = [];
    const context = `${header}\n\n=== open files (what you have read, as the files are now; no need to read them again) ===\n${openText || '(none yet)'}${closed}\n\n=== your notes (kept for the whole task) ===\n${noteText}\n\n=== history (oldest first) ===\n${lines.join('\n\n') || hooks.emptyHistory || '(nothing yet)'}\n\n=== your next action (one JSON object) ===`;
    await ctl.must({ op: 'agent.send', entity, input: context });
    // An empty reply, or a CLI's own tool-call parse failure, is the provider failing, not the mind answering: retry.
    let ran = await ctl.call({ op: 'cycle.run', entity });
    const providerFailed = (r) => r.ok && (!String(r.report?.answer || '').trim() || /^The model's tool call could not be parsed/.test(String(r.report?.answer)));
    for (let retry = 0; retry < 2 && providerFailed(ran); retry++) {
      await new Promise((r) => setTimeout(r, 5000));
      await ctl.must({ op: 'agent.send', entity, input: context });
      ran = await ctl.call({ op: 'cycle.run', entity });
    }
    if (!ran.ok) { log({ cycle, error: ran.error }); history.push({ cycle, reply: '(no reply)', observation: `the mind failed: ${ran.error}` }); continue; }
    const reply = String(ran.report?.answer || '').trim();
    // Where this cycle starts: the entity's checkpoint (kept by aios) and the work tree.
    let checkpoint = '';
    const tree = writer ? snapshotTree() : '';
    if (writer) {
      try {
        const cp = await ctl.call({ op: 'agent.checkpoint', entity });
        if (cp.ok) { checkpoint = cp.checkpoint; trees.set(cycle, tree); }
      } catch { /* a missing checkpoint only means this cycle cannot be rewound to */ }
    }
    let a = parseAction(reply);
    if (a && hooks.mapAction) a = hooks.mapAction(a, ctx);
    let observation;
    if (!a || typeof a.action !== 'string') observation = 'not an action: reply with exactly one JSON object from the protocol';
    else if (a.action === '__invalid') observation = `not run: your action is not valid JSON (${a.error}). Nothing changed. Send it again as one JSON object, strings escaped (\\n for newlines, \\" for quotes); a large edit is safer as several smaller ones.`;
    else if (a.action === 'done') {
      const pending = hooks.doneGate ? await hooks.doneGate(ctx) : [];
      if (pending.length && (refusalsOfDone < 3 || !writer)) {
        refusalsOfDone++;
        observation = `done refused: ${pending.join('; ')}. Keep working.`;
      } else {
        finished = { summary: String(a.summary || ''), outstanding: pending };
        observation = 'finished';
      }
    } else observation = await act(a);
    if (a?.ignored) observation = `${observation}\n(only this first action ran; the ${a.ignored} other action(s) in your reply were ignored: send one per reply)`;
    const obs = String(observation);
    const entry = { cycle, reply: clip(reply, 4000), action: a?.action || null, observation: clip(obs, 24000) };
    const flagged = alertsFor(a ? JSON.stringify(a) : reply, hooks.alerts || []);
    // Refused = a boundary held (aios, the host's fence, the work tree). A gate saying "not yet" is the
    // model being wrong, not the lock working.
    if (/^(refused by aios|the \.git directory|.* is outside your work tree)|\n(refused by aios and reverted|refused and restored):/.test(obs)) flagged.push('refused');
    if (flagged.length) { entry.alerts = flagged; alerts.push({ cycle, alerts: flagged, action: clip(a ? JSON.stringify(a) : reply, 600) }); }
    history.push(entry);
    log(entry);
    const verdict = flagged.includes('refused') ? 'refused' : !a || failed.test(obs) ? 'failed' : 'allowed';
    const target = !a ? '' : a.path || a.command || (a.tool ? `${a.tool}${a.tool === 'claim' ? ' ' + (a.arguments?.paths || []).join(',') : ''}` : '') || a.message || a.summary || '';
    const record = { cycle, action: a?.action || '(none)', target: String(target).slice(0, 300), verdict, reason: verdict === 'allowed' ? '' : obs.split('\n')[0].slice(0, 400),
      reply, observation: obs, checkpoint, tree, alerts: flagged.filter((f) => f !== 'refused') };
    // The work tree after the cycle, computed only if a host asks (it costs a git add of the tree).
    Object.defineProperty(record, 'treeAfter', { get: () => (writer ? snapshotTree() : ''), enumerable: false });
    try {
      await ctl.call({ op: 'cycle.record', entity, cycle, action: record.action, target: record.target, verdict, reason: record.reason,
        reply: clip(reply, 16000), observation: clip(obs, 32000), ...(checkpoint ? { checkpoint } : {}), ...(tree ? { tree } : {}) });
    } catch { /* the record is a convenience; the ledger already has the decision */ }
    if (hooks.afterCycle) { try { await hooks.afterCycle(ctx, record); } catch { /* reporting never stops the agent */ } }
    if (!finished && hooks.finishedBy) {
      try { const summary = await hooks.finishedBy(ctx, record); if (summary) { finished = { summary: String(summary), outstanding: [] }; log({ cycle, action: 'done', observation: `finished: ${summary}` }); } } catch { /* not done */ }
    }
  }

  if (writer && !finished && hooks.outOfCycles) { try { await hooks.outOfCycles(ctx); } catch { /* best effort */ } }
  const events = (await ctl.call({ op: 'ledger.events', entity })).events || [];
  await ctl.call({ op: 'agent.terminate', entity });
  return { entity, finished, cycles: history.length, ledger: events, alerts };
}
