// Activity, in the order it happened (newest at the bottom): the milestones (claimed, pushed, handed in, a check,
// landed) one line each, and between an agent's milestones its tool steps folded into one cluster line ("ran 8
// commands · edited 2 files") that counts up live and opens to the steps. Rows carry keys, so an update only adds
// or changes the rows that changed (see keyed.js).

import { h } from '../dom.js';
import { nowMs, shortSha, timeAgo, plural, formatStepTarget, formatObsSnippet } from '../format.js';

const CHECK = { project: 'project tests', accept: 'done-when check', claim: 'files check', evidence: 'proof check', tests: 'its own tests' };
const short = (s, n = 64) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

function milestone(ev, agentOf) {
  switch (ev.type) {
    case 'TaskCreated': return ['', 'info', `new task: ${short(ev.title)}`];
    case 'AgentAdded': return [ev.agent_id, 'dim', `joined as ${ev.role}`];
    case 'IntentClaimed': return [ev.agent_id, '', `working on ${short((ev.paths || []).map((p) => String(p).split(':')[0]).join(', '), 56)}`];
    case 'Pushed': return [ev.agent_id, 'dim', `saved ${shortSha(ev.commit, 7)}${ev.signer ? ' (signed)' : ''}`];
    case 'PushRefused': return [ev.agent_id, 'bad', `push ${shortSha(ev.commit, 7)} refused: ${short((ev.why || [])[0], 48)}`];
    case 'AgentKeySet': return [ev.agent_id, 'dim', `signs with ${short(ev.fingerprint, 24)}${ev.by === 'operator' ? ' (set by the operator)' : ''}`];
    case 'CombinedFailed': return ['', 'bad', `main failed its checks as a whole${ev.undone ? `: ${(ev.changes || []).length} landing(s) undone` : ''}`];
    case 'Submitted': return [ev.agent_id, 'info', 'submitted for checks'];
    case 'Verified': return [agentOf(ev.change_id), ev.exit_code === 0 ? 'good' : 'bad', `${CHECK[ev.kind] || CHECK.tests} ${ev.exit_code === 0 ? 'passed' : ev.timed_out ? 'timed out' : 'failed: sent back'}`];
    case 'Conflicted': return [agentOf(ev.change_id), 'warn', 'clashes with main, redoing'];
    case 'Landed': return [agentOf(ev.change_id), 'good', `landed on main ${shortSha(ev.commit, 7)}`];
    case 'Superseded': return [agentOf(ev.change_id), 'dim', 'replaced by a newer try'];
    case 'Decided': return [ev.by, ev.kind === 'ship' ? 'good' : 'warn', ev.kind === 'ship' ? `picked ${ev.change_id}` : `held: ${short(ev.reason, 48)}`];
    case 'Rewound': return [ev.agent_id, 'warn', `rewound to before step ${ev.cycle}`];
    case 'MainRewound': return ['', 'warn', `main rewound to ${shortSha(ev.to_commit, 7)}`];
    case 'ChangeStacked': return [ev.agent_id, 'info', `stacking the next change on ${ev.on_change}`];
    case 'ChangeSwitched': return [ev.agent_id, 'dim', `back on ${ev.change_id}`];
    case 'Undone': return ['', 'warn', `undid #${ev.target_seq}: ${short(ev.what, 48)}`];
    case 'Restacked': return [agentOf(ev.change_id), 'info', `rebased onto ${ev.onto_change} ${shortSha(ev.onto, 7)}`];
    case 'LandedOn': return [agentOf(ev.change_id), 'good', `landed on ${ev.target} ${shortSha(ev.commit, 7)}`];
    case 'TargetHeld': return [agentOf(ev.change_id), 'warn', `held for ${ev.target}: ${short(ev.why, 48)}`];
    default: return null;
  }
}

