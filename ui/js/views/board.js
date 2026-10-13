// Built for thousands of agents: counts, one square per agent (red and amber stand out), the agents
// that need attention with one line each, and the detail of the one you pick.

import { h } from '../dom.js';
import { nowMs, shortSha, timeAgo, parseLenientJson, parseNdjsonOrLines, formatStepTarget, refusalWhy, summarizeObject, wordCut } from '../format.js';
import { verification } from '../store.js';
import { receiptSummary } from '../receipts.js';

const STALL_MS = 10 * 60_000;

/** The agent's current change: its open one, else the last one it made. */
function changeOf(state, a) {
  // A task that landed is done: a later, empty hand-in of the same task does not undo it.
  const open = state.changes.find((c) => c.change_id === a.change_id);
  if (open && open.state !== 'landed') {
    const won = state.changes.find((c) => c.state === 'landed' && c.task_id === open.task_id && c.agent_id === a.agent_id);
    if (won) return won;
  }
  return state.changes.find((c) => c.change_id === a.change_id) || [...state.changes].reverse().find((c) => c.agent_id === a.agent_id) || null;
}

export function checksOf(state, ch) {
  const v = verification(state, ch);
  return {
    tests: v === 'off' ? 'none' : v,
    evidence: !ch.claims.length ? 'none' : !ch.evidence || ch.evidence.commit !== ch.head_commit ? 'pending' : ch.evidence.exit_code === 0 ? 'pass' : 'fail',
    done: ch.acceptance || 'none',
    scope: ch.out_of_scope.length ? 'fail' : 'pass',
  };
}

/** Each agent's standing: s = bad | warn | wait | ok | work | idle | gone, and the one-line reason. Working means doing
 *  something (a change under way, or files claimed); an agent that joined and has not begun is idle, not working. */
// Kinds that are over (replaced, stopped) or not begun (idle): counted, but drawn only when their count is picked, so
// hundreds of finished agents do not bury the ones at work.
export const QUIET_KINDS = new Set(['gone', 'stop', 'idle']);
export function assess(state, now = nowMs()) {
  return state.agents.map((a) => {
    const ch = changeOf(state, a);
    const task = state.tasks.find((t) => t.agents.includes(a.agent_id) || (ch && t.task_id === ch.task_id));
    const out = { a, ch, task, s: 'idle', why: a.role === 'reviewer' ? 'reviewer' : 'not started' };
    const acts = state.acts?.[a.agent_id] || [];
    const lastRefused = [...acts].reverse().find((e) => e.verdict === 'refused');
    // Replaced: its task went on to a newer agent (a takeover, a continued run, its command starting a fresh agent
    // when the old one ran out of steps). Read from the task's own list of agents, in order (the event window is
    // only the newest events, so it cannot be the source). In a split task only the last agent is live.
    const mine = state.tasks.find((t) => t.agents.includes(a.agent_id));
    const next = mine && mine.mode !== 'compete' ? mine.agents[mine.agents.indexOf(a.agent_id) + 1] : '';
    if (next) return { ...out, s: 'gone', why: 'replaced by a newer agent' };
    // Its change landed: a refusal along the way was recovered from (it is in the agent's own log), not something to act on.
    if (ch?.state === 'landed') return { ...out, s: 'ok', why: `landed ${shortSha(ch.landed_commit)}` };
    if (a.aios?.refused) return { ...out, s: 'bad', why: `blocked ${a.aios.refused}×${lastRefused ? `: ${lastRefused.action} ${formatStepTarget(lastRefused.action, lastRefused.target)}` : ''}` };
    // Its run has ended (stopped, out of budget, finished) and its work did not land or wait to: it is not working.
    if (state.stoppedAgents?.has(a.agent_id) && !(ch && ['landed', 'submitted', 'superseded'].includes(ch.state))) return { ...out, s: 'stop', why: 'stopped' };
    if (ch) {
      const k = checksOf(state, ch);
      const failed = Object.entries(k).filter(([, v]) => v === 'fail').map(([n]) => ({ done: 'acceptance check', tests: 'tests', evidence: 'proof', scope: 'scope' }[n] || n));
      if (ch.state === 'conflicted') return { ...out, s: 'warn', why: 'clashes with main' };
      if (ch.state === 'submitted' && failed.length) return { ...out, s: 'warn', why: `${failed.join(', ')} failed` };
      if (ch.state === 'landed') return { ...out, s: 'ok', why: `landed ${shortSha(ch.landed_commit)}` };
      if (ch.state === 'superseded') return { ...out, s: 'gone', why: state.tasks.some((t) => t.task_id === ch.task_id && t.agents.at(-1) !== a.agent_id && t.mode !== 'compete') ? 'replaced by a newer agent' : 'another agent won' };
      if (ch.state === 'submitted') return { ...out, s: 'wait', why: Object.values(k).includes('pending') ? 'being checked' : 'ready to land' };
    }
    const begun = Boolean(ch || a.intent?.paths?.length || acts.length);
    if (begun && a.role !== 'reviewer' && a.last_seen && now - a.last_seen > STALL_MS && (!ch || ch.state === 'working'))
      return { ...out, s: 'warn', why: `no activity for ${timeAgo(a.last_seen, now).replace(/ ago$/, '')}` };
    if (ch) return { ...out, s: 'work', why: 'working' };
    if (a.intent?.paths?.length) return { ...out, s: 'work', why: `editing ${[...new Set(a.intent.paths.map((p) => String(p).split(':')[0].split('/').pop()))].slice(0, 2).join(', ')}` };
    // Steps reported lately (a command, a read, an edit) but nothing claimed yet: it is reading its way in.
    const lastAct = acts[acts.length - 1];
    if (lastAct && now - (lastAct.at || 0) < STALL_MS) return { ...out, s: 'work', why: 'reading the code' };
    if (lastAct) return { ...out, why: `idle ${timeAgo(lastAct.at, now).replace(/ ago$/, '')}` };
    return out;
  });
}

