// The work in plain words: one card per task (newest first) with how far it has got and what is happening
// now, its story when opened, and a "needs you" line for what is stuck. The machinery (agents, changes, the
// raw events) stays in board.js, shown under Details.

import { h } from '../dom.js';
import { nowMs, shortSha, timeAgo, plural, parseLenientJson, summarizeObject, parseNdjsonOrLines, formatStepTarget, refusalWhy } from '../format.js';
import { taskStage, checksOf, assess, renderDetail, kindLabel } from './board.js';
import { triesOf, checkShort } from './feed.js';
import { plainStep } from './deck.js';

const STEPS = ['Planned', 'Working', 'Checking', 'Landed'];
const STAGE_STEP = { working: 1, back: 1, checking: 2, landed: 3 };
const FAILED = {
  tests: "the project's tests fail",
  done: 'acceptance checks fail',
  evidence: "proof doesn't hold",
  scope: 'changed files outside its task',
};

/** Every event about a task, oldest first: its own, and its agents' and changes'. */
function eventsOf(state, t) {
  const agents = new Set(t.agents);
  const changes = new Set(state.changes.filter((c) => c.task_id === t.task_id).map((c) => c.change_id));
  for (const c of state.changes) if (changes.has(c.change_id)) agents.add(c.agent_id);
  return [...state.recent, ...Object.values(state.acts || {}).flat()]
    .filter((e) => e.task_id === t.task_id || agents.has(e.agent_id) || changes.has(e.change_id))
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

const attempts = (state, t) => state.changes.filter((c) => c.task_id === t.task_id && c.head_commit).length;

/** Where a task is, in words: status, one sentence, and the step it has reached. */
export function describe(state, t, now = nowMs()) {
  const st = taskStage(state, t);
  const ch = st.ch;
  const tries = attempts(state, t);
  const last = eventsOf(state, t).at(-1);
  const when = last?.at ? timeAgo(last.at, now) : '';
  let status, tone, line;
  if (st.stage === 'landed') {
    status = 'Done'; tone = 'good';
    const passed = t.accept?.length ? ` · ${plural(t.accept.length, 'check')} passed` : '';
    line = `On main as ${shortSha(ch.landed_commit, 7)}${passed}`;
  } else if (/^waiting for you/.test(state.heldWhy?.get(t.task_id) || '')) {
    // Waiting on the owner (its change breaks earlier work's check, or its agent says it cannot be done as asked): said
    // as soon as its agent has asked (the run list reads needs-owner.json itself, local-run.mjs ownerWaiting), even while
    // its change still reads as on the merge train ("landing on main" was wrong). The same words as the row that answers it.
    status = 'Needs you'; tone = 'warn';
    line = `${state.heldWhy.get(t.task_id).replace(/^waiting for you: /, 'Needs your call: ')}`;
  } else if (state.stoppedTasks?.has(t.task_id) && st.stage !== 'checking') {
    // Stopped beats "Retrying": nothing is retrying it until you resume or continue.
    status = 'Stopped'; tone = 'dim';
    // The agent's own reason when it gave one (blocked: ...): "Stopped" alone said nothing about why.
    const own = state.stoppedWhyByTask?.get(t.task_id) || '';
    line = `Stopped${state.stoppedWhy ? ` (${state.stoppedWhy})` : ''}${own ? `: ${own}` : ''}. Work saved; resume it or continue the run.`;
  } else if (st.stage === 'back') {
    status = tries >= 3 ? 'Stuck' : 'Retrying'; tone = 'warn';
    const why = ch?.state === 'conflicted' ? 'it clashes with main'
      : Object.entries(checksOf(state, ch)).filter(([, v]) => v === 'fail').map(([k]) => FAILED[k]).join(', and ');
    line = `Sent back${tries > 1 ? ` (${plural(tries, 'try', 'tries')})` : ''}: ${why}${ch?.out_of_scope?.length ? ` (${ch.out_of_scope.slice(0, 2).join(', ')})` : ''}`;
  } else if (st.stage === 'checking') {
    status = 'Checking'; tone = 'info';
    line = st.why === 'being checked' ? 'Being checked' : 'Checks passed, landing on main';
  } else if (!t.agents.length) {
    status = 'Waiting'; tone = 'dim'; line = 'Waiting for an agent';
  } else if (!ch && !state.agents.some((a) => t.agents.includes(a.agent_id) && (a.intent?.paths?.length || (state.acts?.[a.agent_id] || []).length))) {
    status = 'Waiting'; tone = 'dim'; line = 'Not started yet';
  } else if (st.stalled) {
    status = 'Quiet'; tone = 'warn'; line = `Inactive ${timeAgo(Math.max(...state.agents.filter((a) => t.agents.includes(a.agent_id)).map((a) => a.last_seen || 0)), now)}`;
  } else {
    status = 'Working'; tone = 'accent';
    const ag = state.agents.find((a) => t.agents.includes(a.agent_id) && a.intent?.paths?.length);
    const files = ag ? ag.intent.paths.map((p) => String(p).split(':')[0]).slice(0, 2).join(', ') : '';
    // Its claim names its files; an agent that claims only when it hands in (converge hands in for it) is described by
    // its newest step instead, not as "Reading the code" while it writes them.
    const last = state.agents.filter((a) => t.agents.includes(a.agent_id)).map((a) => (state.acts?.[a.agent_id] || []).at(-1)).filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    const doing = last ? plainStep(last.action, last.target) : '';
    line = files ? `Editing ${files}` : doing ? doing.charAt(0).toUpperCase() + doing.slice(1) : 'Reading the code';
  }
  return { st, ch, status, tone, line, step: status === 'Waiting' ? 0 : STAGE_STEP[st.stage] ?? 1, when, tries };
}

/** The tasks that need a person, as rows for the attention list (or nothing). */
export function renderNeeds(state, openTask, listed = new Set()) {
  // Failing tasks are grouped by cause (swarm.js causeGroups); here only the ones that went quiet (and whose agent is
  // not listed already).
  const stuck = state.tasks.map((t) => ({ t, d: describe(state, t) })).filter(({ t, d }) => d.status === 'Quiet' && !listed.has(t.task_id));
  if (!stuck.length) return null;
  return [
    ...stuck.slice(0, 20).map(({ t, d }) => h('li', { class: 'need', onclick: () => openTask(t.task_id) },
      h('span', { class: 'st warn' }, d.status),
      h('span', { class: 'why ell', title: `"${t.title}" · ${d.line}` }, h('b', null, t.title), h('span', { class: 'dim' }, ` · ${d.line}`)))),
    stuck.length > 20 ? h('li', { class: 'none' }, `+${stuck.length - 20} more`) : null,
  ];
}

/** "3 agents working · 2 of 5 done": the whole project in one line (working: agents actually doing something). */
export function renderPulse(state, planning = null) {
  if (planning) return [h('span', { class: 'pulse on planning' }, planning.title), h('span', { class: 'dim planning-detail' }, planning.detail)];
  if (!state.tasks.length) return h('span', { class: 'dim' }, 'Nothing running');
  const done = state.tasks.filter((t) => describe(state, t).status === 'Done').length;
  const busy = assess(state).filter((x) => x.s === 'work' || x.s === 'wait').length;
  return [
    busy ? h('span', { class: 'pulse on' }, `${plural(busy, 'agent')} working`) : h('span', { class: done === state.tasks.length ? 'pulse good' : 'pulse' }, done === state.tasks.length ? 'All done' : 'Idle'),
    h('span', { class: 'dim' }, `${done} of ${plural(state.tasks.length, 'task')} done`),
  ];
}

// The end of a check's output, the lines that say why (FAIL, Error, expected) kept first.
const tail = (text, n = 14) => {
  const lines = String(text || '').trimEnd().split('\n');
  // The failing lines, each with the line before it (the claim or test it belongs to); else the last lines.
  const bad = lines.map((l, i) => (/\bFAIL|Error\b|AssertionError|expected|not ok|✗/i.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!bad.length) return lines.slice(-n).join('\n');
  const keep = new Set(bad.flatMap((i) => [i - 1, i, i + 1]).filter((i) => i >= 0 && i < lines.length));
  return [...keep].sort((a, b) => a - b).slice(0, n * 2).map((i) => lines[i]).join('\n');
};
const CHECK_NAME = { tests: "The project's tests", evidence: 'Proof', accepted: 'Acceptance checks', claim_check: 'Files in scope' };

/** Why the current try was sent back: each failing check with its output, files outside the task, a clash. */
function whyBack(state, ch) {
  if (!ch) return null;
  const fails = [['verified', ch.verified], ['evidence', ch.evidence], ['accepted', ch.accepted], ['claim_check', ch.claim_check]]
    .filter(([, v]) => v && v.commit === ch.head_commit && v.exit_code !== 0);
  const items = [
    ...fails.map(([k, v]) => h('li', null, h('details', { class: 'out-fold' },
      h('summary', null, h('b', null, `${CHECK_NAME[k] || k} failed`), v.timed_out ? ' (timed out)' : '', h('span', { class: 'dim small' }, ' · show output')),
      v.command ? h('code', { class: 'cmd' }, v.command) : null, v.output_tail ? h('pre', { class: 'out' }, tail(v.output_tail, 20)) : null))),
    ch.out_of_scope?.length ? h('li', null, h('b', null, 'Changed files outside its task: '), ch.out_of_scope.join(', ')) : null,
    ch.state === 'conflicted' ? h('li', null, h('b', null, 'Clashes with main: '), 'another change landed on the same lines first. The agent is redoing it.') : null,
  ].filter(Boolean);
  return items.length ? h('section', { class: 'why-back' }, h('h4', null, 'Why it was sent back'), h('ul', null, items)) : null;
}

function story(state, t, d, actions, ui) {
  const CHECK = { project: "project's tests", accept: 'checks', claim: 'files check', evidence: 'proof', tests: 'tests' };
  const line = (e) => {
    switch (e.type) {
      case 'TaskCreated': return ['dim', 'Planned'];
      case 'AgentAdded': return ['dim', e.role === 'reviewer' ? 'A reviewer joined' : 'An agent picked it up'];
      case 'IntentClaimed': return ['', `Started on ${(e.paths || []).map((p) => String(p).split(':')[0]).slice(0, 3).join(', ')}`];
      case 'Pushed': return ['dim', `Saved a version (${shortSha(e.commit, 7)})`];
      case 'Submitted': return ['info', 'Submitted'];
      case 'Verified': return [e.exit_code === 0 ? 'good' : 'bad', `${CHECK[e.kind] || 'tests'} ${e.exit_code === 0 ? 'passed' : e.timed_out ? 'timed out' : 'failed'}`];
      case 'Conflicted': return ['warn', 'Clashed with main: redoing it'];
      case 'Landed': return ['good', `Landed on main (${shortSha(e.commit, 7)})`];
      case 'Superseded': return ['dim', 'Replaced by a newer try'];
      case 'Acted': return e.verdict === 'refused' ? ['bad', `Blocked: ${e.action} ${e.target || ''}${refusalWhy(e.reason) ? ` · ${refusalWhy(e.reason)}` : ''}`] : null;
      default: return null;
    }
  };
  // Each hand-in is ONE line (its checks as ✓/✗), the newest open; a failing check's output is one click further.
  const evs = eventsOf(state, t);
  const agentOf = (cid) => state.changes.find((c) => c.change_id === cid)?.agent_id || '';
  const tries = triesOf(evs, agentOf);
  const tryAt = new Map(tries.map((x) => [x.events[0].seq, x]));
  const inTry = new Set(tries.flatMap((x) => x.events.map((e) => e.seq)));
  const newest = tries.at(-1);
  const OUT = { checking: ['info', 'checking'], 'sent back': ['bad', 'sent back'], clash: ['warn', 'clashed with main, redoing'], passed: ['good', 'passed'], landed: ['good', 'landed on main'], replaced: ['dim', 'replaced by a newer try'] };
  const rows = [];
  const once = new Set(['Planned', 'An agent picked it up', 'A reviewer joined']);
  const seen = new Set();
  let prev = '';
  for (const e of evs) {
    const tr = tryAt.get(e.seq);
    if (tr) {
      const [tone, word] = OUT[tr.outcome];
      rows.push(h('li', { class: `try ${tone}` }, h('span', { class: 'when', title: tr.at ? new Date(tr.at).toLocaleString() : '' }, tr.at ? timeAgo(tr.at) : ''),
        h('details', { class: 'try-d', open: tr === newest && tr.outcome !== 'landed' },
          h('summary', null, h('b', null, `Try ${tr.n}`), ` · ${word}`, tr.agent && t.agents.length > 1 ? h('span', { class: 'dim mono small' }, ` ${tr.agent}`) : null,
            h('span', { class: 'marks' }, tr.checks.map((c) => h('span', { class: c.ok ? 'good' : 'bad' }, `${c.ok ? '✓' : '✗'} ${checkShort(c.kind)}`)))),
          h('ul', { class: 'try-checks' }, tr.checks.length ? tr.checks.map((c) => h('li', { class: c.ok ? 'good' : 'bad' },
            c.ok ? `✓ ${checkShort(c.kind)} passed` : h('details', { class: 'out-fold' }, h('summary', null, `✗ ${checkShort(c.kind)} ${c.timed_out ? 'timed out' : 'failed'}`, h('span', { class: 'dim small' }, ' · show output')),
              c.command ? h('code', { class: 'cmd' }, c.command) : null, c.output_tail ? h('pre', { class: 'out' }, tail(c.output_tail)) : h('p', { class: 'dim small' }, 'no output')))) : h('li', { class: 'dim' }, 'checks running')))));
      prev = '';
      continue;
    }
    if (inTry.has(e.seq)) continue;
    const l = line(e);
    // Three agents claiming the same thing read as one line; one-off steps show once.
    if (!l || l[1] === prev || (once.has(l[1]) && seen.has(l[1]))) continue;
    prev = l[1];
    seen.add(l[1]);
    rows.push(h('li', { class: l[0] }, h('span', { class: 'when' }, e.at ? timeAgo(e.at) : ''), h('span', null, l[1])));
  }
  const ch = d.ch;
  const k = ch ? checksOf(state, ch) : null;
  const agent = ch?.agent_id || t.agents.at(-1);
  return h('div', { class: 'story' },
    t.description ? h('p', { class: 'desc' }, t.description) : null,
    t.accept?.length ? h('details', { class: 'checks' },
      h('summary', null, d.status === 'Done' ? `${plural(t.accept.length, 'check')} passed` : k?.done === 'fail' ? `${plural(t.accept.length, 'check')}: failing` : `Done when ${plural(t.accept.length, 'check')} pass`, h('span', { class: 'dim' }, ' · show')),
      h('ul', { class: 'accept' }, t.accept.map((c) => h('li', { class: d.status === 'Done' ? 'good' : k?.done === 'fail' ? 'bad' : '' }, h('code', null, c))))) : null,
    h('h4', null, 'What happened'),
    rows.length ? h('ol', { class: 'tl' }, rows.slice(-20)) : h('p', { class: 'dim' }, 'Nothing yet'),
  );
}

// Tasks grouped by where they are, the ones that want a look first. Built for hundreds: one line per task, a group
// shows its first rows (Show all for the rest), Done starts folded; a row opens to its story.
const GROUPS = [
  ['look', 'Needs a look', (d) => ['Stuck', 'Retrying', 'Quiet'].includes(d.status), true],
  ['working', 'Working', (d) => d.status === 'Working', true],
  ['checking', 'Checking', (d) => d.status === 'Checking', true],
  ['waiting', 'Waiting', (d) => d.status === 'Waiting', true],
  ['stopped', 'Stopped', (d) => d.status === 'Stopped', true],
  ['done', 'Done', (d) => d.status === 'Done', false],
];
const ROWS = 25;

export function renderWork(state, ui, actions, keep = null, only = null) {
  const tasks = state.tasks.filter((t) => (!only || only.has(t.task_id))).filter((t) => !keep || t.agents.some((a) => keep.has(a)) || state.changes.some((c) => c.task_id === t.task_id && keep.has(c.agent_id)));
  if (!tasks.length && ui.planning) return h('p', { class: 'dim none planning' }, h('b', null, ui.planning.title), ` — ${ui.planning.detail}`);
  if (!tasks.length) return h('p', { class: 'dim none' }, keep ? 'No tasks from these agents' : 'No tasks yet.');
  const all = [...tasks].reverse().map((t) => ({ t, d: describe(state, t) }));
  ui.groups ??= {};
  return GROUPS.map(([key, label, test, openByDefault]) => {
    const rows = all.filter(({ d }) => test(d));
    if (!rows.length) return null;
    // With many tasks only the exceptions start open: the healthy majority is one line each group.
    const crowded = all.length > 12;
    const open = ui.groups[key]?.open ?? (crowded && ['working', 'checking', 'waiting'].includes(key) ? false : openByDefault);
    const showAll = ui.groups[key]?.all;
    return h('div', { class: 'tgroup', 'data-g': key },
      h('button', { type: 'button', class: 'tgroup-h', 'aria-expanded': open ? 'true' : 'false', onclick: () => actions.toggleGroup(key, { open: !open }) },
        h('span', { class: 'caret' }, open ? '▾' : '▸'), h('span', null, label), h('span', { class: 'n' }, String(rows.length))),
      open ? h('ol', { class: 'trows' },
        (showAll ? rows : rows.slice(0, ROWS)).map(({ t, d }) => {
          const isOpen = ui.fly && ui.task === t.task_id;
          const agent = d.ch?.agent_id || t.agents.at(-1) || '';
          return h('li', { class: isOpen ? 'open' : '', 'data-tone': d.tone },
            h('button', { type: 'button', class: 'trow', 'aria-pressed': isOpen ? 'true' : 'false', onclick: () => actions.openTask(t.task_id) },
              h('span', { class: `tdot ${d.tone}`, title: d.status }),
              h('span', { class: 'tt', title: t.title }, t.title),
              h('span', { class: 'tl', title: d.line }, d.line),
              h('span', { class: 'ta mono' }, agent, t.agents.length > 1 ? ` +${t.agents.length - 1}` : ''),
              h('span', { class: 'steps mini', 'aria-label': `${STEPS[d.step]}` }, STEPS.map((x, i) => h('span', { class: i < d.step || d.status === 'Done' ? 'done' : i === d.step ? 'now' : '' })))));
        }),
        !showAll && rows.length > ROWS ? h('li', { class: 'more-rows' }, h('button', { type: 'button', class: 'link', onclick: () => actions.toggleGroup(key, { all: true }) }, `Show all ${rows.length}`)) : null) : null);
  });
}

export const clockText = (ms) => { const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`; };

/** The newest run, under the composer: the request, how far it has got, and Stop while it goes. */
export function renderRun(r, onStop, onContinue, onOpenDetails, onRestart) {
  if (!r) return null;
  // Spending only where it is measured: a subscription CLI's run has none.
  const money = (v) => (r.metered === false ? '' : `$${Number(v || 0).toFixed(2)}`);
  const cost = (v, of) => (r.metered === false ? 'subscription' : of !== undefined ? `${money(v)} of ${money(of)} spent` : money(v));
  const PHASE = {
    planning: ['info', `Planning${r.model ? ` with ${r.model}` : ''}…`],
    'checking the plan': ['info', `Checking the plan (${plural(r.tasks.length, 'task')})…`],
    replanning: ['warn', 'Fixing the plan…'],
    running: ['accent', `${plural(r.of || r.tasks.length, 'task')} · ${r.landed} landed · ${cost(r.spent, r.budget)}${r.model ? ` · ${r.model}` : ''}`],
    stopping: ['warn', 'Stopping…'],
    stopped: ['warn', `Stopped${r.stopped === 'by you' ? ' by you' : r.stopped ? `: ${r.stopped}` : ''} · ${r.landed} of ${r.of} landed · ${cost(r.spent)}`],
    done: [r.landed === r.of ? 'good' : 'warn', `Finished: ${r.landed} of ${r.of} landed · ${cost(r.spent)}${r.model ? ` · ${r.model}` : ''}`],
    failed: ['bad', `Didn't start: ${r.error}`],
  };
  const [tone, line] = PHASE[r.phase] || ['dim', r.phase];
  // How long it has been going (this stretch, after a Continue), ticking live (main.js updates [data-since]).
  const since = r.resumed || r.started;
  const busy = ['planning', 'checking the plan', 'replanning', 'running', 'stopping'].includes(r.phase);
  const clickHandler = onOpenDetails ? () => onOpenDetails(r) : null;
  return h('div', { class: `runbox ${tone}${busy ? ' busy' : ''}` },
    h('div', { class: 'run-text' },
      h('p', { class: `phase${clickHandler ? ' clickable' : ''}`, onclick: clickHandler, title: clickHandler ? 'Show run details' : '' },
        since ? h('span', { class: 'run-clock', 'data-since': busy ? String(since) : '', title: `started ${new Date(r.started).toLocaleString()}${r.resumed ? `, continued ${new Date(r.resumed).toLocaleTimeString()}` : ''}` }, busy ? clockText(Date.now() - since) : r.ended ? clockText(r.ended - since) : '') : null,
        line),
      r.tasks?.length && ['running', 'stopping', 'stopped', 'done', 'failed'].includes(r.phase) ? h('p',{ class: 'dim small ell', title: r.tasks.join('\n') }, `${plural(r.tasks.length, 'task')}: ${r.tasks.join(' · ')}`) : null,
      r.phase === 'replanning' && r.feedback ? h('p', { class: 'warn small ell clickable', onclick: clickHandler, title: `${r.feedback}\n\n(Click for details)` }, `Plan issue: ${r.feedback.split('\n')[0].replace(/^- task /, '')}`) : null,
      r.dropped?.length ? h('p', { class: 'dim small' }, `Left out: ${r.dropped.join(', ')}`) : null),
    busy && onStop && r.phase !== 'stopping' ? h('button', { type: 'button', class: 'stop', onclick: onStop, title: 'Stop this run and its agents' }, h('span', { class: 'sq' }), 'Stop') : null,
    // Ended with tasks still open (out of budget, stopped): carry on with more money, from where the agents stopped.
    // Ended with tasks still open (out of budget, stopped): carry on from where the agents stopped. The money is the
    // composer's "Up to $", the same as for any run.
    !busy && onContinue && ['stopped', 'done'].includes(r.phase) && r.landed < (r.of || 0) && r.where !== 'mac'
      ? h('button', { type: 'button', class: 'primary cont', title: 'Finish the open tasks with new agents, using the budget below', onclick: (e) => { e.currentTarget.disabled = true; onContinue(); } }, 'Continue') : null,
    // Failed after planning, before any agent started: start the agents on that plan (no planning, and paying, again).
    !busy && onContinue && r.phase === 'failed' && r.tasks?.length && r.where !== 'mac'
      ? h('button', { type: 'button', class: 'primary cont', title: 'Start agents on this plan', onclick: (e) => { e.currentTarget.disabled = true; onContinue(); } }, `Start ${plural(r.tasks.length, 'task')}`) : null,
    onRestart ? h('button', { type: 'button', class: 'restart', onclick: onRestart, title: 'Stop this run if it is going, then start a new one with the same request and agents' }, 'Start over') : null,
    busy ? h('div', { class: 'bar-busy' }) : null);
}

/** A diff, whole: a header per file, added and removed lines coloured. */
export function diffBlock(text) {
  const lines = String(text || '').split('\n');
  const files = lines.filter((l) => l.startsWith('diff --git')).length;
  const adds = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const dels = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return h('div', { class: 'diffwrap' },
    h('div', { class: 'diff-sum' }, `${plural(files || 1, 'file')} · `, h('span', { class: 'good' }, `+${adds}`), ' ', h('span', { class: 'bad' }, `−${dels}`)),
    h('pre', { class: 'diff' }, lines.map((l) => {
      if (l.startsWith('diff --git')) return h('div', { class: 'file' }, l.replace(/^diff --git a\/(.*?) b\/.*$/, '$1'));
      if (/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l)) return null;
      return h('div', { class: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '' }, l || ' ');
    })));
}