const KINDS = [['run', 'ran', 'command'], ['edit', 'edited', 'file'], ['write', 'wrote', 'file'], ['read', 'read', 'file'], ['converge', 'asked converge', 'time']];
const ICON = { run: '$', edit: '✎', write: '✎', read: '›', converge: '⇄', done: '✓' };

function clusterText(steps) {
  const parts = [];
  for (const [k, verb, noun] of KINDS) {
    const n = steps.filter((s) => s.action === k).length;
    if (n) parts.push(k === 'converge' ? `asked converge ${plural(n, 'time')}` : `${verb} ${plural(n, noun)}`);
  }
  const other = steps.filter((s) => !KINDS.some(([k]) => k === s.action) && s.action !== 'done').length;
  if (other) parts.push(`${plural(other, 'other step')}`);
  if (steps.some((s) => s.action === 'done')) parts.push('finished');
  return parts.join(' · ') || plural(steps.length, 'step');
}

// ---- hand-ins: a try is one hand-in and what came of it (its checks, a clash, landing), as ONE row, not one per
// check. The same agent sent back again for the same reasons stacks onto that row (×3). Shared with the details
// flyout (work.js), which shows a task's story as its tries.
const CHECK_SHORT = { project: 'tests', accept: 'done-when', claim: 'scope', evidence: 'proof', tests: 'tests' };
export const checkShort = (kind) => CHECK_SHORT[kind] || 'tests';
const TRY_EVENTS = new Set(['Submitted', 'Verified', 'Conflicted', 'Landed', 'Superseded']);
/** The tries in `events` (oldest first): { key, change, agent, n (its try number), seq, at, startAt, checks: [{kind, ok,
 *  timed_out, output_tail, command}], outcome: checking|sent back|clash|passed|landed|replaced, events }. */
export function triesOf(events, agentOf) {
  const tries = [];
  const open = new Map(); // change -> its latest try
  const count = new Map(); // agent -> tries so far
  const start = (ev, change) => {
    const agent = ev.agent_id || agentOf(change);
    const n = (count.get(agent) || 0) + 1;
    count.set(agent, n);
    const t = { key: `t:${change}:${ev.seq}`, change, agent, n, seq: ev.seq, at: ev.at, startAt: ev.at, checks: [], outcome: 'checking', events: [] };
    tries.push(t); open.set(change, t);
    return t;
  };
  for (const ev of events) {
    if (!TRY_EVENTS.has(ev.type) || !ev.change_id) continue;
    let t = open.get(ev.change_id);
    // A try is a hand-in. A change only pushed and then taken over (its work saved, never handed in) is not one.
    if (!t && ev.type === 'Superseded') continue;
    if (ev.type === 'Submitted' || !t) t = start(ev, ev.change_id);
    t.events.push(ev); t.seq = ev.seq; t.at = ev.at || t.at;
    if (ev.type === 'Verified') {
      const prev = t.checks.findIndex((c) => c.kind === (ev.kind || 'tests'));
      const c = { kind: ev.kind || 'tests', ok: ev.exit_code === 0, timed_out: ev.timed_out, output_tail: ev.output_tail, command: ev.command };
      if (prev >= 0) t.checks[prev] = c; else t.checks.push(c);
    }
    if (ev.type === 'Conflicted') t.outcome = 'clash';
    if (ev.type === 'Landed') t.outcome = 'landed';
    if (ev.type === 'Superseded') t.outcome = 'replaced';
    if (!['clash', 'landed', 'replaced'].includes(t.outcome)) t.outcome = t.checks.some((c) => !c.ok) ? 'sent back' : t.checks.length ? 'passed' : 'checking';
  }
  return tries;
}
const failSig = (t) => `${t.outcome}|${t.checks.filter((c) => !c.ok).map((c) => c.kind).sort().join(',')}`;
/** The tries as feed rows: consecutive tries of one agent that came back for the same reasons become one row (×n). */
function tryRows(tries) {
  const rows = [];
  const last = new Map(); // agent -> its latest try row
  for (const t of tries) {
    const prev = last.get(t.agent);
    if (prev && ['sent back', 'clash'].includes(t.outcome) && failSig(prev.try) === failSig(t)) {
      prev.times += 1; prev.n2 = t.n; prev.seq = t.seq; prev.at = t.at; prev.try = t;
      continue;
    }
    const row = { kind: 'try', key: t.key, seq: t.seq, at: t.at, agent: t.agent, change: t.change, try: t, n1: t.n, n2: t.n, times: 1 };
    rows.push(row); last.set(t.agent, row);
  }
  return rows;
}
/** "try 2 sent back: ✓ scope ✓ proof ✗ tests" */
function tryText(t, n1 = t.n, n2 = t.n, times = 1) {
  const which = n1 === n2 ? `try ${n1}` : `tries ${n1}–${n2}`;
  const marks = t.checks.map((c) => `${c.ok ? '✓' : '✗'} ${checkShort(c.kind)}${c.timed_out ? ' (timed out)' : ''}`).join('  ');
  const what = { checking: 'submitted, checking', 'sent back': 'sent back', clash: 'clashed with main, redoing', passed: 'passed', landed: 'landed on main', replaced: 'replaced by a newer try' }[t.outcome];
  return `${which} ${what}${times > 1 ? ` ×${times}` : ''}${marks ? `: ${marks}` : ''}`;
}
const TRY_TONE = { checking: 'info', 'sent back': 'bad', clash: 'warn', passed: 'good', landed: 'good', replaced: 'dim' };

