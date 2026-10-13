// An agent's own log (its universal-agent.log), as a conversation the dashboard can follow live: each step's call
// (a command, a read, an edit, a converge tool) and what came back, plus the harness's notes (started, checked,
// finished). Finds the agent's folder under a run's folder: agents/converge.mjs leaves agent.json in it; older runs
// are found through the swarm's per-task logs ("a-1234 (model) on t-…" then "workdir <dir>/repo").
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const where = new Map(); // agent -> its folder

export function agentDir(runDirs, agent) {
  if (where.has(agent) && fs.existsSync(where.get(agent))) return where.get(agent);
  for (const run of runDirs) {
    let names = [];
    try { names = fs.readdirSync(run, { withFileTypes: true }); } catch { continue; }
    for (const d of names.filter((x) => x.isDirectory())) {
      try { if (JSON.parse(fs.readFileSync(path.join(run, d.name, 'agent.json'), 'utf8')).agent_id === agent) { where.set(agent, path.join(run, d.name)); return where.get(agent); } } catch { /* none */ }
    }
    for (const f of names.filter((x) => x.isFile() && x.name.endsWith('.log'))) {
      let text = '';
      try { text = fs.readFileSync(path.join(run, f.name), 'utf8'); } catch { continue; }
      const at = text.indexOf(`${agent} (`);
      if (at < 0) continue;
      const m = /workdir\s+(\S+)\/repo/.exec(text.slice(at, at + 2000));
      if (m) { where.set(agent, m[1]); return m[1]; }
    }
  }
  return '';
}


// What a step actually did: universal-agent.log says "run()" with no arguments, but the agent's transcript.jsonl keeps each
// cycle's reply (the JSON action: its command, path, patch...), and cycle N is step N. The first JSON object of a reply is
// the action; a reply in the model's own tool-call markup instead of JSON ("not an action") is shown as what it tried.
const tcache = new Map(); // transcript path -> { sig, byCycle }
function firstObject(text) {
  const t = String(text || '');
  for (let from = t.indexOf('{'); from >= 0 && from < 4000; from = t.indexOf('{', from + 1)) {
    let depth = 0, str = false;
    for (let i = from; i < t.length; i++) {
      const c = t[i];
      if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(t.slice(from, i + 1)); } catch { break; } }
    }
  }
  return null;
}
function markup(reply) {
  const m = /invoke name="([^"]+)"/.exec(reply);
  if (!m) return '';
  const first = /<[^>]*parameter name="[^"]+"[^>]*>([^<]*)</.exec(reply);
  return `${m[1]}${first ? ` ${first[1].trim().replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
}
function transcriptByCycle(dir) {
  const file = path.join(dir, 'transcript.jsonl');
  let st;
  try { st = fs.statSync(file); } catch { return new Map(); }
  const sig = `${st.size}:${st.mtimeMs}`;
  const hit = tcache.get(file);
  if (hit && hit.sig === sig) return hit.byCycle;
  const byCycle = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return byCycle; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const act = firstObject(j.reply);
    if (act && typeof act === 'object') { const { action, ...args } = act; byCycle.set(j.cycle, { action, args }); }
    else { const tried = markup(String(j.reply || '')); if (tried) byCycle.set(j.cycle, { action: '', tried }); }
  }
  tcache.set(file, { sig, byCycle });
  return byCycle;
}

