// The live pane: one stream of what every worker is doing, newest at the bottom, each line stamped with its time and
// labelled with the worker and its task. Fed by each agent's own log (main.js polls GET .../agents/:id/log).
import { h } from '../dom.js';
import { AG_ICON, callLine } from './work.js';

const hue = (s) => { let n = 0; for (const c of String(s)) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n % 360; };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const stamp = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** One log entry as { kind, icon, text, bad } for the stream, or null when it carries nothing worth a line. */
export function liveLine(e) {
  if (e.kind === 'call') return { kind: 'call', icon: AG_ICON[e.tool] || '•', text: clip(callLine(e.tool, e.text).replace(/\s+/g, ' ').trim(), 220) };
  const first = String(e.text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!first || /^\{"t":"end"/.test(first)) return null;
  const bad = e.kind === 'result' && /^(EXIT [1-9]|error|ERROR|fatal|FAIL)/.test(first);
  return { kind: e.kind, icon: e.kind === 'result' ? '↳' : '·', text: clip(first, 220), bad };
}

/**
 * rows:    [{ at, agent, entry }] oldest first
 * workers: [{ id, label, title, active, error, missing }]
 * pick:    the worker id the stream is narrowed to, or ''
 */
export function renderLive({ rows, workers, pick, onPick, onClose }) {
  const chip = (w) => h('button', { type: 'button', class: `lv-chip${pick === w.id ? ' on' : ''}${w.active ? '' : ' off'}`, style: `--c:${hue(w.id)}`, title: `${w.title || w.id}${w.active ? '' : ' (finished)'}`, 'aria-pressed': String(pick === w.id), onclick: () => onPick(pick === w.id ? '' : w.id) },
    h('span', { class: 'lv-dot' }), w.label);
  const by = new Map(workers.map((w) => [w.id, w]));
  const shown = rows.filter((r) => !pick || r.agent === pick);
  const items = [];
  for (const r of shown) {
    const l = liveLine(r.entry);
    if (!l) continue;
    const w = by.get(r.agent) || { label: r.agent.slice(2, 6), title: '' };
    items.push(h('li', { class: `lv-row ${l.kind}${l.bad ? ' bad' : ''}`, style: `--c:${hue(r.agent)}` },
      h('time', { class: 'lv-t mono', datetime: r.at, title: r.at }, stamp(r.at)),
      h('span', { class: 'lv-w mono', title: w.title || r.agent }, w.label),
      h('span', { class: 'lv-i' }, l.icon),
      h('span', { class: 'lv-x mono' }, l.text)));
  }
  const errs = workers.filter((w) => w.error);
  return h('div', { class: 'lv-top-in' },
    h('div', { class: 'fly-h' },
      h('div', { class: 'fly-title' }, h('h2', null, 'Live'), h('span', { class: 'dim small' }, `${workers.filter((w) => w.active).length} working · ${workers.length} agents`)),
      h('button', { type: 'button', class: 'link fly-x', 'aria-label': 'Close', onclick: onClose }, '✕')),
    h('div', { class: 'lv-chips' }, workers.map(chip)),
    errs.length ? h('p', { class: 'bad small lv-err' }, errs.map((w) => `${w.label}: ${w.error}`).join(' · ')) : null,
    h('ol', { class: 'lv-stream' }, items.length ? items : h('li', { class: 'dim small lv-none' }, workers.length ? 'Waiting for the first step…' : 'No agents yet.')));
}
