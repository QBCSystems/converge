// Hundreds of agents: work seen as workstreams (the planner's grouping), what the rules held back for the owner
// (escalated tasks, paused workstreams) with Resume and Drop, and the codebase as a heat map of who is where.

import { h } from '../dom.js';
import { nowMs, plural } from '../format.js';
import { describe, renderWork } from './work.js';
import { claimsOf, overlaps, folderOf } from './swarm.js';

/** task_id -> workstream, from the runs (the newest run wins). */
export function wsMapOf(runs) {
  const m = new Map();
  for (const r of [...(runs || [])].reverse()) for (const [tid, w] of Object.entries(r.workstreams || {})) m.set(tid, w);
  return m;
}
/** agent -> workstream, through its task (or its change's task). */
export function agentWorkstreams(state, wsMap) {
  const m = new Map();
  if (!wsMap.size) return m;
  for (const t of state.tasks) { const w = wsMap.get(t.task_id); if (w) for (const a of t.agents) m.set(a, w); }
  for (const c of state.changes) { const w = wsMap.get(c.task_id); if (w && !m.has(c.agent_id)) m.set(c.agent_id, w); }
  return m;
}
/** Each task's workstream: the planner's, else the top folder of what it touches. */
function taskGroups(state, wsMap) {
  const claims = claimsOf(state);
  const groups = new Map();
  for (const t of state.tasks) {
    let g = wsMap.get(t.task_id);
    if (!g) {
      const ch = [...state.changes].reverse().find((c) => c.task_id === t.task_id && c.files?.length);
      const cl = claims.find((c) => c.task?.task_id === t.task_id);
      g = ch ? folderOf(ch.files[0]) : cl ? folderOf(cl.path) : 'not started';
    }
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  return groups;
}

export function renderWorkstreams(state, ui, actions, wsMap, runs) {
  const groups = taskGroups(state, wsMap);
  const latest = (runs || [])[0];
  if (ui.ws && groups.has(ui.ws)) {
    const only = new Set(groups.get(ui.ws).map((t) => t.task_id));
    return [
      h('div', { class: 'crumbs' }, h('button', { type: 'button', class: 'link', onclick: () => actions.openWs('') }, wsMap.size ? 'All groups' : 'All folders'), h('span', { class: 'dim' }, ' › '), h('b', null, ui.ws)),
      renderWork(state, ui, actions, null, only),
    ];
  }
  const now = nowMs();
  const cards = [...groups.entries()].map(([name, ts]) => {
    const ds = ts.map((t) => describe(state, t));
    const done = ds.filter((d) => d.status === 'Done').length;
    const ids = new Set(ts.map((t) => t.task_id));
    const agents = new Set(ts.filter((t, i) => ['Working', 'Checking', 'Retrying', 'Stuck'].includes(ds[i].status)).flatMap((t) => t.agents)).size;
    const cs = new Set(state.changes.filter((c) => ids.has(c.task_id)).map((c) => c.change_id));
    const recent = state.recent.filter((e) => (e.at || 0) > now - 15 * 60_000 && cs.has(e.change_id));
    const handed = recent.filter((e) => e.type === 'Submitted').length;
    const back = new Set(recent.filter((e) => (e.type === 'Verified' && e.exit_code !== 0) || e.type === 'Conflicted').map((e) => e.commit || e.change_id)).size;
    const paused = latest?.paused?.[name];
    const escalated = Object.values(latest?.escalated || {}).filter((x) => ids.has(x.task_id)).length;
    const lead = (latest?.leads || []).find((l) => l.workstream === name);
    return { name, ts, done, agents, handed, back, paused, escalated, lead };
  }).sort((a, b) => (a.name === 'not started') - (b.name === 'not started') || Number(Boolean(b.paused)) - Number(Boolean(a.paused)) || b.agents - a.agents);
  return h('div', { class: 'wsgrid' }, cards.map((c) => h('button', { type: 'button', class: `wscard${c.paused ? ' paused' : c.escalated ? ' warn' : ''}`, onclick: () => actions.openWs(c.name) },
    h('span', { class: 'ws-h' }, h('b', null, c.name), c.paused ? h('span', { class: 'badge warn' }, 'paused') : c.done === c.ts.length ? h('span', { class: 'badge good' }, 'done') : null),
    h('span', { class: 'ws-bar' }, h('span', { style: `width:${Math.round((c.done / c.ts.length) * 100)}%` })),
    h('span', { class: 'ws-n' }, `${c.done} of ${plural(c.ts.length, 'task')} landed · ${plural(c.agents, 'agent')} at work`),
    c.handed ? h('span', { class: c.back / c.handed > 0.3 ? 'ws-n warn' : 'ws-n' }, `${Math.round((c.back / c.handed) * 100)}% of the last ${c.handed} sent back`) : null,
    c.paused ? h('span', { class: 'ws-n warn' }, `paused: ${c.paused.why}`) : null,
    c.escalated ? h('span', { class: 'ws-n warn' }, `${plural(c.escalated, 'task')} need you`) : null,
    c.lead ? h('span', { class: 'ws-lead' }, h('b', null, 'Lead: '), c.lead.report ? c.lead.report.split('\n')[0].slice(0, 160) : c.lead.alive ? 'reviewing changes…' : 'finished') : null)));
}

/** What the rules held back: escalated tasks and paused workstreams, with Resume and Drop. */
// The owner's note for the next agent, by "<run id>:<task key>", kept across the board's redraws (which rebuild these
// rows every few seconds) while it is typed.
const notes = new Map();

export function renderHeld(state, runs, control) {
  const rows = [];
  for (const r of (runs || []).filter((x) => x.phase === 'running')) {
    for (const [w, p] of Object.entries(r.paused || {})) {
      rows.push(h('li', { class: 'need held' }, h('span', { class: 'st warn' }, 'Paused'),
        h('span', { class: 'why' }, h('b', null, w), `: ${p.why}. Its agents wait for you.`),
        h('span', { class: 'held-act' }, h('button', { type: 'button', class: 'primary', onclick: () => control(r.id, { resume: [`ws:${w}`] }) }, 'Resume'), h('button', { type: 'button', onclick: () => control(r.id, { drop: [`ws:${w}`] }) }, 'Drop'))));
    }
    for (const [k, e] of Object.entries(r.escalated || {})) {
      const t = state.tasks.find((x) => x.task_id === e.task_id);
      // An earlier task's check this change breaks: which one, and the choice to retire it (the request changed that
      // feature on purpose) or send the task back (it should not have).
      const blockers = Array.isArray(e.blockers) ? e.blockers : [];
      const id = `${r.id}:${k}`;
      const note = () => (notes.get(id) ? { notes: { [k]: notes.get(id) } } : {});
      // Retiring some of the checks: those stop running, and the agent is told to keep the others passing (swarm.mjs
      // retryWhy). Each check is the owner's own call, so each has its own Retire; "<key>#<n>" names check n.
      const retire = (which) => { const sent = control(r.id, { retire: which, ...note() }); notes.delete(id); return sent; };
      rows.push(h('li', { class: 'need held' }, h('span', { class: 'st warn' }, 'Needs you'),
        // Seen as soon as the agent wrote needs-owner.json (local-run.mjs), before the swarm stopped it: it is finishing up.
        h('span', { class: 'why' }, h('b', null, t?.title || k), `: ${e.why}${e.workstream ? ` (${e.workstream})` : ''}. ${e.early ? 'Its agent is finishing up and waits for you.' : 'Its agent is stopped.'}`,
          blockers.length ? h('ul', { class: 'held-checks' }, blockers.map((b, i) => h('li', null,
            blockers.length > 1 ? h('button', { type: 'button', class: 'small', title: 'This request changes what this check tests: stop running it. The agent is told to keep the other checks passing', onclick: () => retire([`${k}#${i}`]) }, 'Retire') : null,
            h('span', null, ` From "${b.task}": `), h('code', null, String(b.check).slice(0, 240)), b.output ? h('div', { class: 'dim' }, String(b.output).split('\n').slice(-2).join(' ').slice(0, 200)) : null))) : null),
        // A word to the next agent (what to do differently), sent with Send it back, Try again or Retire.
        h('input', { type: 'text', class: 'held-note', placeholder: 'Note for the next agent (optional)', value: notes.get(id) || '', oninput: (ev) => notes.set(id, ev.target.value) }),
        h('span', { class: 'held-act' },
          blockers.length ? h('button', { type: 'button', class: 'primary', title: blockers.length === 1 ? 'This request changes what that check tests: stop running it, and land the change' : 'This request changes what all of these checks test: stop running them, and land the change', onclick: () => retire([k]) },
            blockers.length === 1 ? 'Retire that check' : 'Retire all') : null,
          h('button', { type: 'button', class: blockers.length ? '' : 'primary', title: blockers.length ? 'The earlier work must keep working: the agent is told which checks its change breaks and to keep them passing' : '', onclick: () => { const sent = control(r.id, { resume: [k], ...note() }); notes.delete(id); return sent; } }, blockers.length ? 'Send it back' : 'Try again'),
          h('button', { type: 'button', onclick: () => control(r.id, { drop: [k] }) }, 'Drop'))));
    }
  }
  return rows.length ? rows : null;
}

/** The codebase: one tile per file, sized by its size, coloured by who is in it. */
export function renderHeat(files, state, ui, actions, select) {
  if (!files) return h('p', { class: 'dim none' }, 'Loading files…');
  if (!files.length) return h('p', { class: 'dim none' }, 'No files on main yet.');
  const claims = claimsOf(state);
  const ov = overlaps(claims);
  const live = state.changes.filter((c) => c.state !== 'superseded' && c.state !== 'landed');
  const heat = (p) => {
    if (live.some((c) => c.state === 'conflicted' && (c.conflicts || []).some((x) => x.path === p)) || ov.some((o) => o.path === p && o.hard)) return 'hot';
    if (ov.some((o) => o.path === p)) return 'warm';
    if (claims.some((c) => c.path === p) || live.some((c) => (c.files || []).includes(p))) return 'busy';
    return 'calm';
  };
  // Files being made right now (claimed or in a change, not on main yet) are where the activity is: they count too.
  const known = new Set(files.map((f) => f.path));
  const extra = [...new Set([...claims.map((c) => c.path), ...live.flatMap((c) => c.files || [])])].filter((p) => !known.has(p)).map((p) => ({ path: p, size: 1200, fresh: true }));
  files = [...files, ...extra];
  const byFolder = new Map();
  for (const f of files) { const g = folderOf(f.path); if (!byFolder.has(g)) byFolder.set(g, []); byFolder.get(g).push(f); }
  const order = { hot: 0, warm: 1, busy: 2, calm: 3 };
  const picked = ui.heatFile;
  const detail = picked ? (() => {
    const cs = claims.filter((c) => c.path === picked);
    const chs = live.filter((c) => (c.files || []).includes(picked));
    return h('div', { class: 'heat-detail' }, h('b', { class: 'mono' }, picked),
      cs.length ? h('span', null, 'reserved by ', cs.map((c) => h('button', { type: 'button', class: 'claim', onclick: () => select(c.agent) }, h('span', { class: 'mono' }, c.agent), c.to === Infinity ? '' : ` ${c.from}-${c.to}`))) : h('span', { class: 'dim' }, 'not reserved'),
      chs.length ? h('span', null, 'changed by ', chs.map((c) => h('button', { type: 'button', class: 'claim', onclick: () => select(c.agent_id, c.change_id) }, h('span', { class: 'mono' }, c.agent_id), ` ${c.state}`))) : null,
      h('button', { type: 'button', class: 'link', onclick: () => actions.pickHeat('') }, 'close'));
  })() : null;
  return [
    h('div', { class: 'heat-legend' }, h('span', { class: 'hl hot' }, 'clash or overlap'), h('span', { class: 'hl warm' }, 'agents close'), h('span', { class: 'hl busy' }, 'being worked on'), h('span', { class: 'hl calm' }, 'quiet')),
    detail,
    h('div', { class: 'heat' }, [...byFolder.entries()].sort((a, b) => Math.min(...a[1].map((f) => order[heat(f.path)])) - Math.min(...b[1].map((f) => order[heat(f.path)])) || b[1].length - a[1].length).map(([g, fs]) => {
      const tiles = fs.map((f) => ({ f, s: heat(f.path) })).sort((a, b) => order[a.s] - order[b.s] || b.f.size - a.f.size);
      const shown = tiles.slice(0, 80);
      return h('div', { class: 'heat-g' }, h('span', { class: 'heat-gl mono' }, g, h('i', null, ` ${fs.length}`)),
        h('div', { class: 'heat-tiles' }, shown.map(({ f, s }) => h('button', { type: 'button', class: `tile ${s}${picked === f.path ? ' picked' : ''}`, title: f.fresh ? `${f.path} · new, not on main yet` : `${f.path} · ${Math.round(f.size / 1024 * 10) / 10} KB`,
          style: `flex-grow:${Math.max(1, Math.round(Math.sqrt(f.size) / 8))};min-width:${Math.min(90, 14 + Math.round(Math.sqrt(f.size) / 3))}px`, onclick: () => actions.pickHeat(f.path) }, f.path.split('/').pop())),
        tiles.length > 80 ? h('span', { class: 'dim small' }, `+${tiles.length - 80} quiet files`) : null));
    })),
  ];
}