export function renderSummary(state) {
  const r = receiptSummary(state);
  const p = state.project;
  return [
    h('span', { class: 'dim' }, 'main ', h('span', null, shortSha(p.main_head, 7) || '—')),
    p.verify_jailed === undefined ? null : h('span', {
      class: p.verify_jailed ? 'good' : 'bad',
      // Say what the fence really is where the checks run: Cloudflare's runner kernel has no Landlock
      // (GET /api/projects/<p>/jail runs the self-check there and returns the kernel's answers).
      title: p.verify_mode === 'runner' ? 'Checks run on cloud runners as a separate limited user. Network not blocked.'
        : p.verify_mode === 'seatbelt' ? 'Checks run in a macOS sandbox: can only write to their copy, no network unless allowed'
        : p.verify_mode === 'uid' ? 'Checks run as a separate limited user. Network not blocked.'
        : p.verify_jailed ? 'Checks run in a sandbox: can only write to their copy, no network' : p.verify_unjailed_why || 'Checks from agents are not run',
    }, p.verify_jailed ? (p.verify_mode === 'uid' || p.verify_mode === 'runner' ? '✓ isolated' : '✓ sandboxed') : '✗ not sandboxed'),
    !p.receipt_key ? null : h('span', { class: r.bad ? 'bad' : r.verified === r.sealed ? 'good' : 'dim', title: 'Signatures checked in your browser' }, `${r.bad ? '✗' : '✓'} ${r.verified}/${r.sealed} landings signed`),
    r.restarts ? h('span', { class: 'warn', title: 'All signatures are valid. Numbering restarted after an engine restart (since fixed).' }, `numbering restarted ${r.restarts}×`) : null,
  ];
}

const KINDS = [['all', 'agents'], ['work', 'working'], ['wait', 'waiting'], ['warn', 'needs a look'], ['bad', 'blocked'], ['ok', 'landed'], ['gone', 'replaced'], ['stop', 'stopped'], ['idle', 'idle']];

export const kindLabel = (k) => (KINDS.find(([x]) => x === k) || KINDS[0])[1];

