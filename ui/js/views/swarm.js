// The swarm at scale: who holds which lines of which files (claims), where two agents are about to collide
// (overlapping claims) or did (conflicts), the codebase by folder ("territories"), and the merge train.
// Everything here is read from the state the board already has: agents' intents, IntentClaimed events, changes'
// files, conflicts and integration runs.

import { h } from '../dom.js';
import { nowMs, shortSha, timeAgo, plural, wordCut } from '../format.js';
import { describe } from './work.js';
import { assess } from './board.js';

const NEAR = 20; // lines: two claims this close in one file are an overlap worth a look

/** "net/tcp.cpp:40-80" -> { path, from, to } (a whole file: 0..Infinity). */
function parseClaim(p) {
  const m = /^(.*?):(\d+)-(\d+)$/.exec(String(p));
  return m ? { path: m[1], from: Number(m[2]), to: Number(m[3]) } : { path: String(p), from: 0, to: Infinity };
}
const span = (c) => (c.to === Infinity ? 'whole file' : `lines ${c.from}-${c.to}`);
export const folderOf = (p) => (String(p).includes('/') ? `${String(p).split('/')[0]}/` : '(top level)');

/** Each active agent's claims now: its open intent, else what its newest IntentClaimed said (unless released). */
export function claimsOf(state) {
  const last = new Map();
  for (const e of state.recent) {
    if (e.type === 'IntentClaimed') last.set(e.agent_id, e);
    else if (e.type === 'IntentReleased' || e.type === 'Landed' || e.type === 'Superseded') {
      const a = e.agent_id || state.changes.find((c) => c.change_id === e.change_id)?.agent_id;
      if (a) last.delete(a);
    }
  }
  const out = [];
  for (const a of state.agents) {
    const paths = a.intent?.paths?.length ? a.intent.paths : last.get(a.agent_id)?.paths || [];
    const task = state.tasks.find((t) => t.agents.includes(a.agent_id));
    // Only agents still in play hold claims: one replaced by a newer agent on its task, or whose run has ended, does not.
    if (task && task.mode !== 'compete' && task.agents.at(-1) !== a.agent_id) continue;
    if (state.stoppedAgents?.has(a.agent_id)) continue;
    for (const p of paths) out.push({ agent: a.agent_id, task, ...parseClaim(p) });
  }
  return out;
}

/** Pairs of agents whose claims meet in one file (overlapping, or within NEAR lines), most severe first. */
export function overlaps(claims) {
  const byPath = new Map();
  for (const c of claims) { if (!byPath.has(c.path)) byPath.set(c.path, []); byPath.get(c.path).push(c); }
  const out = [];
  for (const [path, cs] of byPath) {
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j];
      if (a.agent === b.agent) continue;
      const gap = Math.max(a.from, b.from) - Math.min(a.to, b.to);
      // A whole-file claim is a broad intent, not a collision: git merges line by line, and a real clash is sent
      // back by the platform. Only line ranges that intersect are "hard".
      const whole = a.to === Infinity || b.to === Infinity;
      if (gap <= NEAR) out.push({ path, a, b, hard: !whole && gap <= 0, whole, sameTask: a.task && a.task === b.task });
    }
  }
  return out.sort((x, y) => Number(y.hard) - Number(x.hard));
}