// Channels: milestones (the default: progress, with everyone's tool steps rolled into one "swarm pulse" line per
// half minute), alerts (only what needs a person), the merge train, and every step (each agent's clusters).
// A try sent back is routine (its agent tries again; the flow strip counts it): it shows in Milestones and the
// train, not in Alerts. Alerts are aios refusals, a reviewer's hold, an agent sent back STUCK times in a row for the
// same reasons, and what the board passes in (`extra`: escalations, paused workstreams, clashes, quiet tasks).
export const CHANNELS = [['milestones', 'Milestones'], ['alerts', 'Alerts'], ['train', 'Merge queue'], ['steps', 'All steps']];
const STUCK = 3;
const ALERT = (ev) => (ev.type === 'Acted' && ev.verdict === 'refused') || (ev.type === 'Decided' && ev.kind !== 'ship');
const TRAIN = (ev) => ['Submitted', 'Verified', 'Landed', 'Conflicted', 'Superseded', 'Decided', 'MainRewound', 'Undone', 'LandedOn', 'TargetHeld', 'CombinedFailed', 'PushRefused'].includes(ev.type);
const PULSE_MS = 30_000;

/** The feed's rows, oldest first, up to `upto` (an event number, for the rewind tape) and at most `max`. */
export function feedRows(state, { upto = Infinity, max = 160, channel = 'steps', only = null, extra = [] } = {}) {
  const agentOf = (changeId) => state.changes.find((c) => c.change_id === changeId)?.agent_id || '';
  const taskOf = new Map();
  for (const t of state.tasks) for (const a of t.agents) taskOf.set(a, t.title);
  for (const c of state.changes) if (!taskOf.has(c.agent_id)) taskOf.set(c.agent_id, state.tasks.find((t) => t.task_id === c.task_id)?.title || '');
  const events = [...state.recent, ...Object.values(state.acts || {}).flat()]
    .filter((e) => typeof e.seq === 'number' && e.seq <= upto).sort((a, b) => a.seq - b.seq)
    .filter((e) => !only || only.has(e.agent_id || agentOf(e.change_id || '')) || (e.type === 'TaskCreated' && only.tasks?.has(e.task_id)))
    // The engine records a task again each time an agent joins it: "new task" once.
    .filter(((seen) => (e) => e.type !== 'TaskCreated' || (!seen.has(e.task_id) && seen.add(e.task_id)))(new Set()));
  const tries = tryRows(triesOf(events, agentOf));
  const withTask = (rows) => { for (const r of rows) r.task = r.task || (r.agent ? taskOf.get(r.agent) || '' : ''); return rows; };
  if (channel === 'alerts') {
    const rows = [];
    for (const ev of events.filter(ALERT)) {
      const [agent, tone, text] = ev.type === 'Acted' ? [ev.agent_id, 'bad', `blocked: ${ev.action} ${short(ev.target, 48)}`] : milestone(ev, agentOf);
      rows.push({ kind: 'event', key: `e:${ev.seq}`, seq: ev.seq, at: ev.at, agent, tone, text, change: ev.change_id || '' });
    }
    const latest = new Map(tries.map((r) => [r.agent, r])); // still stuck: the agent's newest row is the stack
    for (const r of tries) if (r.times >= STUCK && latest.get(r.agent) === r && ['sent back', 'clash'].includes(r.try.outcome)) rows.push({ ...r, key: `s:${r.key}`, stuck: true });
    for (const x of extra.filter((x) => !only || only.has(x.agent))) rows.push({ kind: 'event', seq: Infinity, ...x });
    return withTask(rows.sort((a, b) => (a.at || 0) - (b.at || 0))).slice(-max);
  }
  if (channel === 'milestones') return withTask(pulseRows(state, events.filter((e) => !TRY_EVENTS.has(e.type)), agentOf, taskOf).concat(tries).sort((a, b) => a.seq - b.seq)).slice(-max);
  if (channel === 'train') return withTask(tries.concat(events.filter((e) => ['Decided', 'MainRewound'].includes(e.type)).map((ev) => { const [agent, tone, text] = milestone(ev, agentOf); return { kind: 'event', key: `e:${ev.seq}`, seq: ev.seq, at: ev.at, agent, tone, text, change: ev.change_id || '' }; })).sort((a, b) => a.seq - b.seq)).slice(-max);
  const rows = [...tries];
  const open = new Map(); // agent -> its cluster still taking steps
  for (const ev of events) {
    if (ev.type === 'Acted') {
      let c = open.get(ev.agent_id);
      if (!c) { c = { kind: 'cluster', key: `c:${ev.agent_id}:${ev.seq}`, agent: ev.agent_id, steps: [] }; open.set(ev.agent_id, c); rows.push(c); }
      c.steps.push(ev);
      c.seq = ev.seq; c.at = ev.at;
      continue;
    }
    if (TRY_EVENTS.has(ev.type)) { const a = ev.agent_id || agentOf(ev.change_id || ''); if (a) open.delete(a); continue; } // in its try row
    const m = milestone(ev, agentOf);
    if (!m) continue;
    const [agent, tone, text] = m;
    if (agent) open.delete(agent); // its next steps start a new cluster
    rows.push({ kind: 'event', key: `e:${ev.seq}`, seq: ev.seq, at: ev.at, agent, tone, text, change: ev.change_id || '' });
  }
  rows.sort((a, b) => a.seq - b.seq);
  for (const r of rows) r.task = r.agent ? taskOf.get(r.agent) || '' : '';
  return rows.slice(-max);
}