/** How long an agent has been in trouble, in ms (0 when it is fine or never reported). */
const trouble = (x, now) => ((x.s === 'warn' || x.s === 'bad') && x.a.last_seen ? now - x.a.last_seen : 0);

export function renderDots(list, ui, select) {
  const now = nowMs();
  return list.map((x) => {
    const age = trouble(x, now);
    return h('button', { type: 'button', class: age > STALL_MS ? 'dot old' : 'dot', 'data-s': x.s, 'aria-pressed': ui.agent === x.a.agent_id ? 'true' : 'false',
      title: `${x.a.agent_id} · ${x.why}${age > STALL_MS ? ` · stuck ${timeAgo(x.a.last_seen, now)}` : ''}${x.task ? `\n${x.task.title}` : ''}`, onclick: () => select(x.a.agent_id) });
  });
}

const FLEET = [['ok', 'landed'], ['wait', 'waiting'], ['work', 'working'], ['warn', 'needs a look'], ['bad', 'blocked'], ['idle', 'idle'], ['stop', 'stopped'], ['gone', 'replaced']];
/** The whole fleet in one coloured bar, by standing: the only breakdown on the board. Picking a part filters to it. */
export function renderFleet(list, state, ui, setKind) {
  const n = (k) => list.filter((x) => x.s === k).length;
  const total = list.length;
  // One colour only (all landed, say): the status line already says it, and nothing is left to filter by.
  if (!total || (FLEET.filter(([k]) => n(k)).length < 2 && ui.kind === 'all')) return null;
  return h('div', { class: 'fl-bar', role: 'group', 'aria-label': 'Agents by status. Click to filter' },
    FLEET.map(([k, label]) => n(k) ? h('button', { type: 'button', class: `seg s-${k}${ui.kind === k ? ' on' : ''}`, style: `flex-grow:${n(k)}`, title: `${n(k)} ${label}: ${ui.kind === k ? 'click again to show all' : 'show only these'}`,
      'aria-pressed': ui.kind === k ? 'true' : 'false', onclick: () => setKind(ui.kind === k ? 'all' : k) }, n(k) / total > 0.12 ? `${n(k)} ${label}` : n(k) / total > 0.04 ? String(n(k)) : '') : null));
}

const TONE = { bad: 'bad', warn: 'warn', wait: 'info', ok: 'good', gone: 'dim', work: 'violet', idle: 'dim' };

/** Every agent (or every one that matches the filter) as a row, the ones that need attention first. */
export function renderIssues(list, ui, select, filtering = false) {
  const order = { bad: 0, warn: 1, wait: 2, work: 3, idle: 4, ok: 5, stop: 6, gone: 7 };
  const issues = list.filter((x) => x.s in order).sort((p, q) => order[p.s] - order[q.s]);
  if (!issues.length) return h('li', { class: 'none' }, filtering ? 'No agents match' : 'No agents yet');
  return [
    ...issues.slice(0, 200).map((x) => h('li', { 'aria-selected': ui.agent === x.a.agent_id ? 'true' : 'false', onclick: () => select(x.a.agent_id) },
      h('span', { class: `st ${TONE[x.s] || 'dim'}` }, kindLabel(x.s)),
      h('span', { class: 'mono name', title: x.a.agent_id }, x.a.agent_id),
      h('span', { class: 'why', title: x.why }, wordCut(x.why, 160)),
      h('span', { class: 'task', title: x.task?.title || '' }, x.task ? x.task.title : ''))),
    issues.length > 200 ? h('li', { class: 'none' }, `+${issues.length - 200} more`) : null,
  ];
}

const mark = (v) => ({ pass: h('span', { class: 'good' }, '✓'), fail: h('span', { class: 'bad' }, '✗'), pending: h('span', { class: 'warn' }, '…') }[v] || h('span', { class: 'dim' }, '—'));

