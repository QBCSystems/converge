// The dashboard: counts, one square per agent, what needs attention, and the picked agent's detail.
// State comes from the project's event stream (connection.js -> store.js); receipts are verified here.
//
// A timeline slider lets you scrub the whole board back through the project's events: moving it
// fetches the folded snapshot at that sequence (GET /api/projects/:p/state?at=<seq>) and renders
// counts, squares, needs attention and detail from it, while live events keep folding into the
// live state underneath. Landed entries also carry a "rewind main to here" button that asks the
// platform to move main back to that commit (POST /api/projects/:p/rewind with the admin key).

import { $, $$, h, icon, mount, mountStable } from './dom.js';
import { loadSettings, saveSettings, PROJECT_RE, local as prefs } from './config.js';
import { Store, EVENT_GAP, planNoteOf } from './store.js';
import { planningView } from './planning.js';
import { Connection } from './connection.js';
import { mcpCall } from './mcp.js';
import { restartRequest } from './restart.js';
import { shortSha, timeAgo, clock, safeUrl } from './format.js';
import { verifyReceipts } from './receipts.js';
import { assess, kindLabel, renderFleet, renderSummary, renderDots, renderIssues, changeItems, QUIET_KINDS, checksOf } from './views/board.js';
import { renderWork, renderNeeds, renderPulse, renderThread, renderRun, renderFlyout, renderRunFlyout, describe, diffBlock, clockText } from './views/work.js';
import { feedRows, feedItems, CHANNELS } from './views/feed.js';
import { renderTerritories, contentionRows, renderTrain, renderGoal, renderFlow, groupDots, renderCauses, causeGroups, overlaps, claimsOf, digestSince, renderRadar, territories } from './views/swarm.js';
import { deckItems } from './views/deck.js';
import { wsMapOf, agentWorkstreams, renderWorkstreams, renderHeld, renderHeat } from './views/scale.js';
import { reconcile, placeholder } from './keyed.js';
import { renderLive } from './views/live.js';
import { rememberAgents, recallAgents } from './prefs.js';
import { engineStatusView } from './engine-status.js';
import { screenFor, setupBody } from './setup.js';

const settings = loadSettings();
// A project on the deployed Worker: its requests (and its live socket, connection.js) go through this platform's
// /cloud/ relay, which puts the Worker's admin key in for this platform's admin.
const rawFetch = window.fetch.bind(window);
window.fetch = (u, init) => rawFetch(typeof u === 'string' && settings.base && /^\/(api\/projects\/|mcp\/)/.test(u) ? settings.base + u : u, init);
const store = new Store();
// ?present=1 (remembered for this tab; ?present=0 ends it): recording or presenting, so no composer and no admin controls.
const present = (() => {
  const q = new URLSearchParams(location.search);
  try {
    if (q.has('present')) sessionStorage.setItem('converge.present', q.get('present') === '0' ? '' : '1');
    return sessionStorage.getItem('converge.present') === '1';
  } catch { return q.get('present') === '1'; }
})();
document.body.classList.toggle('present', present);
const ui = { picking: false, fly: false, agent: '', task: '', run: '', openCause: new Set(), showTrain: false, ws: '', heatFile: '', tview: 'stage', folder: '', channel: prefs.get('converge.channel') || 'milestones', feedAllFor: '', openClusters: new Set(), threadOpen: false, feedSeen: '', pop: '', kind: 'all', filter: '', reviewerKey: settings.reviewerKey, adminKey: settings.adminKey, allRuns: prefs.get('converge.allRuns') === '1', diff: { changeId: '', text: '' }, cycle: { agent: '', n: 0 }, status: { mode: 'connecting', text: 'connecting' },
  timeline: { seq: 0, snapshot: null, loading: false, error: '', forSeq: 0, drag: null } };
const liveLogs = new Map(); // agent -> { last, entries, seen, error, missing }: what the Live pane has read of each worker's log

function toast(message, tone = 'info') {
  const el = h('div', { class: 'toast', 'data-tone': tone }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), tone === 'error' ? 7000 : 3500);
}

// Theme toggle: Dark / Light with custom SVGs
const themeBtn = $('#btn-theme');
const SVG_MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SVG_SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

function getEffectiveTheme() {
  const saved = prefs.get('converge.theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(target) {
  document.documentElement.dataset.theme = target;
  if (themeBtn) {
    if (target === 'light') {
      themeBtn.innerHTML = SVG_MOON;
      themeBtn.title = 'Switch to dark mode';
      themeBtn.setAttribute('aria-label', 'Switch to dark mode');
    } else {
      themeBtn.innerHTML = SVG_SUN;
      themeBtn.title = 'Switch to light mode';
      themeBtn.setAttribute('aria-label', 'Switch to light mode');
    }
  }
}

applyTheme(getEffectiveTheme());

if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    prefs.set('converge.theme', next);
    applyTheme(next);
  });
}

// ---- talking to the platform: one way to sign a request, and one way to read its answer ----
/** ui.adminKey when the admin rights come from a signed-in ASQL session rather than a key (the server decides; this only shows the controls). */
const SESSION_ADMIN = 'session';
const sessionHeader = () => (settings.sessionToken ? { Authorization: `Bearer ${settings.sessionToken}` } : {});
/** The key or session token that opens the board. */
const authHeaders = () => {
  const h = {};
  if (settings.sessionToken) h['Authorization'] = `Bearer ${settings.sessionToken}`;
  if (settings.viewKey) h['X-View-Key'] = settings.viewKey;
  if (settings.adminKey) h['X-Admin-Key'] = settings.adminKey;
  return h;
};
/** A JSON route's body, or an Error with the server's own reason (and its .status). `raw` skips the /cloud relay. */
async function api(path, { raw = false, auth = authHeaders(), ...init } = {}) {
  const r = await (raw ? rawFetch : fetch)(path, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
}
/** The same with the admin key, for what changes things (and the local platform's settings routes). */
const adminApi = (path, init = {}) => api(path, { ...init, auth: { 'Content-Type': 'application/json', ...sessionHeader(), ...(ui.adminKey && ui.adminKey !== SESSION_ADMIN ? { 'X-Admin-Key': ui.adminKey } : {}) } });
const P = () => `/api/projects/${encodeURIComponent(settings.project)}`;
/** A change's diff: '' when it changed nothing; throws when it could not be read (never passed off as empty). */
async function fetchDiff(changeId) {
  const j = await api(`${P()}/changes/${encodeURIComponent(changeId)}/diff`);
  if (typeof j.diff !== 'string') throw new Error('the server sent no diff');
  return j.diff;
}
const diffText = (d) => d || '(no changes)';

const connection = new Connection({
  getConfig: () => ({ ...settings, viewKey: settings.viewKey || settings.sessionToken, keyInUrl: Boolean(ui.platformLocal) }), // the local dev server reads the socket's key from ?key=
  onSnapshot: (snap) => store.applySnapshot(snap),
  onEvent: (ev) => {
    if (ev?.type === 'Landed' && folderInfo) setTimeout(loadFolder, 5000); // the folder sync follows a landing
    if (ev?.type === 'Landed' && gitLinked) setTimeout(updateGitButton, 6000); // and so does a push to the linked repository
    if (store.applyEvent(ev) === EVENT_GAP) connection.fetchNow();
    if (ev.type === 'Submitted') setTimeout(() => connection.fetchNow(), 300); // engine-derived fields
  },
  // The open project was deleted: say so, and back to the projects list, with no way back to it left behind (the
  // "Back to <project>" link and ?project= in the address both still pointed at it).
  onGone: (message) => {
    allProjects = allProjects.filter((n) => n !== settings.project);
    settings.project = '';
    saveSettings(settings);
    const u = new URL(location.href); u.searchParams.delete('project');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
    ui.picking = true;
    toast(message, 'error');
    schedule();
  },
  onStatus: (s) => {
    ui.status = s;
    // No such project (404): the admin key gets the projects page; any other key the sign-in card, saying so.
    if (s.mode === 'offline' && /\b404\b/.test(s.text)) {
      if (ui.adminKey) ui.picking = true;
      else { connection.stop(); ui.missing = settings.project; }
    }
    schedule();
  },
});

let raf = 0;
function schedule() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
}
store.subscribe(schedule);
store.subscribe((state) => verifyReceipts(state, schedule).catch(() => {}));

/** The state to paint: the folded snapshot while the timeline is scrubbed, else the live state. */
/**
 * The board shows the newest run's work, not every run's piled up. An earlier run's tasks, agents and changes are
 * history: what landed is on main (and in the folder), the runs themselves are under History. Only work no run made
 * (a task made by hand, an agent that joined from the CLI) is always shown. `ui.allRuns` shows everything again, and
 * the notice (renderScopeNote) says what is hidden. Not applied while looking back through the timeline.
 */
function scopeToLatestRun(s, mine) {
  // A run that never got as far as tasks (planning failed, it was refused at the start) has no work of its own to show
  // and must not push an earlier run's off the board: the latest run is the newest one that made tasks.
  const started = mine.filter((r) => Object.keys(r.keys || {}).length);
  if (!s || ui.allRuns || ui.timeline.snapshot || started.length < 2) return s;
  const latest = new Set(Object.keys(started[0].keys));
  const older = new Set(started.slice(1).flatMap((r) => Object.keys(r.keys)).filter((t) => !latest.has(t)));
  if (!older.size) return s;
  const hiddenTasks = s.tasks.filter((t) => older.has(t.task_id));
  if (!hiddenTasks.length) return s;
  const visibleAgents = new Set(s.tasks.filter((t) => !older.has(t.task_id)).flatMap((t) => t.agents));
  const hiddenAgents = new Set(hiddenTasks.flatMap((t) => t.agents).filter((id) => !visibleAgents.has(id)));
  const landed = new Set(s.changes.filter((c) => c.state === 'landed').map((c) => c.task_id));
  return { ...s,
    tasks: s.tasks.filter((t) => !older.has(t.task_id)),
    agents: s.agents.filter((a) => !hiddenAgents.has(a.agent_id)),
    changes: s.changes.filter((c) => !older.has(c.task_id)),
    acts: Object.fromEntries(Object.entries(s.acts || {}).filter(([id]) => !hiddenAgents.has(id))),
    scope: { runs: started.length - 1, tasks: hiddenTasks.length, unlanded: hiddenTasks.filter((t) => !landed.has(t.task_id)).length } };
}

function viewState() {
  const mine = runs.project === settings.project ? runs.list : [];
  const s = scopeToLatestRun(ui.timeline.snapshot || store.state, mine);
  // A run that has ended leaves its agents' last claims behind: its unlanded tasks and their agents are "stopped",
  // not working (a later run that continues them takes over with new agents).
  if (!s || !mine.length) return s;
  const ended = mine.filter((r) => ['stopped', 'done', 'failed'].includes(r.phase));
  const going = mine.filter((r) => !ended.includes(r));
  // A run still going stops some of its tasks itself: a paused workstream, an escalated (or halted) task, a dropped one.
  // Their agents were killed (work saved) and wait for you, so they are stopped, not working.
  const held = new Map(); // task_id -> why
  for (const r of going) {
    const tidOf = new Map(Object.entries(r.keys || {}).map(([tid, k]) => [k, tid]));
    for (const [w, p] of Object.entries(r.paused || {})) for (const k of p.tasks || []) if (tidOf.has(k)) held.set(tidOf.get(k), `workstream ${w} paused: ${p.why}`);
    for (const [k, e] of Object.entries(r.escalated || {})) if (tidOf.has(k)) held.set(tidOf.get(k), e.why === 'halted by you' ? 'halted by you' : `waiting for you: ${e.why}`);
    for (const k of r.dropped || []) if (tidOf.has(k)) held.set(tidOf.get(k), 'dropped');
  }
  const live = new Set(going.flatMap((r) => Object.keys(r.keys || {})));
  const tids = new Set([...ended.flatMap((r) => Object.keys(r.keys || {})).filter((t) => !live.has(t)), ...held.keys()]);
  if (!tids.size) return s;
  const landed = new Set(s.changes.filter((c) => c.state === 'landed').map((c) => c.task_id));
  for (const t of [...tids]) if (landed.has(t)) tids.delete(t);
  const agents = new Set(s.tasks.filter((t) => tids.has(t.task_id)).flatMap((t) => t.agents));
  const endWhy = !ended.length ? '' : ended[0].stopped === 'by you' ? 'by you' : ended[0].stopped ? String(ended[0].stopped).replace(/^spent .*budget.*$/, 'out of budget') : '';
  const why = held.size ? [...new Set(held.values())][0] : endWhy;
  const whyByTask = new Map(mine.flatMap((r) => Object.entries(r.why || {})));
  return { ...s, stoppedTasks: tids, stoppedAgents: agents, stoppedWhy: why, stoppedWhyByTask: whyByTask, heldWhy: held };
}

// What happened at an event number, in words, for the timeline's label and marks.
function momentAt(live, seq) {
  const titleOf = (changeId) => { const c = live.changes.find((x) => x.change_id === changeId); return live.tasks.find((t) => t.task_id === c?.task_id)?.title || c?.summary || changeId; };
  const events = [...live.landings, ...live.recent].filter((e) => typeof e.seq === 'number' && e.seq <= seq).sort((x, y) => y.seq - x.seq);
  const ev = events[0];
  const landed = live.landings.filter((e) => e.seq <= seq).at(-1);
  const time = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
  const what = !ev ? 'the start' : ev.type === 'Landed' ? `landed: ${titleOf(ev.change_id)}` : ev.type === 'TaskCreated' ? `new task: ${ev.title}` : ev.type === 'MainRewound' ? 'main rewound' : ev.type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return { time: time(ev?.at), what, landed: landed ? titleOf(landed.change_id) : '', landedCount: live.landings.filter((e) => e.seq <= seq).length };
}

function renderTimeline(live) {
  const range = $('#timeline-range');
  if (!range) return;
  const version = live.version || 0;
  const t = ui.timeline;
  range.max = String(version);
  const dragging = t.drag !== null && t.drag !== undefined;
  const targetVal = dragging ? t.drag : (t.snapshot || t.loading) ? t.seq : version;
  if (document.activeElement !== range || !dragging) range.value = String(targetVal);
  range.disabled = !store.hasSnapshot || version < 1;
  // Pins on the track: a landing (green), a rewind of main (amber), an action aios refused (red).
  const refusals = Object.values(live.acts || {}).flat().filter((e) => e.verdict === 'refused' && typeof e.seq === 'number');
  const marks = live.landings.concat(live.recent.filter((e) => e.type === 'MainRewound'), refusals);
  const key = `${version}:${marks.length}`;
  if ($('#tl-marks').dataset.key !== key) {
    $('#tl-marks').dataset.key = key;
    mount($('#tl-marks'), version < 1 ? null : marks.map((e) => {
      const m = momentAt(live, e.seq);
      return h('button', { type: 'button', class: `tl-mark${e.type === 'MainRewound' ? ' rw' : e.type === 'Acted' ? ' rf' : ''}`, style: `left: ${(e.seq / version) * 100}%`,
        title: e.type === 'Acted' ? `Blocked ${e.agent_id}: ${e.action} ${e.target || ''}` : `${m.time} · ${m.what}`, onclick: () => goTo(e.seq) });
    }));
  }
  const seq = Number(targetVal);
  const viewing = !!t.snapshot || dragging || t.loading;
  const atLive = !viewing || seq >= version;
  $('#tl-live').className = atLive ? 'live-badge on' : 'live-badge';
  $('#tl-live').textContent = atLive ? 'LIVE' : 'Back to live';
  $('#tl-play').textContent = tape.playing ? '⏸' : '▶';
  if (!viewing || seq >= version) {
    // Live: the row says LIVE; words only for an error.
    $('#timeline-banner').hidden = !t.error;
    mount($('#timeline-banner'), t.error ? h('span', { class: 'bad' }, t.error) : null);
    return;
  }
  $('#timeline-banner').hidden = false;
  const m = momentAt(live, seq);
  const then = t.snapshot ? t.snapshot.project.main_head : '';
  mount($('#timeline-banner'), h('span', { class: 'tl-at' },
    h('b', null, m.time || `event ${seq}`), ` · ${m.what} · `,
    h('span', { class: 'dim' }, m.landedCount ? `main had ${m.landedCount} of ${live.landings.length} landings` : 'before anything landed'),
    dragging ? h('span', { class: 'dim' }, ' · release to load') : t.loading ? h('span', { class: 'dim' }, ' · loading…') : null,
    ' · ', h('button', { type: 'button', class: 'link', onclick: () => timelineLive() }, 'back to live'),
    then && then !== live.project.main_head && ui.adminKey && !present && !dragging ? [' · ', h('button', { type: 'button', class: 'link', onclick: () => actions.rewindMain(then) }, `rewind main to here (${shortSha(then, 7)})`)] : null,
    t.error ? h('span', { class: 'bad' }, ` ${t.error}`) : null));
}

let pjAsked = false; // the projects page asked the platform for the list
let needsSetup = false; // set from GET /api/setup: no account exists yet
const signedIn = () => Boolean(settings.sessionToken || settings.viewKey || settings.adminKey || settings.watch);

// The changes stream: each change's diff, fetched again whenever its head moves (a push).
const diffs = new Map(); // change_id -> { head, text, at }
let diffsBusy = 0;
function loadDiffs(state) {
  for (const c of state.changes) {
    if (!c.head_commit || diffsBusy >= 3) continue;
    const d = diffs.get(c.change_id);
    if (d && (d.head === c.head_commit || d.loading)) continue;
    const entry = { head: c.head_commit, text: d?.text || '', at: Date.now(), loading: true };
    diffs.set(c.change_id, entry);
    diffsBusy++;
    fetchDiff(c.change_id).then((d) => { entry.text = d; entry.failed = false; }, () => { entry.failed = true; })
      .finally(() => { entry.loading = false; diffsBusy--; schedule(); });
  }
}

// Needs you: the tab title shows the count, and a notification fires when it rises while the tab is hidden.
let lastNeed = 0;
function setAlert(n) {
  document.title = n ? `(${n}) Converge` : 'Converge';
  if (n > lastNeed && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(`${n} ${n === 1 ? 'thing needs' : 'things need'} you`, { body: settings.project, tag: 'converge-need' }); } catch { /* no notifications here */ }
  }
  lastNeed = n;
  $('#fleet-alert').hidden = typeof Notification === 'undefined' || Notification.permission !== 'default';
}
$('#fleet-alert').addEventListener('click', () => { Notification.requestPermission().then(() => schedule()); });