/** Milestones: each milestone one line, and the tool steps of everyone in each half minute one "swarm pulse" line. */
function pulseRows(state, events, agentOf, taskOf) {
  for (const t of state.tasks) for (const a of t.agents) taskOf.set(a, t.title);
  const rows = [];
  let pulse = null;
  for (const ev of events) {
    if (ev.type === 'Acted') {
      const bucket = Math.floor((ev.at || 0) / PULSE_MS);
      if (!pulse || pulse.bucket !== bucket) { pulse = { kind: 'pulse', key: `p:${bucket}`, bucket, steps: [], agents: new Set() }; rows.push(pulse); }
      pulse.steps.push(ev); pulse.agents.add(ev.agent_id); pulse.seq = ev.seq; pulse.at = ev.at;
      continue;
    }
    if (ev.type === 'AgentAdded' || ev.type === 'Pushed' || ev.type === 'IntentReleased') continue; // routine at scale
    const m = milestone(ev, agentOf);
    if (!m) continue;
    const [agent, tone, text] = m;
    rows.push({ kind: 'event', key: `e:${ev.seq}`, seq: ev.seq, at: ev.at, agent, tone, text, change: ev.change_id || '', task: agent ? taskOf.get(agent) || '' : '' });
  }
  // An agent handing its task to the next one acts in the same half minute as its successor: count each task (a slot
  // an agent holds) once, so "3 agents active" means three things being worked on, not four ids.
  for (const r of rows) if (r.kind === 'pulse') r.slots = new Set([...r.agents].map((a) => taskOf.get(a) || a)).size;
  return rows.sort((a, b) => a.seq - b.seq);
}

