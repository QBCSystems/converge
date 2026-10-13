// Client-side model of the project, kept in step with the engine.
//
// Truth lives in the engine. A snapshot replaces our view wholesale; live events are folded with a
// reducer that mirrors engine/src/state.cpp `apply()`. Events are applied strictly in sequence:
// duplicates are dropped and a gap asks the caller to resync from a fresh snapshot rather than guess.

const MAX_RECENT = 300;

const EVENT_APPLIED = 'applied';
const EVENT_DUPLICATE = 'duplicate';
export const EVENT_GAP = 'gap';

const blankState = () => ({
  version: 0,
  project: { name: '', main_head: '', main_remote: '' },
  agents: [],
  tasks: [],
  changes: [],
  recent: [], // oldest first, same order as the server
  acts: {}, // agent_id -> its last actions under aios (Acted events), oldest first
  landings: [], // Landed events, receipts included, oldest first
  metrics: { merges: 0 },
});

const MAX_ACTS = 60;

const asArray = (v) => (Array.isArray(v) ? v : []);

function normalizeChange(c) {
  return {
    change_id: c.change_id,
    agent_id: c.agent_id || '',
    task_id: c.task_id || '',
    state: String(c.state || 'working').toLowerCase(),
    files: asArray(c.files),
    preview: c.preview && typeof c.preview === 'object' ? c.preview : {},
    conflicts: asArray(c.conflicts),
    landed_commit: c.landed_commit || '',
    base_commit: c.base_commit || '',
    head_commit: c.head_commit || '',
    summary: c.summary || '',
    tests: c.tests || null,
    context: c.context || null,
    verified: c.verified && typeof c.verified === 'object' ? c.verified : null,
    claim_check: c.claim_check && typeof c.claim_check === 'object' ? c.claim_check : null,
    evidence: c.evidence && typeof c.evidence === 'object' ? c.evidence : null,
    claims: asArray(c.claims),
    prose_removed: Number(c.prose_removed) || 0,
    out_of_scope: asArray(c.out_of_scope),
    accepted: c.accepted && typeof c.accepted === 'object' ? c.accepted : null,
    acceptance: c.acceptance || 'none',
    depends_on: c.depends_on || '',
    stack_base: c.stack_base || '',
    restacked_ref: c.restacked_ref || '',
    targets: Array.isArray(c.targets) ? c.targets.map((t) => ({ branch: t.branch, landed: t.landed || '', held: t.held || '' })) : [],
  };
}

const normalizeAgent = (a) => ({
  agent_id: a.agent_id,
  role: a.role || 'worker',
  intent: a.intent && Array.isArray(a.intent.paths) ? { ...a.intent } : null,
  change_id: a.change_id || '',
  last_seen: Number(a.last_seen) || 0,
  aios: a.aios && typeof a.aios === 'object' ? { grants: [], actions: 0, refused: 0, alerted: 0, ...a.aios } : null,
});

const normalizeTask = (t) => ({
  task_id: t.task_id,
  agents: asArray(t.agents),
  title: t.title || '',
  mode: t.mode || 'split',
  description: t.description || '',
  changes: asArray(t.changes),
  accept: asArray(t.accept),
});