function renderBoard() {
  const showSignin = !signedIn() || !settings.project || Boolean(ui.missing) || ui.status.mode === 'unauthorized' || ui.picking;
  $('#signin').hidden = !showSignin;
  $('#board').hidden = showSignin;
  $('#btn-project').hidden = showSignin;
  $('#btn-keys').hidden = showSignin;
  $('#btn-signout').hidden = !signedIn();
  $('#dock').hidden = showSignin;
  // Signed in (the admin key, or an account) and choosing: the projects page. Otherwise the plain sign-in card.
  const choosing = showSignin && (ui.adminKey || settings.sessionToken) && ui.picking;
  const setupScreen = !choosing && screenFor({ needsSetup, user: settings.user }) === 'setup';
  $('#signin-form').hidden = choosing || setupScreen;
  $('#setup-form').hidden = !setupScreen;
  $('#projects').hidden = !choosing;
  if (choosing) { if (!pjAsked) { pjAsked = true; refreshProjects(); } showPicker(); } else pjAsked = false;
  const stillThere = settings.base ? (cloudProjects?.names || [settings.project]).includes(settings.project) : !allProjects.length || allProjects.includes(settings.project);
  $('#back-board').hidden = !(ui.picking && signedIn() && store.hasSnapshot && stillThere);
  $('#back-board').textContent = `← Back to ${settings.project}`;
  $('#btn-github').hidden = showSignin || !ui.adminKey || present || (ui.local && !gitLinked);
  if (!showSignin) loadProjectLink(); else { $('#btn-pr').hidden = true; ghLinkFor = ''; }
  if (showSignin) {
    closePop();
    Object.assign(ui, { fly: false, task: '', agent: '' });
    $('#flyout').hidden = true;
    document.body.classList.remove('fly-open');
    mount($('#summary'), null);
    mount($('#conn'), null);
    if (ui.missing && !ui.picking) $('#si-error').textContent = `No project named "${ui.missing}"`;
    else if (ui.status.mode === 'unauthorized' && !ui.picking && !$('#si-error').textContent)
      $('#si-error').textContent = `That key doesn't open "${settings.project}"`;
    return;
  }
  $('#btn-project').textContent = `${settings.project} \u25BE`;
  const live = store.state;
  const state = viewState();
  if (ui.agent && !ui.timeline.snapshot && !state.agents.some((a) => a.agent_id === ui.agent)) ui.agent = ''; // scrubbed back, it may not exist yet
  mount($('#summary'), renderSummary(state));
  mount($('#conn'), h('button', { type: 'button', class: `conn-btn${ui.live ? ' on' : ''}`, title: 'Live activity', 'aria-expanded': String(Boolean(ui.live)), onclick: toggleLive },
    h('span', { class: ui.status.mode === 'live' ? 'good' : 'dim' }, ui.status.text)));
  renderTimeline(live);
  if (!store.hasSnapshot) {
    const engine = engineStatusView({ error: ui.status.mode === 'offline' ? `${ui.status.text}: retrying` : '' });
    mountStable($('#work'), h('p', { class: engine.kind === 'error' ? 'bad none' : 'dim none' }, engine.kind === 'error' ? engine.text : 'Loading\u2026'));
    $('#attention').hidden = false;
    $('#dots').hidden = false;
    mountStable($('#dots'), h('span', { class: engine.kind === 'error' ? 'bad' : 'dim' }, engine.kind === 'error' ? engine.text : 'loading\u2026'));
    return;
  }
  // A project with no agents yet: say so, and how to start one, instead of an empty board.
  // When scrubbed back on the timeline, keep the board and timeline controls visible even if no agents existed then.
  const viewing = Boolean(ui.timeline.snapshot || (ui.timeline.loading && ui.timeline.seq < live.version));
  const running = runs.project === settings.project && runs.list[0] && !['failed', 'stopped'].includes(runs.list[0].phase);
  const top = runs.project === settings.project ? runs.list[0] : null;
  ui.planning = top ? planningView({ ...top, status: top.phase, planNote: ui.runPlan?.id === top.id ? planNoteOf(ui.runPlan.entries) : '' }) : null;
  const empty = !viewing && live.agents.length === 0 && !running;
  $('#empty').hidden = !empty;
  $('#dots').hidden = empty;
  $('#attention').hidden = empty;
  $('.bar').hidden = empty;
  $('.tape').hidden = empty;
  if (empty) $('#timeline-banner').hidden = true;
  $('#changes-box').hidden = empty;
  $('#tasks-box').hidden = empty;
  $('#run').hidden = !ui.adminKey || present || Boolean(ui.timeline.snapshot);
  if (empty) mount($('#empty'), renderEmpty(state));
  const all = assess(state);
  const q = ui.filter.toLowerCase();
  const shown = all.filter((x) => (ui.kind === 'all' ? !QUIET_KINDS.has(x.s) : x.s === ui.kind) &&
    (!q || `${x.a.agent_id} ${x.task?.title || ''} ${x.why}`.toLowerCase().includes(q)));
  // The agents at work now, as cards; the squares only when there are more agents than cards.
  // The squares are the whole fleet, quiet ones too (grey: replaced, stopped, not started): with no status picked,
  // every agent; with one, or a search, the agents that match.
  const fleetShown = ui.kind === 'all' ? all.filter((x) => !q || `${x.a.agent_id} ${x.task?.title || ''} ${x.why}`.toLowerCase().includes(q)) : shown;
  // Cards: every agent but those a newer agent replaced (a run with nothing at work still shows its agents).
  const deck = deckItems(fleetShown.filter((x) => x.s !== 'gone'), state, ui, select);
  // The squares, in one labelled row per workstream (a top folder until the planner names them), busiest first.
  // Workstreams: the planner's names for each task (from the runs), else top folders.
  const runsMine = runs.project === settings.project ? runs.list : [];
  const wsMap = wsMapOf(runsMine);
  const dotGroups = groupDots(fleetShown, agentWorkstreams(state, wsMap))(state);
  const byFolder = dotGroups.length > 1 && all.length > 40; // folder rows only when there are enough agents to need them
  mountStable($('#dots'), viewing && !state.agents.length ? h('span', { class: 'dim' }, 'no agents at this event')
    : byFolder ? dotGroups.map(([g, list]) => h('div', { class: 'dot-row' }, h('span', { class: 'dot-g', title: `${list.length} agents` }, h('span', { class: 'mono' }, g), h('i', null, String(list.length))), h('div', { class: 'dot-set' }, renderDots(list, ui, select))))
    : renderDots(fleetShown, ui, select));
  $('#dots').classList.toggle('grouped', byFolder);
  // A few dozen agents read better as bigger squares; thousands need the small ones.
  $('#dots').classList.toggle('few', all.length <= 80);
  $('#dots').classList.toggle('many', all.length > 400);
  // Squares (one per agent, coloured by standing: a fleet of hundreds at a glance) or cards (a few agents, in detail):
  // squares unless the owner flipped to cards (remembered on this browser).
  const squares = ui.agentView !== 'cards';
  $('#agent-view').hidden = empty;
  for (const b of $$('#agent-view [data-v]')) b.setAttribute('aria-pressed', String((b.dataset.v === 'cards') !== squares));
  $('#dots').hidden = empty || (!squares && !(viewing && !state.agents.length));
  // A status or a filter narrows everything below to those agents: the list, the activity and the changes.
  const filtering = ui.kind !== 'all' || Boolean(q);
  const keep = filtering ? new Set(shown.map((x) => x.a.agent_id)) : null;
  const label = kindLabel(ui.kind);
  $('#list-title').textContent = filtering ? (ui.kind === 'all' ? 'Matching agents' : label[0].toUpperCase() + label.slice(1)) : 'Needs attention';
  const attention = all.filter((x) => x.s === 'bad' || x.s === 'warn').length;
  $('#list-n').textContent = filtering ? String(shown.length) : '';
  $('#btn-clear').hidden = !filtering;
  // Needs you: failures grouped by cause (one fix each), claims about to collide, tasks gone quiet, and agents aios
  // refused or that went silent. A blocked agent is in its cause group, not listed again.
  const held = filtering ? null : renderHeld(state, runsMine, actions.control);
  const causes = filtering ? null : renderCauses(state, ui, actions.toggleCause, select);
  const clash = filtering ? null : contentionRows(state, select);
  // Refused, silent or clashing with main: each needs you. One whose checks failed is already in its cause group above.
  // An agent whose change already sits in a cause group (a clash with main, a failed check) is that group's row, not a
  // second one: "2 blocked" for one conflict was the same problem counted twice.
  const grouped = filtering ? new Set() : new Set(causeGroups(state).flatMap((g) => g.items.map((i) => i.change.agent_id)));
  const needy = filtering ? shown : shown.filter((x) => !grouped.has(x.a.agent_id) && (x.s === 'bad' || (x.s === 'warn' && !/\bfailed\b/.test(x.why))));
  // One problem, one row: a task gone quiet whose agent is already listed as silent is that agent's row, not a second.
  const stuck = filtering ? null : renderNeeds(state, actions.openTask, new Set(needy.map((x) => x.task?.task_id).filter(Boolean)));
  mountStable($('#issues'), held, causes, clash, stuck, needy.length || filtering ? renderIssues(needy, ui, select, filtering) : held || causes || stuck || clash ? null : h('li', { class: 'none' }, all.length ? 'Nothing needs attention' : 'No agents yet'));
  // "Need you" is the rows Needs attention shows, counted from the list itself: the two cannot disagree.
  const needCount = filtering ? 0 : $$('#issues > li').filter((li) => !li.classList.contains('none') && !li.classList.contains('more')).length;
  renderActivity(state, keep, filtering ? [] : alertExtras(state, runsMine));
  // The whole fleet in one coloured bar (the only breakdown; it filters), and the tab title says when something needs you.
  const fleet = empty ? null : renderFleet(all, state, ui, (k) => { ui.kind = k; schedule(); });
  $('#fleet-wrap').hidden = !fleet;
  if (fleet) mountStable($('#fleet'), fleet);
  if (!filtering) setAlert(needCount);
  $('#deck-wrap').hidden = empty || !deck.total || squares;
  if (deck.total && !squares) reconcile($('#deck'), deck.items);
  $('#deck-more').hidden = !deck.more;
  $('#deck-more').textContent = `+${deck.more} more`;
  mountStable($('#work'), ui.tview === 'folder' ? renderTerritories(state, ui, actions, select)
    : ui.tview === 'ws' ? renderWorkstreams(state, ui, actions, wsMap, runsMine)
    : ui.tview === 'heat' && ui.local ? renderHeat(heatFiles(state), state, ui, actions, select)
    : renderWork(state, ui, actions, keep));
  for (const b of $$('[data-tview]')) b.setAttribute('aria-selected', String(b.dataset.tview === ui.tview));
  // The flow (planned -> working -> handed in -> train -> main); the merge train opens from it.
  $('#flow').hidden = empty;
  $('#more').hidden = empty;
  $('#flow').hidden = empty || !$('#more').open;
  if (!$('#flow').hidden) mountStable($('#flow'), renderFlow(state, () => openTrain()));
  const train = empty || !ui.showTrain ? null : renderTrain(state, select);
  $('#train-wrap').hidden = !train;
  if (train) mountStable($('#train'), train);
  mountStable($('#pulse'), renderPulse(state, ui.planning));
  const mine = runs.project === settings.project ? runs.list : [];
  // The request just sent shows at once; it gives way to the run once the server lists it.
  if (ui.pending && mine[0] && mine[0].request === ui.pending.request && mine[0].started >= ui.pending.at - 10_000) ui.pending = null;
  renderDock(mine);
  // The goal: the newest run (or the project), how far, how fast, what it cost, what needs you.
  // The four numbers, the radar of where the agents are; the lists and the activity below are the drill-down.
  const firstNeed = $$('#issues > li').find((li) => !li.classList.contains('none'));
  const topNeed = (firstNeed?.querySelector('.why, .cause-t')?.textContent || firstNeed?.textContent || '').replace(/\s+/g, ' ').trim();
  const goal = empty ? null : renderGoal(state, mine[0] && mine[0].phase !== 'failed' ? mine[0] : null, needCount, () => $('#attention').scrollIntoView({ behavior: 'smooth', block: 'start' }), { topNeed, stuck: all.filter((x) => x.s === 'warn' || x.s === 'bad').length, planning: ui.planning });
  $('#goal').hidden = !goal;
  if (goal) mountStable($('#goal'), goal);
  // Territories, flow and the task views live behind "More": drawn only while it is open.
  const more = $('#more').open;
  const radar = empty || !more ? null : renderRadar(state, (f) => { ui.tview = 'folder'; ui.folder = f; schedule(); if (f) $('#tasks-box').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, ui.tview === 'folder' ? ui.folder : '');
  $('#radar').hidden = !radar;
  if (radar) mountStable($('#radar'), radar);
  // Needs attention shows only when something does (or a filter is on): the status line already says "All on track".
  $('#attention').hidden = empty || (!filtering && !needCount && !all.some((x) => x.s === 'warn' || x.s === 'bad'));
  renderDigest(state, mine);
  renderScopeNote(state, mine);
  if (!filtering) { $('#list-n').textContent = needCount ? String(needCount) : ''; $('#list-n').className = needCount ? 'n warn' : 'n'; }
  if (!ui.timeline.snapshot) loadDiffs(state);
  // Tabs: everything, the merge queue (handed in, waiting to land: checking, ready, sent back, clashing), or what landed.
  const CTAB = { queue: (c) => c.state === 'submitted' || c.state === 'conflicted', landed: (c) => c.state === 'landed' };
  const ctab = CTAB[ui.ctab] ? ui.ctab : 'all';
  for (const b of $$('#changes-tabs [data-ctab]')) b.setAttribute('aria-pressed', String(b.dataset.ctab === ctab));
  const active = changeItems(state, diffs, ui, actions, select, { keep, only: CTAB[ctab] || null });
  const past = ctab === 'all' ? changeItems(state, diffs, ui, actions, select, { keep, past: true }) : [];
  if (active.length) reconcile($('#changes'), active);
  else placeholder($('#changes'), h('li', { class: 'none' }, ctab === 'queue' ? 'Nothing waiting to land' : ctab === 'landed' ? 'Nothing landed yet' : 'No changes yet'));
  $('#changes-n').textContent = active.length ? String(active.length) : '';
  $('#past-box').hidden = !past.length;
  $('#past-sum').textContent = `Past attempts (${past.length})`;
  if (past.length) reconcile($('#past'), past);
}

// ---- the merge train, in a window over the page: what waits to land (checks running, ready, failed the train), what
// clashed with main, what landed lately; the picked change's diff beside it at once (fetched once, kept) ----
const trainDlg = $('#train-dialog');
const td = { pick: '', diffs: new Map() };
function trainItems(state) {
  const titleOf = (c) => state.tasks.find((t) => t.task_id === c.task_id)?.title || c.summary || c.change_id;
  const waiting = state.changes.filter((c) => c.state === 'submitted');
  const clashed = state.changes.filter((c) => c.state === 'conflicted');
  const landed = [...state.landings].reverse().slice(0, 12).map((l) => ({ l, c: state.changes.find((c) => c.change_id === l.change_id) })).filter((x) => x.c);
  const st = (c) => {
    if (c.state === 'conflicted') return ['warn', 'clashed with main'];
    if (c.integration && c.integration.exit_code == null) return ['info', 'checking with other changes'];
    if (c.integration && c.integration.exit_code !== 0) return ['bad', 'failed with other changes'];
    const k = checksOf(state, c);
    if (Object.values(k).includes('fail')) return ['bad', `failed:${Object.entries(k).filter(([, v]) => v === 'fail').map(([n]) => n).join(', ')}`];
    if (Object.values(k).includes('pending')) return ['info', 'being checked'];
    return ['good', 'ready to land'];
  };
  return [
    ['Waiting to land', waiting.map((c) => ({ c, title: titleOf(c), tone: st(c) }))],
    ['Clashed with main (being redone)', clashed.map((c) => ({ c, title: titleOf(c), tone: st(c) }))],
    ['Landed lately', landed.map(({ l, c }) => ({ c, title: titleOf(c), tone: ['good', `landed ${timeAgo(l.at)} as ${shortSha(l.commit, 7)}${l.receipt_hash ? ' · signed' : ''}`] }))],
  ];
}
function diffOf(changeId) {
  if (td.diffs.has(changeId)) return td.diffs.get(changeId);
  td.diffs.set(changeId, null);
  fetchDiff(changeId).then(diffText, (e) => `Could not load the diff: ${e.message}`)
    .then((text) => {
      td.diffs.set(changeId, text);
      if (trainDlg.open) renderTrainDlg();
      if (diffsDlg.open) renderDiffsDlg();
    });
  return null;
}
function openTrain() { td.pick = ''; if (!trainDlg.open) trainDlg.showModal(); renderTrainDlg(); }
function renderTrainDlg() {
  if (!trainDlg.open) return;
  const state = viewState();
  if (!state) return;
  const groups = trainItems(state);
  const flat = groups.flatMap(([, xs]) => xs);
  if (!flat.some((x) => x.c.change_id === td.pick)) td.pick = flat[0]?.c.change_id || '';
  $('#td-sum').textContent = `main ${shortSha(state.project.main_head, 7)} · ${groups[0][1].length} waiting · ${groups[1][1].length} clashed · ${state.landings.length} landed in all`;
  mountStable($('#td-list'), flat.length ? groups.map(([label, xs]) => xs.length ? [h('li', { class: 'td-g' }, label, h('span', null, String(xs.length))),
    ...xs.map((x) => h('li', null, h('button', { type: 'button', class: `td-i${x.c.change_id === td.pick ? ' on' : ''}`, 'data-id': x.c.change_id, onclick: () => { td.pick = x.c.change_id; renderTrainDlg(); } },
      h('span', { class: `td-dot ${x.tone[0]}` }), h('span', { class: 'td-t' }, h('b', null, x.title), h('span', { class: 'dim small' }, `${x.c.agent_id} · ${x.tone[1]}`)))))] : null)
    : h('li', { class: 'dim md-pad' }, 'Nothing waiting to land, and nothing landed yet.'));
  const cur = flat.find((x) => x.c.change_id === td.pick);
  if (!cur) return mountStable($('#td-detail'), h('p', { class: 'dim md-pad' }, 'Pick a change to see its diff.'));
  const c = cur.c;
  const k = checksOf(state, c);
  const text = diffOf(c.change_id);
  mountStable($('#td-detail'),
    h('div', { class: 'td-dh' }, h('b', null, cur.title), h('span', { class: `badge ${cur.tone[0]}` }, cur.tone[1]),
      h('span', { class: 'dim small mono' }, `${c.change_id} · ${c.agent_id} · ${shortSha(c.head_commit, 7)}`),
      h('span', { class: 'td-checks' }, Object.entries(k).filter(([, v]) => v !== 'none').map(([n, v]) => h('span', { class: `tag ${v === 'pass' ? 'good' : v === 'fail' ? 'bad' : 'info'}` }, `${v === 'pass' ? '✓' : v === 'fail' ? '✗' : '…'} ${n}`))),
      h('button', { type: 'button', class: 'link small', onclick: () => { trainDlg.close(); select(c.agent_id, c.change_id); } }, 'Open details →')),
    text == null ? h('p', { class: 'dim md-pad' }, 'Loading the diff…') : diffBlock(text));
}
trainDlg.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const ids = $$('#td-list .td-i').map((b) => b.dataset.id);
  const i = ids.indexOf(td.pick);
  const n = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (n && n !== td.pick) { e.preventDefault(); td.pick = n; renderTrainDlg(); $(`#td-list [data-id="${n}"]`)?.scrollIntoView({ block: 'nearest' }); }
});
for (const b of $$('#train-dialog [data-close]')) b.addEventListener('click', () => trainDlg.close());

// ---- Full-window changes inspection modal: page through diffs with animated transitions ----
const diffsDlg = $('#diffs-dialog');
const dv = { ids: [], idx: 0, animDir: '' };

function openDiffsModal(changeIds = [], initialId = '') {
  const state = viewState();
  if (!state) return;
  const list = changeIds.length ? changeIds
    : state.changes.filter((c) => c.head_commit).map((c) => c.change_id).reverse();
  if (!list.length) return toast('No changes to show', 'info');
  dv.ids = list;
  const initIndex = initialId ? dv.ids.indexOf(initialId) : 0;
  dv.idx = initIndex >= 0 ? initIndex : 0;
  dv.animDir = '';
  if (!diffsDlg.open) diffsDlg.showModal();
  renderDiffsDlg();
  // Preload diffs for neighboring items
  for (const id of [dv.ids[dv.idx], dv.ids[dv.idx + 1], dv.ids[dv.idx - 1]].filter(Boolean)) {
    diffOf(id);
  }
}

function pageDiff(delta) {
  if (!dv.ids.length) return;
  const target = dv.idx + delta;
  if (target < 0 || target >= dv.ids.length) return;
  dv.animDir = delta > 0 ? 'slide-next' : 'slide-prev';
  dv.idx = target;
  renderDiffsDlg();
  // Preload next in current direction
  const nextPreload = dv.ids[dv.idx + delta];
  if (nextPreload) diffOf(nextPreload);
}

function renderDiffsDlg() {
  if (!diffsDlg.open) return;
  const state = viewState();
  if (!state || !dv.ids.length) return;
  const total = dv.ids.length;
  dv.idx = Math.max(0, Math.min(total - 1, dv.idx));
  const curId = dv.ids[dv.idx];
  const c = state.changes.find((x) => x.change_id === curId);
  const task = c ? state.tasks.find((t) => t.task_id === c.task_id) : null;
  const title = task?.title || c?.summary || curId;

  // Header counters and buttons
  $('#diffs-counter').textContent = `${dv.idx + 1} of ${total}`;
  $('#diffs-task-title').textContent = title;
  $('#diffs-paging-status').textContent = `${dv.idx + 1} / ${total}`;
  $('#diffs-prev').disabled = dv.idx <= 0;
  $('#diffs-next').disabled = dv.idx >= total - 1;
  $('#diffs-list-count').textContent = String(total);

  // Sidebar change list
  mountStable($('#diffs-list'), dv.ids.map((id, index) => {
    const item = state.changes.find((x) => x.change_id === id);
    const itemState = item?.state || 'unknown';
    const isLanded = itemState === 'landed';
    const isConflicted = itemState === 'conflicted';
    const isSuperseded = itemState === 'superseded';
    const tone = isLanded ? 'good' : isConflicted ? 'warn' : isSuperseded ? 'dim' : 'info';
    return h('li', null,
      h('button', {
        type: 'button',
        class: `diffs-card${index === dv.idx ? ' selected' : ''}`,
        'data-id': id,
        onclick: () => {
          if (index !== dv.idx) {
            dv.animDir = index > dv.idx ? 'slide-next' : 'slide-prev';
            dv.idx = index;
            renderDiffsDlg();
          }
        }
      },
      h('div', { class: 'diffs-card-top' },
        h('span', { class: `diffs-card-state ${tone}` }, itemState),
        h('span', { class: 'diffs-card-agent' }, item?.agent_id || ''),
        item?.head_commit ? h('span', { class: 'diffs-card-commit' }, shortSha(item.head_commit, 7)) : null),
      h('div', { class: 'diffs-card-summary' }, item?.summary || (state.tasks.find((t) => t.task_id === item?.task_id)?.title) || id)));
  }));

  // Auto-scroll selected card into view in sidebar
  $(`#diffs-list [data-id="${curId}"]`)?.scrollIntoView({ block: 'nearest' });

  // Main viewer with slide animation
  if (!c) {
    return mountStable($('#diffs-view-container'), h('div', { class: 'dim md-pad' }, 'Change not found.'));
  }

  const k = checksOf(state, c);
  const text = diffOf(curId);
  const animClass = dv.animDir || 'slide-in';
  const cState = c.state;
  const badgeTone = cState === 'landed' ? 'good' : cState === 'conflicted' ? 'warn' : cState === 'superseded' ? 'dim' : 'info';

  const viewPage = h('div', { class: `diffs-page ${animClass}` },
    h('div', { class: 'diffs-page-head' },
      h('div', { class: 'diffs-page-title-row' },
        h('h3', { class: 'diffs-page-title' }, title),
        h('span', { class: `badge ${badgeTone}` }, cState)),
      h('div', { class: 'diffs-meta-row' },
        h('span', { class: 'dim mono' }, `${c.change_id} · ${c.agent_id} · ${shortSha(c.head_commit, 7)}`),
        h('span', { class: 'td-checks' }, Object.entries(k).filter(([, v]) => v !== 'none').map(([n, v]) =>
          h('span', { class: `tag ${v === 'pass' ? 'good' : v === 'fail' ? 'bad' : 'info'}` }, `${v === 'pass' ? '✓' : v === 'fail' ? '✗' : '…'} ${n}`))),
        h('button', {
          type: 'button',
          class: 'link small',
          onclick: () => {
            diffsDlg.close();
            select(c.agent_id, c.change_id);
          }
        }, 'Open details →'))),
    text == null ? h('p', { class: 'dim md-pad' }, 'Loading the diff…') : diffBlock(text));

  mount($('#diffs-view-container'), viewPage);
  // Reset animation direction after rendering so static re-renders don't re-animate
  dv.animDir = '';
}

$('#diffs-prev').addEventListener('click', () => pageDiff(-1));
$('#diffs-next').addEventListener('click', () => pageDiff(1));
diffsDlg.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    pageDiff(-1);
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    pageDiff(1);
  }
});
for (const b of $$('#diffs-dialog [data-close]')) b.addEventListener('click', () => diffsDlg.close());

// One panel's mistake must not take the page down: the board and the details flyout draw separately, and a failure
// is logged and said once, not left as a frozen page where clicks do nothing.
let renderFailed = '';
function render() {
  // Replaying the past: silent agents and "x minutes ago" are judged at the moment on screen, not by today's clock.
  const snap = ui.timeline.snapshot;
  clock.at = snap ? Math.max(0, ...snap.recent.map((e) => e.at || 0), ...snap.landings.map((e) => e.at || 0)) : 0;
  for (const [name, fn] of [['board', renderBoard], ['details', renderFly], ['merge train', renderTrainDlg], ['inspect changes', renderDiffsDlg]]) {
    try { fn(); }
    catch (e) {
      console.error(`converge: drawing the ${name} failed`, e);
      const msg = `${name}: ${e.message}`;
      if (renderFailed !== msg) { renderFailed = msg; toast(`Part of the page failed to load (${msg}). Try reloading.`, 'error'); }
    }
  }
}
// The picked agent's log, followed live (every 2 s while its details are open): only new entries are fetched.
ui.agentLog = null;
let logBusy = false;
async function followAgentLog(now = false) {
  // Only the local platform keeps agents' logs (the Worker has no log route): nothing to poll there.
  if (!ui.local || !ui.fly || !ui.agent || (document.hidden && !now) || logBusy || !signedIn()) return;
  const cur = ui.agentLog?.agent === ui.agent ? ui.agentLog : { agent: ui.agent, entries: [], total: 0, last: -1 };
  logBusy = true;
  try {
    const j = await api(`${P()}/agents/${encodeURIComponent(cur.agent)}/log?after=${cur.last}`);
    if (ui.agent !== cur.agent) return;
    const entries = [...cur.entries, ...(j.entries || [])].slice(-400);
    // The summary covers the whole agent (every poll recomputes it): the newest one replaces the last.
    ui.agentLog = { agent: cur.agent, entries, total: j.total || cur.total, last: entries.at(-1)?.i ?? cur.last, missing: Boolean(j.missing && !entries.length), where: j.where, summary: j.summary || cur.summary || null };
    if (j.entries?.length || j.missing || cur.error) schedule();
  } catch (e) {
    // Said in the details (and tried again at the next tick), not passed off as an empty log.
    if (ui.agent === cur.agent) { ui.agentLog = { ...cur, error: `could not read the log: ${e.message || e}` }; if (cur.error !== ui.agentLog.error) schedule(); }
  } finally { logBusy = false; }
}
setInterval(followAgentLog, 2000);

