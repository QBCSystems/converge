// The agents at work right now, as cards: on what, what it is doing in plain words, how it stands. The squares show
// every agent (thousands); these show the few that are active, the most urgent first, the rest behind "+N more".

import { h } from '../dom.js';
import { nowMs, timeAgo, formatStepTarget } from '../format.js';
import { kindLabel } from './board.js';

const ORDER = { bad: 0, warn: 1, work: 2, wait: 3, ok: 4, idle: 5, stop: 6 };   // needing you first, then at work, then the rest
const TONE = { bad: 'bad', warn: 'warn', work: 'violet', wait: 'info', ok: 'good', idle: 'dim', stop: 'dim' };
const DECK_MAX = 12;
const deckMax = () => (typeof window !== 'undefined' && window.innerWidth < 640 ? 4 : DECK_MAX); // a phone shows the worst few

const file = (t) => String(t || '').split(/[,\s]/)[0].split(':')[0].split('/').pop();

/** An aios step in plain words: "thinking", "editing roman.js", "running the tests", "handing in". */
export function plainStep(action, target) {
  const t = formatStepTarget(action, target) || String(target || '');
  switch (action) {
    case 'note': case '(none)': case '__invalid': case '': case undefined: return 'thinking';
    case 'check': case 'test': return 'checking its work';
    case 'run': return /\btest\b|--test|vitest|jest|pytest|npm (run )?test/.test(t) ? 'running the tests' : 'trying its code';
    case 'read': case 'outline': return t ? `reading ${file(t)}` : 'reading the code';
    case 'list': case 'search': return 'looking around the code';
    case 'write': return t ? `writing ${file(t)}` : 'writing code';
    case 'edit': return t ? `editing ${file(t)}` : 'editing code';
    case 'commit': return 'saving its work';
    case 'done': return 'finished';
    case 'converge': {
      const w = String(target || '').trim().split(/\s+/)[0];
      return w === 'submit' ? 'submitting' : w === 'claim' ? 'reserving its files' : w === 'status' || w === 'peers' ? 'checking in' : 'talking to converge';
    }
    default: return String(action).replace(/_/g, ' ');
  }
}

export function deckItems(all, state, ui, select) {
  const now = nowMs();
  const active = all.filter((x) => x.s in ORDER).sort((p, q) => ORDER[p.s] - ORDER[q.s] || (q.a.last_seen || 0) - (p.a.last_seen || 0));
  const max = deckMax();
  return {
    more: Math.max(0, active.length - max),
    total: active.length,
    items: active.slice(0, max).map((x) => {
      const acts = state.acts?.[x.a.agent_id] || [];
      const last = acts[acts.length - 1];
      const fresh = x.s === 'work' && last && now - (last.at || 0) < 20_000;
      const refused = x.a.aios?.refused || 0;
      const picked = ui.agent === x.a.agent_id;
      // One line of what it is doing: its step while it works, else where it stands ("ready to land", "checks running").
      const doing = x.s === 'work' && last ? plainStep(last.action, last.target) : x.why;
      const seen = x.a.last_seen ? timeAgo(x.a.last_seen, now) : '';
      return {
        key: x.a.agent_id,
        sig: `${x.s}|${doing}|${fresh}|${refused}|${picked}|${x.task?.title || ''}|${seen}`,
        make: () => h('button', { type: 'button', class: `acard ${TONE[x.s]}${picked ? ' picked' : ''}`, onclick: () => select(x.a.agent_id), title: `${x.a.agent_id} · ${x.why}` },
          h('span', { class: 'ac-task' }, x.task?.title || (x.a.role === 'reviewer' ? 'Reviewing' : 'No task yet')),
          h('span', { class: 'ac-step' }, fresh ? h('span', { class: 'spin' }) : null, h('span', { class: 'ell' }, doing)),
          h('span', { class: 'ac-id' }, h('span', { class: `st ${TONE[x.s]}` }, kindLabel(x.s)), h('span', { class: 'mono' }, x.a.agent_id),
            refused ? h('span', { class: 'shield bad', title: `${refused} actions blocked` }, `⛨ ${refused} blocked`) : null,
            seen ? h('span', null, seen) : null)),
      };
    }),
  };
}