const clock = (at) => (at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');

/** One keyed item per row, for reconcile(). `ui.openClusters` holds the clusters opened by a click. */
export function feedItems(rows, ui, select, toggle) {
  const now = nowMs();
  const focus = ui.agent || '';
  return rows.map((r) => {
    const age = r.at ? timeAgo(r.at, now) : '';
    const dim = focus && r.agent !== focus ? ' faded' : '';
    const when = () => h('span', { class: 'when', title: r.at ? new Date(r.at).toLocaleString() : '' }, age || clock(r.at));
    if (r.kind === 'try') {
      const t = r.try;
      const text = tryText(t, r.n1, r.n2, r.times);
      const tone = r.stuck ? 'bad' : TRY_TONE[t.outcome];
      return { key: r.key, sig: `${text}|${age}|${dim}|${r.task}`, make: () => h('li', { class: `${tone} click${dim}`, title: `${r.agent}: ${text}${r.task ? ` (${r.task})` : ''}`, onclick: () => select(r.agent, r.change) },
        when(), h('span', { class: 'who mono' }, r.agent),
        h('span', { class: 'what' }, h('span', { class: 'txt' }, r.stuck ? `stuck: ${text}` : text), r.task ? h('span', { class: 'task' }, r.task) : null)) };
    }
    if (r.kind === 'event') {
      return { key: r.key, sig: `${r.text}|${age}|${dim}|${r.task}`, make: () => h('li', { class: `${r.tone}${r.agent || r.onclick ? ' click' : ''}${dim}`, title: `${r.agent ? `${r.agent}: ` : ''}${r.text}${r.task ? ` (${r.task})` : ''}`, onclick: r.onclick || (r.agent ? () => select(r.agent, r.change) : undefined) },
        when(), h('span', { class: 'who mono' }, r.agent || r.who || 'project'),
        h('span', { class: 'what' }, h('span', { class: 'txt' }, r.text), r.task ? h('span', { class: 'task' }, r.task) : null)) };
    }
    if (r.kind === 'pulse') {
      // The swarm in half a minute, one line; opened: one line per agent (what it did, its latest steps), each opening
      // that agent's live view.
      const n = (k) => r.steps.filter((s) => s.action === k).length;
      const parts = [n('run') && `${n('run')} ran commands`, (n('edit') + n('write')) && `${n('edit') + n('write')} edited`, n('read') && `${n('read')} read`, n('converge') && `${n('converge')} asked converge`].filter(Boolean);
      const refused = r.steps.filter((s) => s.verdict === 'refused').length;
      const opened = ui.openClusters?.has(r.key);
      const byAgent = new Map();
      for (const st of r.steps) { if (!byAgent.has(st.agent_id)) byAgent.set(st.agent_id, []); byAgent.get(st.agent_id).push(st); }
      return { key: r.key, sig: `${r.steps.length}|${age}|${dim}|${opened}`, make: () => h('li', { class: `pulse-row cluster${refused ? ' bad' : ''}${dim}${opened ? ' open' : ''}` },
        when(),
        h('span', { class: 'who' }, byAgent.size === 1 ? h('span', { class: 'mono' }, [...byAgent.keys()][0]) : 'agents'),
        h('span', { class: 'what' },
          h('button', { type: 'button', class: 'cl-h', 'aria-expanded': opened ? 'true' : 'false', onclick: () => toggle(r.key) },
            h('span', { class: 'chev' }, opened ? '▾' : '▸'), h('span', { class: 'cl-n' }, String(r.steps.length)),
            ` ${byAgent.size === 1 ? 'steps' : `${plural(r.slots || byAgent.size, 'agent')} active`}${parts.length ? `: ${parts.join(' · ')}` : ''}`,
            refused ? h('span', { class: 'bad' }, ` · ${refused} refused`) : null),
          opened ? h('ol', { class: 'cl-agents' }, [...byAgent.entries()].map(([ag, sts]) => h('li', null,
            h('button', { type: 'button', class: 'cl-ag', onclick: () => select(ag), title: 'Watch this agent' },
              h('span', { class: 'mono' }, ag), h('span', { class: 'dim' }, ` ${clusterText(sts)}`)),
            h('ol', { class: 'cl-steps' }, sts.slice(-4).map((s) => h('li', { class: s.verdict === 'allowed' ? '' : s.verdict === 'refused' ? 'bad' : 'warn' },
              h('span', { class: 'i' }, ICON[s.action] || '·'), h('span', { class: 't' }, short(formatStepTarget(s.action, s.target) || s.action, 110)),
              s.verdict !== 'allowed' ? h('span', { class: 'v' }, s.verdict) : null)),
              sts.length > 4 ? h('li', { class: 'dim' }, h('span', { class: 'i' }, ''), h('span', { class: 't' }, `${sts.length - 4} earlier`)) : null)))) : null)) };
    }
    const failed = r.steps.filter((s) => s.verdict === 'failed').length;
    const refused = r.steps.filter((s) => s.verdict === 'refused').length;
    const opened = ui.openClusters?.has(r.key);
    const live = now - (r.at || 0) < 20_000 && !r.steps.some((s) => s.action === 'done');
    const last = r.steps[r.steps.length - 1];
    return { key: r.key, sig: `${r.steps.length}|${age}|${opened}|${dim}|${live}`, make: () => h('li', { class: `cluster${refused ? ' bad' : failed ? ' warn' : ''}${dim}${opened ? ' open' : ''}` },
      when(),
      h('span', { class: 'who mono click', onclick: () => select(r.agent) }, r.agent),
      h('span', { class: 'what' },
        h('button', { type: 'button', class: 'cl-h', 'aria-expanded': opened ? 'true' : 'false', onclick: () => toggle(r.key) },
          h('span', { class: 'chev' }, opened ? '▾' : '▸'),
          h('span', { class: 'cl-n', title: `${r.steps.length} steps` }, String(r.steps.length)),
          h('span', null, clusterText(r.steps)),
          failed ? h('span', { class: 'warn' }, ` · ${failed} failed`) : null,
          refused ? h('span', { class: 'bad' }, ` · ${refused} refused`) : null),
        live && last ? h('span', { class: 'cl-now' }, h('span', { class: 'spin' }), `${ICON[last.action] || '·'} ${short(formatStepTarget(last.action, last.target), 70)}`) : null,
        r.task ? h('span', { class: 'task' }, r.task) : null,
        opened ? h('ol', { class: 'cl-steps' }, r.steps.map((s) => h('li', { class: s.verdict === 'allowed' ? '' : s.verdict === 'refused' ? 'bad' : 'warn' },
          h('span', { class: 'i' }, ICON[s.action] || '·'),
          h('span', { class: 't' }, formatStepTarget(s.action, s.target) || s.action, s.observation ? h('span', { class: 'o' }, formatObsSnippet(s.observation, 90)) : null),
          s.verdict !== 'allowed' ? h('span', { class: 'v' }, s.verdict) : null))) : null)) };
  });
}