// A run's planning, followed while its details are open: the planner's and converge's steps, then the tasks in full.
let planBusy = false;
async function followRunPlan(now = false) {
  if (!ui.local || !ui.fly || !ui.run || (document.hidden && !now) || planBusy || !signedIn()) return;
  const id = ui.run;
  planBusy = true;
  try {
    const j = await api(`${P()}/runs/${encodeURIComponent(id)}/plan`);
    if (ui.run !== id) return;
    const before = ui.runPlan?.id === id ? ui.runPlan : null;
    ui.runPlan = { id, ...j };
    if (!before || before.entries.length !== j.entries.length || before.tasks.length !== j.tasks.length || before.phase !== j.phase) schedule();
  } catch (e) {
    if (ui.run === id) { ui.runPlan = { id, entries: ui.runPlan?.entries || [], tasks: ui.runPlan?.tasks || [], error: `could not read the plan: ${e.message || e}` }; schedule(); }
  } finally { planBusy = false; }
}
setInterval(followRunPlan, 2000);
// ---- The Live pane (click "Live" at the top right): every worker's log in one stream, each line with its time and
// its worker, and the Activity feed under it. Each worker's log is read like the details view does (only new entries). ----
ui.live = false; ui.livePick = '';
let liveBusy = false, liveTick = 0;
function liveWorkers(state) {
  const landed = new Set(state.changes.filter((c) => c.state === 'landed').map((c) => c.task_id));
  return state.agents.map((a) => {
    const t = state.tasks.find((x) => x.agents.includes(a.agent_id));
    const c = liveLogs.get(a.agent_id);
    return { id: a.agent_id, label: a.agent_id.slice(2, 6), title: t?.title || '', active: !(t && landed.has(t.task_id)) && !state.stoppedAgents?.has(a.agent_id), error: c?.error || '', missing: Boolean(c?.missing) };
  });
}
function renderLivePane() {
  const pane = $('#livepane');
  const state = ui.live && $('#signin').hidden ? viewState() : null;
  pane.hidden = !state;
  if (!state) return;
  const workers = liveWorkers(state);
  const rows = [];
  for (const w of workers) for (const e of liveLogs.get(w.id)?.entries || []) rows.push({ at: e.at, agent: w.id, entry: e });
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : a.entry.i - b.entry.i));
  const old = $('#lv-top .lv-stream');
  const pinned = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 30;
  const top = old?.scrollTop;
  mountStable($('#lv-top'), renderLive({ rows: rows.slice(-400), workers, pick: ui.livePick, onPick: (id) => { ui.livePick = id; renderLivePane(); }, onClose: toggleLive }));
  const now = $('#lv-top .lv-stream');
  if (now) now.scrollTop = pinned ? now.scrollHeight : top;
}
function toggleLive() {
  ui.live = !ui.live;
  if (ui.live && ui.fly) actions.closeFly();
  renderLivePane();
  document.body.classList.toggle('fly-open', !$('#livepane').hidden || !$('#flyout').hidden);
  if (ui.live) followLive(true);
  schedule();
}
async function followLive(now = false) {
  // Only the local platform keeps agents' logs; the Activity feed under the stream works anywhere.
  if (!ui.live || !ui.local || !signedIn() || (document.hidden && !now) || liveBusy) return;
  const state = viewState();
  if (!state) return;
  liveBusy = true; liveTick++;
  let changed = false;
  try {
    await Promise.all(liveWorkers(state).map(async (w) => {
      const c = liveLogs.get(w.id) || { last: -1, entries: [], seen: false, error: '', missing: false };
      liveLogs.set(w.id, c);
      if (c.seen && !w.active && liveTick % 8) return; // a finished worker's log hardly changes: looked at now and then
      try {
        const j = await api(`${P()}/agents/${encodeURIComponent(w.id)}/log?after=${c.last}`);
        let es = j.entries || [];
        if (!c.seen) es = es.slice(-30); // the first look: the latest of each, not their whole history
        const missing = Boolean(j.missing && !c.entries.length);
        if (es.length || missing !== c.missing || c.error) changed = true;
        c.seen = true; c.error = ''; c.missing = missing;
        if (es.length) { c.entries = [...c.entries, ...es].slice(-150); c.last = es.at(-1).i; }
      } catch (e) {
        const m = `could not read the log: ${e.message || e}`;
        if (c.error !== m) { c.error = m; changed = true; }
      }
    }));
  } finally { liveBusy = false; }
  if (changed) renderLivePane();
}
setInterval(followLive, 2000);
// The run clocks tick every second without redrawing anything else.
setInterval(() => { for (const el of $$('[data-since]')) { const t = Number(el.dataset.since); if (t) el.textContent = clockText(Date.now() - t); } }, 1000);

function renderFly() {
  if (ui.fly && ui.live) ui.live = false; // the details and the live pane share the right edge: the details win
  renderLivePane();
  if ($('#signin').hidden === false) return;
  const state = viewState();
  if (!state) return;
  actions.canHalt = Boolean(ui.adminKey && ui.local);
  if (!ui.local) ui.agentLog = null; // no logs off the local platform: the details show the agent's steps instead
  if (ui.local && ui.fly && ui.agent && ui.agentLog?.agent !== ui.agent) { ui.agentLog = { agent: ui.agent, entries: [], total: 0, last: -1 }; followAgentLog(true); }
  let fly = null;
  if (ui.fly) {
    if (ui.run) {
      const targetRun = runs.list.find((r) => r.id === ui.run);
      if (ui.runPlan?.id !== ui.run) { ui.runPlan = { id: ui.run, entries: [], tasks: [] }; followRunPlan(true); }
      fly = targetRun ? renderRunFlyout(targetRun, actions, ui.runPlan) : null;
    }
    if (!fly) fly = renderFlyout(state, ui, actions);
  }
  $('#flyout').hidden = !fly;
  document.body.classList.toggle('fly-open', Boolean(fly) || !$('#livepane').hidden);
  if (fly) {
    // Redraws must not move what the owner is reading: same item, same scroll position and the same sections open.
    const key = ui.run ? `run|${ui.run}` : `${ui.task}|${ui.agent}`;
    const body = $('#fly .fly-body');
    const al = $('#fly .alog');
    const keep = $('#fly').dataset.key === key && body ? { top: body.scrollTop, open: $$('#fly details').map((d) => d.open), alTop: al?.scrollTop, alPinned: !al || al.scrollHeight - al.scrollTop - al.clientHeight < 30 } : null;
    mountStable($('#fly'), fly);
    $('#fly').dataset.key = key;
    const nb = $('#fly .fly-body');
    if (keep && nb && nb !== body) {
      $$('#fly details').forEach((d, i) => { if (keep.open[i] != null) d.open = keep.open[i]; });
      nb.scrollTop = keep.top;
    }
    const nal = $('#fly .alog');
    if (nal) nal.scrollTop = !keep || keep.alPinned ? nal.scrollHeight : keep.alTop;
  }
}

// The runs started on this platform (GET /api/projects/:p/runs; the local server keeps them): the newest is shown
// above the work, from "planning" to "finished", whoever started it.
const runs = { project: '', list: [] };
async function pollRuns() {
  clearTimeout(runs.timer);
  // Both platforms list a project's runs (GET .../runs; on Cloudflare it never starts a container to answer).
  if (runs.busy) return;
  runs.busy = true;
  if (signedIn() && settings.project) {
    try {
      const list = (await api(`${P()}/runs`)).runs || [];
      runs.project = settings.project; runs.list = list;
      schedule();
    } catch { if (runs.project !== settings.project) { runs.project = settings.project; runs.list = []; } } // offline: try again at the next poll, not every frame
  }
  runs.busy = false;
  clearTimeout(runs.timer);
  runs.timer = setTimeout(pollRuns, runs.list[0] && !['done', 'failed', 'stopped'].includes(runs.list[0].phase) ? 2000 : 6000);
}


/** An agent picked anywhere (a square, a row, an event, a change): its task in the flyout, with it in focus. */
function select(agentId, changeId = '') {
  const state = viewState();
  const a = state.agents.find((x) => x.agent_id === agentId);
  const ch = changeId ? state.changes.find((c) => c.change_id === changeId) : [...state.changes].reverse().find((c) => c.agent_id === agentId && c.head_commit);
  const task = state.tasks.find((t) => t.agents.includes(agentId) || (ch && t.task_id === ch.task_id));
  Object.assign(ui, { fly: true, agent: a ? agentId : '', task: task?.task_id || '' });
  if (ch?.head_commit) actions.loadDiff(ch.change_id, true);
  schedule();
  // An agent aios refused opens on the refused cycle itself: what the model said, and what aios answered, without
  // hunting for the row. (Not again if that agent already has a cycle open: the person may be reading another.)
  const lastRefused = a?.aios?.refused ? [...(state.acts?.[agentId] || [])].reverse().find((e) => e.verdict === 'refused') : null;
  if (lastRefused && ui.cycle.agent !== agentId) actions.selectCycle(agentId, lastRefused.cycle);
}

function copyable(text) {
  return h('div', { class: 'cmd' }, h('code', null, text),
    h('button', { type: 'button', class: 'link', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('copied', 'success'), () => toast('copy failed', 'error')) }, 'copy'));
}

function renderEmpty(state) {
  const p = settings.project;
  const env = `CONVERGE_API_URL=${location.origin} ADMIN_KEY=<your admin key>`;
  const task = state.tasks[0];
  const cli = [
    task ? null : [h('p', null, '1. Give the project a task'), copyable(`${env} npm run converge -- task --project ${p} --title "What to do" --agents 0`)],
    h('p', null, `${task ? '' : '2. '}Run an agent on ${task ? `task ${task.task_id} (${task.title})` : 'it'}`),
    copyable(`${env} npm run converge -- run --project ${p} --task ${task ? task.task_id : '<task id>'} --agent <provider> --model <model>`),
    h('p', { class: 'dim' }, 'Or connect your own agent (Claude Code, Gemini, Codex):'),
    copyable(`${env} npm run converge -- join --project ${p} --task ${task ? task.task_id : '<task id>'}`),
  ];
  return [
    h('h2', null, 'Nothing running here yet'),
    h('p', { class: 'dim' }, ui.adminKey
      ? 'Type a request below. Its tasks show up here.'
      : 'Agents show up here as they work. Sign in with the admin key to start a run.'),
    h('details', null, h('summary', null, 'Or use the command line'), cli),
  ];
}

// ---- timeline ---------------------------------------------------------------------------------

async function timelineFetch(seq) {
  const t = ui.timeline;
  t.seq = seq;
  if (seq < 0 || seq >= store.state.version) {
    // At the head (or past the end): show the live state, don't fetch.
    t.snapshot = null;
    t.error = '';
    t.forSeq = 0;
    schedule();
    return;
  }
  if (t.snapshot && t.forSeq === seq) return;
  t.loading = true;
  schedule();
  const project = encodeURIComponent(settings.project);
  try {
    const snap = await api(`/api/projects/${project}/state?at=${seq}`).catch((e) => { throw e.status === 401 || e.status === 403 ? new Error('view key required') : e; });
    if (t.seq !== seq) return;
    const probe = new Store();
    probe.applySnapshot(snap);
    t.snapshot = probe.state;
    t.forSeq = seq;
    t.error = '';
  } catch (err) {
    if (t.seq !== seq) return;
    t.error = String(err.message || err);
  } finally {
    if (t.seq === seq) { t.loading = false; schedule(); }
  }
}

// The tape's controls: the landings (and rewinds) are the stops; play steps through them to now.
const tape = { playing: 0 };
function tapeStops() { return store.state.landings.map((e) => e.seq).concat(store.state.recent.filter((e) => e.type === 'MainRewound').map((e) => e.seq)).sort((a, b) => a - b); }
function tapeAt() { const t = ui.timeline; return t.drag ?? (t.snapshot || t.loading ? t.seq : store.state.version || 0); }
function goTo(seq) {
  const range = $('#timeline-range');
  ui.timeline.drag = null;
  if (seq >= (store.state.version || 0)) return timelineLive();
  range.value = String(seq);
  timelineFetch(seq);
}
function tapeStep(dir) {
  const stops = tapeStops();
  const at = tapeAt();
  const live = at >= (store.state.version || 0);
  const next = dir < 0 ? (live ? stops.at(-1) : [...stops].reverse().find((x) => x < at)) : stops.find((x) => x > at);
  if (next === undefined) { if (dir > 0) { timelineLive(); return false; } return false; }
  goTo(next);
  return true;
}
function tapePlay() {
  if (tape.playing) { clearInterval(tape.playing); tape.playing = 0; return schedule(); }
  if (tapeAt() >= (store.state.version || 0)) goTo(tapeStops()[0] ?? 0);
  tape.playing = setInterval(() => { if (!tapeStep(1)) { clearInterval(tape.playing); tape.playing = 0; schedule(); } }, 1400);
  schedule();
}
$('#tl-prev').addEventListener('click', () => tapeStep(-1));
$('#tl-next').addEventListener('click', () => tapeStep(1));
$('#tl-play').addEventListener('click', tapePlay);
$('#tl-live').addEventListener('click', () => { if (tape.playing) tapePlay(); timelineLive(); });
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.target.closest?.('input, textarea, select, dialog, [contenteditable]') || $('#board').hidden) return;
  e.preventDefault();
  tapeStep(e.key === 'ArrowLeft' ? -1 : 1);
});

function timelineLive() {
  ui.timeline.drag = null;
  ui.timeline.snapshot = null;
  ui.timeline.seq = store.state.version;
  ui.timeline.forSeq = 0;
  ui.timeline.error = '';
  schedule();
}

// Dragging only moves the label (what happened at that point); the project as it was loads when the slider is let go.
const range = $('#timeline-range');
if (range) {
  range.addEventListener('input', (e) => { ui.timeline.drag = Number(e.target.value) || 0; schedule(); });
  range.addEventListener('change', (e) => { ui.timeline.drag = null; timelineFetch(Number(e.target.value) || 0); });
}

// ---- actions ----------------------------------------------------------------------------------