/** The folders being worked in: tasks, agents and claims per top-level folder, overlaps and conflicts flagged. */
export function territories(state) {
  const claims = claimsOf(state);
  const ov = overlaps(claims);
  const map = new Map();
  const get = (f) => { if (!map.has(f)) map.set(f, { folder: f, tasks: new Set(), agents: new Set(), files: new Map(), working: 0, checking: 0, landed: 0, overlaps: 0, clashes: 0, conflicts: 0 }); return map.get(f); };
  for (const c of claims) {
    const t = get(folderOf(c.path));
    t.agents.add(c.agent);
    if (c.task) t.tasks.add(c.task.task_id);
    if (!t.files.has(c.path)) t.files.set(c.path, []);
    t.files.get(c.path).push(c);
  }
  for (const ch of state.changes) {
    if (ch.state === 'superseded') continue;
    for (const f of ch.files || []) {
      const t = get(folderOf(f));
      if (ch.task_id) t.tasks.add(ch.task_id);
      if (ch.state === 'landed') t.landed++;
      if (ch.state === 'conflicted') t.conflicts += (ch.conflicts || []).filter((x) => folderOf(x.path) === t.folder).length || 1;
      if (!t.files.has(f)) t.files.set(f, []);
    }
  }
  for (const o of ov) { const t = get(folderOf(o.path)); t.overlaps++; if (o.hard && !o.sameTask) t.clashes++; }
  for (const t of map.values()) {
    for (const id of t.tasks) {
      const task = state.tasks.find((x) => x.task_id === id);
      if (!task) continue;
      const d = describe(state, task);
      if (d.status === 'Working') t.working++;
      else if (d.status === 'Checking') t.checking++;
    }
  }
  return { list: [...map.values()].sort((a, b) => b.overlaps + b.conflicts - (a.overlaps + a.conflicts) || b.agents.size - a.agents.size), overlaps: ov, claims };
}

/** Territory cards; the open one lists its files and who holds which lines. */
export function renderTerritories(state, ui, actions, select) {
  const { list, overlaps: ov } = territories(state);
  if (!list.length) return h('p', { class: 'dim none' }, 'No files in use yet.');
  return h('div', { class: 'terr' }, list.map((t) => {
    const open = ui.folder === t.folder;
    const hot = t.clashes || t.conflicts;
    return h('div', { class: `tcardx${hot ? ' hot' : ''}${open ? ' open' : ''}` },
      h('button', { type: 'button', class: 'tx-h', onclick: () => actions.openFolder(open ? '' : t.folder) },
        h('span', { class: 'tx-name mono' }, t.folder),
        h('span', { class: 'tx-n' }, `${plural(t.tasks.size, 'task')}${t.agents.size ? ` · ${plural(t.agents.size, 'agent')} here` : ''}`),
        h('span', { class: 'tx-st' }, [t.working ? `${t.working} working` : '', t.checking ? `${t.checking} checking` : '', t.landed ? `${t.landed} landed` : ''].filter(Boolean).join(' · ') || (t.agents.size ? 'quiet' : 'no agents here')),
        hot ? h('span', { class: 'tx-hot' }, [t.clashes ? `${plural(t.clashes, 'overlap')} on the same lines` : '', t.conflicts ? plural(t.conflicts, 'clash', 'clashes') + ' with main' : ''].filter(Boolean).join(' · ')) : null,
        h('span', { class: 'tx-files mono' }, [...t.files.keys()].slice(0, 3).map((f) => f.split('/').pop()).join(', ') + (t.files.size > 3 ? ` +${t.files.size - 3}` : ''))),
      open ? h('ol', { class: 'tx-list' }, [...t.files.entries()].map(([f, cs]) => {
        const fo = ov.filter((o) => o.path === f);
        const conflicted = state.changes.filter((c) => c.state === 'conflicted' && (c.conflicts || []).some((x) => x.path === f));
        return h('li', { class: fo.length || conflicted.length ? 'hot' : '' },
          h('span', { class: 'mono f' }, f),
          cs.length ? h('span', { class: 'who' }, cs.map((c) => h('button', { type: 'button', class: 'claim', onclick: () => select(c.agent), title: c.task?.title || '' }, h('span', { class: 'mono' }, c.agent), ` ${span(c)}`))) : h('span', { class: 'dim small' }, 'changed, not reserved'),
          fo.length ? h('span', { class: 'warn small' }, fo.map((o) => `${o.hard ? 'overlap' : 'close'}: ${o.a.agent} and ${o.b.agent}`).join(' · ')) : null,
          conflicted.length ? h('span', { class: 'bad small' }, `clash with main: ${conflicted.map((c) => c.agent_id).join(', ')}`) : null);
      })) : null);
  }));
}