// An agent's log as a conversation: each call it made (a command, a read, an edit, a converge tool), what came back
// (folded, one click away), and the harness's notes (checks, limits, how it ended). Newest at the bottom.
export const AG_ICON = {
  run: '$',
  run_command: '$',
  task_start: '$',
  task_wait: '⏳',
  task_status: '⏳',
  bash: '$',
  exec: '$',
  shell: '$',
  read: '›',
  read_file: '›',
  list_dir: '›',
  list: '›',
  view_file: '›',
  cat: '›',
  write: '✎',
  write_file: '✎',
  edit: '✎',
  edit_file: '✎',
  apply_patch: '✎',
  replace_file_content: '✎',
  search: '⌕',
  search_code: '⌕',
  find_files: '⌕',
  grep: '⌕',
  mcp_call: '⇄',
  mcp_list_tools: '⇄',
  claim: '⚐',
  tests: '✓',
  status: '⏳',
  done: '✓',
};

export function toolCategory(tool, args) {
  let effectiveTool = (tool || '').toLowerCase();
  let parsed = typeof args === 'object' && args !== null ? args : parseLenientJson(args);
  if (/^(mcp_call|call|tool_call|run_tool)$/.test(effectiveTool)) {
    const sub = parsed?.tool || parsed?.name || parsed?.tool_name || parsed?.method || '';
    if (sub) effectiveTool = sub.toLowerCase();
    else if (parsed?.paths || parsed?.claims) effectiveTool = 'claim';
    else if (parsed?.tests) effectiveTool = 'tests';
    else if (parsed?.wait !== undefined) effectiveTool = 'status';
  }
  if (/^(run|run_command|task_start|bash|exec|shell)$/.test(effectiveTool)) return 'run';
  if (/^(write|write_file|edit|edit_file|apply_patch|replace_file_content|patch)$/.test(effectiveTool)) return 'edit';
  if (/^(read|read_file|list|list_dir|view_file|cat)$/.test(effectiveTool)) return 'read';
  if (/^(search|search_code|find|find_files|grep)$/.test(effectiveTool)) return 'search';
  if (/^(claim|tests|status|converge)/.test(effectiveTool)) return 'converge';
  if (/^(task_wait|task_status|wait)$/.test(effectiveTool)) return 'wait';
  if (/^done$/.test(effectiveTool)) return 'done';
  return 'other';
}