const actions = {
  openFolder(f) { ui.folder = f; schedule(); },
  openWs(w) { ui.ws = w; schedule(); },
  pickHeat(p) { ui.heatFile = p; schedule(); },
  // The owner's answer to what the rules held back: resume or drop a task, or a whole workstream ("ws:<name>").
  async control(runId, body) {
    try {
      await adminApi(`${P()}/runs/${runId}/control`, { method: 'POST', body: JSON.stringify(body) });
      toast(body.retire ? `Retiring ${body.retire.some((x) => /#\d+$/.test(x)) ? 'that check' : 'the checks'}` : body.resume ? 'Resuming' : 'Dropped', 'success');
      setTimeout(pollRuns, 1500);
    } catch (e) { toast(`Failed: ${e.message || e}`, 'error'); }
  },
  toggleCause(key) { if (ui.openCause.has(key)) ui.openCause.delete(key); else ui.openCause.add(key); schedule(); },
  toggleCluster(key) { if (ui.openClusters.has(key)) ui.openClusters.delete(key); else ui.openClusters.add(key); schedule(); },
  toggleGroup(key, change) { ui.groups ??= {}; ui.groups[key] = { ...ui.groups[key], ...change }; schedule(); },
  async stopRun(id) {
    try { await adminApi(`${P()}/runs/${id}/stop`, { method: 'POST' }); } catch (e) { return toast(`stop: ${e.message}`, 'error'); }
    toast('Stopping all agents in this run', 'info');
    pollRuns();
  },
  async startOver(r) {
    const { stop, request } = restartRequest({ status: r.phase, request: r.request });
    if (stop) { try { await adminApi(`${P()}/runs/${r.id}/stop`, { method: 'POST' }); } catch (e) { return toast(`stop: ${e.message}`, 'error'); } }
    try {
      const directTasks = loadDirectTasks();
      await adminApi(`${P()}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          request,
          ...(!$('#run-pick').hidden && ui.pick ? { pick: ui.pick } : { model: $('#run-model').value }),
          agents: r.agents || (directTasks.length ? Math.max(directTasks.length, Number($('#run-agents').value)) : Number($('#run-agents').value)),
          budget: Number($('#run-budget').value),
          rules: rulesBody(),
          ...(directTasks.length ? { tasks: directTasks } : {})
        }),
      });
    } catch (e) { return toast(`start over: ${e.message}`, 'error'); }
    toast('Started over', 'success');
    pollRuns();
  },
  canHalt: false,
  async haltAgent(agent, taskId) {
    if (!confirm(`Stop ${agent}? Its work is saved, and you can resume it from Needs attention.`)) return;
    try { await adminApi(`${P()}/agents/${encodeURIComponent(agent)}/halt`, { method: 'POST', body: JSON.stringify({ task_id: taskId }) }); } catch (e) { return toast(`halt: ${e.message}`, 'error'); }
    toast(`Stopping ${agent}. Its work is saved.`, 'success');
    setTimeout(pollRuns, 1500);
  },
  async continueRun(id, add, confirmed = false) {
    let j;
    try { j = await adminApi(`${P()}/runs/${id}/continue`, { method: 'POST', body: JSON.stringify({ add_budget: add, ...(confirmed ? { confirm: true } : {}) }) }); } catch (e) { return toast(`continue: ${e.message}`, 'error'); }
    // More than the provider's balance covers: said, and started only if you say so (the balance floor still ends it).
    if (j.over_by) {
      if (confirm(`Over budget by $${j.over_by}. Continue anyway?`)) return this.continueRun(id, add, true);
      setTimeout(pollRuns, 300);
      return;
    }
    toast(j.added ? `Continuing with up to $${j.added} more` : `Starting ${j.tasks?.length || ''} tasks from the existing plan`, 'success');
    setTimeout(pollRuns, 800);
  },
  openRun(runId) {
    Object.assign(ui, { fly: true, run: runId, task: '', agent: '' });
    schedule();
  },
  openTask(taskId) {
    Object.assign(ui, { fly: true, task: taskId, agent: '', run: '' });
    const ch = [...viewState().changes].reverse().find((c) => c.task_id === taskId && c.head_commit);
    if (ch) actions.loadDiff(ch.change_id, true);
    schedule();
  },
  focusAgent(agentId) { ui.agent = agentId; ui.run = ''; schedule(); },
  closeFly() { Object.assign(ui, { fly: false, task: '', agent: '', run: '' }); schedule(); },
  inspect(agentId) { select(agentId); },
  inspectChanges(changeIds = [], initialId = '') { openDiffsModal(changeIds, initialId); },

  async rewind(agentId, cycle) {
    try { await adminApi(`${P()}/agents/${encodeURIComponent(agentId)}/rewind`, { method: 'POST', body: JSON.stringify({ cycle }) }); } catch (e) { return toast(`rewind: ${e.message}`, 'error'); }
    toast(`Rewinding to step ${cycle}`, 'success');
    connection.fetchNow();
  },
  /** Replay one cycle: its full reply and result (the snapshot keeps only a summary) and its files. */
  async selectCycle(agentId, n) {
    if (ui.cycle.agent === agentId && ui.cycle.n === n) { ui.cycle = { agent: '', n: 0 }; return schedule(); }
    ui.cycle = { agent: agentId, n, loading: true };
    schedule();
    const base = `${P()}/agents/${encodeURIComponent(agentId)}`;
    try {
      const [cy, df] = await Promise.all([api(`${base}/cycles`).catch((e) => { throw new Error(`cycles: ${e.message}`); }),
        api(`${base}/cycles/diff?from=${n - 1}&to=${n}`).catch((e) => ({ diff: `Could not load the diff: ${e.message}` }))]);
      const full = [...(cy.cycles || [])].reverse().find((e) => e.cycle === n) || null;
      const diff = typeof df.diff === 'string' ? df.diff : 'Could not load the diff: the server sent none';
      if (ui.cycle.agent === agentId && ui.cycle.n === n) ui.cycle = { agent: agentId, n, full, diff };
    } catch (err) {
      if (ui.cycle.agent === agentId && ui.cycle.n === n) ui.cycle = { agent: agentId, n, error: String(err.message || err) };
    }
    schedule();
  },
  async loadDiff(changeId, open = false) {
    if (ui.diff.changeId === changeId) { if (!open) { ui.diff = { changeId: '', text: '' }; schedule(); } return; }
    ui.diff = { changeId, text: 'loading…' };
    schedule();
    const show = (text) => { if (ui.diff.changeId === changeId) { ui.diff = { changeId, text }; schedule(); } }; // unless another was picked meanwhile
    // The view route (any key that opens the board); the reviewer's MCP diff only where that route is missing.
    try { return show(diffText(await fetchDiff(changeId))); }
    catch (e) {
      if (e.status !== 404 || !settings.reviewerKey) return show(`Could not load the diff: ${e.message}`);
      const m = await mcpCall({ project: settings.project, key: settings.reviewerKey, tool: 'diff', args: { change_id: changeId } }).catch((x) => ({ error: x.message }));
      return show(m.ok && typeof m.data?.diff === 'string' ? diffText(m.data.diff) : `Could not load the diff${m.error ? `: ${m.error}` : ''}`);
    }
  },
  async land(changeId) {
    const r = await mcpCall({ project: settings.project, key: settings.reviewerKey, tool: 'ship', args: { change_id: changeId } });
    if (!r.ok) return toast(`land: ${r.error}`, 'error');
    toast(`landed ${changeId} \u2192 ${shortSha(r.data.landed_commit)}`, 'success');
    connection.fetchNow();
  },
  /** Ask the platform to move main back to a commit already in its history. */
  async rewindMain(commit) {
    if (!ui.adminKey) return toast('Rewinding needs the admin key', 'error');
    if (!window.confirm(`Rewind main to ${shortSha(commit, 12)}? This adds a new commit that restores it.`)) return;
    try {
      await adminApi(`${P()}/rewind`, { method: 'POST', body: JSON.stringify({ commit }) });
      toast(`Main rewound to ${shortSha(commit, 12)}`, 'success');
      timelineLive();
      connection.fetchNow();
    } catch (err) {
      toast(`rewind: ${err.message || err}`, 'error');
    }
  },
};


// ---- the heat map's files (GET /api/projects/:p/files, the local platform only: the Worker has no such route, so the
// view is offered only there), loaded when the view is open, again when main moves ----
const heat = { key: '', files: null, busy: false };
function heatFiles(state) {
  const key = `${settings.project}@${state.project.main_head || ''}`;
  if (heat.key !== key && !heat.busy) {
    heat.busy = true;
    api(`${P()}/files`).then((j) => { heat.files = j.files || []; }, () => { heat.files = []; })
      .finally(() => { heat.key = key; heat.busy = false; schedule(); });
  }
  return heat.key === key || heat.files ? heat.files : null;
}

// ---- rules: what converge does on its own (escalate, pause a workstream, leads), sent with every run ----------
const RULES_KEY = 'converge.rules';
function loadRules() { return { esc: true, tries: 3, pause: true, pct: 40, leads: false, ...prefs.getJson(RULES_KEY, {}) }; }
function rulesBody() { const r = loadRules(); return { maxTries: r.esc ? Number(r.tries) || 3 : 0, pauseAt: r.pause ? (Number(r.pct) || 40) / 100 : 0, leads: Boolean(r.leads) }; }
function showRulesChip() {
  const r = loadRules();
  const parts = [r.esc && `${r.tries} tries`, r.pause && `pause ${r.pct}%`, r.leads && 'leads'].filter(Boolean);
  $('#run-rules').textContent = parts.length ? `Rules: ${parts.join(' · ')}` : 'Rules: none';
}
$('#run-rules').addEventListener('click', () => {
  const r = loadRules();
  $('#rule-esc').checked = r.esc; $('#rule-tries').value = r.tries; $('#rule-pause').checked = r.pause; $('#rule-pct').value = r.pct; $('#rule-leads').checked = r.leads;
  openPop('rulespop');
});
$('#rules-done').addEventListener('click', () => {
  prefs.setJson(RULES_KEY, { esc: $('#rule-esc').checked, tries: Number($('#rule-tries').value) || 3, pause: $('#rule-pause').checked, pct: Number($('#rule-pct').value) || 40, leads: $('#rule-leads').checked });
  showRulesChip();
  closePop();
});
showRulesChip();

// ---- Direct Tasks (bypass model planning) --------------------------------------------------------
const TASKS_KEY = () => `converge.direct_tasks.${settings.project}`;
function loadDirectTasks() {
  const t = prefs.getJson(TASKS_KEY(), []);
  return Array.isArray(t) ? t : [];
}
function saveDirectTasks(tasks) {
  prefs.setJson(TASKS_KEY(), Array.isArray(tasks) ? tasks : []);
  showTasksChip();
}
function showTasksChip() {
  const tasks = loadDirectTasks();
  const chip = $('#run-tasks');
  const stat = $('#tasks-status-text');
  if (chip) {
    if (tasks.length > 0) {
      chip.textContent = `Tasks: ${tasks.length} direct`;
      chip.classList.add('active');
      if (stat) stat.textContent = `${tasks.length} direct task(s) active`;
    } else {
      chip.textContent = 'Tasks: auto';
      chip.classList.remove('active');
      if (stat) stat.textContent = 'Using AI model planner';
    }
  }
}

let activeTasksTab = 'cards';
function renderTaskCardsList(tasks) {
  const list = $('#tasks-list');
  if (!list) return;
  list.innerHTML = '';
  tasks.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'task-card-item';
    
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'task-card-del';
    delBtn.title = 'Remove task';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      const current = readTasksFromCards();
      current.splice(i, 1);
      renderTaskCardsList(current);
    });
    
    const titleIn = document.createElement('input');
    titleIn.type = 'text';
    titleIn.className = 'task-card-title';
    titleIn.placeholder = 'Task title (e.g. Build auth module)';
    titleIn.value = t.title || '';

    const descIn = document.createElement('textarea');
    descIn.rows = 2;
    descIn.className = 'task-card-desc';
    descIn.placeholder = 'Instructions for agent';
    descIn.value = t.description || '';

    const checks = Array.isArray(t.accept) ? t.accept.join('\n') : (typeof t.accept === 'string' ? t.accept : '');
    const acceptIn = document.createElement('textarea');
    acceptIn.rows = 2;
    acceptIn.className = 'mono task-card-accept';
    acceptIn.placeholder = 'Acceptance checks (one shell command per line)';
    acceptIn.value = checks;

    card.append(delBtn, titleIn, descIn, acceptIn);
    list.appendChild(card);
  });
}

function readTasksFromCards() {
  const cards = $$('#tasks-list .task-card-item');
  const tasks = [];
  cards.forEach((c) => {
    const title = c.querySelector('.task-card-title')?.value.trim() || '';
    const description = c.querySelector('.task-card-desc')?.value.trim() || '';
    const acceptRaw = c.querySelector('.task-card-accept')?.value.trim() || '';
    const accept = acceptRaw ? acceptRaw.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    if (title || description || accept.length) {
      tasks.push({ title: title || 'Task', description, accept });
    }
  });
  return tasks;
}

$('#run-tasks').addEventListener('click', () => {
  const tasks = loadDirectTasks();
  activeTasksTab = 'cards';
  $('#tasks-cards-view').hidden = false;
  $('#tasks-json-view').hidden = true;
  $('#tasks-tab-cards').classList.add('active');
  $('#tasks-tab-json').classList.remove('active');
  renderTaskCardsList(tasks);
  $('#tasks-json-input').value = JSON.stringify(tasks, null, 2);
  openPop('taskspop');
});

$('#tasks-tab-cards').addEventListener('click', () => {
  if (activeTasksTab === 'cards') return;
  activeTasksTab = 'cards';
  $('#tasks-cards-view').hidden = false;
  $('#tasks-json-view').hidden = true;
  $('#tasks-tab-cards').classList.add('active');
  $('#tasks-tab-json').classList.remove('active');
  let tasks = [];
  try {
    const txt = $('#tasks-json-input').value.trim();
    tasks = txt ? JSON.parse(txt) : [];
  } catch {}
  renderTaskCardsList(Array.isArray(tasks) ? tasks : []);
});

$('#tasks-tab-json').addEventListener('click', () => {
  if (activeTasksTab === 'json') return;
  activeTasksTab = 'json';
  $('#tasks-cards-view').hidden = true;
  $('#tasks-json-view').hidden = false;
  $('#tasks-tab-cards').classList.remove('active');
  $('#tasks-tab-json').classList.add('active');
  const tasks = readTasksFromCards();
  $('#tasks-json-input').value = JSON.stringify(tasks, null, 2);
});

$('#tasks-add-btn').addEventListener('click', () => {
  const tasks = readTasksFromCards();
  tasks.push({ title: '', description: '', accept: [] });
  renderTaskCardsList(tasks);
  const cards = $$('#tasks-list .task-card-item');
  if (cards.length) cards[cards.length - 1].querySelector('.task-card-title')?.focus();
});

$('#tasks-clear').addEventListener('click', () => {
  saveDirectTasks([]);
  renderTaskCardsList([]);
  $('#tasks-json-input').value = '[]';
  toast('Direct tasks cleared (using auto model planner)', 'info');
});

$('#tasks-load-draft').addEventListener('click', async () => {
  try {
    const res = await api(`${P()}/draft-tasks`);
    if (res && Array.isArray(res.tasks) && res.tasks.length) {
      saveDirectTasks(res.tasks);
      renderTaskCardsList(res.tasks);
      $('#tasks-json-input').value = JSON.stringify(res.tasks, null, 2);
      toast(`Loaded ${res.tasks.length} direct task(s) from project`, 'success');
    } else {
      toast('No draft tasks found in project (.converge-tasks.json)', 'info');
    }
  } catch (e) {
    toast(`Failed to load draft tasks: ${e.message}`, 'error');
  }
});

$('#tasks-apply-btn').addEventListener('click', () => {
  let tasks = [];
  if (activeTasksTab === 'json') {
    try {
      const txt = $('#tasks-json-input').value.trim();
      tasks = txt ? JSON.parse(txt) : [];
      if (!Array.isArray(tasks)) throw new Error('Tasks must be an array');
    } catch (e) {
      return toast(`Invalid JSON plan: ${e.message}`, 'error');
    }
  } else {
    tasks = readTasksFromCards();
  }
  saveDirectTasks(tasks);
  toast(tasks.length ? `Applied ${tasks.length} direct task(s)` : 'Direct tasks cleared (using auto model planner)', 'success');
  closePop();
});

showTasksChip();

// ---- "since you looked": what happened while the board was not watched (away 10 minutes or more) ----------------
const seenKey = () => `converge.seen.${settings.project}`;
function loadSeen() { return prefs.getJson(seenKey(), null); }
function markSeen(state, runsList) {
  if (!store.hasSnapshot) return;
  const done = state.tasks.filter((t) => t.changes?.length && state.changes.some((c) => c.task_id === t.task_id && c.state === 'landed')).map((t) => t.task_id);
  const spent = (runsList || []).reduce((s, r) => s + (r.metered === false ? 0 : Number(r.spent) || 0), 0);
  prefs.setJson(seenKey(), { seq: state.version || 0, at: Date.now(), done, spent });
}
let digest = null; // { project, data }, shown until dismissed
function renderDigest(state, mine) {
  if (ui.timeline.snapshot) return;
  if (!digest || digest.project !== settings.project) {
    const seen = loadSeen();
    const away = seen && Date.now() - seen.at > 10 * 60_000;
    digest = { project: settings.project, data: away ? digestSince(state, seen, mine) : null };
    if (!digest.data) markSeen(state, mine);
  }
  const d = digest.data;
  $('#digest').hidden = !d;
  if (!d) return;
  const since = new Date(d.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  mount($('#digest'), h('span', null, h('b', null, `Since ${since}: `), [d.landed && `${d.landed} landed`, d.done && `${d.done} task${d.done === 1 ? '' : 's'} finished`, d.spent ? `$${d.spent.toFixed(2)} spent` : ''].filter(Boolean).join(' · ')),
    h('button', { type: 'button', class: 'link', onclick: () => { digest.data = null; markSeen(store.state, mine); schedule(); } }, 'Got it'));
}
// Leaving the board marks the moment; coming back after a while shows the digest.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && signedIn() && store.hasSnapshot && !digest?.data) markSeen(store.state, runs.project === settings.project ? runs.list : []);
  else if (!document.hidden) { digest = null; schedule(); }
});

// ---- activity: in order, newest at the bottom, pinned there unless you scrolled up to read ------------------
function feedAtBottom() { const f = $('#feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 28; }
/** What needs a person, as Alerts rows (the routine stays in Milestones): work the rules held (escalated tasks,
 *  paused workstreams), claims that collide, and tasks gone quiet. */
function alertExtras(state, runsMine) {
  const out = [];
  for (const r of runsMine.filter((x) => x.phase === 'running')) {
    for (const [w, p] of Object.entries(r.paused || {})) out.push({ key: `x:p:${r.id}:${w}`, at: p.at || Date.now(), tone: 'bad', who: 'rules', text: `workstream ${w} paused: ${p.why}`, onclick: () => $('#attention').scrollIntoView({ behavior: 'smooth', block: 'start' }) });
    for (const [k, e] of Object.entries(r.escalated || {})) {
      const t = state.tasks.find((x) => x.task_id === e.task_id);
      out.push({ key: `x:e:${r.id}:${k}`, at: e.at || Date.now(), tone: 'bad', who: 'rules', agent: e.agent || '', text: `needs you: ${e.why}`, task: t?.title || k, onclick: () => actions.openTask(e.task_id) });
    }
  }
  const files = new Map(); // agents of different tasks on the same lines: one alert per file
  for (const o of overlaps(claimsOf(state)).filter((x) => x.hard && !x.sameTask)) { const f = files.get(o.path) || new Set(); f.add(o.a.agent); f.add(o.b.agent); files.set(o.path, f); }
  for (const [path, ags] of files) out.push({ key: `x:o:${path}`, at: Date.now(), tone: 'warn', agent: [...ags][0], text: `${ags.size} agents editing the same lines in ${path}: ${[...ags].join(', ')}`, change: '' });
  for (const t of state.tasks) {
    const d = describe(state, t);
    if (d.status === 'Quiet') out.push({ key: `x:q:${t.task_id}`, at: d.when || Date.now(), tone: 'warn', agent: d.ch?.agent_id || t.agents.at(-1) || '', text: 'gone quiet', task: t.title, onclick: () => actions.openTask(t.task_id) });
  }
  return out.sort((a, b) => a.at - b.at);
}
function renderActivity(state, keep, extra = []) {
  const feed = $('#feed');
  const wasBottom = !feed.dataset.filled || feedAtBottom();
  // Dragging the tape rolls the activity back to that moment (from the events already here; no fetch).
  const upto = ui.timeline.drag ?? (ui.timeline.snapshot ? ui.timeline.seq : Infinity);
  // While a task or an agent is open in the details, Activity shows only its agents (until "Show everyone").
  const focusKey = ui.fly ? `${ui.task}|${ui.agent}` : '';
  let only = null;
  if (focusKey && ui.feedAllFor !== focusKey) {
    const t = state.tasks.find((x) => x.task_id === ui.task);
    only = new Set(ui.agent ? [ui.agent] : t ? [...t.agents, ...state.changes.filter((c) => c.task_id === t.task_id).map((c) => c.agent_id)] : []);
    only.tasks = new Set(t ? [t.task_id] : []);
  }
  $('#feed-focus').hidden = !only;
  if (only) mountStable($('#feed-focus'), h('span', null, 'Showing only ', h('b', null, ui.agent || state.tasks.find((x) => x.task_id === ui.task)?.title || '')), h('button', { type: 'button', class: 'link', onclick: () => { ui.feedAllFor = focusKey; schedule(); } }, 'Show everyone'));
  let rows = feedRows(state, { upto, channel: ui.channel, only, extra });
  if (keep) rows = rows.filter((r) => !r.agent || keep.has(r.agent));
  // Logs are the drill-down, not the home screen: folded to the newest few rows until opened (or while a task, an
  // agent or a filter is picked, when they are what you asked to see).
  const folded = !only && !keep && !ui.actAll && ui.timeline.drag == null;
  $('#activity').classList.toggle('folded', folded);
  $('#act-toggle').textContent = folded ? `Show all${rows.length > 5 ? ` (${rows.length})` : ''}` : 'Fold';
  $('#act-toggle').hidden = Boolean(only || keep);
  if (folded) rows = rows.slice(-5);
  // The Alerts count: only what needs a person (routine retries are in Milestones, not counted here).
  const alerts = feedRows(state, { upto, channel: 'alerts', max: 999, extra }).length;
  mountStable($('#channels'), CHANNELS.map(([k, label]) => h('button', { type: 'button', 'aria-selected': String(ui.channel === k), onclick: () => { ui.channel = k; prefs.set('converge.channel', k); $('#feed').dataset.filled = ''; placeholder($('#feed'), h('li')); schedule(); } },
    label, k === 'alerts' && alerts ? h('span', { class: 'badge warn' }, String(alerts)) : null)));
  if (!rows.length) placeholder(feed, h('li', { class: 'dim none' }, keep ? 'Nothing from these agents' : 'Nothing yet'));
  else reconcile(feed, feedItems(rows, ui, select, actions.toggleCluster));
  $('#feed-n').textContent = rows.length ? `last ${rows.length}` : '';
  fitSoon();
  const last = rows.length ? rows[rows.length - 1].key : '';
  if (wasBottom || ui.timeline.drag != null) { feed.scrollTop = feed.scrollHeight; requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; }); ui.feedSeen = last; }
  const seenAt = rows.findIndex((r) => r.key === ui.feedSeen);
  const unread = seenAt >= 0 ? rows.length - 1 - seenAt : 0;
  $('#feed-new').hidden = !unread;
  $('#feed-new').textContent = `↓ ${unread} new`;
}
ui.actAll = prefs.get('converge.activity') === 'all';
ui.agentView = prefs.get('converge.agentView') === 'cards' ? 'cards' : 'squares';
ui.ctab = prefs.get('converge.changesTab') || 'all';
for (const b of $$('#changes-tabs [data-ctab]')) b.addEventListener('click', () => { ui.ctab = b.dataset.ctab; prefs.set('converge.changesTab', ui.ctab); schedule(); });
for (const b of $$('#agent-view [data-v]')) b.addEventListener('click', () => { ui.agentView = b.dataset.v; prefs.set('converge.agentView', ui.agentView); schedule(); });
$('#act-toggle').addEventListener('click', () => { ui.actAll = !ui.actAll; prefs.set('converge.activity', ui.actAll ? 'all' : ''); $('#feed').dataset.filled = ''; schedule(); });
$('#feed').addEventListener('scroll', () => { if (feedAtBottom() && !$('#feed-new').hidden) schedule(); else if (feedAtBottom()) { const k = $('#feed').lastElementChild?.dataset.key; if (k) ui.feedSeen = k; } }, { passive: true });
$('#feed-new').addEventListener('click', () => { const f = $('#feed'); f.scrollTo({ top: f.scrollHeight, behavior: 'smooth' }); ui.feedSeen = f.lastElementChild?.dataset.key || ''; schedule(); });
for (const b of $$('[data-tview]')) b.addEventListener('click', () => { ui.tview = b.dataset.tview; schedule(); });
$('#more').addEventListener('toggle', () => schedule());
$('#deck-more').addEventListener('click', () => { ui.kind = 'work'; schedule(); $('#attention').scrollIntoView({ behavior: 'smooth', block: 'start' }); });

// ---- the dock: the newest run (with Stop) above the composer; the whole conversation as a drawer ----------------
function renderDock(mine) {
  // The run the server is planning shows (and opens) as soon as it exists: "Sending…" only until then.
  if (ui.pending && !ui.pending.error && mine[0] && (mine[0].started || 0) >= ui.pending.at - 5000) ui.pending = null;
  const latest = ui.pending ? null : mine[0];
  const n = mine.length + (ui.pending ? 1 : 0);
  $('#dock-run').hidden = !latest && !ui.pending;
  if (latest || ui.pending) {
    const req = ui.pending ? ui.pending.request : latest.request;
    const reqClean = (req || '').trim().replace(/\s+/g, ' ');
    mount($('#dock-run'), h('div', { class: 'dr' },
      h('span', { class: `dr-req${ui.reqOpen ? ' open' : ''}`, title: ui.reqOpen ? 'Click to collapse' : `${req}\n\n(click to expand)`, onclick: () => { ui.reqOpen = !ui.reqOpen; schedule(); } }, ui.reqOpen ? `“${req}”` : `“${reqClean}”`),
      ui.pending
        ? h('div', { class: `runbox ${ui.pending.error ? 'bad' : 'info busy'}` }, h('div', { class: 'run-text' }, h('p', { class: 'phase' }, ui.pending.error ? `Could not start: ${ui.pending.error}` : 'Sending…')), ui.pending.error ? null : h('div', { class: 'bar-busy' }))
        : renderRun(latest, ui.adminKey ? () => actions.stopRun(latest.id) : null, ui.adminKey && ui.local ? () => actions.continueRun(latest.id, Number($('#run-budget').value) || 2) : null, (r) => actions.openRun(r.id), ui.adminKey ? () => actions.startOver(latest) : null),
      n > 1 ? h('button', { type: 'button', class: 'link dr-hist', 'aria-expanded': ui.threadOpen ? 'true' : 'false', onclick: () => { ui.threadOpen = !ui.threadOpen; schedule(); } }, ui.threadOpen ? 'Hide history' : `History (${n})`) : null));
  }
  const thread = ui.threadOpen ? renderThread(mine, ui.pending, null) : null;
  $('#thread').hidden = !thread;
  if (thread) { mount($('#thread'), thread); $('#thread').scrollTop = $('#thread').scrollHeight; }
}
// Activity is as tall as the room between where it starts on screen and the dock, so its newest rows never sit under it.
let fitRaf = 0;
function fitFeed() {
  fitRaf = 0;
  const f = $('#feed');
  if (!f || $('#board').hidden || window.innerWidth < 1100) { if (f) f.style.maxHeight = ''; return; }
  const pinned = f.scrollHeight - f.scrollTop - f.clientHeight < 28;
  const room = window.innerHeight - ($('#dock').hidden ? 0 : $('#dock').offsetHeight) - f.getBoundingClientRect().top - 16;
  f.style.maxHeight = `${Math.max(220, Math.round(room))}px`;
  if (pinned) f.scrollTop = f.scrollHeight;
}
const fitSoon = () => { if (!fitRaf) fitRaf = requestAnimationFrame(fitFeed); };
window.addEventListener('scroll', fitSoon, { passive: true });
window.addEventListener('resize', fitSoon);
// The board leaves room at the bottom for the dock, however tall it gets.
new ResizeObserver(() => { document.documentElement.style.setProperty('--dock-h', `${$('#dock').offsetHeight}px`); fitSoon(); }).observe($('#dock'));

// ---- popovers: the project switcher and GitHub (Esc, Cancel or a click outside closes; the board stays) ---------
function openPop(id) { closePop(); ui.pop = id; $(`#${id}`).hidden = false; $('#pop-back').hidden = false; }
function closePop() { if (!ui.pop) return; $(`#${ui.pop}`).hidden = true; $('#pop-back').hidden = true; ui.pop = ''; }
$('#pop-back').addEventListener('click', closePop);
let swProjects = []; // [{ name, base, info }]
function showSwitcher() {
  const q = $('#sw-q').value.trim().toLowerCase();
  const list = swProjects.filter((p) => !q || p.name.toLowerCase().includes(q));
  const cur = (p) => p.name === settings.project && p.base === (settings.base || '');
  const items = [];
  let group = null;
  for (const p of list) {
    if (swProjects.some((x) => x.base) && p.base !== group) { group = p.base; items.push(h('li', { class: 'sw-g' }, p.base ? 'On Cloudflare' : 'On this computer')); }
    const k = KIND[p.info?.kind] ?? '';
    items.push(h('li', null, h('button', { type: 'button', class: cur(p) ? 'sw-item current' : 'sw-item', onclick: () => { closePop(); if (!cur(p)) open(p.name, p.base); } },
      h('span', { class: 'dot-s' }), h('span', { class: 'sw-n' }, p.name), k ? h('span', { class: `proj-k k-${p.info.kind}` }, k) : null, cur(p) ? h('span', { class: 'dim small' }, 'open now') : null)));
  }
  mount($('#sw-list'), items.length ? items : h('li', { class: 'dim none' }, swProjects.length ? 'No match' : 'Only this project'));
}
$('#sw-q').addEventListener('input', showSwitcher);
$('#sw-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = $('#sw-list button'); if (b) b.click(); } });
$('#sw-cancel').addEventListener('click', closePop);
$('#sw-new').addEventListener('click', () => { closePop(); openNew(); });
$('#sw-all').addEventListener('click', () => { closePop(); ui.picking = true; pjAsked = false; schedule(); });

async function showGitHub(target = $('#gh-body')) {
  const body = target || $('#gh-body');
  mount(body, h('p', { class: 'dim' }, 'Checking GitHub…'));
  let st;
  if (ui.local) return showGitHubLocal(body);
  try { st = await adminApi('/api/github/status'); }
  catch (x) { return mount(body, h('h3', null, 'GitHub'), h('p', { class: 'dim' }, `GitHub: ${x.message || x}`)); }
  let link = null;
  try { link = (await adminApi(`/api/projects/${encodeURIComponent(settings.project)}/github`)).link; } catch { /* not linked */ }
  mount(body,
    h('h3', null, link ? h('a', { href: `https://github.com/${link.repo}`, target: '_blank', rel: 'noopener' }, `github.com/${link.repo} ↗`) : 'Not linked to GitHub'),
    link ? [h('p', { class: 'dim' }, 'Landed work goes back to this repository as a pull request.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => { closePop(); sendPr(); } }, 'Create pull request'))]
      : [h('p', { class: 'dim' }, st.setup ? 'This project wasn\'t imported from GitHub. To use GitHub, import a repository as a new project.'
          : 'GitHub isn\'t set up yet. One click on GitHub sets it up.'),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => { closePop(); openNew('github'); } }, st.setup ? 'Import a repository' : 'Set up GitHub'))]);
}
$('#back-board').addEventListener('click', () => { ui.picking = false; schedule(); });
$('#btn-github').addEventListener('click', () => {
  $('#in-project').value = settings.project;
  $('#in-view').value = settings.viewKey;
  $('#in-reviewer').value = settings.reviewerKey;
  const admin = $('#in-admin');
  if (admin) admin.value = settings.adminKey || '';
  $('#in-remember').checked = settings.remember;
  const keysTabBtn = $('#keys-dialog [data-tab="k-converge"]');
  if (keysTabBtn) keysTabBtn.hidden = Boolean(ui.platformLocal);   // as in Settings: no shared keys locally
  keysTab('k-github');
  dlg.showModal();
});

// The local platform's GitHub: your own GitHub App (one click creates it), installed on the repositories you choose on
// GitHub's screen; a project links to one of them and sends what landed back as a pull request. No URL, no token.
async function showGitHubLocal(body) {
  const P = `/api/projects/${encodeURIComponent(settings.project)}`;
  const status = h('p', { class: 'small dim', role: 'status' });
  const fail = (x) => { status.className = 'small bad'; status.textContent = String(x.message || x); };
  const other = h('button', { type: 'button', class: 'link small', onclick: () => showRemote(body, true) }, 'Not on GitHub? Use another git server');
  let st, link;
  let wb = null;
  try { [st, link] = await Promise.all([adminApi('/api/github/status'), adminApi(`${P}/github`).then((j) => { wb = j.write_back; return j.link; })]); } catch (x) { return mount(body, h('p', { class: 'bad' }, String(x.message || x))); }
  if (link) {
    const pr = h('button', { type: 'button', class: 'primary' }, 'Open pull request');
    pr.addEventListener('click', async () => {
      pr.disabled = true; pr.textContent = 'Opening…';
      try { const j = await adminApi(`${P}/github/pr`, { method: 'POST' }); status.className = 'small good'; status.replaceChildren('Pull request ', h('a', { href: safeUrl(j.pr.url), target: '_blank', rel: 'noopener' }, `#${j.pr.number}`), ` from ${j.branch}`); }
      catch (x) { fail(x); } finally { pr.disabled = false; pr.textContent = 'Open pull request'; }
    });
    return mount(body, h('h3', null, h('a', { href: `https://github.com/${link.repo}`, target: '_blank', rel: 'noopener' }, `${link.repo} ↗`)),
      h('p', { class: 'dim' }, link.write_back ? `Converge is the source: each landing is pushed to ${link.base || 'main'} (never forced).` : `Landed work goes back to ${link.base || 'main'} as a pull request.`),
      // Converge as the source: main pushed to the repository's branch after each landing. Never forced: a branch with
      // commits converge does not have is left alone, and that is said here.
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: Boolean(link.write_back), onchange: async (e) => {
        try { await adminApi(`${P}/github/write-back`, { method: 'POST', body: JSON.stringify({ on: e.target.checked }) }); } catch (x) { toast(`Write-back: ${x.message || x}`, 'error'); }
        showGitHubLocal(body);
      } }), `Push each landing to ${link.base || 'main'}`),
      wb?.state === 'failed' ? h('p', { class: 'small bad' }, `Last push failed: ${wb.error}`) : wb?.state === 'done' ? h('p', { class: 'small dim' }, `${link.base || 'main'} is at ${String(wb.head).slice(0, 8)}`) : null,
      h('div', { class: 'row' }, pr, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'link', onclick: async () => { await adminApi(`${P}/github/link`, { method: 'POST', body: JSON.stringify({ unlink: true }) }); updateGitButton(); showGitHubLocal(body); } }, 'Unlink')), status);
  }
  if (!st.setup) {
    const go = h('button', { type: 'button', class: 'primary' }, 'Set up GitHub');
    go.addEventListener('click', () => $('#gh-setup').click());
    return mount(body, h('h3', null, 'Connect GitHub'),
      h('p', { class: 'dim' }, 'Creates a private GitHub App on your account. You pick which repositories it can use. It can only read and write code and open pull requests.'),
      h('div', { class: 'row' }, go), other, status);
  }
  mount(body, h('h3', null, 'Link a repository'), h('p', { class: 'dim' }, 'Loading your repositories…'));
  let repos = [];
  try { repos = (await adminApi('/api/github/repos')).repos || []; } catch (x) { return mount(body, h('h3', null, 'Link a repository'), h('p', { class: 'bad' }, String(x.message || x)), other); }
  // Same tab: GitHub comes back here and the repositories picked there are brought in (ghFinish).
  const choose = h('a', { href: safeUrl(st.install_url), onclick: () => ghRemember(repos) },repos.length ? 'Choose more repositories on GitHub' : 'Choose repositories on GitHub');
  const refresh = h('button', { type: 'button', class: 'link', onclick: () => showGitHubLocal(body) }, 'Refresh');
  const q = h('input', { type: 'search', placeholder: 'Find a repository', autocomplete: 'off', spellcheck: 'false', hidden: repos.length < 8 });
  const list = h('ol', { class: 'sw-list' });
  const draw = () => mount(list, repos.filter((x) => !q.value || x.full_name.toLowerCase().includes(q.value.toLowerCase())).slice(0, 60).map((x) => h('li', null,
    h('button', { type: 'button', class: 'sw-item', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { await adminApi(`${P}/github/link`, { method: 'POST', body: JSON.stringify({ repo: x.full_name, installation_id: x.installation_id }) }); toast(`Linked to ${x.full_name}`, 'success'); updateGitButton(); showGitHubLocal(body); }
      catch (y) { fail(y); b.disabled = false; }
    } }, h('span', { class: 'dot-s' }), h('span', { class: 'mono' }, x.full_name), x.private ? h('span', { class: 'dim small' }, 'private') : null, h('span', { class: 'small link-word' }, 'Link')))));
  q.addEventListener('input', draw);
  draw();
  mount(body, h('h3', null, 'Link a repository'),
    repos.length ? [q, list] : h('p', { class: 'dim' }, 'No repositories yet. Choose some on GitHub, then refresh.'),
    h('div', { class: 'row' }, choose, h('span', { class: 'grow' }), refresh), other, status);
}