const CLIP = 4000;
/** The log as entries { i, at, step, kind: call|result|note, tool, text }, those after `after` (an entry index). */
export function readAgentLog(dir, after = -1, max = 400) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'universal-agent.log'), 'utf8'); } catch { return { entries: [], total: 0, missing: true }; }
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] (.*)$/.exec(line);
    if (!m) { if (cur && !/^\(node:\d+\)|^\(Use `node --trace/.test(line)) cur.text += `\n${line}`; continue; }
    const body = m[2];
    const step = /^\[step (\d+)\] (.*)$/s.exec(body);
    if (step && step[2].startsWith('-> ')) cur = { at: m[1], step: Number(step[1]), kind: 'result', tool: '', text: step[2].slice(3) };
    else if (step) {
      // "tool(args) [native]", the args sometimes running on to the next lines; a step line that is not a call is a note.
      const call = /^([a-z][\w.-]*)\((.*)$/s.exec(step[2]);
      cur = call ? { at: m[1], step: Number(step[1]), kind: 'call', tool: call[1], text: call[2].replace(/\)(?: \[\w+\])?$/, '') }
        : { at: m[1], step: Number(step[1]), kind: 'note', tool: '', text: step[2] };
    } else cur = { at: m[1], step: null, kind: 'note', tool: '', text: body };
    entries.push(cur);
  }
  const cycles = transcriptByCycle(dir);
  const out = entries.map((e, i) => {
    let t = e.text;
    if (e.kind === 'call' && !t.trim() && e.step != null) {
      const c = cycles.get(e.step);
      if (c?.args && Object.keys(c.args).length) t = JSON.stringify(c.args);
      else if (c?.tried) t = `replied in the wrong format (not the JSON protocol): ${c.tried}`;
    }
    if (e.kind === 'call') t = t.replace(/\)(?: \[\w+\])?\s*$/, '');
    return { ...e, i, text: t.length > CLIP ? `${t.slice(0, CLIP)}\n… (${t.length - CLIP} more characters)` : t };
  });
  const from = Math.max(after + 1, out.length - max);
  return { entries: out.slice(from), total: out.length };
}

// ---- an agent at a glance: what its steps went on, and what its model calls cost ----
// From the agent's transcript.jsonl (one line per step: the reply's action and what came back) and its run's
// usage/registry-events.jsonl (one line per model call, naming the agent since converge 2026-10-09). Older runs
// carry no agent on their usage lines: then the calls are not known per agent (model: null).
let pricing = null;
// fileURLToPath: a URL's pathname is /C:/... on Windows, which no require finds.
try { pricing = createRequire(import.meta.url)(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents', 'universal', 'pricing.cjs')); } catch { /* no table: calls without a price */ }
const LOOKING = new Set(['read', 'search', 'list', 'outline']);
const CHANGING = new Set(['edit', 'write', 'move', 'delete']);
const READ_ONLY_SHELL = /^\s*(sed\s+-n|cat|head|tail|nl|grep|rg|ls|find|wc|tree|git\s+(show|log|diff|status|grep|ls-files|blame))\b/;

// The universal agent's own tools (an agent run outside aios logs to universal-agent.log, not transcript.jsonl).
const UA_LOOKING = /^(read_file|list_dir|search_code|glob|grep|outline|view|find_files)$/;
const UA_CHANGING = /^(edit_file|write_file|create_file|delete_file|move_file|apply_patch|multi_edit)$/;
const UA_RUNNING = /^(run_command|bash|shell|exec)$/;

/** A logged call's arguments. The universal agent cuts a long one short in its log ("...[truncated, N chars total]",
 *  an edit's find/replace text), which is no longer JSON: the fields the summary needs are read out of it as they
 *  stand, so a long edit still names its file. */
function logArgs(text) {
  try { return JSON.parse(text); } catch { /* cut short */ }
  const out = { text };
  for (const k of ['path', 'command', 'tool', 'name', 'pattern']) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
    if (m) { try { out[k] = JSON.parse(`"${m[1]}"`); } catch { out[k] = m[1]; } }
  }
  return out;
}

/** agentSummary for an agent with no transcript: its steps as universal-agent.log records them. */
function summaryFromLog(dir) {
  const { entries } = readAgentLog(dir, -1, 100000);
  if (!entries.length) return null;
  const kinds = { looking: 0, changing: 0, running: 0, notes: 0, converge: 0, invalid: 0 };
  const tools = {};
  const seen = new Map();
  const files = new Set();
  const list = [];
  let steps = 0, repeats = 0, firstChange = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind !== 'call') continue;
    steps++;
    const args = logArgs(e.text);
    const result = entries[i + 1]?.kind === 'result' && entries[i + 1].step === e.step ? String(entries[i + 1].text || '') : '';
    const key = `${e.tool} ${e.text}`;
    const again = seen.get(key);
    if (again != null) repeats++; else seen.set(key, e.step);
    let kind = 'other';
    if (UA_LOOKING.test(e.tool)) kind = 'looking';
    else if (UA_CHANGING.test(e.tool)) { kind = 'changing'; if (args.path) files.add(String(args.path)); if (firstChange == null) firstChange = e.step; }
    else if (UA_RUNNING.test(e.tool)) kind = READ_ONLY_SHELL.test(String(args.command || '')) ? 'looking' : 'running';
    else if (/^mcp_/.test(e.tool)) { kind = 'converge'; const t = String(args.tool || args.name || e.tool); tools[t] = (tools[t] || 0) + 1; }
    if (kind === 'converge') kinds.converge++; else if (kind !== 'other') kinds[kind]++;
    const target = args.path ? `${args.path}${args.start ? ` ${args.start}–${args.end ?? 'end'}` : ''}` : args.command ? short(args.command, 140) : args.pattern ? `"${short(args.pattern, 70)}"` : short(args.tool || args.name || e.text, 120);
    list.push({ n: e.step, kind: kind === 'converge' ? 'converge' : kind, action: e.tool, target, outcome: stepOutcome(e.tool, result), ...(again != null ? { repeat_of: again } : {}) });
  }
  // What converge said while the agent got ready (run.mjs writes "converge: ..." lines): its copy of the code, main
  // merged in, what it picked up from the agent before it, starting. Plain words, shown above its steps.
  const setup = entries.filter((e) => e.kind === 'note' && e.step == null && /^converge: /.test(e.text) && !/^converge: the agent runs under /.test(e.text))
    .map((e) => ({ at: e.at, text: e.text.slice('converge: '.length) }));
  return { steps, ...kinds, converge_tools: tools, repeats, files_changed: [...files], first_change: firstChange, commits: 0, model: modelUse(dir), notebook: [], list: list.slice(-300), setup };
}

export function agentSummary(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8'); } catch { return summaryFromLog(dir); }
  if (!text.trim()) return summaryFromLog(dir);
  const kinds = { looking: 0, changing: 0, running: 0, notes: 0, converge: 0, invalid: 0 };
  const tools = {};
  const seen = new Map();
  const files = new Set();
  const list = [];   // one line per step: what it did, to what, and what came back
  const notebook = [];  // the agent's own notes, in full: what it concluded and means to do
  let steps = 0, repeats = 0, firstChange = null, commits = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.cycle == null) continue;
    steps++;
    const act = firstObject(j.reply);
    const action = act && typeof act === 'object' ? String(act.action || '') : '';
    const obs = String(j.observation ?? j.error ?? '');
    if (!action || action === '__invalid' || /^not (an action|run:)/.test(obs)) {
      kinds.invalid++;
      list.push({ n: j.cycle, kind: 'invalid', action: action || '?', target: 'not a valid action', outcome: obs.split('\n')[0].slice(0, 160) });
      continue;
    }
    const { action: _a, ...args } = act;
    const key = `${action} ${JSON.stringify(args)}`;
    const again = seen.get(key);
    if (again != null) repeats++; else seen.set(key, j.cycle);
    if (action === 'note') notebook.push({ n: j.cycle, text: String(args.text || args.note || '') });
    list.push({ n: j.cycle, kind: stepKind(action, args), action: action === 'converge' ? String(args.tool || 'converge') : action, target: stepTarget(action, args),
      outcome: stepOutcome(action, obs), ...(again != null ? { repeat_of: again } : {}) });
    if (LOOKING.has(action)) kinds.looking++;
    else if (CHANGING.has(action)) { kinds.changing++; if (args.path) files.add(String(args.path)); if (firstChange == null) firstChange = j.cycle; }
    else if (action === 'note') kinds.notes++;
    else if (action === 'run') { if (READ_ONLY_SHELL.test(String(args.command || ''))) kinds.looking++; else kinds.running++; }
    else if (action === 'converge') { kinds.converge++; const t = String(args.tool || '?'); tools[t] = (tools[t] || 0) + 1; }
    else if (action === 'commit') commits++;
  }
  return { steps, ...kinds, converge_tools: tools, repeats, files_changed: [...files], first_change: firstChange, commits, model: modelUse(dir),
    notebook, list: list.slice(-300) };
}

/** What an agent's model calls came to, priced as the swarm prices them (usage lines that name the agent). */
function modelUse(dir) {
  let model = null;
  try {
    const events = fs.readFileSync(path.join(path.dirname(dir), 'usage', 'registry-events.jsonl'), 'utf8').split('\n');
    const agent = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')).agent_id;
    let calls = 0, tin = 0, tout = 0, cache = 0, usd = 0, estimated = false;
    for (const l of events) {
      if (!l.includes(`"agent":"${agent}"`)) continue;
      let ev; try { ev = JSON.parse(l); } catch { continue; }
      if (ev.t !== 'usage' || ev.agent !== agent) continue;
      calls++; tin += Number(ev.tin) || 0; tout += Number(ev.tout) || 0; cache += Number(ev.cache) || 0;
      estimated ||= Boolean(ev.estimated);
      if (pricing && ev.ref) { const cut = ev.ref.indexOf('/'); usd += pricing.costOf(ev.ref.slice(0, cut), ev.ref.slice(cut + 1), Number(ev.tin) || 0, Number(ev.tout) || 0, Number(ev.cache) || 0).usd; }
    }
    if (calls) model = { calls, tokens_in: tin, tokens_out: tout, cached: cache, per_call_in: Math.round(tin / calls), usd: Math.round(usd * 10000) / 10000, estimated };
  } catch { /* no usage on record for this run */ }
  return model;
}

function stepKind(action, args) {
  if (LOOKING.has(action)) return 'looking';
  if (CHANGING.has(action)) return 'changing';
  if (action === 'note') return 'note';
  if (action === 'converge') return 'converge';
  if (action === 'run') return READ_ONLY_SHELL.test(String(args.command || '')) ? 'looking' : 'running';
  return 'other';
}
const short = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
function stepTarget(action, a) {
  switch (action) {
    case 'read': return `${a.path || ''}${a.start ? ` ${a.start}–${a.end ?? 'end'}` : ''}`;
    case 'search': return `"${short(a.pattern, 70)}"${a.path ? ` in ${a.path}` : ''}`;
    case 'list': case 'outline': case 'delete': return String(a.path || '.');
    case 'write': return `${a.path || ''} (${String(a.content || '').split('\n').length} lines)`;
    case 'edit': return `${a.path || ''} (${String(a.old || '').split('\n').length} → ${String(a.new || '').split('\n').length} lines)`;
    case 'move': return `${a.path || ''} → ${a.to || ''}`;
    case 'run': return short(a.command, 140);
    case 'note': return short(a.text || a.note, 140);
    case 'converge': {
      const g = a.arguments || {};
      return Array.isArray(g.paths) ? `${g.paths.length} path(s): ${short(g.paths.join(', '), 110)}` : short(g.summary || g.message || JSON.stringify(g) === '{}' ? '' : JSON.stringify(g), 110);
    }
    default: return short(a.summary || a.message || JSON.stringify(a), 120);
  }
}
function stepOutcome(action, obs) {
  const lines = obs.split('\n');
  if (LOOKING.has(action) && action !== 'search' && !/^(no such|not |refused)/i.test(lines[0])) return `${Math.max(0, lines.length - 1)} lines`;
  const first = short(lines[0], 140);
  return lines.length > 2 ? `${first} (${lines.length} lines)` : first;
}