export class Store {
  constructor() {
    this.state = blankState();
    this.hasSnapshot = false;
    this.listeners = new Set();
    // The engine's snapshot omits per-change submission details (summary, tests, context) on older
    // builds. Remember what Submitted events told us so a snapshot never wipes it.
    this.submissions = new Map();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  reset() {
    this.state = blankState();
    this.hasSnapshot = false;
    this.submissions.clear();
    this.emit();
  }

  /** Returns false when the snapshot is older than what we already hold. */
  applySnapshot(snap) {
    const version = Number(snap.state_version) || 0;
    if (this.hasSnapshot && version < this.state.version) return false;

    const recent = asArray(snap.recent);
    for (const ev of recent) if (ev.type === 'Submitted') this.rememberSubmission(ev);

    this.state = {
      version,
      project: { ...blankState().project, ...(snap.project || {}) },
      agents: asArray(snap.agents).map(normalizeAgent),
      tasks: asArray(snap.tasks).map(normalizeTask),
      changes: asArray(snap.changes).map(normalizeChange),
      recent: recent.slice(-MAX_RECENT),
      acts: snap.acts && typeof snap.acts === 'object' ? Object.fromEntries(Object.entries(snap.acts).map(([k, v]) => [k, asArray(v).slice(-MAX_ACTS)])) : {},
      landings: asArray(snap.landings),
      metrics: snap.metrics && typeof snap.metrics === 'object' ? { merges: 0, ...snap.metrics } : { merges: 0 },
    };
    for (const c of this.state.changes) this.mergeSubmission(c);
    this.hasSnapshot = true;
    this.emit();
    return true;
  }

  rememberSubmission(ev) {
    this.submissions.set(ev.change_id, {
      agent_id: ev.agent_id || '',
      task_id: ev.task_id || '',
      summary: ev.summary || '',
      tests: ev.tests || null,
      context: ev.context || null,
    });
  }

  /** Fill gaps in a change from remembered submission details; engine-provided values win. */
  mergeSubmission(change) {
    const s = this.submissions.get(change.change_id);
    if (!s) return;
    change.task_id ||= s.task_id;
    change.agent_id ||= s.agent_id;
    change.summary ||= s.summary;
    change.tests ||= s.tests;
    change.context ||= s.context;
  }

  /** @returns {'applied'|'duplicate'|'gap'} */
  applyEvent(ev) {
    if (!ev || !ev.type) return EVENT_DUPLICATE;
    const seq = Number(ev.seq) || 0;
    if (!this.hasSnapshot) return EVENT_GAP;
    if (seq) {
      if (seq <= this.state.version) return EVENT_DUPLICATE;
      if (seq > this.state.version + 1) return EVENT_GAP;
      this.state.version = seq;
    }
    // Actions get their own per-agent window (engine rule), so landings never scroll out.
    if (ev.type === 'Acted') {
      const list = (this.state.acts[ev.agent_id] ||= []);
      list.push(ev);
      if (list.length > MAX_ACTS) list.shift();
    } else {
      this.state.recent.push(ev);
      if (this.state.recent.length > MAX_RECENT) this.state.recent.shift();
    }
    if (ev.type === 'Landed') this.state.landings.push(ev);
    this.fold(ev);
    this.emit();
    return EVENT_APPLIED;
  }

  // ---- reducer (mirrors engine apply()) -------------------------------------------------------

  agent(id) {
    return this.state.agents.find((a) => a.agent_id === id);
  }
  task(id) {
    return this.state.tasks.find((t) => t.task_id === id);
  }
  change(id) {
    return this.state.changes.find((c) => c.change_id === id);
  }

  ensureAgent(id, role = 'worker') {
    let a = this.agent(id);
    if (!a) {
      a = normalizeAgent({ agent_id: id, role });
      this.state.agents.push(a);
    }
    return a;
  }

  taskOfAgent(agentId) {
    return this.state.tasks.find((t) => t.agents?.includes(agentId))?.task_id || '';
  }

  /** Engine rule: landing or being superseded releases the agent's claim for that task. */
  releaseClaimFor(ch) {
    const a = this.agent(ch.agent_id);
    if (a?.intent && (!ch.task_id || a.intent.task_id === ch.task_id)) a.intent = null;
  }

  fold(ev) {
    const s = this.state;
    switch (ev.type) {
      case 'ProjectCreated':
        s.project = { name: ev.name, main_remote: ev.main_remote || '', main_head: ev.main_head || '' };
        break;

      case 'TaskCreated': {
        let t = this.task(ev.task_id);
        if (!t) {
          t = normalizeTask({ task_id: ev.task_id });
          s.tasks.push(t);
        }
        Object.assign(t, {
          title: ev.title || '',
          description: ev.description || '',
          mode: ev.mode || 'split',
          agents: asArray(ev.agents).map((a) => a.agent_id),
          accept: asArray(ev.accept),
        });
        for (const a of asArray(ev.agents)) this.ensureAgent(a.agent_id);
        break;
      }

      case 'AgentAdded': {
        const a = this.ensureAgent(ev.agent_id, ev.role);
        a.role = ev.role || a.role;
        break;
      }

      case 'IntentClaimed':
        this.ensureAgent(ev.agent_id).intent = {
          paths: asArray(ev.paths),
          summary: ev.summary || '',
          task_id: ev.task_id || '',
          at: ev.at,
        };
        break;

      case 'IntentReleased': {
        const a = this.agent(ev.agent_id);
        if (a?.intent && (!ev.task_id || a.intent.task_id === ev.task_id)) a.intent = null;
        break;
      }

      case 'Pushed': {
        const a = this.agent(ev.agent_id);
        if (a) { a.push_refused = ''; a.push_refused_why = []; }
        let ch = a?.change_id ? this.change(a.change_id) : undefined;
        const task = a?.intent?.task_id || this.taskOfAgent(ev.agent_id);
        if (!ch || ch.state === 'landed' || ch.state === 'superseded') {
          let id = 'c-' + String(ev.commit || '').slice(0, 8);
          if (this.change(id)) {
            let n = 2;
            while (this.change(`${id}-${n}`)) n++;
            id = `${id}-${n}`;
          }
          // stacked on the agent's change below it (engine rule: ChangeStacked)
          const below = a?.stack_on ? this.change(a.stack_on) : undefined;
          const stacked = below && below.state !== 'landed' && below.state !== 'superseded';
          ch = normalizeChange({
            change_id: id,
            agent_id: ev.agent_id,
            task_id: stacked && below.task_id ? below.task_id : task,
            state: 'working',
            base_commit: s.project.main_head,
            head_commit: ev.commit,
            depends_on: stacked ? below.change_id : '',
            stack_base: stacked ? below.head_commit : '',
          });
          if (a) a.stack_on = '';
          s.changes.push(ch);
          if (a) a.change_id = id;
          if (task) {
            const t = this.task(task);
            if (t && !t.changes.includes(id)) t.changes.push(id);
          }
        } else {
          ch.head_commit = ev.commit;
          ch.verified = null; // new code: the old test runs no longer apply
          ch.claim_check = null;
          ch.evidence = null;
          ch.accepted = null;
          ch.acceptance = this.task(ch.task_id || task)?.accept?.length ? 'pending' : 'none';
          ch.task_id ||= task;
          // New code invalidates an earlier submission, exactly as the engine does.
          if (ch.state === 'conflicted' || ch.state === 'submitted') ch.state = 'working';
        }
        break;
      }

      case 'ChangeStacked': {
        const a = this.agent(ev.agent_id);
        if (a) { a.stack_on = ev.on_change || ''; a.change_id = ''; }
        break;
      }

      case 'ChangeSwitched': {
        const a = this.agent(ev.agent_id);
        if (a) { a.change_id = ev.change_id || ''; a.stack_on = ''; }
        break;
      }

      case 'LandedOn':
      case 'TargetHeld': {
        // a landed change's landing on one of the project's release branches, or why it could not
        const ch = this.change(ev.change_id);
        if (!ch) break;
        ch.targets = ch.targets || [];
        let t = ch.targets.find((x) => x.branch === ev.target);
        if (!t) ch.targets.push((t = { branch: ev.target, landed: '', held: '' }));
        if (ev.type === 'LandedOn') { t.landed = ev.commit; t.held = ''; } else t.held = ev.why;
        break;
      }

      case 'Restacked': {
        const ch = this.change(ev.change_id);
        if (!ch) break;
        ch.head_commit = ev.to;
        ch.stack_base = ev.onto || '';
        ch.restacked_ref = ev.ref || '';
        ch.verified = null; // a new head: every check runs again (engine rule)
        ch.claim_check = null;
        ch.evidence = null;
        ch.accepted = null;
        ch.acceptance = this.task(ch.task_id)?.accept?.length ? 'pending' : 'none';
        if (ch.state === 'conflicted') ch.state = ch.summary ? 'submitted' : 'working';
        break;
      }

      case 'Preview': {
        const ch = this.change(ev.change_id);
        if (!ch) break;
        ch.preview = { against: ev.against || '', merge_base: ev.merge_base || '', clean: !!ev.clean };
        if (ev.merge_base) ch.base_commit = ev.merge_base; // where it really forked (engine rule)
        ch.files = asArray(ev.files);
        ch.conflicts = asArray(ev.conflicts);
        if (!ev.clean && ch.state !== 'landed' && ch.state !== 'superseded') ch.state = 'conflicted';
        else if (ev.clean && ch.state === 'conflicted') ch.state = ch.summary ? 'submitted' : 'working';
        break;
      }

      case 'Submitted': {
        this.rememberSubmission(ev);
        let ch = this.change(ev.change_id);
        if (!ch) {
          ch = normalizeChange({ change_id: ev.change_id, agent_id: ev.agent_id, task_id: ev.task_id, state: 'submitted' });
          s.changes.push(ch);
        }
        // Submitting does not clear a conflict (same rule as the engine).
        ch.state = ch.preview?.clean === false ? 'conflicted' : 'submitted';
        this.mergeSubmission(ch);
        ch.summary = ev.summary || ch.summary;
        ch.claims = asArray(ev.claims);
        ch.prose_removed = Number(ev.prose_removed) || 0;
        ch.tests = ev.tests || ch.tests;
        ch.context = ev.context || ch.context;
        const t = ch.task_id && this.task(ch.task_id);
        if (t && !t.changes.includes(ch.change_id)) t.changes.push(ch.change_id);
        break;
      }

      case 'Landed': {
        const ch = this.change(ev.change_id);
        if (ch) {
          ch.state = 'landed';
          ch.landed_commit = ev.commit;
          this.releaseClaimFor(ch);
        }
        s.project.main_head = ev.commit;
        break;
      }

      case 'Conflicted': {
        const ch = this.change(ev.change_id);
        if (ch) {
          ch.state = 'conflicted';
          ch.conflicts = asArray(ev.conflicts);
        }
        break;
      }

      case 'Superseded': {
        const ch = this.change(ev.change_id);
        if (ch) {
          ch.state = 'superseded';
          this.releaseClaimFor(ch);
        }
        break;
      }

      case 'MainAdvanced':
        s.project.main_head = ev.commit;
        break;

      case 'ProjectConfigured':
        s.project.test_command = ev.test_command || '';
        s.project.leases = ev.leases || 'advisory';
        s.project.signing = ev.signing || 'optional';
        break;

      case 'AgentKeySet': {
        const a = this.ensureAgent(ev.agent_id);
        a.signing_key = ev.key;
        a.signing_fingerprint = ev.fingerprint;
        break;
      }

      case 'PushRefused': {
        const a = this.ensureAgent(ev.agent_id);
        a.push_refused = ev.commit;
        a.push_refused_why = asArray(ev.why);
        break;
      }

      case 'CombinedFailed':
        // landings undone (each an Undone of its own); the changes go back to the train
        for (const id of asArray(ev.changes)) {
          const ch = this.change(id);
          if (ch && ev.undone) ch.state = 'submitted';
        }
        break;

      case 'Undone':
        // an operation taken back: main moves to the commit that reverses it, or a configuration comes back
        if (ev.commit) s.project.main_head = ev.commit;
        if (ev.config) s.project.test_command = ev.test_command || '';
        break;

      case 'Verified': {
        const ch = this.change(ev.change_id);
        // A result for an older head says nothing about the change now (engine rule).
        if (ch && ev.commit === ch.head_commit) {
          ch[ev.kind === 'claim' ? 'claim_check' : ev.kind === 'evidence' ? 'evidence' : ev.kind === 'accept' ? 'accepted' : 'verified'] = ev;
          if (ev.kind === 'accept') ch.acceptance = ev.exit_code === 0 && !ev.timed_out ? 'pass' : 'fail';
        }
        break;
      }

      case 'Contained': {
        const a = this.ensureAgent(ev.agent_id);
        a.aios = { actions: 0, refused: 0, alerted: 0, ...(a.aios || {}), entity: ev.entity, mind: ev.mind, grants: asArray(ev.grants) };
        break;
      }

      case 'Acted': {
        const a = this.ensureAgent(ev.agent_id);
        a.aios ||= { entity: ev.entity, mind: '', grants: [], actions: 0, refused: 0, alerted: 0 };
        a.aios.actions++;
        if (ev.verdict === 'refused') a.aios.refused++;
        if (asArray(ev.alerts).length) a.aios.alerted++;
        break;
      }

      default:
        break; // ShipRequested and future event types only appear in the activity log.
    }
  }
}

// ---- selectors ---------------------------------------------------------------------------------

/** The engine's own verdict on a change: 'off' (project has no test command) | 'pending' | 'pass' | 'fail'. */
export function verification(state, c) {
  if (!state.project.test_command) return 'off';
  const v = c.verified;
  if (!v || v.commit !== c.head_commit) return 'pending';
  return v.exit_code === 0 && !v.timed_out ? 'pass' : 'fail';
}

/** What the planner is doing now: the text of its newest step in a run's plan journal. */
export function planNoteOf(entries) {
  const last = [...(entries || [])].reverse().find((e) => e.by === 'planner' && e.text);
  return last ? last.text : '';
}