function formatSingleObservation(data, str) {
  const sum = summarizeObject(data);
  const rows = [];
  const walk = (obj, prefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      const keyName = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) continue;
      if (typeof v === 'boolean') {
        rows.push(h('div', { class: 'obs-row' },
          h('span', { class: 'obs-k mono' }, keyName.replace(/_/g, ' ')),
          h('span', { class: v ? 'obs-v good' : 'obs-v dim' }, v ? '✓ yes' : '✗ no')));
      } else if (typeof v === 'string' || typeof v === 'number') {
        const isSha = typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
        rows.push(h('div', { class: 'obs-row' },
          h('span', { class: 'obs-k mono' }, keyName.replace(/_/g, ' ')),
          h('span', { class: isSha ? 'obs-v mono' : 'obs-v' }, isSha ? shortSha(v, 10) : String(v))));
      } else if (Array.isArray(v)) {
        rows.push(h('div', { class: 'obs-row' },
          h('span', { class: 'obs-k mono' }, keyName.replace(/_/g, ' ')),
          h('span', { class: v.length ? (typeof v[0] === 'string' && v.length <= 4 ? v.join(', ') : `${v.length} item(s)`) : '(none)' })));
      } else if (typeof v === 'object' && prefix === '') {
        walk(v, k);
      }
    }
  };
  walk(data);
  const outText = data.stdout || data.output || (typeof data.report === 'string' ? data.report : '');
  return h('div', { class: 'obs-card' },
    h('div', { class: `obs-header${sum.tone ? ` ${sum.tone}` : ''}` },
      h('span', { class: `al-badge${sum.tone ? ` ${sum.tone}` : ''}` }, sum.badge),
      h('span', { class: 'obs-title' }, sum.title)),
    rows.length ? h('div', { class: 'obs-rows' }, rows) : null,
    outText ? h('pre', { class: 'out' }, outText) : null,
    h('details', { class: 'al-raw' },
      h('summary', { class: 'dim' }, 'raw details'),
      h('pre', null, str)));
}

function formatObservation(obs) {
  if (!obs) return h('div', { class: 'dim small' }, '(none)');
  const str = String(obs).trim();
  const items = parseNdjsonOrLines(str);
  if (items.length) {
    const cards = [];
    for (const item of items) {
      if (typeof item === 'object' && item !== null) {
        if ((item.t === 'end' || item.type === 'end') && Object.keys(item).length <= 2) continue;
        cards.push(formatSingleObservation(item, JSON.stringify(item, null, 2)));
      } else {
        cards.push(h('pre', null, String(item)));
      }
    }
    if (cards.length === 1) return cards[0];
    if (cards.length > 1) return h('div', { class: 'obs-cards' }, cards);
  }
  return h('pre', null, obs);
}

function diffView(text) {
  return h('pre', null, String(text).split('\n').map((l) =>
    h('div', { class: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '' }, l || ' ')));
}