/** Needs attention, at scale: overlapping claims and conflicts first (where the swarm is about to collide or did). */
export function contentionRows(state, select) {
  // Needs a person: agents of different tasks claiming the same lines of a file, one row per file (not per pair).
  // Broad (whole-file) and near-miss claims are routine: they show on the heat map, not here.
  const { overlaps: ov } = territories(state);
  const byFile = new Map();
  for (const o of ov.filter((x) => x.hard && !x.sameTask)) {
    const f = byFile.get(o.path) || { path: o.path, agents: new Map(), from: Infinity, to: 0 };
    for (const c of [o.a, o.b]) f.agents.set(c.agent, c);
    f.from = Math.min(f.from, Math.max(o.a.from, o.b.from)); f.to = Math.max(f.to, Math.min(o.a.to, o.b.to));
    byFile.set(o.path, f);
  }
  const rows = [...byFile.values()].slice(0, 8).map((f) => {
    const cs = [...f.agents.values()];
    return h('li', { class: 'need', onclick: () => select(cs[0].agent), title: cs.map((c) => `${c.agent} (${span(c)}): ${c.task?.title || '?'}`).join('\n') },
      h('span', { class: 'st bad' }, 'Same lines'),
      h('span', { class: 'why ell' }, `${plural(cs.length, 'agent')} on `, h('span', { class: 'mono' }, `${f.path}:${f.from}-${f.to}`), h('span', { class: 'dim' }, ` · ${cs.map((c) => c.agent).join(', ')}`)));
  });
  return rows.length ? rows : null;
}

/** The merge train: what waits for main, what is being checked together, and the last landing (signed). */
export function renderTrain(state, select) {
  const waiting = state.changes.filter((c) => c.state === 'submitted');
  const running = waiting.filter((c) => c.integration && c.integration.exit_code == null);
  const failedRun = waiting.filter((c) => c.integration && c.integration.exit_code != null && c.integration.exit_code !== 0);
  const landed = state.landings.at(-1);
  const landedCh = landed && state.changes.find((c) => c.change_id === landed.change_id);
  const titleOf = (c) => state.tasks.find((t) => t.task_id === c.task_id)?.title || c.summary || c.change_id;
  if (!waiting.length && !landed) return null;
  return h('div', { class: 'train' },
    h('span', { class: 'tr-main' }, h('span', { class: 'dim' }, 'main '), h('span', { class: 'mono' }, shortSha(state.project.main_head, 7))),
    landed ? h('button', { type: 'button', class: 'tr-car good', onclick: () => landedCh && select(landedCh.agent_id, landedCh.change_id), title: landedCh ? titleOf(landedCh) : '' },
      `✓ landed ${timeAgo(landed.at)}`, landed.receipt_hash ? h('span', { class: 'dim' }, ' · signed') : null) : null,
    waiting.length ? h('span', { class: 'tr-rail' }) : null,
    waiting.slice(0, 8).map((c) => h('button', { type: 'button', class: `tr-car ${running.includes(c) ? 'info' : failedRun.includes(c) ? 'bad' : ''}`, onclick: () => select(c.agent_id, c.change_id), title: titleOf(c) },
      running.includes(c) ? h('span', { class: 'spin' }) : null, h('span', { class: 'ell' }, titleOf(c)))),
    waiting.length > 8 ? h('span', { class: 'dim small' }, `+${waiting.length - 8}`) : null,
    h('span', { class: 'tr-sum dim' }, waiting.length ? `${plural(waiting.length, 'change')} waiting${running.length ? ` · ${running.length} being checked together` : ''}${failedRun.length ? ` · ${failedRun.length} failed` : ''}` : 'nothing waiting'));
}