// The local platform: link the project to any git server (a token for private https; ssh uses your keys), then push
// what landed to a branch, or open a GitHub pull request.
async function showRemote(body, editing = false) {
  const base = `/api/projects/${encodeURIComponent(settings.project)}/remote`;
  let r = null;
  try { r = (await adminApi(base)).remote; } catch (x) { return mount(body, h('p', { class: 'bad' }, String(x.message || x))); }
  const status = h('p', { class: 'small dim', role: 'status' });
  const busy = async (btn, label, fn) => { btn.disabled = true; const was = btn.textContent; btn.textContent = label; try { await fn(); } catch (x) { status.className = 'small bad'; status.textContent = String(x.message || x); } finally { btn.disabled = false; btn.textContent = was; } };
  if (!r || editing) {
    const url = h('input', { type: 'text', spellcheck: 'false', placeholder: 'https://github.com/you/repo.git  or  git@gitlab.com:you/repo.git', value: r?.url || '' });
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: r?.has_token ? 'Keep saved token' : 'Token (for private repos and pull requests)' });
    const go = h('button', { type: 'button', class: 'primary' }, 'Link');
    go.addEventListener('click', () => busy(go, 'Checking…', async () => {
      await adminApi(base, { method: 'POST', body: JSON.stringify({ url: url.value.trim(), ...(token.value.trim() ? { token: token.value.trim() } : {}) }) });
      toast('Linked', 'success'); updateGitButton(); showRemote(body);
    }));
    return mount(body, h('h3', null, r ? 'Change the link' : 'Link a git server'),
      h('p', { class: 'dim' }, 'GitHub, GitLab, Bitbucket or any git server. Landed work can be pushed to a branch or opened as a GitHub pull request.'),
      h('label', { class: 'field' }, 'Repository URL', url), h('label', { class: 'field' }, 'Access token', token),
      h('div', { class: 'row' }, go, r ? h('button', { type: 'button', class: 'link', onclick: () => showRemote(body) }, 'Cancel') : null), status);
  }
  const web = r.url.replace(/^git@([\w.-]+):/, 'https://$1/').replace(/\.git$/, '');
  const pr = h('button', { type: 'button', class: 'primary' }, 'Open pull request');
  const push = h('button', { type: 'button' }, 'Push to a new branch');
  const done = (j) => { status.className = 'small good'; status.replaceChildren(j.pr ? ['Pull request ', h('a', { href: safeUrl(j.pr.url), target: '_blank', rel: 'noopener' }, `#${j.pr.number}`), ` from ${j.branch}`] : `Pushed to ${j.branch}`); };
  pr.addEventListener('click', () => busy(pr, 'Opening…', async () => done(await adminApi(`${base}/push`, { method: 'POST', body: JSON.stringify({ pr: true, title: `converge: ${settings.project}` }) }))));
  push.addEventListener('click', () => busy(push, 'Pushing…', async () => done(await adminApi(`${base}/push`, { method: 'POST', body: JSON.stringify({}) }))));
  mount(body, h('h3', null, safeUrl(web) ? h('a', { href: safeUrl(web), target: '_blank', rel: 'noopener' }, web.replace(/^https?:\/\//, ''), ' ↗') : h('span', { class: 'mono' }, web)),
    h('p', { class: 'dim' }, `Pushes main to a new branch${r.github && r.has_token ? ' and opens a GitHub pull request' : ''}.`),
    h('div', { class: 'row' }, r.github && r.has_token ? pr : null, push, h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'link', onclick: () => showRemote(body, true) }, 'Change'),
      h('button', { type: 'button', class: 'link', onclick: async () => { await adminApi(base, { method: 'POST', body: JSON.stringify({ unlink: true }) }); updateGitButton(); showRemote(body); } }, 'Unlink')),
    status);
}
// The header button says what the project is linked to (or offers to link it).
let gitLinked = false; // the local project is linked to GitHub or another git server (else the button stays hidden)
async function updateGitButton() {
  const b = $('#btn-github');
  if (!ui.local) { b.textContent = 'GitHub'; return; }
  gitLinked = false;
  const project = settings.project;
  try {
    const P = `/api/projects/${encodeURIComponent(project)}`;
    const g = await adminApi(`${P}/github`);
    const link = g.link;
    const r = link ? null : (await adminApi(`${P}/remote`)).remote;
    if (project !== settings.project) return;   // another project was opened while this one's answer came back
    // Said the way the folder button says it: ↩ when each landing goes back, and whether the last push went through.
    const wb = g.write_back;
    const state = !link?.write_back ? '' : wb?.state === 'failed' ? ' · failed' : wb?.state === 'syncing' ? ' · pushing' : wb?.head && wb.head === g.main_head ? '' : ' · not pushed';
    b.textContent = link ? `${link.write_back ? '↩ ' : ''}${link.repo}${state}` : r ? r.url.replace(/^.*[/:]([\w.-]+\/[\w.-]+?)(\.git)?$/, '$1') : '+ Link GitHub';
    b.classList.toggle('warn', wb?.state === 'failed');
    b.title = wb?.state === 'failed' ? `Last push failed: ${wb.error}` : '';
    gitLinked = Boolean(link || r);
  }
  catch { if (project !== settings.project) return; b.textContent = 'GitHub'; }
  b.hidden = !ui.adminKey || present || !gitLinked || !$('#signin').hidden;
}
$('#gh-close').addEventListener('click', closePop);

// ---- a folder project: its results go back into the folder(s) it came from (after every landing), shown here ----
let folderInfo = null;
async function loadFolder() {
  folderInfo = null;
  $('#btn-folder').hidden = true;
  if (!ui.adminKey || !ui.local) return;
  const project = settings.project;
  try {
    const f = await adminApi(`/api/projects/${encodeURIComponent(project)}/folder`);
    if (!f.folder || project !== settings.project) return;
    folderInfo = f;
    const home = (p) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
    const behind = f.write_back && f.synced !== f.head;
    $('#btn-folder').hidden = false;
    $('#btn-folder').textContent = `${f.write_back ? '↩' : '⏸'} ${home(f.paths[0])}${f.paths.length > 1 ? ` +${f.paths.length - 1}` : ''}${f.sync?.state === 'failed' ? ' · failed' : behind ? ' · not synced' : ''}`;
    $('#btn-folder').classList.toggle('warn', f.sync?.state === 'failed' || Boolean(f.sync?.report?.some((r) => r.beside.length)));
    renderFolderNote(f, home(f.paths[0]));
    if (!$('#folderpop').hidden) showFolder();
  } catch { /* not a folder project */ }
}
/** Landed work that is not being written to the project's folder: said at the top, with the one click that fixes it. */
function renderFolderNote(f, where) {
  const note = $('#folder-note');
  const stranded = !f.write_back && f.head && f.synced && f.head !== f.synced;
  note.hidden = !stranded;
  if (!stranded) { mount(note, null); return; }
  mount(note, [
    h('span', { class: 'grow' }, h('b', null, 'Your results aren\'t in ' + where + ' yet. '), 'They landed on main, but folder sync is off.'),
    h('button', { type: 'button', class: 'primary', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        const base = `/api/projects/${encodeURIComponent(settings.project)}/folder`;
        await adminApi(base, { method: 'POST', body: JSON.stringify({ write_back: true }) });
        const r = await adminApi(`${base}/sync`, { method: 'POST' });
        toast(`Wrote ${(r.report || []).reduce((n, x) => n + x.written, 0)} file(s) to ${where}`, 'success');
      } catch (x) { toast(`Could not write to the folder: ${x.message || x}`, 'error'); }
      loadFolder();
    } }, 'Sync to ' + where)]);
}
function renderScopeNote(state, mine) {
  const n = $('#scope-note');
  const sc = state.scope;
  n.hidden = !(sc || (ui.allRuns && mine.filter((r) => Object.keys(r.keys || {}).length).length >= 2));
  if (n.hidden) { mount(n, null); return; }
  const toggle = (label) => h('button', { type: 'button', class: 'link small', onclick: () => {
    ui.allRuns = !ui.allRuns;
    prefs.set('converge.allRuns', ui.allRuns ? '1' : '0');
    schedule();
  } }, label);
  mount(n, sc
    ? [h('span', { class: 'grow dim small' },
        `${sc.tasks} task${sc.tasks === 1 ? '' : 's'} from ${sc.runs} earlier run${sc.runs === 1 ? '' : 's'} hidden`), toggle('Show all tasks')]
    : [h('span', { class: 'grow dim small' }, 'Showing all tasks'), toggle('Latest run only')]);
}
function showFolder() {
  const f = folderInfo;
  if (!f) return;
  const home = (p) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
  const rep = f.sync?.report || [];
  const beside = rep.flatMap((r) => r.beside.map((b) => `${home(r.path)}/${b}`));
  mount($('#folder-body'),
    h('h3', null, 'Folder sync'),
    h('ul', { class: 'fd-paths' }, f.paths.map((p) => h('li', { class: 'mono' }, home(p)))),
    h('p', { class: 'small dim' }, f.write_back ? 'After each landing, changes on main are written here. A git folder gets them on the "converge" branch. Files you edited are never overwritten: the new version is saved as <file>.converge.' : 'Sync is off.'),
    h('p', { class: 'small' }, f.sync?.state === 'failed' ? h('span', { class: 'bad' }, `Last sync failed: ${f.sync.error}`)
      : f.synced === f.head ? h('span', { class: 'good' }, `Up to date${f.synced_at ? ` · synced ${timeAgo(new Date(f.synced_at).getTime())}` : ''}`)
      : h('span', { class: 'warn' }, 'The folder is behind main.'),
      rep.length ? h('span', { class: 'dim' }, ` · last time: ${rep.reduce((n, r) => n + r.written, 0)} file(s) written${rep.some((r) => r.git) ? ', branch converge updated' : ''}`) : null),
    beside.length ? h('div', { class: 'small' }, h('b', { class: 'warn' }, `Saved next to your edits (${beside.length}):`), h('ul', { class: 'fd-paths' }, beside.slice(0, 20).map((b) => h('li', { class: 'mono' }, `${b}.converge`)))) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', disabled: !f.write_back, onclick: async (e) => { e.currentTarget.disabled = true; try { await adminApi(`/api/projects/${encodeURIComponent(settings.project)}/folder/sync`, { method: 'POST' }); toast('Folder synced', 'success'); } catch (x) { toast(`Sync failed: ${x.message || x}`, 'error'); } loadFolder(); } }, 'Sync now'),
      // The other way: the folder's files into main, keeping the project's tasks and their checks (between runs).
      h('button', { type: 'button', title: 'Bring main up to the folder as it is now (your edits made outside converge). Tasks and their checks are kept.', onclick: async (e) => { e.currentTarget.disabled = true; try { const j = await adminApi(`/api/projects/${encodeURIComponent(settings.project)}/folder/refresh`, { method: 'POST' }); toast(j.changed ? 'Main refreshed from the folder' : 'Main already matches the folder', 'success'); } catch (x) { toast(`Refresh failed: ${x.message || x}`, 'error'); } loadFolder(); } }, 'Refresh from folder'),
      h('span', { class: 'grow' }),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: f.write_back, onchange: async (e) => { await adminApi(`/api/projects/${encodeURIComponent(settings.project)}/folder`, { method: 'POST', body: JSON.stringify({ write_back: e.target.checked }) }); loadFolder(); } }), 'Sync to folder')));
}
$('#btn-folder').addEventListener('click', () => { openPop('folderpop'); showFolder(); loadFolder(); });
$('#folder-close').addEventListener('click', closePop);

// ---- sign in ----
// One key: the admin key lists the projects and opens any of them; a view key opens one project.
// null: the key is not the admin key (401/403); any other failure throws, so it is not mistaken for that.
async function listProjects(key) {
  try {
    const j = await api('/api/projects', { auth: key === SESSION_ADMIN ? sessionHeader() : { 'X-Admin-Key': key } });
    projectInfo = j.info || projectInfo;
    return j.projects || [];
  } catch (e) {
    if (e.status === 401 || e.status === 403) return null;
    throw e;
  }
}

// Where the open project lives decides what is offered: the local platform's own routes (runs, logs, folders, keys,
// models, Cloudflare) are only there when this dashboard is the local platform and the project is on it.
function setPlace() {
  ui.local = ui.platformLocal && !settings.base;
  for (const el of $$('[data-local]')) el.hidden = !ui.local;
  for (const el of $$('[data-cloud]')) el.hidden = ui.local;
  $('#run-rules').hidden = !ui.local;
}

function open(project, base = settings.base || '') {
  const changed = project !== settings.project || base !== (settings.base || '');
  settings.project = project;
  settings.base = base;
  setPlace();
  saveSettings(settings);
  // The address names the open project, so a reload (or the link) opens this one: a ?project= left from before won over
  // the one picked, and the dashboard went back to it.
  const q = new URLSearchParams(location.search);
  if (q.has('project') || project) {
    if (project && !base) q.set('project', project); else q.delete('project');
    const qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  }
  ui.picking = false;
  ui.missing = '';
  ui.status = { mode: 'connecting', text: 'connecting' };
  $('#si-error').textContent = '';
  // What the header says about the project (its GitHub repository, pull request, folder) belongs to the one that was
  // open: cleared at once, so the new project never shows the last one's while its own loads.
  if (changed) { store.reset(); ui.agent = ''; liveLogs.clear(); timelineLive(); gitLinked = false; folderInfo = null; for (const id of ['#btn-github', '#btn-pr', '#btn-folder']) $(id).hidden = true; }
  connection.restart();
  pollRuns();
  loadRunOptions();
  showTasksChip();
  setTimeout(updateGitButton, 300);
  setTimeout(loadFolder, 400);
  schedule();
}

// ---- a new project (admin): empty, a copy of a demo, or an import ----
// Which ways to start a project fit this platform: a folder only locally, the demo templates only on Cloudflare.
// A newer dashboard on the server (its files changed): say so, and reload on a click (never mid-typing on its own).
let uiSeen = '';
setInterval(() => {
  if (document.hidden) return;
  rawFetch('/health').then((r) => r.json()).then((j) => {
    if (!j.ui) return;
    if (!uiSeen) { uiSeen = j.ui; return; }
    if (j.ui !== uiSeen && !$('#ui-update')) {
      const b = h('button', { type: 'button', id: 'ui-update', class: 'ui-update', onclick: () => location.reload() }, 'Update available · Reload');
      document.body.append(b);
    }
  }).catch(() => {});
}, 20_000);
// Which platform serves this page decides the local-only routes; they wait for the answer (see the end of this file).
const platform = rawFetch('/health').then((r) => r.json()).then((j) => { uiSeen = j.ui || ''; ui.platformLocal = Boolean(j.local); setPlace(); })
  .catch((e) => { setPlace(); toast(`Could not reach the server (${e.message || e}). Some features are hidden.`, 'error'); });