export function renderDetail(state, ui, actions) {
  const a = state.agents.find((x) => x.agent_id === ui.agent);
  if (!a) return null;
  const ch = changeOf(state, a);
  const task = state.tasks.find((t) => t.agents.includes(a.agent_id) || (ch && t.task_id === ch.task_id));
  const rawActs = (state.acts?.[a.agent_id] || []).slice().reverse();
  // Group consecutive identical steps (like repetitive task_status or repeated file reads) into clusters
  const groupedActs = [];
  for (const e of rawActs) {
    const prev = groupedActs[groupedActs.length - 1];
    if (prev && prev.action === e.action && (prev.target || '') === (e.target || '') && prev.verdict === e.verdict && !prev.alerts?.length && !e.alerts?.length && !prev.reason && !e.reason) {
      prev.times = (prev.times || 1) + 1;
      prev.lastCycle = e.cycle;
      prev.items.push(e);
    } else {
      groupedActs.push({ ...e, times: 1, firstCycle: e.cycle, lastCycle: e.cycle, items: [e] });
    }
  }

  // Replay: every cycle is a row; picking one shows what the mind said, what it saw and the files that
  // cycle changed (loaded from the platform), and offers to rewind the agent to just before it.
  const picked = ui.cycle.agent === a.agent_id ? ui.cycle : null;
  const sel = picked && rawActs.find((e) => e.cycle === picked.n);
  const full = sel && picked.full;
  const cycleView = sel ? h('div', { class: 'cycle-detail' },
    h('h4', null, `#${sel.cycle} · ${sel.action} ${formatStepTarget(sel.action, sel.target)}`),
    picked.loading ? h('div', { class: 'dim' }, 'loading…') : picked.error ? h('div', { class: 'bad' }, picked.error) : [
      h('h4', null, 'reply'), h('pre', null, full?.reply || '(none)'),
      h('h4', null, 'result'), formatObservation(full?.observation),
      h('h4', null, 'files changed'), picked.diff ? diffView(picked.diff) : h('div', { class: 'dim' }, 'none'),
    ],
    a.rewind_to ? h('div', { class: 'warn cycle-actions' }, `Rewind to before step ${a.rewind_to} queued`)
      : ui.adminKey ? h('div', { class: 'cycle-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => actions.rewind(a.agent_id, sel.cycle) }, `Rewind to before step ${sel.cycle}`))
      : h('div', { class: 'dim cycle-actions' }, 'Rewinding needs the admin key')) : null;

  const ACTION_TONE = { run: 'cmd', edit: 'edit', write: 'edit', read: 'read', status: 'dim', task_status: 'dim', converge: 'conv' };

  const activity = h('div', null,
    h('h3', null, a.aios ? `${a.agent_id} · ${String(a.aios.mind).replace(/^external:(bridge:)?/, '')}` : a.agent_id),
    groupedActs.length
      ? h('ol', { class: 'log' }, groupedActs.map((g) => {
          const isSel = sel && g.items.some((i) => i.cycle === sel.cycle);
          const activeCycle = isSel ? sel.cycle : g.firstCycle;
          const cycleLabel = g.times > 1 ? `#${g.firstCycle}–#${g.lastCycle}` : `#${g.firstCycle}`;
          const badgeClass = `act-tag ${ACTION_TONE[g.action] || 'other'}`;
          return h('li', {
            class: `${g.verdict === 'refused' ? 'bad' : (g.alerts || []).length ? 'warn' : ''}${isSel ? ' sel' : ''}`,
            onclick: () => actions.selectCycle(a.agent_id, activeCycle),
            title: g.target ? `${g.action} ${formatStepTarget(g.action, g.target)}` : g.action
          },
            h('span', { class: 'dim log-cyc' }, cycleLabel),
            h('span', { class: badgeClass }, g.action),
            h('span', { class: 'log-target ell' },
              g.verdict === 'refused' ? h('b', { class: 'bad' }, 'REFUSED ') : g.verdict === 'failed' ? h('b', { class: 'warn' }, '(failed) ') : null,
              formatStepTarget(g.action, g.target) || ''),
            g.times > 1 ? h('span', { class: 'log-count' }, `×${g.times}`) : null,
            g.verdict !== 'allowed' && g.reason ? h('span', { class: 'why' }, g.reason) : null);
        }))
      : h('div', { class: 'dim' }, 'No steps yet'),
    cycleView,
    a.aios?.grants?.length ? h('details', null, h('summary', null, `${a.aios.grants.length} permissions`), h('pre', null, a.aios.grants.join('\n'))) : null);

  const k = ch ? checksOf(state, ch) : null;
  const v = ch?.verified && ch.verified.commit === ch.head_commit ? ch.verified : null;
  const canLand = ch && ch.state === 'submitted' && !Object.values(k).some((x) => x === 'fail' || x === 'pending') && ui.reviewerKey;
  const change = h('div', null,
    h('h3', null, ch ? `change ${ch.change_id} · ${ch.state}` : 'No change yet'),
    h('dl', { class: 'facts' },
      h('dt', null, 'task'), h('dd', null, task ? `${task.title}${task.mode === 'compete' ? ' (compete)' : ''}` : '—'),
      ch ? [
        h('dt', null, 'summary'), h('dd', null, ch.summary || '—'),
        h('dt', null, 'tests'), h('dd', null, v ? h('span', { class: v.exit_code === 0 ? 'good' : 'bad' }, `exit ${v.exit_code} · ${v.command}`) : mark(k.tests)),
        h('dt', null, 'proof'), h('dd', null, ch.claims.length ? [mark(k.evidence), ` ${ch.claims.length} statements`] : h('span', { class: 'dim' }, 'none')),
        h('dt', null, 'done when'), h('dd', null, task?.accept?.length ? [mark(k.done), ' ', task.accept.join('  ·  ')] : h('span', { class: 'dim' }, 'none set')),
        h('dt', null, 'files'), h('dd', null, ch.out_of_scope.length ? h('span', { class: 'bad' }, `outside its task: ${ch.out_of_scope.join(', ')}`) : h('span', { class: 'good' }, 'within its task')),
      ] : null),
    ch?.head_commit ? (ui.diff.changeId === ch.change_id ? diffView(ui.diff.text) : h('button', { type: 'button', onclick: () => actions.loadDiff(ch.change_id) }, 'Show diff')) : null,
    canLand ? h('div', { class: 'land-row' }, h('button', { type: 'button', class: 'primary', onclick: () => actions.land(ch.change_id) }, 'Land')) : null);
  return [activity, change];
}

// The newest steps across every agent, one short line each, newest first: the board's motion.
const CHECK = { project: 'project tests', accept: 'done-when check', claim: 'files check', evidence: 'proof check', tests: 'its own tests' };

// The pipeline: every task as a card, in the column of how far it has got. Working (its agents are on it),
// Checking (handed in; converge runs the checks and the merge train), Landed (on main, signed), Sent back
// (a check failed or it clashed; its agent redoes it).
const COLUMNS = [['working', 'Working'], ['checking', 'Checking'], ['landed', 'Landed'], ['back', 'Sent back']];

export function taskStage(state, t) {
  const chs = state.changes.filter((c) => c.task_id === t.task_id);
  const landed = chs.find((c) => c.state === 'landed');
  if (landed) return { stage: 'landed', ch: landed };
  const live = [...chs].reverse().find((c) => c.state !== 'superseded') || chs[chs.length - 1] || null;
  if (live && live.state === 'conflicted') return { stage: 'back', ch: live, why: 'clashes with main' };
  if (live && live.state === 'submitted') {
    const k = checksOf(state, live);
    const failed = Object.entries(k).filter(([, v]) => v === 'fail').map(([n]) => n);
    if (failed.length) return { stage: 'back', ch: live, why: `${failed.map((f) => ({ tests: 'tests', evidence: 'proof', done: 'acceptance check', scope: 'scope' }[f])).join(', ')} failed` };
    return { stage: 'checking', ch: live, why: Object.values(k).includes('pending') ? 'being checked' : 'waiting to land' };
  }
  const seen = Math.max(0, ...state.agents.filter((x) => t.agents.includes(x.agent_id)).map((x) => Math.max(x.last_seen || 0, x.intent?.at || 0)));
  if (t.agents.length && seen && nowMs() - seen > STALL_MS) return { stage: 'working', ch: live, stalled: true, why: `last active ${timeAgo(seen)}` };
  const ag = state.agents.find((x) => t.agents.includes(x.agent_id) && x.intent?.paths?.length);
  const on = ag ? ag.intent.paths.map((p) => String(p).split('/').pop()).slice(0, 3).join(', ') : '';
  return { stage: 'working', ch: live, why: !t.agents.length ? 'waiting for an agent' : on ? `editing ${on}` : 'reading the code' };
}

const CHECK_ROW = [['tests', 'tests'], ['done', 'acceptance'], ['scope', 'scope'], ['evidence', 'proof']];

/** Changes as a review queue: one row per change (newest first), what it is and how it stands, and what to do
 *  with it. `past` lists the attempts another one replaced. Rows are keyed items for reconcile(). */
export function changeItems(state, diffs, ui, actions, select, { past = false, keep = null, only = null } = {}) {
  // A leftover hand-in of a task that already landed (same agent) belongs with the past attempts.
  const leftover = (c) => c.state !== 'landed' && c.state !== 'superseded' && state.changes.some((x) => x.state === 'landed' && x.task_id === c.task_id && x.agent_id === c.agent_id);
  const rows = state.changes.filter((c) => (past ? c.state === 'superseded' || leftover(c) : c.state !== 'superseded' && !leftover(c)) && (c.head_commit || c.state !== 'working') && (!keep || keep.has(c.agent_id)) && (!only || only(c))).slice().reverse();
  // Many landed changes with all checks green are one line, not one row each: the exceptions stay as rows.
  ui.groups ??= {};
  const landedAll = rows.filter((c) => c.state === 'landed');
  const fold = !past && !only && landedAll.length > 6 && !ui.groups.landedChanges?.open;   // the Landed tab shows them all
  const hidden = fold ? new Set(landedAll.slice(3).map((c) => c.change_id)) : new Set();
  const shown = rows.filter((c) => !hidden.has(c.change_id)).slice(0, 60);
  const more = hidden.size ? [{
    key: '~landed-more', sig: `more|${hidden.size}`,
    make: () => h('li', { class: 'crow more-landed' }, h('button', { type: 'button', class: 'link', onclick: () => actions.toggleGroup('landedChanges', { open: true }) }, `Show ${hidden.size} more landed`)),
  }] : [];
  const items = shown.map((c) => {
    const task = state.tasks.find((t) => t.task_id === c.task_id);
    const d = diffs.get(c.change_id);
    const lines = String(d?.text || '').split('\n');
    const adds = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const dels = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    const k = checksOf(state, c);
    const failed = Object.values(k).includes('fail');
    const pending = Object.values(k).includes('pending');
    const [label, tone] = c.state === 'landed' ? ['Landed', 'good'] : c.state === 'conflicted' ? ['Clash', 'warn'] : c.state === 'superseded' || leftover(c) ? ['Replaced', 'dim']
      : c.state === 'submitted' ? (failed ? ['Sent back', 'warn'] : pending ? ['Checking', 'info'] : ['Ready to land', 'good'])
      : state.stoppedAgents?.has(c.agent_id) ? ['Stopped, work saved', 'dim'] : ['In progress', 'violet'];
    const canLand = label === 'Ready to land' && ui.reviewerKey;
    return {
      key: c.change_id,
      sig: `${c.state}|${label}|${adds}|${dels}|${canLand}|${d?.failed || ''}|${c.depends_on || ''}`,
      make: () => h('li', { class: 'crow' },
        h('div', { class: 'cr-main', onclick: () => select(c.agent_id, c.change_id) },
          h('span', { class: 'cr-title' }, task?.title || c.summary || c.change_id),
          h('span', { class: 'cr-meta mono' }, `${c.change_id} · ${c.agent_id}${c.depends_on ? ` · stacked on ${c.depends_on}` : ''}${(c.targets || []).map((t) => ` · ${t.branch}: ${t.landed ? 'landed' : t.held ? 'held' : 'pending'}`).join('')}`),
          d?.text ? h('span', { class: 'cr-stat' }, h('span', { class: 'good' }, `+${adds}`), ' ', h('span', { class: 'bad' }, `−${dels}`)) : d?.failed ? h('span', { class: 'cr-stat bad', title: "Couldn't load the diff. Check your key or try again." }, 'no diff') : h('span', { class: 'cr-stat dim' }, '…'),
          h('span', { class: `badge ${tone}` }, label)),
        h('div', { class: 'cr-act' },
          c.head_commit ? h('button', { type: 'button', onclick: () => select(c.agent_id, c.change_id) }, 'View diff') : null,
          c.state === 'conflicted' ? h('button', { type: 'button', onclick: () => select(c.agent_id, c.change_id) }, 'View clash') : null,
          canLand ? h('button', { type: 'button', class: 'primary', onclick: () => actions.land(c.change_id) }, 'Land') : null)),
    };
  });
  return [...items, ...more];
}