// ---- phase 1: the goal, the flow, the squares by workstream, failures by cause ------------------------------------

const MIN = 60_000;
const WINDOW = 15 * MIN;

/** Where each agent works: the top folder of what it claims or changed ("" when it has not begun). */
function agentFolders(state) {
  const out = new Map();
  for (const c of claimsOf(state)) if (!out.has(c.agent)) out.set(c.agent, folderOf(c.path));
  for (const ch of [...state.changes].reverse()) if (!out.has(ch.agent_id) && ch.files?.length) out.set(ch.agent_id, folderOf(ch.files[0]));
  return out;
}

/** The squares in labelled rows, one per workstream (a top folder for now), the busiest first. */
export function groupDots(all, named = new Map()) {
  return (state) => {
    const folders = agentFolders(state);
    const where = new Map([...folders, ...named]); // the planner's workstream names win over folders
    const groups = new Map();
    for (const x of all) {
      const g = where.get(x.a.agent_id) || 'not started';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(x);
    }
    return [...groups.entries()].sort((a, b) => (a[0] === 'not started') - (b[0] === 'not started') || b[1].length - a[1].length);
  };
}

/** Planned -> working -> handed in -> merge train -> on main, with how fast it lands and how much comes back. */
export function flowNumbers(state, now = nowMs()) {
  const n = { planned: 0, working: 0, handed: 0, train: 0, main: 0 };
  for (const t of state.tasks) {
    const st = describe(state, t).status;
    if (st === 'Done') n.main++;
    else if (st === 'Waiting') n.planned++;
    else if (st === 'Checking') n.handed++;
    else if (st === 'Stopped') n.stopped = (n.stopped || 0) + 1;
    else n.working++;
  }
  n.train = state.changes.filter((c) => c.state === 'submitted' && c.integration && c.integration.exit_code == null).length;
  const recent = state.recent.filter((e) => (e.at || 0) > now - WINDOW);
  const landed = state.landings.filter((e) => (e.at || 0) > now - WINDOW).length;
  const handedIn = recent.filter((e) => e.type === 'Submitted').length;
  const sentBack = new Set(recent.filter((e) => (e.type === 'Verified' && e.exit_code !== 0) || e.type === 'Conflicted').map((e) => e.change_id)).size;
  return { ...n, perMin: landed / 15, landed15: landed, backRate: handedIn ? Math.min(1, sentBack / handedIn) : 0, handedIn };
}

export function renderFlow(state, onTrain) {
  const f = flowNumbers(state);
  const stage = (n, label, extra, cls = '') => h('div', { class: `fl-st ${cls}` }, h('b', null, String(n)), h('span', null, label), extra || null);
  return [
    h('span', { class: 'fl-l' }, 'Flow', h('i', null, 'last 15 min')),
    stage(f.planned, 'planned'), h('span', { class: 'fl-ar' }, '→'),
    stage(f.working, 'working', f.stopped ? h('em', { class: 'dim' }, `${f.stopped} stopped`) : null), h('span', { class: 'fl-ar' }, '→'),
    stage(f.handed, 'submitted', f.handedIn ? h('em', { class: f.backRate > 0.3 ? 'warn' : '' }, `${Math.round(f.backRate * 100)}% sent back`) : null), h('span', { class: 'fl-ar' }, '→'),
    h('button', { type: 'button', class: 'fl-st fl-train', onclick: onTrain, title: 'Show the merge queue' }, h('b', null, String(f.train)), h('span', null, 'to merge')), h('span', { class: 'fl-ar' }, '→'),
    stage(f.main, 'on main', h('em', { class: 'good' }, f.landed15 ? `${f.perMin >= 1 ? f.perMin.toFixed(1) : f.landed15}${f.perMin >= 1 ? '/min' : ' in 15 min'}` : 'none lately'), 'good'),
  ];
}

/** Minutes left, read from the pace of the latest landings: only once three have landed, only while landings keep
 *  coming, and never an absurd number (no estimate beats a wrong one). */