const newDlg = $('#new-dialog');
let npSrc = '';
let npWhere = '';
function pickWhere(w) {
  npWhere = w;
  const local = ui.platformLocal && !w;
  for (const b of $$('#np-where [data-where]')) b.setAttribute('aria-pressed', String(b.dataset.where === w));
  for (const el of $$('#new-dialog [data-local]')) el.hidden = !local;
  for (const el of $$('#new-dialog [data-cloud]')) el.hidden = local;
  $('#np-token-row').hidden = !local; // the Worker clones public URLs (GitHub through its own app)
  showTemplates(local ? null : w);
}
// The Worker's templates (its SANDBOX_TEMPLATES: none unless the deploy names some), one tab each, asked once per place.
const templateLists = {};
async function showTemplates(base) {
  for (const b of $$('#np-from [data-template]')) b.remove();
  if (base === null) return;
  if (!templateLists[base]) templateLists[base] = adminApi(`${base}/api/templates`, { raw: true }).then((j) => (Array.isArray(j.templates) ? j.templates : [])).catch(() => []);
  const names = await templateLists[base];
  if (npWhere !== base || $('#np-from [data-template]')) return;   // moved on while asking, or already shown
  $('#np-from').append(...names.map((n) => h('button', { type: 'button', role: 'tab', 'data-src': n, 'data-template': '', 'aria-selected': String(npSrc === n) }, h('b', {}, n), h('span', {}, 'template'))));
}
$('#np-where').addEventListener('click', (e) => { const b = e.target.closest('[data-where]'); if (b) { pickWhere(b.dataset.where); pickSrc(''); } });
function openNew(src = '') {
  $('#np-error').textContent = '';
  if (!newDlg.open) newDlg.showModal();
  $('#np-where').hidden = !(ui.platformLocal && cloudProjects && !cloudProjects.error);
  pickWhere(src ? '' : ui.platformLocal ? (settings.base || '') : '');
  if (!cloudProjects && ui.platformLocal) refreshProjects().then(() => { $('#np-where').hidden = !(cloudProjects && !cloudProjects.error); });
  pickSrc(src);
  requestAnimationFrame(() => (src === 'github' ? $('#gh-filter') : $('#np-name')).focus());
}
function pickSrc(src) {
  npSrc = src;
  for (const b of $$('#np-from [data-src]')) b.setAttribute('aria-selected', String(b.dataset.src === src));
  for (const p of $$('#new-form .np-panel')) p.hidden = p.dataset.for !== src;
  $('#np-foot').hidden = src === 'github'; // a GitHub repository is created from its row
  $('#np-error').textContent = '';
  if (src === 'github') loadGitHub();
  if (src === 'folders' && !fp.loaded) fpLoad('');
}
$('#np-from').addEventListener('click', (e) => { const b = e.target.closest('[data-src]'); if (b) pickSrc(b.dataset.src); });
$('#pj-new').addEventListener('click', () => { closePop(); openNew(); });
for (const b of $$('#new-dialog [data-close]')) b.addEventListener('click', () => newDlg.close());

// ---- the folder browser (like a file picker's): type a path or click down, add as many folders as you like ----
const fp = { loaded: false, here: '', parent: '', picked: [], recents: [] };
fp.recents = [].concat(prefs.getJson('converge.folders', [])).filter((x) => typeof x === 'string').slice(0, 8);
const short = (p) => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || p;   // a path of any OS: / or \
async function fpLoad(at) {
  fp.loaded = true;
  mount($('#fp-list'), h('li', { class: 'dim' }, 'loading…'));
  try {
    if (!ui.platformLocal) throw new Error('Folders only work when converge runs on this computer');
    const j = await adminApi(`/api/folders?path=${encodeURIComponent(at)}`);
    Object.assign(fp, { here: j.path, parent: j.parent, home: j.home, git: j.git });
    $('#fp-path').value = j.home && j.path.startsWith(j.home) ? `~${j.path.slice(j.home.length)}` || '~' : j.path;
    fpShow(j.dirs);
  } catch (x) { mount($('#fp-list'), h('li', { class: 'bad' }, String(x.message || x))); }
}
function fpShow(dirs) {
  const added = new Set(fp.picked);
  const join = (n) => `${fp.here}/${n}`;
  mount($('#fp-list'), [
    h('li', null, h('button', { type: 'button', class: 'fp-row up', disabled: !fp.parent, onclick: () => fpLoad(fp.parent) }, '↑ Up one level')),
    ...(dirs.length ? dirs.map((d) => h('li', { class: 'fp-item' },
      h('button', { type: 'button', class: 'fp-row', onclick: () => fpLoad(join(d.name)) }, h('span', { class: 'fp-ic' }, '▸'), h('span', { class: 'fp-n' }, d.name), d.git ? h('span', { class: 'fp-git' }, 'git') : null),
      h('button', { type: 'button', class: added.has(join(d.name)) ? 'fp-add on' : 'fp-add', onclick: () => fpToggle(join(d.name)) }, added.has(join(d.name)) ? '✓ Added' : 'Add'))) : [h('li', { class: 'dim fp-none' }, 'no subfolders')]),
  ]);
  $('#fp-here').textContent = fp.here + (fp.git ? '  · git' : '');
  const b = $('#fp-add-here');
  b.textContent = added.has(fp.here) ? '✓ Added' : 'Add this folder';
  b.classList.toggle('on', added.has(fp.here));
  fpPicked();
  fp.dirs = dirs;
}
function fpToggle(p) {
  fp.picked = fp.picked.includes(p) ? fp.picked.filter((x) => x !== p) : [...fp.picked, p];
  if (fp.picked.length === 1 && !$('#np-name').value.trim()) $('#np-name').value = p.split(/[\\/]/).filter(Boolean).pop().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  fpShow(fp.dirs || []);
}
function fpPicked() {
  const recents = fp.recents.filter((p) => !fp.picked.includes(p));
  mount($('#fp-picked'), fp.picked.length
    ? [h('span', { class: 'fp-lbl' }, fp.picked.length === 1 ? 'Folder' : `${fp.picked.length} folders`), ...fp.picked.map((p) => h('span', { class: 'fp-chip', title: p }, short(p), h('button', { type: 'button', 'aria-label': `remove ${p}`, onclick: () => fpToggle(p) }, '✕')))]
    : h('span', { class: 'dim small' }, 'No folder chosen. Browse below and click Add.'));
  mount($('#fp-recents'), recents.length ? [h('span', { class: 'dim small' }, 'Recent'), ...recents.map((p) => h('button', { type: 'button', class: 'chip', title: p, onclick: () => fpToggle(p) }, `+ ${short(p)}`))] : null);
}
$('#fp-add-here').addEventListener('click', () => fp.here && fpToggle(fp.here));
$('#fp-go').addEventListener('click', () => fpLoad($('#fp-path').value.trim()));
$('#fp-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fpLoad($('#fp-path').value.trim()); } });

$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#np-name').value.trim();
  const from = npSrc;
  const err = $('#np-error');
  err.textContent = '';
  if (!PROJECT_RE.test(name)) return (err.textContent = 'Names can use letters, digits, . and -');
  const url = $('#np-url').value.trim();
  const token = $('#np-token').value.trim();
  if (from === 'import' && !url) return (err.textContent = 'Enter the repository URL');
  if (from === 'folders' && !fp.picked.length) return (err.textContent = 'Add at least one folder');
  const local = ui.platformLocal ? !npWhere : ui.local;
  const body = { name, ...(from === 'import' ? (local ? { source: { kind: 'git', url, ...(token ? { token } : {}) } } : { import_url: url })
    : from === 'folders' ? { source: { kind: 'folders', paths: fp.picked } } : from ? { template: from } : {}) };
  $('#np-go').disabled = true;
  $('#np-go').textContent = from === 'import' ? 'Cloning…' : from === 'folders' ? `Reading ${fp.picked.length === 1 ? 'the folder' : `${fp.picked.length} folders`}…` : 'Creating…';
  try {
    await adminApi(`${local ? '' : npWhere}/api/projects`, { raw: true, method: 'POST', body: JSON.stringify(body) });
    if (from === 'folders') { fp.recents = [...fp.picked, ...fp.recents.filter((p) => !fp.picked.includes(p))].slice(0, 8); prefs.setJson('converge.folders', fp.recents); fp.picked = []; }
    $('#np-name').value = ''; $('#np-token').value = '';
    newDlg.close();
    toast(`Created ${name}${local ? '' : ' on Cloudflare'}`, 'success');
    pjAsked = false;
    open(name, local ? '' : npWhere);
    requestAnimationFrame(() => $('#run-req').focus());
  } catch (x) {
    err.textContent = String(x.message || x);
  } finally { $('#np-go').disabled = false; $('#np-go').textContent = 'Create'; }
});

// ---- GitHub (admin): set the app up once, connect accounts, bring a repository in, send results back as a PR ----
let ghRepos = [];
async function loadGitHub() {
  if (!ui.adminKey) return;
  try {
    const st = await adminApi('/api/github/status');
    $('#gh-setup').hidden = st.setup;
    $('#gh-connect').hidden = !st.setup;
    $('#gh-refresh').hidden = !st.setup;
    if (!st.setup) {
      $('#gh-note').textContent = 'One click creates a GitHub App on your account. Then pick which repositories converge can see.';
      return;
    }
    $('#gh-connect').href = safeUrl(st.install_url) || '#';
    $('#gh-note').textContent = 'Connect GitHub and choose repositories. Each becomes a project, and landed work goes back as a pull request.';
    const r = await adminApi('/api/github/repos');
    ghRepos = r.repos || [];
    $('#gh-filter').hidden = ghRepos.length < 8;
    showRepos();
  } catch (x) { $('#gh-note').textContent = `GitHub: ${x.message || x}`; }
}
function showRepos() {
  const q = $('#gh-filter').value.trim().toLowerCase();
  const list = ghRepos.filter((x) => !q || x.full_name.toLowerCase().includes(q)).slice(0, 50);
  mount($('#gh-repos'), list.length ? list.map((x) => h('li', null,
    h('span', { class: 'mono' }, x.full_name), x.private ? h('span', { class: 'dim small' }, ' private') : null,
    h('button', { type: 'button', onclick: (e) => importRepo(x, e.target) }, 'Import'))) : h('li', { class: 'dim' }, ghRepos.length ? 'No match' : 'No repositories yet. Connect GitHub, pick some, then refresh.'));
}
async function importRepo(x, btn) {
  btn.disabled = true; btn.textContent = 'Importing…';
  try {
    const r = await adminApi('/api/github/import', { method: 'POST', body: JSON.stringify({ installation_id: x.installation_id, repo: x.full_name }) });
    toast(`Imported ${x.full_name} as ${r.project}`, 'success');
    newDlg.close();
    open(r.project);
    requestAnimationFrame(() => $('#run-req').focus());
  } catch (err) { toast(`Could not import ${x.full_name}: ${err.message || err}`, 'error'); btn.disabled = false; btn.textContent = 'Import'; }
}
// Off to GitHub to pick repositories: note the ones converge has now, so the ones added there are brought in on return.
function ghRemember(list) { try { sessionStorage.setItem('converge.gh.before', JSON.stringify(list.map((x) => x.full_name))); } catch { /* storage off: all of them come back */ } }
$('#gh-connect').addEventListener('click', () => ghRemember(ghRepos));
$('#gh-filter').addEventListener('input', showRepos);
$('#gh-refresh').addEventListener('click', loadGitHub);
$('#gh-setup').addEventListener('click', async () => {
  try {
    const r = await adminApi('/api/github/setup', { method: 'POST' });
    // GitHub's manifest flow: a form posted to GitHub, which creates the app and comes back with its keys.
    if (!safeUrl(r.action)) throw new Error('no setup link received');
    const f = h('form', { method: 'post', action: safeUrl(r.action) }, h('input', { type: 'hidden', name: 'manifest', value: JSON.stringify(r.manifest) }));
    document.body.append(f);
    f.submit();
  } catch (x) { toast(`GitHub setup failed: ${x.message || x}`, 'error'); }
});
// Pull request: one button in the header, beside the repository the project came from (shown when it is linked).
// After one is opened it links to it, until the project changes.
let ghLinkFor = '';
async function loadProjectLink() {
  if (!ui.adminKey || ghLinkFor === settings.project) return;
  ghLinkFor = settings.project;
  const b = $('#btn-pr');
  b.hidden = true; b.textContent = 'Pull request'; delete b.dataset.url;
  try { const r = await adminApi(`/api/projects/${encodeURIComponent(settings.project)}/github`); if (r.link && ghLinkFor === settings.project) { b.hidden = false; b.title = `Open a pull request on ${r.link.repo} with landed work`; } } catch { /* not linked */ }
}
async function sendPr() {
  const b = $('#btn-pr');
  if (b.dataset.url) return window.open(b.dataset.url, '_blank', 'noopener');
  b.disabled = true; b.textContent = 'Opening…';
  try {
    const r = await adminApi(`/api/projects/${encodeURIComponent(settings.project)}/github/pr`, { method: 'POST' });
    b.dataset.url = safeUrl(r.pr.url); b.textContent = `PR #${r.pr.number} ↗`;
    toast(`Pull request #${r.pr.number} opened from ${r.branch}`, 'success');
  } catch (x) { b.textContent = 'Pull request'; toast(String(x.message || x), 'error'); }
  finally { b.disabled = false; }
}
$('#btn-pr').addEventListener('click', sendPr);
{
  // Back from GitHub: say what happened, and show the picker with the GitHub card.
  const g = new URLSearchParams(location.search).get('github');
  if (g) {
    const why = new URLSearchParams(location.search).get('why');
    const installation = Number(new URLSearchParams(location.search).get('installation_id')) || 0;
    history.replaceState(null, '', location.pathname);
    if (g === 'installed' || g === 'created') ghFinish(installation);
    else setTimeout(() => toast(g === 'expired' ? 'GitHub link expired. Try again.' : `GitHub: ${why || g}`, 'error'), 300);
  }
}
// Back from installing the GitHub App: the repositories just picked on GitHub's screen come in as projects, without
// picking them again here. A few are brought in at once (one already in opens); "all repositories" (many) opens the
// list to choose from instead.
async function ghFinish(installation) {
  for (let i = 0; i < 100 && !ui.adminKey; i++) await new Promise((ok) => setTimeout(ok, 300));   // signed in first
  if (!ui.adminKey) return toast('GitHub connected. Sign in, then import a repository from New project.', 'info');
  let repos = [];
  try { repos = ((await adminApi('/api/github/repos')).repos || []).filter((x) => !installation || x.installation_id === installation); }
  catch (x) { return toast(`GitHub: ${x.message || x}`, 'error'); }
  // GitHub does not say which repositories were just added: the ones that were not there when we went to GitHub are.
  let before = null;
  try { before = JSON.parse(sessionStorage.getItem('converge.gh.before') || 'null'); sessionStorage.removeItem('converge.gh.before'); } catch { /* none */ }
  if (Array.isArray(before)) repos = repos.filter((x) => !before.includes(x.full_name));
  if (!repos.length) { toast(Array.isArray(before) ? 'No new repositories added' : 'GitHub connected, but no repositories shared yet', 'info'); return openNew('github'); }
  if (repos.length > 5) { toast(`GitHub connected. Pick which of the ${repos.length} repositories to import.`, 'success'); return openNew('github'); }
  let last = '';
  for (const x of repos) {
    toast(`Importing ${x.full_name}…`, 'info');
    try {
      const r = await adminApi('/api/github/import', { method: 'POST', body: JSON.stringify({ installation_id: x.installation_id, repo: x.full_name }) });
      last = r.project;
      toast(r.existing ? `${x.full_name} is already project ${r.project}` : `Imported ${x.full_name} as ${r.project}`, 'success');
    } catch (err) { toast(`Could not import ${x.full_name}: ${err.message || err}`, 'error'); }
  }
  if (last) { pjAsked = false; open(last); requestAnimationFrame(() => $('#run-req')?.focus()); }
}

// The projects page: this computer's projects and, when a Worker is connected (Keys → Cloudflare), the Worker's,
// each with what it is; open, filter, delete.
let allProjects = [];
let projectInfo = {};
let cloudProjects = null; // null: not asked; { names, info } | { error }
const KIND = { folder: 'Folder', git: 'Git', github: 'GitHub', empty: 'Empty', template: 'Template', demo: 'Demo', unknown: '' };
async function refreshProjects() {
  const p = await listProjects(ui.adminKey || SESSION_ADMIN).catch((e) => { toast(`Could not list projects: ${e.message}`, 'error'); return null; });
  if (p) { allProjects = p; showPicker(); }
  if (!ui.platformLocal || !ui.adminKey) return;   // Cloudflare is the administrator's
  let cf;
  try { cf = await adminApi('/api/cloudflare'); } catch { cloudProjects = null; return showPicker(); }
  if (!cf.connected) { cloudProjects = null; return showPicker(); }
  try {
    const j = await adminApi('/cloud/api/projects', { raw: true });
    cloudProjects = { names: j.projects || [], info: j.info || {}, url: cf.worker_url };
  } catch (e) { cloudProjects = { error: e.message, url: cf.worker_url }; }
  showPicker();
}
function showPicker() {
  const q = $('#pj-q').value.trim().toLowerCase();
  const match = (n, i) => !q || n.toLowerCase().includes(q) || String(i?.detail || '').toLowerCase().includes(q) || String(i?.kind || '').includes(q);
  const row = (name, info, base) => {
    const here = name === settings.project && (settings.base || '') === base;
    const k = KIND[info?.kind] ?? '';
    return h('li', { class: 'pj-item' },
      h('button', { type: 'button', class: here ? 'proj current' : 'proj', onclick: () => open(name, base) },
        h('span', { class: 'proj-ic' }, name.slice(0, 1).toUpperCase()),
        h('span', { class: 'proj-txt' }, h('span', { class: 'proj-n' }, name), info?.detail ? h('span', { class: 'proj-d', title: info.detail }, info.detail) : null),
        k ? h('span', { class: `proj-k k-${info.kind}` }, k) : null,
        here && store.hasSnapshot ? h('span', { class: 'proj-b' }, 'open now') : null,
        h('span', { class: 'proj-go' }, 'Open →')),
      ui.adminKey ? h('button', { type: 'button', class: 'proj-del', title: `Delete ${name}`, 'aria-label': `Delete ${name}`, onclick: () => deleteProject(name, base) }, '🗑') : null);
  };
  const local = allProjects.filter((n) => match(n, projectInfo[n]));
  const groups = [h('li', { class: 'pj-g' }, h('span', null, 'On this computer'), h('span', { class: 'dim' }, String(allProjects.length)))];
  groups.push(...(local.length ? local.map((n) => row(n, projectInfo[n], '')) : [h('li', { class: 'dim none' }, allProjects.length ? 'No project matches' : ui.adminKey ? 'No projects yet. Click + New project.' : 'You are not a member of any project yet. Ask an owner to add you.')]));
  $('#pj-new').hidden = !ui.adminKey;
  if (cloudProjects) {
    groups.push(h('li', { class: 'pj-g' }, h('span', null, 'On Cloudflare'), h('span', { class: 'dim mono' }, String(cloudProjects.url || '').replace(/^https:\/\//, ''))));
    if (cloudProjects.error) groups.push(h('li', { class: 'bad none' }, `Could not list Cloudflare projects: ${cloudProjects.error}`));
    else {
      const cl = cloudProjects.names.filter((n) => match(n, cloudProjects.info[n]));
      groups.push(...(cl.length ? cl.map((n) => row(n, cloudProjects.info[n], '/cloud')) : [h('li', { class: 'dim none' }, cloudProjects.names.length ? 'No project matches' : 'No projects on Cloudflare yet')]));
    }
  } else if (ui.platformLocal && ui.adminKey) groups.push(h('li', { class: 'pj-g' }, h('span', null, 'On Cloudflare'), h('button', { type: 'button', class: 'link small', onclick: () => { $('#btn-keys').click(); keysTab('k-cloudflare'); } }, 'Connect your account →')));
  $('#pj-q').hidden = allProjects.length + (cloudProjects?.names?.length || 0) < 8;
  mountStable($('#si-list'), groups);
}
async function deleteProject(name, base) {
  const where = base ? 'on Cloudflare' : 'on this computer';
  const typed = prompt(`Delete "${name}" ${where}?\n\nThis removes all its code, history and keys. It cannot be undone.\n\nType the project name to confirm:`);
  if (typed == null) return;
  if (typed.trim() !== name) return toast('Name did not match. Nothing deleted.', 'error');
  try {
    await adminApi(`${base}/api/projects/${encodeURIComponent(name)}`, { raw: true, method: 'DELETE' });
    toast(`Deleted ${name}`, 'success');
    if (name === settings.project && (settings.base || '') === base) { connection.stop?.(); store.reset(); settings.project = ''; settings.base = ''; saveSettings(settings); ui.picking = true; schedule(); }
    refreshProjects();
  } catch (x) { toast(`Could not delete ${name}: ${x.message || x}`, 'error'); }
}
$('#pj-q').addEventListener('input', showPicker);

// Direct user sign-in with subtle key toggle
let signinMode = 'user';
const modeUser = $('#si-mode-user');
const modeKey = $('#si-mode-key');
const keyToggle = $('#si-key-toggle');

if (keyToggle) {
  keyToggle.addEventListener('click', () => {
    if (signinMode === 'user') {
      signinMode = 'key';
      modeUser.hidden = true;
      modeKey.hidden = false;
      keyToggle.textContent = 'Use account';
      $('#si-key').focus();
    } else {
      signinMode = 'user';
      modeUser.hidden = false;
      modeKey.hidden = true;
      keyToggle.textContent = 'Use key';
      $('#si-identifier').focus();
    }
    $('#si-error').textContent = '';
  });
}

$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#si-error').textContent = '';
  settings.remember = $('#si-remember').checked;

  if (signinMode === 'user') {
    const identifier = $('#si-identifier').value.trim();
    const password = $('#si-password').value;
    if (!identifier) return ($('#si-error').textContent = 'Enter a username or email');
    if (!password) return ($('#si-error').textContent = 'Enter a password');

    try {
      const res = await rawFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return ($('#si-error').textContent = data.error || 'Sign in failed');

      settings.sessionToken = data.token;
      settings.user = data.user;
      saveSettings(settings);

      // Determine available projects for this user
      // The server says whether this session may administer; it enforces that itself on every request.
      ui.adminKey = data.admin ? SESSION_ADMIN : '';
      saveSettings(settings);
      allProjects = (await listProjects(SESSION_ADMIN).catch(() => null)) || [];

      if (allProjects.length === 1) {
        return open(allProjects[0], '');
      }
      ui.picking = true;
      schedule();
      toast(`Signed in as ${data.user.name || data.user.email}`, 'good');
      return;
    } catch (err) {
      return ($('#si-error').textContent = `Connection error: ${err.message}`);
    }
  }

  // Key mode (original flow)
  const key = $('#si-key').value.trim();
  const project = $('#si-project').value.trim();
  if (!key) return ($('#si-error').textContent = 'Enter a key');
  if (project && !PROJECT_RE.test(project)) return ($('#si-error').textContent = 'Project names use letters, digits, . _ -');
  let projects;
  try { projects = await listProjects(key); } catch (x) { return ($('#si-error').textContent = `Could not reach the server: ${x.message}`); }
  if (projects) {
    Object.assign(settings, { adminKey: key, viewKey: key });
    ui.adminKey = key;
    saveSettings(settings);
    allProjects = projects;
    if (project && projects.includes(project)) return open(project, '');
    if (projects.length === 1 && !project) return open(projects[0], '');
    ui.picking = true;
    if (project) toast(`No project "${project}". Pick one.`, 'error');
    schedule();
    return;
  }
  if (!project) return ($('#si-error').textContent = 'A view key opens one project. Enter its name.');
  Object.assign(settings, { viewKey: key, adminKey: '' });
  ui.adminKey = '';
  open(project);
});

$('#btn-project').addEventListener('click', async () => {
  openPop('switcher');
  const fill = () => {
    swProjects = [...allProjects.map((n) => ({ name: n, base: '', info: projectInfo[n] })), ...(cloudProjects?.names || []).map((n) => ({ name: n, base: '/cloud', info: cloudProjects.info[n] }))];
    if (!swProjects.length) swProjects = [{ name: settings.project, base: settings.base || '', info: null }];
    showSwitcher();
  };
  $('#sw-q').value = '';
  // An owner signed in with an account is admin too (ui.adminKey is then the session), not only one with a pasted key.
  $('#sw-new').hidden = !ui.adminKey;
  $('#sw-all').hidden = !ui.adminKey;
  fill();
  requestAnimationFrame(() => $('#sw-q').focus());
  if (ui.adminKey) { await refreshProjects(); fill(); }
});

$('#btn-signout').addEventListener('click', async () => {
  if (settings.sessionToken) {
    try {
      await rawFetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: settings.sessionToken }),
      });
    } catch { /* signed out here whether or not the server heard */ }
  }
  Object.assign(settings, { viewKey: '', adminKey: '', reviewerKey: '', sessionToken: '', user: null, remember: false, watch: false });
  saveSettings(settings);
  Object.assign(ui, { adminKey: '', reviewerKey: '', picking: false, agent: '' });
  $('#si-key').value = '';
  if ($('#si-password')) $('#si-password').value = '';
  allProjects = [];
  connection.stop?.();
  store.reset();
  schedule();
  toast('Signed out', 'info');
});