export function callLine(tool, args) {
  const raw = typeof args === 'string' ? args : JSON.stringify(args || '');
  let parsed = parseLenientJson(raw);

  // Unwrap wrapper tools (mcp_call, call, tool_call, run_tool)
  let subTool = '';
  let payload = parsed;
  if (/^(mcp_call|call|tool_call|run_tool)$/.test(tool)) {
    subTool = parsed?.tool || parsed?.name || parsed?.tool_name || parsed?.method || '';
    if (parsed && typeof parsed === 'object') {
      payload = parsed.args ?? parsed.arguments ?? parsed.params ?? parsed.parameters ?? parsed.input ?? parsed;
      if (typeof payload === 'object' && payload && payload.args && typeof payload.args === 'object') {
        payload = payload.args;
      }
    }
  }

  let effectiveTool = subTool || tool;
  const isWrapper = Boolean(subTool) || tool === 'mcp_call';

  // Infer tool from arguments when mcp_call passed implicit arguments
  if (effectiveTool === 'mcp_call') {
    if (payload?.paths || payload?.claims || /(?:\\"|")(?:paths|claims)(?:\\"|")\s*:\s*\[/.test(raw)) effectiveTool = 'claim';
    else if (payload?.tests || /(?:\\"|")tests(?:\\"|")/.test(raw)) effectiveTool = 'tests';
    else if (payload?.wait !== undefined || /(?:\\"|")wait(?:\\"|")/.test(raw)) effectiveTool = 'status';
  }

  const prefix = isWrapper ? 'converge ' : '';

  // 1. Command runners
  if (/^(run|run_command|task_start|bash|exec|shell)$/.test(effectiveTool)) {
    const cmd = payload?.command || payload?.cmd || payload?.script;
    if (cmd) return cmd;
    const cmdMatch = /(?:\\"|")command(?:\\"|")\s*:\s*(?:\\"|")((?:[^"\\]|\\.)*)/.exec(raw);
    if (cmdMatch) return cmdMatch[1].replace(/\\+"/g, '"').replace(/\\\\/g, '\\').trim();
  }

  // 2. Primary target extraction from parsed object
  if (payload && typeof payload === 'object') {
    const p = payload.path || payload.file_path || payload.file || payload.targetFile || payload.target;
    if (p) {
      const verb = /write/.test(effectiveTool) ? 'write'
        : /edit|patch|replace/.test(effectiveTool) ? 'edit'
        : /read|view/.test(effectiveTool) ? 'read'
        : /list/.test(effectiveTool) ? 'list'
        : effectiveTool.replace(/_/g, ' ');
      return `${prefix}${verb} ${p}${payload.startLine ? `:${payload.startLine}${payload.endLine ? `-${payload.endLine}` : ''}` : ''}`;
    }

    const paths = payload.paths || payload.files;
    if (Array.isArray(paths) && paths.length) {
      return `${prefix}${effectiveTool.replace(/_/g, ' ')} ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3} more` : ''}`;
    }

    if (Array.isArray(payload.claims) && payload.claims.length) {
      const files = payload.claims.map((c) => c.file || c.statement).filter(Boolean);
      return `${prefix}claim ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3} more` : ''}`;
    }

    const testCmd = payload.command || payload.tests?.command;
    if (testCmd) {
      return `${prefix}${effectiveTool.replace(/_/g, ' ')}: ${testCmd}`;
    }

    if (payload.query || payload.pattern) {
      return `${prefix}search "${payload.query || payload.pattern}"`;
    }

    if (payload.summary || payload.message) {
      return `${prefix}${effectiveTool.replace(/_/g, ' ')}: "${payload.summary || payload.message}"`;
    }

    if (payload.wait === true) {
      return `${prefix}${effectiveTool.replace(/_/g, ' ')} (waiting)`;
    }

    // Format remaining compact arguments (skip huge content/diff payloads)
    const compact = [];
    for (const [k, v] of Object.entries(payload)) {
      if (/^(content|diff|patch|body|text|source|_)/.test(k)) continue;
      if (typeof v === 'boolean') compact.push(v ? k : `no-${k}`);
      else if (typeof v === 'string' || typeof v === 'number') compact.push(`${k}=${v}`);
    }
    if (compact.length) {
      return `${prefix}${effectiveTool.replace(/_/g, ' ')} ${compact.join(' ')}`;
    }
    return `${prefix}${effectiveTool.replace(/_/g, ' ')}`;
  }

  // 3. Fallbacks on raw string when JSON parsing failed (e.g. truncated mid-token)
  const cmdMatch = /(?:\\"|")command(?:\\"|")\s*:\s*(?:\\"|")((?:[^"\\]|\\.)*)/.exec(raw);
  if (cmdMatch) {
    const cleanCmd = cmdMatch[1].replace(/\\+"/g, '"').replace(/\\\\/g, '\\').trim();
    return /^(run|run_command|task_start|bash|exec)$/.test(effectiveTool) ? cleanCmd : `${prefix}${effectiveTool}: ${cleanCmd}`;
  }

  const pathMatch = /(?:\\"|")(?:path|file_path|file|targetFile|target)(?:\\"|")\s*:\s*(?:\\"|")([^"\\]+)/.exec(raw);
  if (pathMatch) {
    const verb = /write/.test(effectiveTool) ? 'write' : /edit/.test(effectiveTool) ? 'edit' : effectiveTool.replace(/_/g, ' ');
    return `${prefix}${verb} ${pathMatch[1]}`;
  }

  const pathsMatch = /(?:\\"|")(?:paths|claims)(?:\\"|")\s*:\s*\[/.test(raw);
  if (pathsMatch) {
    const files = [...new Set((raw.match(/(?:[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-\.\/]+\/)/g) || []).filter((f) => !/^(json|args|paths|claims|mcp_call)$/.test(f)))];
    if (files.length) {
      return `${prefix}claim ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3} more` : ''}`;
    }
  }

  if (/(?:\\"|")wait(?:\\"|")\s*:\s*true/.test(raw)) {
    return `${prefix}${effectiveTool} (waiting)`;
  }

  if (raw.startsWith('{') || raw.startsWith('{"')) {
    const t = formatStepTarget(effectiveTool, raw);
    if (t && t !== raw && !t.startsWith('{')) {
      return `${prefix}${effectiveTool.replace(/_/g, ' ')} ${t}`.trim();
    }
    return `${prefix}${effectiveTool.replace(/_/g, ' ')}`;
  }

  return `${prefix}${effectiveTool} ${raw.slice(0, 160)}`;
}

function renderShellCommand(cmd) {
  const parts = [];
  const regex = /("[^"]*"|'[^']*'|&&|\|\||\||;|--?[a-zA-Z0-9_\-]+|[^\s"';|&]+|\s+)/g;
  let match;
  let lastWasOp = true;
  while ((match = regex.exec(cmd)) !== null) {
    const token = match[0];
    if (/^\s+$/.test(token)) {
      parts.push(token);
    } else if (token === '&&' || token === '||' || token === '|' || token === ';') {
      parts.push(h('span', { class: 'sh-op' }, token));
      lastWasOp = true;
    } else if (/^("[^"]*"|'[^']*')$/.test(token)) {
      parts.push(h('span', { class: 'sh-str' }, token));
      lastWasOp = false;
    } else if (/^--?[a-zA-Z0-9_\-]+$/.test(token)) {
      parts.push(h('span', { class: 'sh-flag' }, token));
      lastWasOp = false;
    } else if (lastWasOp && /^[a-zA-Z0-9_\.\-]+$/.test(token)) {
      parts.push(h('span', { class: 'sh-bin' }, token));
      lastWasOp = false;
    } else {
      parts.push(token);
      lastWasOp = false;
    }
  }
  return parts.length ? parts : cmd;
}

export function renderCallSpans(text, cat) {
  if (cat === 'run') {
    let cmd = text;
    if (text.startsWith('run: ')) cmd = text.slice(5).trim();
    else if (text.startsWith('run ')) cmd = text.slice(4).trim();
    return [
      h('span', { class: 'al-verb cat-run' }, 'run'),
      ' ',
      h('span', { class: 'al-cmd' }, renderShellCommand(cmd))
    ];
  }
  const m = /^((?:converge\s+)?[a-z_]+:?)\s+(.*)$/i.exec(text);
  if (m) {
    const rawVerb = m[1].replace(/:$/, '');
    const rest = m[2];
    return [
      h('span', { class: `al-verb cat-${cat}` }, rawVerb),
      ' ',
      h('span', { class: `al-arg cat-${cat}` }, rest)
    ];
  }
  return text;
}

export function renderTerminalLines(str) {
  if (!str) return null;
  const lines = String(str).split('\n');
  const out = [];
  const limit = Math.min(lines.length, 600);
  for (let i = 0; i < limit; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    let cls = '';
    if (/^===+[^=]+===+$|^---+[^-]+---+$/.test(trimmed)) {
      cls = 'out-sec';
    } else if (/^(exit 0\b|✔\b|✓\b|ok\b|PASS\b|Passed\b)/i.test(trimmed)) {
      cls = 'out-good';
    } else if (/^(exit [1-9]\d*|✖\b|✗\b|not ok\b|FAIL\b|Error:|AssertionError:|fatal:|ERR!)/i.test(trimmed)) {
      cls = 'out-bad';
    } else if (/^(TAP\b|#|ℹ\b|total\s+\d+)/.test(trimmed)) {
      cls = 'out-info';
    } else if (/^([0-9a-f]{7,10})\s+(.*)$/.test(trimmed)) {
      const commitMatch = /^([0-9a-f]{7,10})\s+(.*)$/.exec(trimmed);
      out.push(h('div', { class: 'out-line' },
        h('span', { class: 'out-sha mono' }, commitMatch[1]), ' ',
        h('span', { class: 'out-msg' }, commitMatch[2])));
      continue;
    } else if (/^\s*at\s+.*:\d+:\d+/.test(l)) {
      cls = 'out-dim';
    } else if (/^[dcbpsl-][rwxstST-]{9}[@+]?\s+/.test(trimmed)) {
      cls = 'out-ls';
    }
    out.push(h('div', { class: cls ? `out-line ${cls}` : 'out-line' }, l || ' '));
  }
  if (lines.length > limit) {
    out.push(h('div', { class: 'out-line out-dim' }, `… (${lines.length - limit} more lines)`));
  }
  return out;
}

export function renderResultSummary(first, linesCount, bad, good) {
  const exitMatch = /^(exit\s+(\d+))(?:\s*·\s*(.*))?$/i.exec(first);
  if (exitMatch) {
    const code = Number(exitMatch[2]);
    const tone = code === 0 ? 'good' : 'bad';
    const icon = code === 0 ? '✓' : '✗';
    return [
      h('span', { class: `res-badge ${tone}` }, `${icon} ${exitMatch[1]}`),
      linesCount > 1 ? h('span', { class: 'res-count' }, `${linesCount} lines`) : null,
      exitMatch[3] ? h('span', { class: `res-text ${tone}` }, exitMatch[3]) : null
    ];
  }
  if (bad) {
    return [
      h('span', { class: 'res-badge bad' }, '✗ ERR'),
      linesCount > 1 ? h('span', { class: 'res-count' }, `${linesCount} lines`) : null,
      h('span', { class: 'res-text bad' }, first.slice(0, 120))
    ];
  }
  if (good) {
    return [
      h('span', { class: 'res-badge good' }, '✓ OK'),
      linesCount > 1 ? h('span', { class: 'res-count' }, `${linesCount} lines`) : null,
      h('span', { class: 'res-text good' }, first.slice(0, 120))
    ];
  }
  return [
    h('span', { class: 'res-badge dim' }, 'OUT'),
    linesCount > 1 ? h('span', { class: 'res-count' }, `${linesCount} lines`) : null,
    h('span', { class: 'res-text' }, first.slice(0, 120))
  ];
}

export function formatLogResult(text) {
  if (!text) return h('span', { class: 'mono dim' }, '(nothing)');

  // Accept already parsed object or leniently parse string
  const isObj = typeof text === 'object' && text !== null;
  const data = isObj ? text : parseLenientJson(String(text).trim());
  const rawStr = isObj ? JSON.stringify(text, null, 2) : String(text).trim();

  if (data && typeof data === 'object') {
    const sum = summarizeObject(data);
    const rows = [];
    const notices = [];

    const walk = (obj, prefix = '') => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue;
        const keyName = prefix ? `${prefix}.${k}` : k;
        if (k === 'notices' && Array.isArray(v)) {
          notices.push(...v);
        } else if (v === null || v === undefined) {
          // omit
        } else if (typeof v === 'boolean') {
          rows.push(h('div', { class: 'al-item' },
            h('span', { class: 'al-lbl' }, keyName.replace(/_/g, ' ')),
            h('span', { class: v ? 'al-val good' : 'al-val dim' }, v ? '✓ yes' : '✗ no')));
        } else if (typeof v === 'string' || typeof v === 'number') {
          const isSha = typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
          const valText = isSha ? shortSha(v, 10) : String(v);
          rows.push(h('div', { class: 'al-item' },
            h('span', { class: 'al-lbl' }, keyName.replace(/_/g, ' ')),
            h('span', { class: isSha ? 'al-val mono' : 'al-val' }, valText)));
        } else if (Array.isArray(v)) {
          if (!v.length) {
            rows.push(h('div', { class: 'al-item' },
              h('span', { class: 'al-lbl' }, keyName.replace(/_/g, ' ')),
              h('span', { class: 'al-val dim' }, '(none)')));
          } else if (typeof v[0] === 'string' && v.length <= 4) {
            rows.push(h('div', { class: 'al-item' },
              h('span', { class: 'al-lbl' }, keyName.replace(/_/g, ' ')),
              h('span', { class: 'al-val' }, v.join(', '))));
          } else {
            rows.push(h('div', { class: 'al-item' },
              h('span', { class: 'al-lbl' }, keyName.replace(/_/g, ' ')),
              h('span', { class: 'al-val' }, `${v.length} item(s)`)));
          }
        } else if (typeof v === 'object' && prefix === '') {
          walk(v, k);
        }
      }
    };

    walk(data);

    const outText = data.stdout || data.output || (typeof data.report === 'string' ? data.report : '');

    return h('details', { class: 'al-card-details' },
      h('summary', { class: `al-card-summary${sum.tone ? ` ${sum.tone}` : ''}` },
        h('span', { class: `al-badge${sum.tone ? ` ${sum.tone}` : ''}` }, sum.badge),
        h('span', { class: 'al-card-title' }, sum.title)),
      h('div', { class: 'al-card-body' },
        rows.length ? h('div', { class: 'al-grid' }, rows) : null,
        outText ? h('pre', { class: 'out' }, outText) : null,
        notices.length ? h('div', { class: 'al-notices' }, notices.map((n) => h('div', { class: 'al-notice' }, `ℹ ${n}`))) : null,
        h('details', { class: 'al-raw' },
          h('summary', { class: 'dim' }, 'raw details'),
          h('pre', { class: 'out' }, rawStr))));
  }

  // Plain text result
  const str = rawStr;
  const first = str.split('\n').find((l) => l.trim()) || '(nothing)';
  const bad = /^(EXIT [1-9]|error|ERROR|fatal|FAIL)|No such file|not found/i.test(first);
  const good = /^(exit 0\b|PASS\b|ok\b)/i.test(first);
  const linesCount = str.split('\n').length;
  if (str.includes('\n') || str.length > 140) {
    return h('details', { class: `al-res-fold${bad ? ' bad' : good ? ' good' : ''}` },
      h('summary', { class: `mono${bad ? ' bad' : good ? ' good' : ''}` }, renderResultSummary(first, linesCount, bad, good)),
      h('pre', { class: 'out terminal-out' }, renderTerminalLines(str)));
  }
  return h('span', { class: `mono${bad ? ' bad' : good ? ' good' : ''}` }, renderResultSummary(first, 1, bad, good));
}

// ---- an agent at a glance (the server's summary of its transcript): what its steps went on, its own notes, and one
// line per step. The raw log stays one click away below it.
const GLANCE_KINDS = [['looking', 'looking'], ['changing', 'changing'], ['running', 'running'], ['notes', 'notes'], ['converge', 'bookkeeping'], ['invalid', 'invalid']];
const STEP_ICON = { looking: '›', changing: '✎', running: '$', note: '✱', converge: '⇄', invalid: '!', other: '•' };
function agentGlance(s) {
  const onlyLooking = s.changing === 0 && s.steps >= 20;
  const chip = (label, n, tone = '') => h('span', { class: `ag-chip${tone ? ' ' + tone : ''}` }, h('b', null, String(n)), ` ${label}`);
  const bar = h('div', { class: 'ag-bar', role: 'img', 'aria-label': GLANCE_KINDS.map(([k, l]) => `${s[k]} ${l}`).join(', ') },
    ...GLANCE_KINDS.filter(([k]) => s[k] > 0).map(([k, l]) => h('span', { class: `ag-seg k-${k}`, style: `flex:${s[k]}`, title: `${s[k]} ${l}` })));
  const tools = Object.entries(s.converge_tools || {}).map(([t, n]) => `${t} ×${n}`).join(', ');
  const m = s.model;
  return h('div', { class: 'ag-glance' },
    h('div', { class: 'ag-line' },
      h('span', { class: 'ag-steps' }, `${s.steps} steps`),
      chip('looking', s.looking, onlyLooking ? 'warn' : ''),
      chip('changing', s.changing, onlyLooking ? 'bad' : s.changing ? 'good' : ''),
      s.running ? chip('running', s.running) : null,
      chip('notes', s.notes),
      h('span', { title: tools || '' }, chip('bookkeeping', s.converge, s.converge > s.steps / 5 ? 'warn' : '')),
      chip('repeats', s.repeats, s.repeats ? 'warn' : ''),
      s.invalid ? chip('invalid', s.invalid, 'bad') : null),
    bar,
    h('div', { class: 'ag-line dim small' },
      s.first_change ? `First change at step ${s.first_change}` : h('span', { class: onlyLooking ? 'bad' : '' }, 'No change made yet'),
      s.files_changed?.length ? ` · changed ${s.files_changed.join(', ')}` : '',
      s.commits ? ` · ${s.commits} commit(s)` : '',
      m ? ` · ${m.calls} model calls, ~${Math.round(m.per_call_in / 1000)}k tokens each, $${m.usd.toFixed(2)}${m.estimated ? ' (estimated)' : ''}` : ''));
}
function agentNotes(s) {
  if (!s.notebook?.length) return null;
  return h('section', { class: 'ag-notes' },
    h('h3', null, `Its notes (${s.notebook.length}): what it found and means to do`),
    // Each note opens on a click: its first lines say what it is about, the rest is the agent's reasoning.
    h('ol', null, ...s.notebook.map((n) => h('li', null, h('details', null,
      h('summary', null, h('span', { class: 'ag-n dim' }, `#${n.n}`), h('span', { class: 'ag-note-head' }, n.text)),
      h('div', { class: 'ag-note-full' }, n.text))))));
}
// How it got ready, in converge's words, newest last; while it has taken no step yet this is all there is to see.
function agentSetup(s) {
  if (!s.setup?.length) return null;
  const at = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return h('section', { class: 'ag-setup' },
    h('h3', null, s.steps ? 'How it got ready' : 'Getting ready'),
    h('ol', null, ...s.setup.map((x) => h('li', null, h('span', { class: 'dim small' }, at(x.at)), ' ', x.text))));
}
function agentSteps(s) {
  return h('ol', { class: 'ag-steps-list' }, ...(s.list || []).map((x) => h('li', { class: `ag-step k-${x.kind}${x.repeat_of ? ' again' : ''}` },
    h('span', { class: 'ag-n dim' }, `#${x.n}`),
    h('span', { class: `ag-i k-${x.kind}` }, STEP_ICON[x.kind] || '•'),
    h('span', { class: 'ag-act' }, x.action),
    h('span', { class: 'ag-tgt mono', title: x.target }, x.target),
    h('span', { class: 'ag-out dim', title: x.outcome }, x.outcome ? `→ ${x.outcome}` : ''),
    x.repeat_of ? h('span', { class: 'ag-again' }, `again (#${x.repeat_of})`) : null)));
}

export function agentLogView(log) {
  if (!log) return null;
  if (log.missing) return h('p', { class: 'dim small' }, 'No log for this agent.');
  const raw = agentRawLog(log);
  if (!log.summary) return raw;
  return h('div', { class: 'ag-view' },
    agentSetup(log.summary),
    agentGlance(log.summary),
    agentNotes(log.summary),
    agentSteps(log.summary),
    h('details', { class: 'ag-raw' }, h('summary', null, `Full log (${log.total} entries: every call and its whole output)`), raw));
}

function agentRawLog(log) {
  const rows = [];
  for (const e of log.entries) {
    const t = new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    if (e.kind === 'call') {
      const cat = toolCategory(e.tool, e.text);
      const icon = AG_ICON[e.tool] || (cat === 'run' ? '$' : cat === 'edit' ? '✎' : cat === 'read' ? '›' : cat === 'search' ? '⌕' : cat === 'converge' ? '⇄' : '•');
      const text = callLine(e.tool, e.text);
      rows.push(h('li', { class: `al-call cat-${cat}`, title: t, 'data-cat': cat },
        h('span', { class: `al-i cat-${cat}` }, icon),
        h('span', { class: `al-t mono cat-${cat}` }, renderCallSpans(text, cat))));
    } else {
      // Both results and notes can contain NDJSON, JSON objects, interrupted turn messages, or plain text
      const items = parseNdjsonOrLines(e.text);
      for (const item of (items.length ? items : [e.text])) {
        if (typeof item === 'object' && item !== null) {
          // 1. Silent stream termination tokens
          if ((item.t === 'end' || item.type === 'end') && Object.keys(item).length <= 2) {
            continue;
          }

          // 2. Interrupted turn warning
          if (item.interrupted || item.code === 143) {
            const msg = item.text || 'Stopped mid-step (restart or stop)';
            rows.push(h('li', { class: 'al-warn-chip', title: t },
              h('span', { class: 'chip-icon' }, '⚠️'),
              h('span', { class: 'chip-text' }, 'Interrupted: '),
              h('span', { class: 'chip-sub' }, msg)));
            continue;
          }

          // 3. Model/harness text answer
          if ((item.t === 'answer' || item.type === 'answer') && item.text) {
            rows.push(h('li', { class: 'al-note answer', title: t }, item.text));
            continue;
          }

          // 4. Any other structured JSON result/status/verification
          const bad = e.kind === 'result' && /^(EXIT [1-9]|error|ERROR|fatal|FAIL)/i.test(JSON.stringify(item));
          const good = e.kind === 'result' && (item.exit_code === 0 || /^(ok|pass|clean|landed|submitted|success)$/i.test(String(item.status || item.state || '')));
          rows.push(h('li', { class: `al-res${bad ? ' bad' : good ? ' good' : ''}`, title: t }, formatLogResult(item)));
          continue;
        }

        // Plain text lines
        const line = String(item || '').trim();
        if (!line) continue;

        const repMatch = /(?:repetition warning|exact parameter repetition detected):\s*tool\s*'([^']+)'\s*invoked\s*(\d+x)\s*(.*)/i.exec(line);
        if (repMatch) {
          rows.push(h('li', { class: 'al-warn-chip', title: t },
            h('span', { class: 'chip-icon' }, '⚠️'),
            h('span', { class: 'chip-text' }, `Repeated ${repMatch[2]}: tool `),
            h('code', { class: 'chip-tool' }, repMatch[1]),
            h('span', { class: 'chip-sub dim' }, ` (${repMatch[3].trim() || 'same arguments'})`)));
          continue;
        }

        if (e.kind === 'result') {
          const bad = /^(EXIT [1-9]|error|ERROR|fatal|FAIL)|No such file|not found/i.test(line);
          const good = /^(exit 0\b|PASS\b|ok\b)/i.test(line);
          rows.push(h('li', { class: `al-res${bad ? ' bad' : good ? ' good' : ''}`, title: t }, formatLogResult(line)));
          continue;
        }

        const loud = /VALIDATION GATE|FAIL|RUN ENDED|ceiling|SUMMARY|error/i.test(line);
        if (!loud && /^(task:|validation gate:|provider=|task \S+ started)/.test(line)) continue;
        rows.push(h('li', { class: `al-note${loud ? ' loud' : ''}`, title: t }, line.split('\n').slice(0, loud ? 6 : 2).join('\n')));
      }
    }
  }
  return h('div', { class: 'alog-wrap' },
    h('div', { class: 'al-meta dim small' }, `${log.total} entries · live`, log.where === 'mac' ? ' · host' : (log.where ? ` · ${log.where}` : ''),
      log.error ? h('span', { class: 'bad' }, ` · ${log.error}`) : null),
    h('ol', { class: 'alog' }, rows.length ? rows : h('li', { class: 'dim' }, 'Nothing yet.')));
}

/** The details flyout: a task (its story, checks, agents and changes) and, when one is picked, an agent's own steps. */
export function renderFlyout(state, ui, actions) {
  const all = assess(state);
  const a = ui.agent ? all.find((x) => x.a.agent_id === ui.agent) : null;
  const t = state.tasks.find((x) => x.task_id === ui.task) || a?.task || null;
  if (!t && !a) return null;
  const d = t ? describe(state, t) : null;
  const changes = t ? state.changes.filter((c) => c.task_id === t.task_id && c.head_commit).reverse() : (a?.ch ? [a.ch] : []);
  const agents = t ? all.filter((x) => t.agents.includes(x.a.agent_id) || changes.some((c) => c.agent_id === x.a.agent_id)) : [];
  return [
    h('div', { class: 'fly-h' },
      h('div', { class: 'fly-title' },
        h('h2', null, t ? t.title : a.a.agent_id),
        d ? h('span', { class: `badge ${d.tone}` }, d.status) : h('span', { class: 'badge' }, kindLabel(a.s))),
      h('button', { type: 'button', class: 'link fly-x', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => actions.closeFly() }, '✕')),
    h('div', { class: 'fly-body' },
      // Watching an agent: what it is doing, live, as a conversation (its log), with Halt; the task's story follows.
      a ? h('section', { class: 'fly-agent' },
        h('div', { class: 'ag-h' }, h('span', { class: `st ${{ bad: 'bad', warn: 'warn', wait: 'info', ok: 'good', work: 'violet' }[a.s] || 'dim'}` }, kindLabel(a.s)),
          h('b', { class: 'mono' }, a.a.agent_id), h('span', { class: 'dim ell' }, a.why), h('span', { class: 'grow' }),
          actions.canHalt && ['work', 'wait', 'warn'].includes(a.s) ? h('button', { type: 'button', class: 'stop', title: 'Stop this agent. Its work is saved.', onclick: () => actions.haltAgent(a.a.agent_id, a.task?.task_id || '') }, h('span', { class: 'sq' }), 'Stop') : null),
        agentLogView(ui.agentLog?.agent === a.a.agent_id ? ui.agentLog : null) || renderDetail(state, ui, actions)?.[0]) : null,
      d ? [
        h('p', { class: 'fly-line' },
          d.line.startsWith('Editing ') ? h('span', { class: 'fly-icon edit' }, '✎ ')
            : d.line.startsWith('Reading ') ? h('span', { class: 'fly-icon read' }, '› ')
            : d.line.startsWith('Pushed ') ? h('span', { class: 'fly-icon push' }, '↑ ')
            : null,
          d.line),
        h('div', { class: 'steps' }, STEPS.map((x, i) => h('span', { class: i < d.step || d.status === 'Done' ? 'done' : i === d.step ? 'now' : '', title: x }))),
        d.status !== 'Done' ? whyBack(state, d.ch) : null,
        story(state, t, d, actions, ui)] : a ? whyBack(state, a.ch) : null,
      changes.length ? h('section', null,
        h('div', { class: 'fly-sec-h' },
          h('h4', null, changes.length > 1 ? `Changes (${changes.length} tries)` : 'Change'),
          actions.inspectChanges ? h('button', { type: 'button', class: 'link', onclick: () => actions.inspectChanges(changes.map((c) => c.change_id), ui.diff.changeId || changes[0]?.change_id) }, 'View all →') : null),
        h('ol', { class: 'fly-list' }, changes.map((c) => h('li', { 'aria-selected': ui.diff.changeId === c.change_id ? 'true' : 'false' },
          h('button', { type: 'button', class: 'fly-row', onclick: () => actions.loadDiff(c.change_id) },
            h('span', { class: `chg-state ${c.state === 'landed' ? 'good' : c.state === 'conflicted' ? 'warn' : c.state === 'superseded' ? 'dim' : ''}` }, c.state),
            h('span', { class: 'mono dim' }, c.agent_id),
            h('span', { class: 'grow ell' }, c.summary || ''),
            h('span', { class: 'link' }, ui.diff.changeId === c.change_id ? 'hide' : 'diff')),
          ui.diff.changeId === c.change_id ? diffBlock(ui.diff.text) : null)))) : null,
      agents.length ? h('section', null, h('h4', null, `Agents (${agents.length})`),
        h('ol', { class: 'fly-list' }, agents.map((x) => h('li', { 'aria-selected': ui.agent === x.a.agent_id ? 'true' : 'false' },
          h('button', { type: 'button', class: 'fly-row', onclick: () => actions.focusAgent(ui.agent === x.a.agent_id ? '' : x.a.agent_id) },
            h('span', { class: `st ${{ bad: 'bad', warn: 'warn', wait: 'info', ok: 'good', work: 'violet' }[x.s] || 'dim'}` }, kindLabel(x.s)),
            h('span', { class: 'mono' }, x.a.agent_id),
            h('span', { class: 'grow ell dim' }, x.why)))))) : null),
  ];
}

/** The run flyout: inspection panel for a planning, checking, or active run. */
// How a run was planned: each step (the planner's and converge's), each model answer in full on a click, the problems
// found with a plan, and the tasks it came to, with what each must do and the checks that say it is done.
function planView(plan) {
  if (!plan) return null;
  const at = (s) => { try { return new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };
  const rows = plan.entries.map((e) => {
    const meta = [e.ms != null ? `${(e.ms / 1000).toFixed(1)}s` : '', e.tokens_in ? `${e.tokens_in.toLocaleString()} in / ${Number(e.tokens_out || 0).toLocaleString()} out${e.cached ? `, ${e.cached.toLocaleString()} cached` : ''}` : '',
      e.prompt_chars ? `prompt ${Math.round(e.prompt_chars / 1000)}k chars` : ''].filter(Boolean).join(' · ');
    return h('li', { class: `pl-row k-${e.kind}` },
      h('span', { class: 'pl-at dim' }, at(e.at)),
      h('span', { class: 'pl-by dim' }, e.by === 'planner' ? 'planner' : 'converge'),
      h('div', { class: 'pl-body' },
        h('div', null, e.text, meta ? h('span', { class: 'dim small' }, `  ${meta}`) : null),
        e.answer ? h('details', null, h('summary', { class: 'small' }, 'What the model answered'), h('pre', { class: 'pl-pre' }, e.answer)) : null,
        e.problems?.length ? h('ul', { class: 'pl-problems' }, ...e.problems.map((p) => h('li', null, p))) : null));
  });
  const tasks = plan.tasks.map((t, i) => h('li', { class: 'pl-task' },
    h('div', { class: 'pl-task-h' }, h('span', { class: 'dim mono' }, `#${i + 1}`), h('b', null, t.title), t.workstream ? h('span', { class: 'badge' }, t.workstream) : null),
    t.description ? h('p', { class: 'pl-desc' }, t.description) : null,
    t.accept?.length ? h('div', { class: 'pl-checks' }, h('span', { class: 'dim small' }, 'Done when these pass:'), h('ol', null, ...t.accept.map((c) => h('li', null, h('code', null, c))))) : null));
  return [
    h('section', null, h('h4', null, `How it planned${plan.entries.length ? '' : ' (waiting for the planner…)'}`),
      plan.error ? h('p', { class: 'bad small' }, plan.error) : null,
      rows.length ? h('ol', { class: 'pl-log' }, ...rows) : h('p', { class: 'dim small' }, 'Nothing yet.')),
    tasks.length ? h('section', null, h('h4', null, `The plan: ${tasks.length} task(s)`), h('ol', { class: 'pl-tasks' }, ...tasks)) : null,
  ];
}

export function renderRunFlyout(r, actions, plan) {
  if (!r) return null;
  const money = (v) => (r.metered === false ? '' : `$${Number(v || 0).toFixed(2)}`);
  const cost = (v, of) => (r.metered === false ? 'subscription' : of !== undefined ? `${money(v)} of ${money(of)}` : money(v));
  const planUsage = r.plan_usage;
  return [
    h('div', { class: 'fly-h' },
      h('div', { class: 'fly-title' },
        h('h2', null, `Run ${r.id}`),
        h('span', { class: `badge ${{ planning: 'info', replanning: 'warn', 'checking the plan': 'info', running: 'accent', done: 'good', failed: 'bad', stopped: 'dim' }[r.phase] || 'dim'}` }, r.phase)),
      h('button', { type: 'button', class: 'link fly-x', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => actions.closeFly() }, '✕')),
    h('div', { class: 'fly-body' },
      h('section', null,
        h('h4', null, 'Request'),
        h('p', { class: 'fly-line', style: 'white-space: pre-wrap; font-size: 13.5px; color: var(--text); background: var(--panel-2); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--line);' }, r.request || '(empty request)')),
      h('section', null,
        h('h4', null, 'Setup and cost'),
        h('div', { style: 'display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; line-height: 1.5;' },
          h('span', { class: 'dim' }, 'Model:'), h('span', { class: 'mono' }, r.model || '(default)'),
          h('span', { class: 'dim' }, 'Agents:'), h('span', null, String(r.agents || 0)),
          h('span', { class: 'dim' }, 'Cost:'), h('span', { class: 'good' }, `${cost(r.spent, r.budget || undefined)} spent`),
          planUsage ? [
            h('span', { class: 'dim' }, 'Planning:'),
            h('span', null, `${planUsage.tokens?.calls || 1} model call(s) · ${(planUsage.tokens?.in || 0).toLocaleString()} tokens in / ${(planUsage.tokens?.out || 0).toLocaleString()} out · $${Number(planUsage.spent_usd || 0).toFixed(4)}`)
          ] : null,
          r.error ? [h('span', { class: 'dim' }, 'Error:'), h('span', { class: 'bad' }, r.error)] : null)),
      planView(plan),
      r.feedback ? h('section', null,
        h('h4', null, 'Plan issues'),
        h('pre', { style: 'margin: 0; padding: 10px 12px; font-size: 12px; line-height: 1.45; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm); overflow-x: auto; white-space: pre-wrap; color: var(--warn);' }, r.feedback)) : null,
      r.tasks?.length && !plan?.tasks?.length ? h('section', null,
        h('h4', null, `Tasks (${r.tasks.length})`),
        h('ol', { class: 'fly-list' }, r.tasks.map((t, idx) =>
          h('li', { style: 'padding: 8px 12px; font-size: 13px; display: flex; align-items: center; gap: 8px;' },
            h('span', { class: 'mono dim', style: 'font-size: 11.5px; width: 22px;' }, `#${idx + 1}`),
            h('span', { class: 'grow ell' }, typeof t === 'string' ? t : t.title || t.key))))) : null)
  ];
}


/** The conversation: each request (newest last) and converge's answer, which follows the run as it goes. */
export function renderThread(runs, pending, onStop) {
  const list = runs.slice(0, 8).reverse();
  if (!list.length && !pending) return null;
  const msg = (text) => h('div', { class: 'msg you' }, h('p', {
    onclick: (e) => { e.currentTarget.classList.toggle('expanded'); },
    title: 'Click to expand',
  }, text));
  return [
    ...list.map((r, i) => [msg(r.request), h('div', { class: 'msg reply' }, renderRun(r, i === list.length - 1 ? onStop : null))]),
    pending ? [msg(pending.request), h('div', { class: 'msg reply' }, h('div', { class: `runbox ${pending.error ? 'bad' : 'info busy'}` },
      h('div', { class: 'run-text' }, h('p', { class: 'phase' }, pending.error ? `Could not start: ${pending.error}` : 'Sending…')),
      pending.error ? null : h('div', { class: 'bar-busy' })))] : null,
  ];
}