export function etaMinutes(state, left, now = nowMs(), since = 0) {
  // This run's landings only: the pace of earlier runs (hours apart) said "about 18 min left" for a run that took one.
  const at = state.landings.map((e) => e.at || 0).filter((t) => t && t >= since).sort((x, y) => x - y);
  if (left <= 0 || at.length < 3) return null;
  const last = at.slice(-8);
  const per = (last.at(-1) - last[0]) / (last.length - 1); // ms per landing, lately
  if (!(per > 0)) return null;
  if (now - last.at(-1) > Math.max(per * 4, 5 * MIN)) return null; // gone quiet: the pace no longer holds
  const m = (left * per) / MIN;
  return m > 240 ? null : m;
}

/** The one status line: what this is, a thin progress line, the verdict (which always agrees with what needs you),
 *  how long is left (when that can be said honestly) and what it cost. */
export function renderGoal(state, run, needs, onNeeds, more = {}) {
  const total = state.tasks.length;
  if (!total && !run) return null;
  const done = state.tasks.filter((t) => describe(state, t).status === 'Done').length;
  const of = run && run.of ? run.of : total;
  // The run's own count comes from its swarm every 15 s; its tasks' landings show at once. The board reads the higher,
  // so the top line never says 0 done while the task list below says 1.
  const runDone = run ? state.tasks.filter((t) => (run.tasks || []).includes(t.title) && describe(state, t).status === 'Done').length : 0;
  const landed = Math.min(of, run ? Math.max(run.landed || 0, runDone) : done);
  const pct = of ? Math.round((landed / of) * 100) : 0;
  const left = of - landed;
  const eta = etaMinutes(state, left, nowMs(), run ? run.resumed || run.started || 0 : 0);
  const standing = assess(state);
  const busy = standing.some((x) => x.s === 'work' || x.s === 'wait');
  const title = run ? run.request.split(/(?<=[.!?:])\s/)[0].slice(0, 80) : state.project.name;
  const money = run && run.metered !== false && Number(run.spent) > 0 ? `$${Number(run.spent).toFixed(2)}${run.budget ? ` of $${Number(run.budget).toFixed(2)}` : ''} spent` : '';
  const going = run && ['running', 'stopping'].includes(run.phase);
  const since = run ? run.resumed || run.started : 0;
  const handedSince = since ? state.changes.some((c) => ['submitted', 'landed', 'conflicted'].includes(c.state)) || state.recent.some((e) => e.type === 'Submitted' && (e.at || 0) >= since) : false;
  const dry = going && !handedSince && nowMs() - since > 10 * MIN;
  // The verdict reads from the needs-you count itself, so the two can never disagree.
  // A run with no tasks yet is planning: said, with the planner's newest step, never "Idle" or "0 of N done" (N being an
  // earlier run's tasks).
  const planning = more.planning;
  const verdict = planning ? h('span', { class: 'gl-v info', title: planning.detail }, `${planning.title}…`)
    : needs ? h('button', { type: 'button', class: 'gl-v bad', onclick: onNeeds, title: 'show blocked tasks' }, `${needs} blocked`)
    : more.stuck ? h('button', { type: 'button', class: 'gl-v warn', onclick: onNeeds, title: 'show blocked agents' }, `${more.stuck} blocked`)
    : of && landed >= of ? h('span', { class: 'gl-v good' }, 'All done')
    : busy ? h('span', { class: 'gl-v good' }, 'All on track')
    // The run is going but no agent has reported a step yet: they are starting, not idle.
    : going ? h('span', { class: 'gl-v info' }, 'Starting agents…')
    : h('span', { class: 'gl-v dim' }, 'Idle');
  return [
    h('div', { class: 'gl-row' },
      h('b', { class: 'gl-t', title: run?.request || state.project.name }, title),
      h('div', { class: 'gl-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(of), 'aria-valuenow': String(landed), title: `${pct}%` }, h('div', { style: `width:${pct}%` })),
      planning ? h('span', { class: 'gl-n dim ell', title: planning.detail }, wordCut(planning.detail, 90)) : h('span', { class: 'gl-n' }, h('b', null, String(landed)), ` of ${of} done`),
      verdict,
      // Time left only while agents work: an ended or idle run ("about 142 min left" under Idle) has none.
      eta != null && !planning && (going || busy) ? h('span', { class: 'dim' }, eta < 1 ? 'under a minute left' : `about ${Math.round(eta)} min left`) : null,
      money ? h('span', { class: 'dim' }, money) : null,
      going || planning ? h('span', { class: 'gl-clock run-clock', 'data-since': String(since), title: 'Time running' }, '') : null,
      dry ? h('span', { class: 'gl-dry', title: 'Open an agent to see what it is doing' }, 'nothing finished yet') : null),
    needs && more.topNeed ? h('button', { type: 'button', class: 'gl-need', onclick: onNeeds, title: more.topNeed }, wordCut(more.topNeed, 160)) : null,
  ];
}

/** The radar: one bubble per folder, sized by the agents in it. Blue pulses where agents work, red where agents of
 *  different tasks claim the same lines or a change clashes with main; a click narrows the board to that folder. */
export function renderRadar(state, onPick, picked = '') {
  const ts = territories(state).list.filter((t) => t.agents.size || t.working || t.checking || t.conflicts);
  if (!ts.length) return null;
  const max = Math.max(...ts.map((t) => t.agents.size), 1);
  return [
    h('div', { class: 'rd-h' }, h('h2', null, 'Folders'), h('span', { class: 'dim small' }, `${plural(new Set(ts.flatMap((t) => [...t.agents])).size, 'agent')} in ${plural(ts.length, 'folder')} · blue: working · red: clash`)),
    h('div', { class: 'rd' }, ts.sort((a, b) => b.clashes + b.conflicts - (a.clashes + a.conflicts) || b.agents.size - a.agents.size).map((t) => {
      const hot = t.clashes || t.conflicts;
      const size = 46 + Math.round((t.agents.size / max) * 34);
      const busy = t.working + t.checking;
      return h('button', { type: 'button', class: `rd-b${hot ? ' hot' : busy ? ' busy' : ''}${picked === t.folder ? ' picked' : ''}`, style: `--sz:${size}px`, onclick: () => onPick(picked === t.folder ? '' : t.folder),
        title: `${t.folder}: ${plural(t.agents.size, 'agent')}, ${plural(t.tasks.size, 'task')}, ${plural(t.files.size, 'file')}${t.clashes ? ` · ${plural(t.clashes, 'same-lines overlap')}` : ''}${t.conflicts ? ` · ${plural(t.conflicts, 'clash')} with main` : ''}${t.landed ? ` · ${t.landed} landed` : ''}` },
        h('span', { class: 'rd-n' }, String(t.agents.size)),
        h('span', { class: 'rd-f mono' }, t.folder),
        h('span', { class: 'rd-w' }, hot ? (t.clashes ? 'same lines' : 'clash') : t.agents.size === 1 ? 'agent' : 'agents'));
    })),
  ];
}

// Failures by cause: the same failing line from many agents is one problem with one fix.
const SIG = (t) => String(t || '').replace(/\/tmp\/[\w.\-/]+/g, '<tmp>').replace(/\b[0-9a-f]{7,40}\b/g, '<sha>').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 140);
const firstBad = (out) => String(out || '').split('\n').find((l) => /\bFAIL|Error\b|error:|AssertionError|expected|not ok|✗|exit [1-9]/i.test(l)) || String(out || '').trim().split('\n').pop() || '';
const KIND = { verified: "The project's tests failed", evidence: 'Proof check failed', accepted: 'Acceptance check failed', claim_check: 'Files check failed' };
/** The engine's own words ("FAIL acceptance check 1: exit 1 (expected 0)") in a form a person reads. */
const plainFail = (line) => String(line || '').trim()
  .replace(/^FAIL\s+/i, '')
  .replace(/(?:acceptance |reported test )?(?:command|check)\s*(\d+)?:?\s*exit (\d+) \(expected 0\)/i, (_, n, code) => `check exited with code ${code}`);

export function causeGroups(state) {
  const groups = new Map();
  const add = (key, label, kind, c, detail) => {
    if (!groups.has(key)) groups.set(key, { key, label, kind, items: [] });
    groups.get(key).items.push({ change: c, detail });
  };
  for (const c of state.changes) {
    if (c.state === 'superseded' || c.state === 'landed') continue;
    if (state.changes.some((x) => x.state === 'landed' && x.task_id === c.task_id && x.agent_id === c.agent_id)) continue; // its task already landed
    if (c.state === 'conflicted') for (const x of (c.conflicts || []).slice(0, 1)) add(`clash:${x.path}`, `clash with main in ${x.path}`, 'clash', c, `lines ${x.base_start}-${x.base_start + x.base_len - 1}`);
    if (c.state !== 'submitted') continue;
    if (c.out_of_scope?.length) add(`scope:${c.out_of_scope[0]}`, `edited files outside its task: ${c.out_of_scope[0]}`, 'scope', c, c.out_of_scope.join(', '));
    for (const k of ['verified', 'evidence', 'accepted', 'claim_check']) {
      const v = c[k];
      if (!v || v.commit !== c.head_commit || v.exit_code === 0) continue;
      const line = firstBad(v.output_tail);
      add(`${k}:${SIG(line)}`, `${KIND[k]}${line.trim() ? `: ${plainFail(line).slice(0, 110)}` : ` (exit ${v.exit_code})`}`, 'check', c, v.output_tail);
    }
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

export function renderCauses(state, ui, toggle, select) {
  const gs = causeGroups(state);
  if (!gs.length) return null;
  return gs.slice(0, 12).map((g) => {
    const open = ui.openCause?.has(g.key);
    const tasks = new Set(g.items.map((i) => i.change.task_id)).size;
    return h('li', { class: `cause${open ? ' open' : ''}` },
      h('button', { type: 'button', class: 'cause-h', onclick: () => toggle(g.key) },
        h('span', { class: `cause-n ${g.kind === 'check' ? 'bad' : 'warn'}` }, String(g.items.length)),
        h('span', { class: 'cause-t' }, g.label),
        h('span', { class: 'dim small' }, `${plural(tasks, 'task')} · ${open ? 'hide' : 'show'}`)),
      open ? h('ol', { class: 'cause-list' }, g.items.map((i) => h('li', { onclick: () => select(i.change.agent_id, i.change.change_id) },
        h('span', { class: 'mono' }, i.change.agent_id),
        h('span', { class: 'ell' }, state.tasks.find((t) => t.task_id === i.change.task_id)?.title || i.change.summary || i.change.change_id),
        g.kind !== 'check' ? h('span', { class: 'dim small' }, i.detail) : null)),
        g.kind === 'check' && g.items[0].detail ? h('pre', { class: 'out' }, String(g.items[0].detail).trim().split('\n').slice(-10).join('\n')) : null) : null);
  });
}

/** "Since you looked": what happened while the board was not watched. */
export function digestSince(state, seen, runs) {
  if (!seen) return null;
  const landed = state.landings.filter((e) => e.seq > seen.seq).length;
  const done = state.tasks.filter((t) => describe(state, t).status === 'Done' && !seen.done?.includes(t.task_id)).length;
  const spent = (runs || []).reduce((s, r) => s + (r.metered === false ? 0 : Number(r.spent) || 0), 0) - (seen.spent || 0);
  if (!landed && !done) return null;
  return { landed, done, spent: Math.max(0, spent), since: seen.at };
}