// ---- keys ----
const dlg = $('#keys-dialog');
$('#btn-keys').addEventListener('click', () => {
  $('#in-project').value = settings.project;
  $('#in-view').value = settings.viewKey;
  $('#in-reviewer').value = settings.reviewerKey;
  const admin = $('#in-admin');
  if (admin) admin.value = settings.adminKey || '';
  $('#in-remember').checked = settings.remember;
  // Reset all key fields to password mode on open
  for (const input of $$('#keys-form input[type="text"][id^="in-"]')) {
    if (input.id !== 'in-project') input.type = 'password';
  }
  // Run locally, sign-in is an account and the server listens on this machine only: the shared view/reviewer/admin
  // keys (for a converge others reach, as on Cloudflare) have nothing to do here, so their tab is not shown.
  const keysTabBtn = $('#keys-dialog [data-tab="k-converge"]');
  if (keysTabBtn) keysTabBtn.hidden = Boolean(ui.platformLocal);
  keysTab(ui.platformLocal ? 'k-github' : 'k-converge');
  dlg.showModal();
});

// Show/hide and copy handlers for Converge keys
$('#keys-form').addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('[data-toggle]');
  if (toggleBtn) {
    const targetId = toggleBtn.dataset.toggle;
    const input = $(`#${targetId}`);
    if (input) {
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      mount(toggleBtn, icon(isPass ? 'lock' : 'eye', 15));
      toggleBtn.title = isPass ? 'Hide' : 'Show';
    }
    return;
  }
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    const targetId = copyBtn.dataset.copy;
    const input = $(`#${targetId}`);
    if (input && input.value) {
      navigator.clipboard?.writeText(input.value).then(
        () => toast('Key copied', 'success'),
        () => toast('Copy failed', 'error')
      );
    } else {
      toast('Key is empty', 'warn');
    }
  }
});
// Settings dialog tabs: converge keys, GitHub linking, providers' API keys, CLIs' logins, Cloudflare
function keysTab(id) {
  for (const t of $$('#keys-dialog [data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === id));
  for (const p of $$('#keys-dialog [data-panel]')) p.hidden = p.dataset.panel !== id;
  if (id === 'k-github') showGitHub($('#k-github'));
  else if (id === 'k-providers' || id === 'k-clis' || id === 'k-cloudflare') loadKeys(id);
}
for (const t of $$('#keys-dialog [data-tab]')) t.addEventListener('click', () => keysTab(t.dataset.tab));
async function loadKeys(id) {
  const panel = $(`#${id}`);
  if (!ui.platformLocal) return mount(panel, h('p', { class: 'dim' }, id === 'k-cloudflare' ? 'Deploy from converge running on your computer.' : id === 'k-providers' ? 'On Cloudflare, runs use Workers AI models. No API keys needed.' : 'CLI agents only run when converge runs on your computer.'));
  if (!ui.adminKey) return mount(panel, h('p', { class: 'dim' }, 'Sign in with the admin key to set these.'));
  mount(panel, h('p', { class: 'dim' }, 'Loading…'));
  let k;
  try { k = id === 'k-cloudflare' ? {} : await adminApi('/api/keys'); } catch (x) { return mount(panel, h('p', { class: 'bad' }, String(x.message || x))); }
  // Workers AI: on, off, or unknown (the question failed: say so, do not show it as off).
  if (id === 'k-providers') { try { k.workers_ai = (await adminApi('/api/cloudflare')).workers_ai; } catch (x) { k.workers_ai = false; k.workers_ai_error = String(x.message || x); } }
  const save = async (btn, body) => {
    btn.disabled = true;
    try { await adminApi('/api/keys', { method: 'POST', body: JSON.stringify(body) }); toast('Saved', 'success'); loadRunOptions(); loadKeys(id); }
    catch (x) { toast(String(x.message || x), 'error'); btn.disabled = false; }
  };
  if (id === 'k-providers') {
    // Set up first (each with its models as chips), then the rest, folded: one line each until you add a key.
    const ready = k.providers.filter((p) => p.has_key || p.accounts || (p.managed && k.workers_ai));
    const rest = k.providers.filter((p) => !ready.includes(p));
    const addModel = (p) => {
      const inp = h('input', { type: 'text', spellcheck: 'false', class: 'pv-add', placeholder: '+ model id', 'aria-label': `add a ${p.label} model` });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); save(inp, { provider: p.id, keep_key: true, model: inp.value.trim() }); } });
      return inp;
    };
    const fetchLive = async (p, liveBox, btn) => {
      if (!liveBox.hidden) { liveBox.hidden = true; btn.textContent = 'Browse models ▾'; return; }
      btn.disabled = true;
      btn.textContent = 'Loading models…';
      try {
        const res = await adminApi(`/api/models?provider=${encodeURIComponent(p.id)}&where=container`);
        const list = res.models || [];
        mount(liveBox, list.length ? list.map((m) => {
          const isAdded = p.models.includes(m.id);
          const chip = h('span', { class: `pv-chip mono${isAdded ? ' good' : ''}`, title: `${m.id}${m.price ? ` ($${m.price.in}/in, $${m.price.out}/out)` : ''}` },
            m.id.split('/').pop(),
            isAdded ? h('span', { class: 'dim small' }, '✓') : h('button', { type: 'button', 'aria-label': `add ${m.id}`, onclick: () => save(chip, { provider: p.id, keep_key: true, model: m.id }) }, '+'));
          return chip;
        }) : h('span', { class: 'dim small' }, 'No models found'));
        liveBox.hidden = false;
        btn.textContent = 'Hide models ▴';
      } catch (err) {
        toast(`Could not load models: ${err.message}`, 'error');
        btn.textContent = 'Browse models ▾';
      } finally {
        btn.disabled = false;
      }
    };
    const row = (p) => {
      const managed = p.managed === 'cloudflare';
      const liveBox = h('div', { class: 'pv-live', hidden: true });
      const liveBtn = (!managed && (p.has_key || p.accounts)) ? h('button', { type: 'button', class: 'link small', onclick: () => fetchLive(p, liveBox, liveBtn) }, 'Browse models ▾') : null;
      const models = h('div', { class: 'pv-models' }, p.models.map((m) => h('span', { class: 'pv-chip mono', title: m }, m.split('/').pop(),
        managed ? null : h('button', { type: 'button', 'aria-label': `remove ${m}`, onclick: (e) => save(e.currentTarget, { provider: p.id, drop_model: m }) }, '✕'))),
        p.models.length ? null : h('span', { class: 'dim small' }, 'No models added yet'), managed ? null : addModel(p), liveBtn);
      const replace = h('div', { class: 'pv-form', hidden: true });
      return h('li', { class: 'pv' },
        h('div', { class: 'pv-h' }, h('b', null, p.label),
          managed ? h('span', { class: 'badge good' }, 'On (Cloudflare)') : p.has_key ? h('span', { class: 'badge good' }, 'key set') : h('span', { class: 'badge info' }, `${p.accounts} free accounts`),
          h('span', { class: 'grow' }),
          managed ? h('button', { type: 'button', class: 'link small', onclick: (e) => cfCall(e.currentTarget, '/workers-ai', { on: false }).then(() => loadKeys(id)) }, 'Turn off')
            : [h('button', { type: 'button', class: 'link small', onclick: () => { replace.hidden = !replace.hidden; replace.querySelector('input')?.focus(); } }, p.has_key ? 'Replace key' : 'Add a key'),
              p.has_key ? h('button', { type: 'button', class: 'link small bad', onclick: (e) => { if (confirm(`Remove the ${p.label} key? Its models stay listed.`)) save(e.currentTarget, { provider: p.id, key: null }); } }, 'Remove') : null]),
        models, liveBox, managed ? null : keyForm(p, replace));
    };
    const keyForm = (p, box = h('div', { class: 'pv-form' })) => {
      const key = h('input', { type: 'password', autocomplete: 'off', placeholder: `Paste your ${p.label} key` });
      const model = h('input', { type: 'text', spellcheck: 'false', placeholder: p.model || 'Model ID (optional)', value: p.has_key ? '' : p.model || '' });
      const go = h('button', { type: 'button', class: 'primary' }, 'Save');
      go.addEventListener('click', () => { if (!key.value.trim()) return key.focus(); save(go, { provider: p.id, key: key.value.trim(), model: model.value.trim() || p.model || '' }); });
      key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
      box.append(key, model, go, safeUrl(p.keys) ? h('a', { href: safeUrl(p.keys), target: '_blank', rel: 'noopener', class: 'small' }, 'Get a key ↗') : '');
      return box;
    };
    const other = (p) => {
      if (p.managed === 'cloudflare') return h('li', { class: 'pv off' }, h('div', { class: 'pv-h' }, h('b', null, p.label), h('span', { class: 'dim small' }, 'GPT-OSS, Kimi, DeepSeek, GLM via Cloudflare'), h('span', { class: 'grow' }),
        k.workers_ai_error ? h('span', { class: 'bad small' }, `Could not check status: ${k.workers_ai_error}`) : h('button', { type: 'button', class: 'small', onclick: (e) => cfCall(e.currentTarget, '/workers-ai', { on: true }).then(() => loadKeys(id)).catch(() => keysTab('k-cloudflare')) }, 'Turn on')));
      const form = keyForm(p); form.hidden = true;
      return h('li', { class: 'pv off' }, h('div', { class: 'pv-h' }, h('b', null, p.label), h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'small', onclick: () => { form.hidden = !form.hidden; form.querySelector('input')?.focus(); } }, 'Add a key')), form);
    };
    return mount(panel, h('p', { class: 'dim small' }, 'Models your agents can use.'),
      ready.length ? h('ol', { class: 'pvlist' }, ready.map(row)) : h('p', { class: 'dim small' }, 'No providers yet. Add a key below.'),
      h('h4', { class: 'pv-sec' }, 'Add a provider'),
      h('ol', { class: 'pvlist' }, rest.map(other)));
  }
  if (id === 'k-cloudflare') return showCloudflare(panel);
  // A subscription CLI keeps its own login where it is installed; nothing is pasted or stored here. Each is asked for its
  // own sign-in status (the server runs `claude auth status`, `codex login status`, `cursor-agent status`).
  return mount(panel, h('p', { class: 'dim small' }, 'CLI tools use their own sign-in.' + (k.mac.length ? ` Found: ${k.mac.join(', ')}.` : '')),
    h('ol', { class: 'keylist' }, k.clis.map((c) => h('li', null,
      h('div', { class: 'kl-h' }, h('b', null, c.label), c.ready ? h('span', { class: 'badge good' }, 'signed in') : h('span', { class: 'badge warn' }, 'not signed in')),
      h('div', { class: 'small dim' }, c.ready ? 'Signed in on this computer.' : c.how)))));
}
// ---- Keys → Cloudflare: the account, a check of what is there, deploy with its log, Workers AI, and the Worker's
// projects alongside this computer's (the Mac helper keeps the token and the Worker's keys; never sent back here) ----
const cfCall = (p, body) => adminApi(`/api/cloudflare${p}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});
const cfCallBtn = async (btn, p, body) => { if (btn) btn.disabled = true; try { return await cfCall(p, body); } catch (x) { toast(String(x.message || x), 'error'); throw x; } finally { if (btn) btn.disabled = false; } };
let cfPoll = null;
async function showCloudflare(panel) {
  clearTimeout(cfPoll);
  let st;
  try { st = await cfCall(''); } catch (x) { return mount(panel, h('p', { class: 'bad' }, String(x.message || x))); }
  try {
    const ck = st.last_check;
    const job = st.job;
    const item = (ok, text, hint) => h('li', { class: ok ? 'ok' : ok === false ? 'no' : 'na' }, h('span', { class: 'ck' }, ok ? '✓' : ok === false ? '✕' : '·'), h('span', null, text, hint ? h('span', { class: 'dim small' }, ` · ${hint}`) : null));
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: st.has_token ? 'Saved (paste to replace)' : 'API token' });
    const account = h('input', { type: 'text', spellcheck: 'false', placeholder: 'Account ID (optional if the token has one account)', value: st.account_id });
    const saveBtn = h('button', { type: 'button', class: 'primary' }, st.has_token ? 'Save and check' : 'Connect');
    saveBtn.addEventListener('click', async () => {
      const body = {};
      if (token.value.trim()) body.api_token = token.value.trim();
      if (account.value.trim() !== st.account_id) body.account_id = account.value.trim();
      if (!st.has_token && !body.api_token) return token.focus();
      try { if (Object.keys(body).length) await cfCallBtn(saveBtn, '', body); saveBtn.textContent = 'Checking…'; await cfCallBtn(saveBtn, '/check', {}); toast('Cloudflare checked', 'success'); } catch { /* toasted */ }
      showCloudflare(panel);
    });
    const removeTokenBtn = st.has_token ? h('button', { type: 'button', class: 'link small bad', onclick: async (e) => {
      if (!confirm('Remove the saved Cloudflare token and account ID?')) return;
      try {
        await cfCallBtn(e.currentTarget, '', { api_token: null, account_id: null });
        toast('Token removed', 'info');
        showCloudflare(panel);
      } catch {}
    } }, 'Remove') : null;
    const deployBtn = h('button', { type: 'button', class: 'primary' }, ck?.scripts?.includes('converge') ? 'Redeploy' : 'Deploy to Cloudflare');
    deployBtn.disabled = !st.has_token || !st.account_id || st.job?.state === 'running';
    deployBtn.addEventListener('click', async () => {
      const what = ck && !ck.images_match ? 'build container images (needs g++ on Linux x86_64, or zig), then deploy' : 'deploy';
      if (!confirm(`Deploy converge to Cloudflare account ${st.account_name || st.account_id}?\n\nThis will ${what}. It can take several minutes.`)) return;
      try { await cfCall('/deploy', {}); }
      catch (x) {
        if (!/already deployed/.test(x.message)) return toast(String(x.message || x), 'error');
        if (!confirm(`${x.message}\n\nDeploy anyway with new keys?`)) return;
        try { await cfCall('/deploy', { fresh_keys: true }); } catch (y) { return toast(String(y.message || y), 'error'); }
      }
      showCloudflare(panel);
    });
    const wurl = h('input', { type: 'url', spellcheck: 'false', placeholder: 'https://converge.<you>.workers.dev', value: st.worker_url });
    const wkey = h('input', { type: 'password', autocomplete: 'off', placeholder: st.connected ? 'Saved (paste to replace)' : 'Admin key' });
    const linkBtn = h('button', { type: 'button' }, 'Save');
    linkBtn.addEventListener('click', async () => {
      const body = { worker_url: wurl.value.trim() };
      if (wkey.value.trim()) body.admin_key = wkey.value.trim();
      try { await cfCallBtn(linkBtn, '', body); toast('Saved. Its projects are on the projects page.', 'success'); } catch { /* toasted */ }
      pjAsked = false; cloudProjects = null; showCloudflare(panel);
    });
    const logBox = h('pre', { class: 'cf-log' });
    const oauthBtn = h('button', { type: 'button', class: 'secondary' }, 'Sign in with Cloudflare');
    oauthBtn.addEventListener('click', async () => {
      try {
        await cfCallBtn(oauthBtn, '/oauth', {});
        toast('Opening Cloudflare sign-in in your browser…', 'info');
        let attempts = 0;
        const pollAuth = setInterval(async () => {
          attempts++;
          try {
            const fresh = await cfCall('');
            if (fresh.wrangler?.logged_in || attempts >= 10) {
              clearInterval(pollAuth);
              if (fresh.wrangler?.logged_in) {
                toast('Cloudflare connected', 'success');
                try { await cfCall('/check'); } catch {}
                showCloudflare(panel);
              }
            }
          } catch { clearInterval(pollAuth); }
        }, 3000);
      } catch { /* toasted */ }
    });
    const logoutWranglerBtn = h('button', { type: 'button', class: 'link small bad', onclick: async (e) => {
      if (!confirm('Sign out of Cloudflare?')) return;
      try {
        await cfCallBtn(e.currentTarget, '/oauth-logout', {});
        toast('Signed out of Cloudflare', 'info');
        showCloudflare(panel);
      } catch {}
    } }, 'Sign out');
    const wranglerInfo = st.wrangler?.logged_in
      ? h('div', { class: 'cf-row' },
          h('span', { class: 'small good' }, `✓ Signed in (${st.wrangler.accounts[0]?.name || st.wrangler.accounts[0]?.id || 'Cloudflare'})`),
          h('span', { class: 'grow' }),
          logoutWranglerBtn)
      : h('div', { class: 'cf-row' }, oauthBtn, h('span', { class: 'dim small' }, 'Opens Cloudflare sign-in in your browser.'));

    mount(panel,
      h('p', { class: 'dim small' }, 'Run converge on Cloudflare. Your token stays on this computer.'),
      h('section', { class: 'cf-sec' }, h('h4', null, '1 · Account'),
        wranglerInfo,
        h('p', { class: 'small dim', style: 'margin-top:8px;' }, 'Or use an API token from the ', h('a', { href: 'https://dash.cloudflare.com/profile/api-tokens', target: '_blank', rel: 'noopener' }, 'Cloudflare dashboard ↗'),
          ' (permissions: Workers AI: Read, Queues: Edit, Containers: Edit, Artifacts: Edit):'),
        h('div', { class: 'cf-row' }, token, saveBtn, removeTokenBtn),
        h('div', { class: 'cf-row' }, account),
        ck ? h('ol', { class: 'cf-check' },
          item(ck.token, 'token accepted'),
          item(Boolean(ck.account_id), ck.account_id ? `account ${st.account_name || ''} (${ck.account_id.slice(0, 8)}…)` : 'account', ck.accounts?.length > 1 && !st.account_id ? `this token has ${ck.accounts.length} accounts:${ck.accounts.map((a) => `${a.name} ${a.id}`).join(', ')}` : ''),
          item(Boolean(ck.subdomain), ck.subdomain ? `workers.dev: ${ck.subdomain}.workers.dev` : 'workers.dev subdomain', ck.subdomain ? '' : 'turn it on in the dashboard (Workers → Settings)'),
          item(ck.workers_ai, 'Workers AI access'),
          item(ck.scripts?.includes('converge') ? true : null, ck.scripts?.includes('converge') ? 'converge is deployed' : 'converge is not deployed yet'),
          item(ck.images_match ? true : null, ck.images_match ? 'container images are on this account' : 'container images will be built for this account (no Docker needed)'),
          st.worker_url ? item(ck.health?.ok === true || ck.health?.ok === undefined && ck.health ? true : ck.health ? false : null, `${st.worker_url} answers`, ck.health?.ok === false ? String(ck.health.error || ck.health.status || '') : '') : null,
          ...(ck.notes || []).map((n) => h('li', { class: 'na' }, h('span', { class: 'ck' }, '!'), h('span', { class: 'small' }, n))),
        ) : null),
      h('section', { class: 'cf-sec' }, h('h4', null, '2 · Deploy'),
        h('div', { class: 'cf-row' }, deployBtn, job ? h('span', { class: job.state === 'failed' ? 'bad small' : job.state === 'done' ? 'good small' : 'small' },
          job.state === 'running' ? `${job.step}… (${job.steps.indexOf(job.step) + 1} of ${job.steps.length})` : job.state === 'done' ? `deployed ${timeAgo(job.ended)}` : job.error) : null),
        job ? logBox : null),
      h('section', { class: 'cf-sec' }, h('h4', null, '3 · Cloudflare projects'),
        h('p', { class: 'small dim' }, st.connected ? `Connected: ${st.worker_url}` : 'Connects after deploy, or enter the URL and admin key.'),
        h('div', { class: 'cf-row' }, wurl), h('div', { class: 'cf-row' }, wkey, linkBtn),
        st.connected ? h('button', { type: 'button', class: 'link small bad', onclick: async (e) => { if (!confirm('Disconnect? Nothing on Cloudflare is changed.')) return; await cfCallBtn(e.currentTarget, '', { worker_url: null, admin_key: null }); cloudProjects = null; showCloudflare(panel); } }, 'Disconnect') : null),
      h('section', { class: 'cf-sec' }, h('h4', null, '4 · Workers AI for local runs'),
        h('div', { class: 'cf-row' }, h('span', { class: 'small' }, st.workers_ai ? 'On. Workers AI models are in the model picker.' : 'Use Workers AI models (DeepSeek, GLM, Kimi) in local runs.'),
          h('span', { class: 'grow' }), h('button', { type: 'button', disabled: !st.has_token || !st.account_id, onclick: async (e) => { try { await cfCallBtn(e.currentTarget, '/workers-ai', { on: !st.workers_ai }); loadRunOptions(); } catch { /* toasted */ } showCloudflare(panel); } }, st.workers_ai ? 'Turn off' : 'Turn on'))));
    if (job) {
      const tick = async () => {
        if (!panel.isConnected || panel.hidden || !$('#keys-dialog').open) return;
        try {
          const l = await cfCall('/log');
          const atEnd = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 30;
          logBox.textContent = l.log || '';
          if (atEnd) logBox.scrollTop = logBox.scrollHeight;
          if (l.job?.state === 'running') cfPoll = setTimeout(tick, 2000);
          else if (job.state === 'running') showCloudflare(panel); // just finished: show the result
        } catch { /* the next open retries */ }
      };
      tick();
    }
  } catch (x) {
    mount(panel, h('p', { class: 'bad' }, `Could not show Cloudflare settings:${String(x.message || x)}`));
  }
}
for (const b of $$('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
$('#keys-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const project = $('#in-project').value.trim();
  if (!PROJECT_RE.test(project)) return ($('#project-error').textContent = 'Use letters, digits, . _ - only');
  const changed = project !== settings.project;
  const admin = $('#in-admin');
  Object.assign(settings, { project, viewKey: $('#in-view').value.trim(), reviewerKey: $('#in-reviewer').value.trim(), remember: $('#in-remember').checked });
  if (admin) settings.adminKey = admin.value.trim();
  saveSettings(settings);
  ui.reviewerKey = settings.reviewerKey;
  ui.adminKey = settings.adminKey || (ui.adminKey === SESSION_ADMIN ? SESSION_ADMIN : '');
  ui.diff = { changeId: '', text: '' };
  diffs.clear();
  dlg.close();
  if (changed) { store.reset(); timelineLive(); }
  connection.restart();
  pollRuns();
  loadRunOptions();
});

$('#filter').addEventListener('input', (e) => { ui.filter = e.target.value; schedule(); });
// ---- start a run (admin): converge hands it to converge-sandbox, which runs the team in a container ----
const money = (v) => `$${Number(v).toFixed(2)}`;
// The local platform lists the models it can run (the providers on this machine, GET /api/projects/:p/run-options):
// the picker then offers those instead of Cloudflare's free Workers AI models.
async function loadRunOptions() {
  if (!ui.local || !settings.project) return; // Cloudflare: keep its own list (the Worker has no run-options route)
  try {
    const { models = [] } = await api(`${P()}/run-options`);
    // This platform: the model picker instead of the list (the select stays for a Worker's Workers AI models).
    $('#run-pick').hidden = !ui.adminKey;
    $('#run-model-f').hidden = Boolean(ui.adminKey);
    showPick();
    const sel = $('#run-model');
    const keep = sel.value;
    const groups = [...new Set(models.map((m) => m.group || 'Models'))];
    mount(sel, groups.map((g) => h('optgroup', { label: g }, models.filter((m) => (m.group || 'Models') === g).map((m) =>
      h('option', { value: m.id, disabled: Boolean(m.missing), title: m.missing ? `needs setup: ${m.missing}` : m.where === 'mac' ? 'Runs on your computer with no sandbox. Changes are still checked.' : '' }, m.missing ? `${m.label} (needs setup)` : m.label)))));
    ui.models = models;
    if (!ui.adminKey) whereNote();
    if (models.some((m) => m.id === keep)) sel.value = keep;
    const saved = prefs.get('converge.model'); if (saved && models.some((m) => m.id === saved)) sel.value = saved;

    $('#run-agents').max = '200';
    $('#run-agents').value = String(Math.min(recallAgents(localStorage), 200));
    // Real work costs dollars, not cents: the cap goes to $50 on this platform, and a remembered cap comes back.
    $('#run-budget').max = '50';
    $('#run-budget').step = 'any'; // any amount: a step counted from the minimum made round dollars "invalid"
    const b = Number(prefs.get('converge.budget')); if (b > 0) $('#run-budget').value = String(Math.min(b, 50)); else if (Number($('#run-budget').value) < 2) $('#run-budget').value = '2';
  } catch {
    // This platform did not answer (restarting): its own picker stays, with the model last picked, and the list is asked
    // for again. Falling back to the Workers AI list put "GPT-OSS 120B (fast)" in the Model box, and Start would have run
    // a Cloudflare model nobody picked.
    $('#run-pick').hidden = !ui.adminKey;
    $('#run-model-f').hidden = Boolean(ui.adminKey);
    showPick();
    setTimeout(loadRunOptions, 3000);
  }
}
// ---- the model picker (this platform): providers on the left (ready first, what each needs), their models listed live
// by the provider, searchable across every provider, with price, effort and capabilities; recent picks on top ----
const PICK_KEY = 'converge.pick';
ui.pick = prefs.getJson(PICK_KEY, null);
const md = { provs: [], models: new Map(), errors: new Map(), active: null, effort: '' };
const provKey = (p) => `${p.id}@${p.where}`;
const mdDlg = $('#model-dialog');
const price = (m) => (m.free || (m.price && !m.price.in && !m.price.out) ? (m.subscription ? 'subscription' : 'free') : m.price ? `$${m.price.in} in · $${m.price.out} out${m.estimated ? ' ~' : ''}` : '');
function pickLabel(p) { return p ? `${String(p.model || 'default').split('/').pop()} · ${p.label || p.provider}${p.where === 'mac' ? ' (no sandbox)' : ''}${p.effort ? ` · ${p.effort}` : ''}` : 'choose'; }
function showPick() {
  $('#run-pick-l').textContent = pickLabel(ui.pick);
  const cli = Boolean(ui.pick?.provider?.endsWith('-cli'));
  $('#run-budget-f').hidden = cli;
  $('#run-where').textContent = !ui.pick ? '' : [ui.pick.where === 'mac' ? 'Your computer (no sandbox)' : 'Sandboxed', cli ? 'Subscription' : ''].filter(Boolean).join(' · ');
  $('#run-where').className = ui.pick?.where === 'mac' ? 'chip-note warn' : 'chip-note';
}
async function openPicker() {
  if (!mdDlg.open) mdDlg.showModal();
  $('#md-q').value = '';
  md.effort = ui.pick?.effort || '';
  mount($('#md-provs'), h('p', { class: 'dim small md-pad' }, 'Loading providers…'));
  mount($('#md-models'), null);
  requestAnimationFrame(() => $('#md-q').focus());
  try { if (!ui.platformLocal) throw new Error('Models are only listed when converge runs on your computer'); md.provs = (await adminApi('/api/models/providers')).providers; } catch (x) { return mount($('#md-provs'), h('p', { class: 'bad md-pad' }, String(x.message || x))); }
  md.active = md.provs.find((p) => ui.pick && p.id === ui.pick.provider && p.where === (ui.pick.where || 'container')) || md.provs.find((p) => p.ready) || md.provs[0];
  renderPicker();
  // Every ready provider's models at once, so a search covers them all (the server keeps each list for 10 minutes).
  await Promise.all(md.provs.filter((p) => p.ready).map((p) => loadModels(p)));
}
async function loadModels(p, fresh = false) {
  const k = provKey(p);
  if (md.models.has(k) && !fresh) return;
  md.errors.delete(k);
  try {
    const r = await adminApi(`/api/models?provider=${encodeURIComponent(p.id)}&where=${p.where}${fresh ? '&fresh=1' : ''}`);
    md.models.set(k, (r.models || []).map((m) => ({ ...m, subscription: p.kind === 'cli' })));
    md.effortLevels = r.effortLevels?.length ? r.effortLevels : md.effortLevels;
  } catch (x) { md.errors.set(k, String(x.message || x)); }
  if (mdDlg.open) renderPicker();
}
function choose(p, m) {
  const eff = m.effort ? md.effort : '';
  ui.pick = { provider: p.id, where: p.where, model: m.id, label: p.label, effort: eff };
  prefs.setJson(PICK_KEY, ui.pick);
  const recent = prefs.getJson('converge.recentPicks', []).filter((x) => !(x.provider === p.id && x.where === p.where && x.model === m.id));
  prefs.setJson('converge.recentPicks', [{ ...ui.pick }, ...recent].slice(0, 6));
  showPick();
  // A model with thinking control stays open on its effort row, so it can be set right away; others close.
  if (m.effort) renderPicker(); else mdDlg.close();
}
function renderPicker() {
  const q = $('#md-q').value.trim().toLowerCase();
  const groups = [['api', 'container', 'API models'], ['cli', 'container', 'Subscriptions · sandboxed'], ['cli', 'mac', 'Subscriptions · no sandbox']];
  mountStable($('#md-provs'), groups.map(([kind, where, title]) => {
    const ps = md.provs.filter((p) => p.kind === kind && p.where === where).sort((a, b) => Number(b.ready) - Number(a.ready));
    if (!ps.length) return null;
    return h('div', { class: 'md-g' }, h('div', { class: 'md-gt' }, title), ps.map((p) => {
      const n = md.models.get(provKey(p))?.length;
      return h('button', { type: 'button', class: `md-p${p === md.active && !q ? ' on' : ''}${p.ready ? '' : ' off'}`, title: p.note, onclick: () => { md.active = p; $('#md-q').value = ''; renderPicker(); if (p.ready) loadModels(p); } },
        h('span', { class: `md-dot${p.ready ? ' ok' : ''}` }), h('span', { class: 'md-pl' }, p.label), h('span', { class: 'md-pn' }, p.ready ? (n != null ? String(n) : '') : 'set up'));
    }));
  }));
  // Right side: a search spans every provider; otherwise the picked provider (or what it needs to be set up).
  const row = (p, m) => {
    const on = ui.pick && ui.pick.provider === p.id && ui.pick.where === p.where && ui.pick.model === m.id;
    return h('li', null, h('button', { type: 'button', class: `md-m${on ? ' on' : ''}`, onclick: () => choose(p, m), title: m.id },
      h('span', { class: 'md-mn' }, String(m.id).split('/').pop(), m.id.includes('/') ? h('span', { class: 'md-mid mono' }, m.id) : null),
      h('span', { class: 'md-tags' },
        q ? h('span', { class: 'tag' }, p.label) : null,
        m.default ? h('span', { class: 'tag acc' }, 'converge default') : m.listed ? h('span', { class: 'tag acc' }, 'in your list') : null,
        m.effort ? h('span', { class: 'tag' }, 'thinking · effort') : m.thinking ? h('span', { class: 'tag' }, 'thinking') : null, m.vision ? h('span', { class: 'tag' }, 'vision') : null,
        price(m) ? h('span', { class: 'md-price' }, price(m)) : null),
      on ? h('span', { class: 'md-ck' }, '✓') : null));
  };
  const recent = prefs.getJson('converge.recentPicks', []);
  mountStable($('#md-recent'), !q && recent.length ? [h('span', { class: 'dim small' }, 'Recent'), ...recent.map((r) => {
    const p = md.provs.find((x) => x.id === r.provider && x.where === r.where);
    return p ? h('button', { type: 'button', class: 'chip md-rc', disabled: !p.ready, onclick: () => choose(p, { id: r.model, effort: Boolean(r.effort) }) }, pickLabel(r)) : null;
  })] : null);
  let items = [];
  if (q) {
    for (const p of md.provs.filter((x) => x.ready)) for (const m of md.models.get(provKey(p)) || []) if (`${m.id} ${p.label}`.toLowerCase().includes(q)) items.push(row(p, m));
    const p = md.active?.ready ? md.active : md.provs.find((x) => x.ready);
    if (p && !items.length) items.push(h('li', { class: 'dim md-pad' }, 'No matching models.'));
    if (p) items.push(h('li', null, h('button', { type: 'button', class: 'md-m md-use', onclick: () => choose(p, { id: $('#md-q').value.trim() }) }, `Use “${$('#md-q').value.trim()}” on ${p.label}`)));
  } else if (md.active) {
    const p = md.active;
    const k = provKey(p);
    if (!p.ready) items = [h('li', { class: 'md-setup' }, h('b', null, `${p.label} is not set up`), h('p', { class: 'dim small' }, p.note),
      h('button', { type: 'button', class: 'primary', onclick: () => { mdDlg.close(); $('#btn-keys').click(); keysTab(p.kind === 'cli' ? 'k-clis' : p.id === 'cloudflare' ? 'k-cloudflare' : 'k-providers'); } }, 'Set it up'))];
    else if (md.errors.has(k)) items = [h('li', { class: 'bad md-pad' }, md.errors.get(k))];
    else if (!md.models.has(k)) items = [h('li', { class: 'dim md-pad' }, `Loading ${p.label} models…`)];
    else items = (md.models.get(k) || []).map((m) => row(p, m));
  }
  mount($('#md-models'), items);
  // Thinking and effort, always here, for the chosen model: Off turns thinking off, Minimal…High set how hard it
  // reasons, Auto leaves it to the provider. A model without the control says so instead of hiding it.
  const cur = ui.pick && (md.models.get(`${ui.pick.provider}@${ui.pick.where}`) || []).find((m) => m.id === ui.pick.model);
  const can = Boolean(cur?.effort);
  const levels = ['', 'off', ...(md.effortLevels?.length ? md.effortLevels : ['minimal', 'low', 'medium', 'high'])];
  $('#md-foot').hidden = false;
  md.effort = ui.pick?.effort || '';
  mount($('#md-effort'), levels.map((l) => h('button', { type: 'button', disabled: !can, 'aria-selected': String(md.effort === l),
    title: l === '' ? 'Provider default' : l === 'off' ? 'Fastest and cheapest' : `think ${l === 'minimal' ? 'as little as possible' : l === 'low' ? 'a little' : l === 'medium' ? 'moderately' : 'hard'}`,
    onclick: () => { md.effort = l; ui.pick.effort = l; prefs.setJson(PICK_KEY, ui.pick); showPick(); renderPicker(); } }, l === '' ? 'Auto' : l === 'off' ? 'Thinking off' : l[0].toUpperCase() + l.slice(1))));
  $('#md-note').textContent = !ui.pick ? 'Pick a model first.' : !cur ? (md.models.has(`${ui.pick.provider}@${ui.pick.where}`) ? `${ui.pick.model}: not in the provider's list` : 'Loading…')
    : `${String(cur.id).split('/').pop()}${can ? '' : ': effort not adjustable'}${price(cur) ? ` · ${price(cur)} per 1M tokens` : ''}`;
}
$('#md-q').addEventListener('input', renderPicker);
$('#md-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#md-models .md-m')?.click(); } });
$('#md-refresh').addEventListener('click', () => { md.models.clear(); md.provs.filter((p) => p.ready).forEach((p) => loadModels(p, true)); renderPicker(); });
$('#run-pick').addEventListener('click', openPicker);
for (const b of $$('#model-dialog [data-close]')) b.addEventListener('click', () => mdDlg.close());

$('#run-budget').addEventListener('change', (e) => prefs.set('converge.budget', String(Number(e.target.value) || '')));
$('#run-model').addEventListener('change', (e) => { prefs.set('converge.model', e.target.value); whereNote(); });
// Under the picker: where the picked model's agents run (on the host they have no sandbox; say so before Start).
function whereNote() {
  const m = (ui.models || []).find((x) => x.id === $('#run-model').value);
  if (!m) return;
  // A subscription CLI bills your plan, not per call: nothing to meter, so no spending cap to set.
  const cli = Boolean(m.provider?.endsWith('-cli'));
  $('#run-budget-f').hidden = cli;
  $('#run-where').textContent = [m.where === 'mac' ? 'Your computer (no sandbox)' : 'Sandboxed', cli ? 'Subscription' : ''].filter(Boolean).join(' · ');
  $('#run-where').title = m.where === 'mac' ? 'Runs on your computer. Changes are checked before landing.' : '';
  $('#run-where').className = m.where === 'mac' ? 'chip-note warn' : 'chip-note';
}
// The composer: Enter starts, Shift+Enter is a new line; the box grows with what is typed.
const req = $('#run-req');
const grow = () => {
  req.style.height = '24px';
  if (req.value.trim()) req.style.height = `${Math.min(Math.max(req.scrollHeight, 24), 180)}px`;
};
req.addEventListener('input', grow);
req.addEventListener('paste', () => setTimeout(grow, 0));
window.addEventListener('resize', grow);
grow();
req.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#run').requestSubmit(); } });
$('#run').addEventListener('submit', async (e) => {
  e.preventDefault();
  const request = req.value.trim();
  const status = $('#run-status');
  status.textContent = '';
  if (request.length < 6) { status.className = 'run-status bad'; status.textContent = 'Describe what you want done.'; return; }
  // No model is assumed: a run uses the one picked, for planning and for the agents.
  if (!$('#run-pick').hidden && !ui.pick) { status.className = 'run-status bad'; status.textContent = 'Pick a model first.'; return; }
  // Sent: the box empties and the request joins the conversation above it.
  req.value = '';
  grow();
  ui.pending = { request, at: Date.now(), error: '' };
  schedule();
  try {
    const directTasks = loadDirectTasks();
    await adminApi(`${P()}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        request,
        ...(!$('#run-pick').hidden && ui.pick ? { pick: ui.pick } : { model: $('#run-model').value }),
        agents: directTasks.length ? Math.max(directTasks.length, Number($('#run-agents').value)) : Number($('#run-agents').value),
        budget: Number($('#run-budget').value),
        rules: rulesBody(),
        ...(directTasks.length ? { tasks: directTasks } : {})
      }),
    });
    ui.pending = null;
  } catch (err) {
    // Not started: say why in the conversation, and give the request back to edit.
    if (ui.pending) ui.pending.error = String(err.message || err);
    if (!req.value) { req.value = request; grow(); }
  }
  pollRuns();
});
// The Agents number is kept as soon as it is typed: kept only once a run was accepted, the model list reloading in the
// meantime (it sets the box from what was kept) put it back to 3 while the run started.
$('#run-agents').addEventListener('input', () => { const n = Number($('#run-agents').value); if (Number.isInteger(n) && n > 0) try { rememberAgents(localStorage, n); } catch { /* no storage: the box still holds it */ } });
// Esc: closes the details; with none open, shows every agent again.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.target.closest?.('dialog')) return;
  if (ui.pop) closePop();
  else if (ui.picking && signedIn() && store.hasSnapshot) { ui.picking = false; schedule(); }
  else if (ui.live) { ui.live = false; schedule(); }
  else if (ui.fly) actions.closeFly();
  else if (ui.channel !== 'milestones') { ui.channel = 'milestones'; schedule(); }
  else if (ui.kind !== 'all' || ui.filter) { ui.kind = 'all'; ui.filter = ''; $('#filter').value = ''; schedule(); }
});
$('#btn-clear').addEventListener('click', () => { ui.kind = 'all'; ui.filter = ''; $('#filter').value = ''; schedule(); });
setInterval(schedule, 30_000); // silent agents turn amber without an event

$('#si-project').value = settings.project;
$('#si-remember').checked = settings.remember;
// First run: no account exists yet, so the sign-in card is replaced by the "Set up converge" form.
$('#signin').append(h('form', { class: 'card si-card', id: 'setup-form', hidden: true, autocomplete: 'on' },
  h('h2', {}, 'Set up converge'),
  h('p', { class: 'dim' }, 'Create the first account. It will own this installation.'),
  h('label', {}, 'Name', h('input', { id: 'su-name', name: 'name', autocomplete: 'name' })),
  h('label', {}, 'Email', h('input', { id: 'su-email', name: 'email', type: 'email', autocomplete: 'email' })),
  h('label', {}, 'Password', h('input', { id: 'su-password', name: 'password', type: 'password', autocomplete: 'new-password' })),
  h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'su-remember', checked: true }), ' Remember on this device'),
  h('div', { class: 'error', id: 'su-error', role: 'alert' }),
  h('button', { type: 'submit', class: 'primary', id: 'su-create' }, 'Create')));
$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#su-error').textContent = '';
  const body = setupBody({ name: $('#su-name').value, email: $('#su-email').value, password: $('#su-password').value });
  if (!body) return ($('#su-error').textContent = 'Enter a name, email and password');
  try {
    const res = await rawFetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return ($('#su-error').textContent = data.error || 'Setup failed');
    settings.sessionToken = data.token;
    settings.user = data.user;
    settings.remember = $('#su-remember').checked;   // as on sign-in: ticked, the session outlives closing the browser
    saveSettings(settings);
    needsSetup = false;
    ui.adminKey = data.admin === false ? '' : SESSION_ADMIN; // the first account owns the platform
    allProjects = (await listProjects(SESSION_ADMIN).catch(() => null)) || [];
    ui.picking = true; // the projects page, with "New project" ready
    schedule();
    toast(`Signed in as ${data.user?.name || data.user?.email || body.email}`, 'good');
  } catch (err) {
    $('#su-error').textContent = `Connection error: ${err.message}`;
  }
});
rawFetch('/api/setup').then((r) => r.json().catch(() => ({}))).then((j) => { needsSetup = Boolean(j.needsSetup); schedule(); }, () => { /* no setup route: sign-in as before */ });
// The admin key with no project chosen: the projects page (a view key gets the sign-in card, which asks for one).
if (ui.adminKey && !settings.project) ui.picking = true;
render();
// The socket and the local-only routes wait until the platform said what it is (it decides how the socket's key goes).
platform.then(() => { if (signedIn() && settings.project) { connection.start(); pollRuns(); loadRunOptions(); setTimeout(updateGitButton, 300); setTimeout(loadFolder, 400); } });   // the folder button too: a reload left it hidden
if (ui.adminKey) listProjects(ui.adminKey).then((p) => { if (p) { allProjects = p; if (!p.includes(settings.project) && !settings.base) { ui.picking = true; schedule(); } } }, () => { /* said when the projects page asks again */ });
// A signed-in ASQL session survives a reload: ask the server what it may still do (an expired one signs out).
if (settings.sessionToken) {
  rawFetch('/api/auth/session', { headers: sessionHeader() }).then(async (r) => {
    if (r.status === 401) { Object.assign(settings, { sessionToken: '', user: null }); saveSettings(settings); schedule(); return; }
    const j = await r.json().catch(() => ({}));
    if (j.admin && !ui.adminKey) ui.adminKey = SESSION_ADMIN;
    const p = await listProjects(ui.adminKey || SESSION_ADMIN).catch(() => null);
    if (p) allProjects = p;
    if (!settings.base && (!settings.project || (p && !p.includes(settings.project)))) ui.picking = true;
    schedule();
  }, () => {});
}
