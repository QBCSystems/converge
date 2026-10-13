/**
 * Project Durable Object: one per project. Owns the project's durable event log, its agents' keys and
 * git credentials, and the engine (C++ compiled to WebAssembly, running inside this object) that folds
 * the log into state. Verification runs go to runner containers.
 *
 * - Every engine call is serialized and versioned (X-State-Version). On 409 the engine is rebuilt from
 *   our log with a reset replay that also carries the git credentials (never part of the log).
 * - Artifacts tokens expire; they are re-minted before they lapse and pushed to the engine.
 * - Claims are leases: a scheduled sweep releases the claims of agents that went silent.
 * - WebSocket clients get a snapshot on connect, then every recorded event.
 */

import { DurableObject } from 'cloudflare:workers';
import { Engine } from './engine-wasm.ts';
import { RUNNER_IMAGE_TAG } from './runner-image.ts';
import { generateKey, hashToken, redactSecrets, WS_PROTOCOL } from './auth.ts';
import { forkName, needsRefresh, refreshCredentials, type RepoCredentials } from './artifacts.ts';
import type { Env as WorkerEnv } from './index.ts';

/** The Worker's env plus the RECEIPT_SEED secret passed through to the engine (the receipt signing seed). */
export interface Env extends WorkerEnv {
  RECEIPT_SEED?: string;
}

export interface TaskAgentParam {
  agent_id: string;
  fork_remote: string;
  fork_token: string;
}

export interface CreateTaskParam {
  task_id: string;
  title: string;
  description: string;
  mode: string;
  agents: TaskAgentParam[];
  accept?: string[]; // acceptance checks: the definition of done, run by the engine on each submitted commit
}

/** Where a project's code came from, recorded when it is created (GET /api/projects reports it). */
export interface ProjectOrigin {
  kind: 'empty' | 'git' | 'github' | 'template' | 'unknown';
  /** A short human string: the import URL, "owner/repo", the template's name ('' for empty). */
  detail: string;
  /** ISO 8601. */
  created_at: string;
}

interface StoredCreds {
  remote: string;
  token: string;
  expiresAt: string;
}

const DEFAULT_LEASE_MS = 20 * 60 * 1000;

// Served here rather than by the engine: credentials never pass through the engine's MCP surface.
const CREDENTIALS_TOOL = {
  name: 'git_credentials',
  description:
    "Your fork's HTTPS git remote and a fresh write token (use it as the basic-auth password, any username). Call it when git push or fetch is refused for authentication; tokens expire.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

class EngineError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** How often a status call may fetch an agent's fork to look for a push (see handleMcp). */
const POLL_MS = 20_000;

/** How long status {wait: true} may hold an agent before answering anyway. */
const WAIT_STATUS_MS = 120_000;

/** The status object inside an engine's MCP reply (the tool result's text is JSON). */
function statusOf(res: any): any {
  try {
    const reply = JSON.parse(res.reply);
    return JSON.parse(reply.result.content[0].text);
  } catch {
    return null;
  }
}

/** Submitted, nothing failed: what is left is waiting (checks pending, or the merge train). */
function awaitingLanding(st: any): boolean {
  if (st.state !== 'submitted') return false;
  const failed = (v: any) => v && typeof v === 'object' && (v.passed === false || v.reproduced === false || v.held === false);
  if (['verified', 'claim_check', 'evidence', 'acceptance', 'integration'].some((k) => failed(st[k]) || st[k] === 'fail')) return false;
  return !(st.notices || []).some((n: string) => /failed|refuted|conflict|not covered|outside/i.test(String(n)));
}

// The jail report runs on a runner of its own per image (the tag scripts/runner-image.sh wrote with the image it
// pushed): a new image is checked by a fresh container.
const JAIL_IMAGE = RUNNER_IMAGE_TAG;
/**
 * Where a check runs. Each workspace (an agent's fork, the merge train) has a runner of its own, `<project>/w-<workspace>`,
 * so its checkout stays warm between that agent's commits; the watchdog (watch.ts) stops it once idle. When it cannot
 * start (the account's max_instances reached, a start error) the check runs on the project's shared pool instead,
 * `<project>/<n>` by the workspace's hash, and its output says so. A one-off workspace (a change id) uses the pool.
 */
const RUNNERS = 8;
/** A sandbox session's project (anyone can start one) gets no runners of its own and a small pool, so a handful of sessions cannot hold the account's containers. */
const SANDBOX_RUNNERS = 2;

// Live sockets: per address and per project (each holds memory here and is sent every event).
const WS_PER_NET = 8;
const WS_PER_PROJECT = 300;
// A new socket's snapshot is shared for this long (and while no event lands): a burst of reloads costs one read.
const STATE_CACHE_MS = 2000;

export class Project extends DurableObject<Env> {
  private lastPoll = new Map<string, number>(); // agent -> when its fork was last polled (handleMcp)
  private forkSeen = new Map<string, string>(); // agent -> the fork head the engine last looked at

  // Engine calls and the log writes that follow them must not interleave: each `await` on the engine
  // opens the input gate, and two overlapping calls would number their events out of order.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.ensureTables();
  }

  private ensureTables(): void {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER, json TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS keys (agent_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  }

  // What the serial queue costs: per call, how long it waited for the ones ahead and how long it ran
  // (the last few hundred, for GET .../timings).
  private timingLog: Array<{ at: number; what: string; wait_ms: number; run_ms: number }> = [];
  // Agents waiting for something to happen to their change (waitFor), woken by record().
  private waiters = new Set<{ agent: string; change: string; wake: () => void }>();

  // The shared snapshot (cachedState) and folds of the log by sequence number (stateAt): a fold up to a recorded seq
  // never changes, so it is kept (the last few).
  private stateCache: { at: number; v: number; p: Promise<any> } | null = null;
  private foldCache = new Map<number, Promise<any>>();

  private serial<T>(fn: () => Promise<T>, what = ''): Promise<T> {
    const queued = Date.now();
    const timed = async () => {
      const started = Date.now();
      try { return await fn(); } finally {
        this.timingLog.push({ at: started, what, wait_ms: started - queued, run_ms: Date.now() - started });
        if (this.timingLog.length > 500) this.timingLog.splice(0, this.timingLog.length - 500);
      }
    };
    const run = this.queue.then(timed, timed);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The head of an agent's fork as Artifacts has it now, or undefined if it cannot say. */
  private async forkHead(agentId: string): Promise<string | undefined> {
    const project = this.getMeta('name');
    if (!project || !this.env.ARTIFACTS) return undefined;
    const t0 = Date.now();
    try {
      const repo = await this.env.ARTIFACTS.get(forkName(project, agentId));
      const [head] = await repo.log({ ref: this.getMeta('main_branch') || 'main', limit: 1 });
      return head?.hash ?? '';
    } catch {
      return undefined;
    } finally {
      this.timingLog.push({ at: t0, what: 'fork-head', wait_ms: 0, run_ms: Date.now() - t0 });
    }
  }

  async timings(): Promise<any> {
    let engine: any = null;
    try { engine = await (await this.engineFetch('/v1/health')).json(); } catch (err: any) { engine = { error: String(err?.message || err) }; }
    return { engine, runs_in_flight: this.runsInFlight, calls: this.timingLog };
  }

  /** Until something happens to this agent's change (or to the agent), or `ms` passes. */
  private waitChange(agent: string, change: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const w = { agent, change, wake: () => { clearTimeout(t); this.waiters.delete(w); resolve(); } };
      const t = setTimeout(() => { this.waiters.delete(w); resolve(); }, Math.max(ms, 1000));
      this.waiters.add(w);
    });
  }

  /**
   * Hold an agent until something happens to its change (a run result, a landing, a conflict) or to
   * the agent, or `timeoutMs` passes, without a place in the serial queue: an agent waiting on checks
   * or the merge train asks once instead of polling status.
   */
  async waitFor(mcpKey: string, changeId: string, timeoutMs: number): Promise<{ woke: boolean } | null> {
    const who = await this.authenticate(mcpKey);
    if (!who) return null;
    return new Promise((resolve) => {
      const w = { agent: who.agent_id, change: changeId, wake: () => { clearTimeout(t); this.waiters.delete(w); resolve({ woke: true }); } };
      const t = setTimeout(() => { this.waiters.delete(w); resolve({ woke: false }); }, Math.min(Math.max(timeoutMs, 1000), 30_000));
      this.waiters.add(w);
    });
  }

  // ---- storage ----------------------------------------------------------------------------------

  private rows(query: string, ...args: unknown[]): any[] {
    return this.ctx.storage.sql.exec(query, ...args).toArray();
  }

  private getMeta(k: string): string | null {
    const r = this.rows('SELECT v FROM meta WHERE k = ?', k);
    return r.length ? String(r[0].v) : null;
  }

  private setMeta(k: string, v: string): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v);
  }

  private getCreds(key: string): StoredCreds | null {
    const v = this.getMeta(key);
    return v ? (JSON.parse(v) as StoredCreds) : null;
  }

  private version(): number {
    const r = this.rows('SELECT MAX(seq) AS s FROM events');
    return r.length && r[0].s != null ? Number(r[0].s) : 0;
  }

  private log(): any[] {
    return this.rows('SELECT seq, at, json FROM events ORDER BY seq').map((r) => ({ ...JSON.parse(String(r.json)), seq: Number(r.seq), at: Number(r.at) }));
  }

  /** Append engine events to the log (numbered by us) and fan them out. */
  private record(events: any[] = []): any[] {
    if (!events.length) return [];
    this.ctx.storage.transactionSync(() => {
      let seq = this.version();
      for (const ev of events) {
        ev.seq = ++seq;
        ev.at ||= Date.now();
        this.ctx.storage.sql.exec('INSERT INTO events (seq, at, json) VALUES (?, ?, ?)', ev.seq, ev.at, JSON.stringify(ev));
      }
    });
    for (const w of [...this.waiters]) {
      if (events.some((e) => (w.change && e.change_id === w.change) || e.agent_id === w.agent)) w.wake();
    }
    const sockets = this.ctx.getWebSockets('view');
    const shown = sockets.length ? events.map((ev) => this.shown(ev)) : [];
    for (const ws of sockets) {
      for (const text of shown) {
        try {
          ws.send(text);
        } catch {
          // closed sockets are dropped by the runtime
        }
      }
    }
    return events;
  }

  // ---- engine -----------------------------------------------------------------------------------

  private engineKey(): string {
    // No well-known fallback: a default key is the same as no key. The engine refuses to start without
    // one too, so a missing secret fails loudly at both ends.
    const key = this.env.ENGINE_SHARED_KEY;
    if (!key) throw new Error('ENGINE_SHARED_KEY is not configured (wrangler secret put ENGINE_SHARED_KEY)');
    return key;
  }

  private engineEnv(): Record<string, string> {
    const vars: Record<string, string> = { ENGINE_SHARED_KEY: this.engineKey() };
    // The receipt chain must survive any engine restart, on any machine: the Ed25519 signing seed
    // comes from the Worker's environment, not a key file on the engine's disk.
    if (this.env.RECEIPT_SEED) vars.CONVERGE_RECEIPT_SEED = this.env.RECEIPT_SEED;
    return vars;
  }

  // ---- the engine: WebAssembly in this object ------------------------------------------------------
  //
  // converge's engine (C++, with aios's git) is compiled to WebAssembly and runs here, in the object
  // that owns the log: no container and no network between them. It starts empty and rebuilds its
  // state from our log on its first versioned call (409 -> replay); if it ever traps, the next call
  // starts a fresh one the same way. Its verification runs go to runner containers (dispatchJobs).

  private engine: Engine | null = null;
  private engineStarting: Promise<Engine> | null = null;

  private async getEngine(): Promise<Engine> {
    if (this.engine) return this.engine;
    // A fresh engine catches up from the whole log before anything else reaches it. Waiting for a versioned
    // call's 409 is not enough: a call that feeds it one new event (an agent joining, a task) would set its
    // version to the log's without the history, and it then landed changes knowing no earlier receipts, so
    // the receipt chain started again at 1.
    // The receipt seed: the RECEIPT_SEED secret, else the one kept here. With neither the engine makes one,
    // and it is kept once (never over one already kept), so the chain survives restarts without the secret.
    this.engineStarting ||= Engine.create({ engine_key: this.engineKey(), receipt_seed: this.env.RECEIPT_SEED || this.getMeta('receipt_seed') || '' })
      .then(async (e) => {
        if (e.generatedSeed) {
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)', 'receipt_seed', e.generatedSeed);
          e.generatedSeed = '';
        }
        const headers = { 'Content-Type': 'application/json', 'X-Engine-Key': this.engineKey() };
        const res = await e.request('/v1/replay', { method: 'POST', headers, body: JSON.stringify({ reset: true, events: this.log(), remotes: this.remotes() }) });
        if (!res.ok) throw new Error(`engine replay failed (${res.status}): ${await res.text()}`);
        this.engine = e;
        return e;
      })
      .finally(() => { this.engineStarting = null; });
    return this.engineStarting;
  }

  private async engineFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('X-Engine-Key', this.engineKey());
    if (this.env.ENGINE_URL) return fetch(new URL(path, this.env.ENGINE_URL), { ...init, headers });
    const engine = await this.getEngine();
    try {
      const res = await engine.request(path, { ...init, headers });
      this.dispatchJobs(engine);
      if (!/^\/v1\/(edges|sweep|replay)/.test(path)) this.askEdges(engine);
      return res;
    } catch (err) {
      // A trap (out of memory, an abort) leaves the instance unusable: drop it; the next call starts
      // a fresh engine, which catches up from the log.
      if (this.engine === engine) this.engine = null;
      throw err;
    }
  }

  // ---- cells edges: a ready or failed edge rose -> sweep -------------------------------------------
  //
  // GET /v1/edges?seen=N answers {"edges":M,"fired":bool,"seen":N}; in WebAssembly it answers at once.
  // Asked after each request this object serves and each run result. Fired -> one sweep, and M is the
  // next `seen`; M < N (a restarted engine) fires too: one sweep, then on from M.

  private edgesSeen = 0;
  private edgesAsking = false;
  private edgesAgain = false;

  private askEdges(engine: Engine): void {
    // Not while a fresh engine replays (it is not this.engine yet); one question at a time, and a request
    // served meanwhile asks once more when it is answered.
    if (this.engine !== engine) return;
    if (this.edgesAsking) { this.edgesAgain = true; return; }
    this.edgesAsking = true;
    const headers = { 'X-Engine-Key': this.engineKey(), 'X-State-Version': String(this.version()) };
    engine.request(`/v1/edges?seen=${this.edgesSeen}&timeout_ms=1000`, { headers })
      .then(async (res) => {
        if (!res.ok) return; // behind the log (409): the next call replays it, and asks again
        const { edges, fired } = (await res.json()) as { edges: number; fired: boolean };
        if (!fired || this.engine !== engine) return;
        this.edgesSeen = Number(edges) || 0;
        this.sweepLeases().catch((err) => console.error('sweep on an edge failed:', err));
      })
      .catch((err) => console.error('asking the engine for edges failed:', err))
      .finally(() => {
        this.edgesAsking = false;
        if (this.edgesAgain) {
          this.edgesAgain = false;
          this.askEdges(engine);
        }
      });
  }

  // ---- verification runs: runner containers ---------------------------------------------------------

  private runsInFlight = 0;

  /** Send the engine's queued verification jobs to runners; each result goes back and is collected. */
  private dispatchJobs(engine: Engine): void {
    engine.takeJobs().then((jobs) => {
      for (const job of jobs) {
        this.runsInFlight++;
        this.runJob(job)
          .then((result) => engine.jobDone(result))
          .catch((err) => engine.jobDone({ job_id: job.job_id, exit_code: -1, timed_out: false, output_tail: `[converge] the runner failed: ${String(err?.message || err)}\n` }))
          .then(() => this.askEdges(engine))
          .finally(() => {
            this.runsInFlight--;
            this.sweepLeases().catch((err) => console.error('sweep after a run failed:', err));
          });
      }
    }).catch((err) => console.error('taking verification jobs failed:', err));
  }

  /** One job on its workspace's own runner (see RUNNERS), or on the shared pool when that one cannot start. */
  private async runJob(job: any): Promise<any> {
    const t0 = Date.now();
    const project = this.getMeta('name') || '';
    const ws = String(job.workspace ?? '');
    let h = 0;
    for (const ch of ws) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const pooled = `${project}/${h % this.runnerCount()}`;
    const own = !project.startsWith('sandbox-') && /^(a-[0-9a-f]{8}|train)$/.test(ws) ? `${project}/w-${ws}` : '';
    let res: Record<string, unknown>;
    let where = own || pooled;
    try {
      res = (await this.env.RUNNER.get(this.env.RUNNER.idFromName(where)).run(job)) as Record<string, unknown>;
    } catch (err: any) {
      if (!own) throw err;
      // Its own runner did not start or answer: the check still runs, on the shared pool, and says where.
      where = pooled;
      res = (await this.env.RUNNER.get(this.env.RUNNER.idFromName(pooled)).run(job)) as Record<string, unknown>;
      const why = redactSecrets(String(err?.message || err)).slice(0, 200);
      res = { ...res, output_tail: `[converge] ran on the shared runner ${pooled}: this workspace's own runner could not start (${why})\n${String(res.output_tail ?? '')}` };
    }
    this.timingLog.push({ at: t0, what: `run:${job.kind}@${where.slice(project.length + 1)}`, wait_ms: 0, run_ms: Date.now() - t0 });
    return { ...res, job_id: job.job_id };
  }

  private remotes() {
    const main = this.getCreds('creds:main');
    const forks = this.rows("SELECT k, v FROM meta WHERE k >= 'creds:fork:' AND k < 'creds:fork;'").map((r) => {
      const c = JSON.parse(String(r.v)) as StoredCreds;
      return { agent_id: String(r.k).slice('creds:fork:'.length), url: c.remote, token: c.token };
    });
    return { ...(main ? { main: { url: main.remote, token: main.token } } : {}), forks };
  }

  /** Rebuild the engine from our log (always a reset: the log is the truth). */
  private async replayAll(): Promise<void> {
    const res = await this.engineFetch('/v1/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true, events: this.log(), remotes: this.remotes() }),
    });
    if (!res.ok) throw new Error(`engine replay failed (${res.status}): ${await res.text()}`);
  }

  /** Versioned engine call with the 409 -> reset replay -> retry handshake. Call inside serial(). */
  private async callEngine(path: string, body?: unknown): Promise<any> {
    await this.refreshCredentials();
    const post = body !== undefined;
    const init: RequestInit = {
      method: post ? 'POST' : 'GET',
      headers: { ...(post ? { 'Content-Type': 'application/json' } : {}), 'X-State-Version': String(this.version()) },
      body: post ? JSON.stringify(body) : undefined,
    };
    let res = await this.engineFetch(path, init);
    if (res.status === 409) {
      await this.replayAll();
      res = await this.engineFetch(path, init);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {
        // plain text
      }
      throw new EngineError(res.status, message);
    }
    return JSON.parse(text);
  }

  /** Re-mint Artifacts tokens that are about to expire and hand them to the engine. */
  private async refreshCredentials(): Promise<void> {
    const project = this.getMeta('name');
    if (!project || !this.env.ARTIFACTS) return;
    let changed = false;
    const targets: Array<[string, string]> = [['creds:main', project]];
    for (const r of this.rows("SELECT k FROM meta WHERE k >= 'creds:fork:' AND k < 'creds:fork;'")) {
      const agent = String(r.k).slice('creds:fork:'.length);
      targets.push([String(r.k), forkName(project, agent)]);
    }
    for (const [key, repoName] of targets) {
      const cur = this.getCreds(key);
      if (cur && !needsRefresh(cur.expiresAt)) continue;
      const fresh = await refreshCredentials(this.env.ARTIFACTS, repoName);
      this.setMeta(key, JSON.stringify({ remote: fresh.remote, token: fresh.token, expiresAt: fresh.expiresAt }));
      changed = true;
    }
    if (changed) {
      // Remotes only, no events: the engine re-points its fetch/push credentials.
      await this.engineFetch('/v1/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [], remotes: this.remotes() }),
      });
    }
  }

  // ---- RPC from the Worker ----------------------------------------------------------------------

  async exists(): Promise<boolean> {
    return this.getMeta('name') !== null;
  }

  /** Where the project came from, as recorded at creation; null for a project from before that was recorded. */
  async origin(): Promise<ProjectOrigin | null> {
    if (this.getMeta('name') === null) return null;
    const v = this.getMeta('origin');
    return v ? (JSON.parse(v) as ProjectOrigin) : null;
  }

  /**
   * Forget the project for good: the log, keys, credentials and any pending sweep. Answers the agents
   * that had forks (the Worker deletes those repositories), or busy while verification runs are in
   * flight (a run's result would land in a project that is gone).
   */
  async destroy(): Promise<{ busy: true } | { busy: false; forks: string[] }> {
    return this.serial(async () => {
      if (this.runsInFlight > 0) return { busy: true as const };
      const forks = this.rows("SELECT k FROM meta WHERE k >= 'creds:fork:' AND k < 'creds:fork;'").map((r) => String(r.k).slice('creds:fork:'.length));
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(1000, 'project deleted'); } catch { /* already closed */ }
      }
      for (const w of [...this.waiters]) w.wake();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.engine = null;
      this.lastPoll.clear();
      this.forkSeen.clear();
      this.timingLog = [];
      this.stateCache = null;
      this.foldCache.clear();
      // This instance may serve another call before it is evicted: empty tables, as a new object has.
      this.ensureTables();
      return { busy: false as const, forks };
    }, 'destroy');
  }

  async hasTask(taskId: string): Promise<boolean> {
    return this.rows("SELECT 1 FROM events WHERE json LIKE '%\"TaskCreated\"%' AND json LIKE ?", `%"task_id":"${taskId.replace(/[%_"\\]/g, '')}"%`).length > 0;
  }

  async createProject(name: string, repo: RepoCredentials, origin?: ProjectOrigin): Promise<void> {
    return this.serial(async () => {
      this.setMeta('name', name);
      if (origin) this.setMeta('origin', JSON.stringify(origin));
      this.setMeta('main_branch', repo.defaultBranch);
      this.setMeta('creds:main', JSON.stringify({ remote: repo.remote, token: repo.token, expiresAt: repo.expiresAt }));
      const res = await this.callEngine('/v1/project', { name, main_remote: repo.remote, main_token: repo.token, main_branch: repo.defaultBranch });
      this.record(res.events);
    });
  }

  async addAgent(role: string, agentId: string, fork?: RepoCredentials): Promise<{ agent_id: string; mcp_key: string }> {
    return this.serial(async () => {
      const mcp_key = generateKey('mcp_');
      try {
        // Plain INSERT: an id collision must fail, never replace another agent's key.
        this.ctx.storage.sql.exec('INSERT INTO keys (agent_id, key_hash, role) VALUES (?, ?, ?)', agentId, await hashToken(mcp_key), role);
      } catch {
        throw new Error(`Agent id ${agentId} already exists`);
      }
      if (fork) this.setMeta(`creds:fork:${agentId}`, JSON.stringify({ remote: fork.remote, token: fork.token, expiresAt: fork.expiresAt }));
      // The DO numbers events: record first, then feed the engine exactly that event.
      const [ev] = this.record([{ type: 'AgentAdded', agent_id: agentId, role }]);
      const res = await this.engineFetch('/v1/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [ev], remotes: this.remotes() }),
      });
      if (!res.ok) await this.replayAll();
      return { agent_id: agentId, mcp_key };
    });
  }

  async createTask(t: CreateTaskParam): Promise<{ task_id: string; main_branch: string }> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/task', t);
      this.record(res.events);
      this.scheduleSweep();
      return { task_id: t.task_id, main_branch: this.getMeta('main_branch') || 'main' };
    });
  }

  async isWorker(agentId: string): Promise<boolean> {
    return this.getMeta(`creds:fork:${agentId}`) !== null;
  }

  async joinTask(taskId: string, agent: TaskAgentParam, takeoverOf?: string): Promise<{ main_branch: string }> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/task', { task_id: taskId, join: true, ...(takeoverOf ? { takeover_of: takeoverOf } : {}), agents: [agent] });
      this.record(res.events);
      // Revoke the stalled agent: its key stops working, so it cannot come back and race its successor.
      if (takeoverOf) this.ctx.storage.sql.exec('DELETE FROM keys WHERE agent_id = ?', takeoverOf);
      return { main_branch: this.getMeta('main_branch') || 'main' };
    });
  }

  async configure(cfg: Record<string, unknown>): Promise<void> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/configure', cfg);
      this.record(res.events);
    });
  }

  /** A read of the receipts' transparency log: /log (the signed tree head) or /log/{inclusion,consistency,leaves}?... */
  async readLog(sub: string, search: string): Promise<{ status: number; body: any }> {
    // The engine's own refusal (no receipt for that commit, a size past the log) is the answer, with its status: an
    // error thrown across the Durable Object call would lose the status and reach the caller as "internal error".
    return this.serial(async () => {
      try { return { status: 200, body: await this.callEngine(`/v1${sub}${search}`) }; } catch (e) {
        if (e instanceof EngineError && e.status >= 400 && e.status < 500) return { status: e.status, body: { error: e.message } };
        throw e;
      }
    }, 'state');
  }

  async setAgentKey(agentId: string, key: string): Promise<{ events: number }> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/agent_key', { agent_id: agentId, key, by: 'operator' });
      return { events: this.record(res.events).length };
    });
  }

  async audit(events: unknown[]): Promise<{ recorded: number }> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/audit', { events });
      return { recorded: this.record(res.events).length };
    });
  }

  async onPush(p: { agent: string; ref: string; commit: string }): Promise<void> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/push', p);
      this.record(res.events);
    });
  }

  async getProjectState(): Promise<any> {
    // Serialized with writes: a read racing an in-flight write would see the engine one version
    // ahead of the log and force a pointless reset.
    return this.serial(() => this.callEngine('/v1/state'), 'state');
  }

  /** The live snapshot, shared for STATE_CACHE_MS while no event lands (a new socket). */
  async cachedState(): Promise<any> {
    const v = this.version();
    const c = this.stateCache;
    if (c && c.v === v && Date.now() - c.at < STATE_CACHE_MS) return c.p;
    const p = this.getProjectState();
    this.stateCache = { at: Date.now(), v, p };
    p.catch(() => { if (this.stateCache?.p === p) this.stateCache = null; });
    return p;
  }

  /** How many agents (workers and reviewers) hold a key here. */
  async agentCount(): Promise<number> {
    return Number(this.rows('SELECT COUNT(*) AS n FROM keys')[0]?.n || 0);
  }

  /** The snapshot of a fresh state folded with exactly the log's events up to and including `at`. */
  async stateAt(at: number): Promise<any> {
    // Past the end is the same fold as the end; a fold of what is recorded never changes, so it is kept.
    const upTo = Math.min(at, this.version());
    const kept = this.foldCache.get(upTo);
    if (kept) return kept;
    const p = this.serial(async () => {
      const events = this.rows('SELECT seq, at, json FROM events WHERE seq <= ? ORDER BY seq', upTo)
        .map((r) => ({ ...JSON.parse(String(r.json)), seq: Number(r.seq), at: Number(r.at) }));
      return this.callEngine('/v1/fold', { events });
    }, 'state-at');
    this.foldCache.set(upTo, p);
    if (this.foldCache.size > 16) this.foldCache.delete(this.foldCache.keys().next().value!);
    p.catch(() => this.foldCache.delete(upTo));
    return p;
  }

  /** Ask the agent to rewind to `cycle` (recorded as an event; the agent state flips when its Rewound lands). */
  async rewindAgent(agentId: string, cycle: number): Promise<any> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/rewind_agent', { agent_id: agentId, cycle, by: 'operator' });
      this.record(res.events);
      return res;
    });
  }

  /** Unified diff between the cycle snapshots of the agent's fork. Read-only: no events. */
  /** One agent's cycles in full (reply and observation included), from the log; the snapshot keeps only a short window without them. */
  async agentCycles(agentId: string): Promise<{ cycles: any[] }> {
    const rows = this.rows("SELECT seq, at, json FROM events WHERE json LIKE '%\"type\":\"Acted\"%' AND json LIKE ? ORDER BY seq DESC LIMIT 500",
      `%"agent_id":"${agentId.replace(/[%_"\\]/g, '')}"%`);
    const cycles = rows.reverse().map((r) => ({ ...JSON.parse(String(r.json)), seq: Number(r.seq), at: Number(r.at) })).filter((e) => e.agent_id === agentId);
    return { cycles };
  }

  /** A change's own edits as a unified diff, for the board (read-only; asked as a reviewer would). */
  async changeDiff(changeId: string): Promise<{ diff: string }> {
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diff', arguments: { change_id: changeId } } });
    const r = await this.serial(() => this.callEngine('/v1/mcp', { agent_id: 'board', role: 'reviewer', request }), 'board-diff');
    const result = JSON.parse(r.reply || '{}').result || {};
    if (result.isError) throw new Error(result.content?.[0]?.text || 'no diff');
    return { diff: String(result.diff ?? JSON.parse(result.content?.[0]?.text || '{}').diff ?? '') };
  }

  async cycleDiff(agentId: string, from: number, to: number): Promise<any> {
    return this.serial(() => this.callEngine('/v1/cycle_diff', { agent_id: agentId, from, to }));
  }

  /** CAS-lands a commit that rewinds main; the returned events carry the signed receipt. */
  async rewindMain(commit: string): Promise<any> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/rewind_main', { commit, by: 'operator' });
      this.record(res.events);
      return res;
    });
  }

  /** Takes back one operation (a landing, a rewind, an undo, a configuration): the engine's /v1/undo. */
  async undo(seq: number): Promise<any> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/undo', { seq, by: 'operator' });
      this.record(res.events);
      return res;
    });
  }

  private async authenticate(mcpKey: string): Promise<{ agent_id: string; role: string } | null> {
    const r = this.rows('SELECT agent_id, role FROM keys WHERE key_hash = ?', await hashToken(mcpKey));
    return r.length ? { agent_id: String(r[0].agent_id), role: String(r[0].role) } : null;
  }

  async handleMcp(mcpKey: string, body: string): Promise<{ status: number; body: string }> {
    const who = await this.authenticate(mcpKey);
    if (!who) return { status: 401, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized: invalid MCP key' } }) };

    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
    }
    if (Array.isArray(msg)) return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batching is not supported' } }) };

    if (msg.method === 'tools/call' && msg.params?.name === 'git_credentials') {
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: await this.gitCredentials(who.agent_id) }) };
    }

    let res: any;
    try {
      const label = `mcp:${msg.method === 'tools/call' ? String(msg.params?.name || '') : msg.method}`;
      const forkHead = who.role === 'worker' && msg.method === 'tools/call' && ['status', 'submit'].includes(String(msg.params?.name)) ? await this.forkHead(who.agent_id) : undefined;

      const ask = () => this.serial(async () => {
        // Artifacts reports pushes per repository only, so a fork's pushes may never arrive as events:
        // before a worker's status or submit, ask the engine whether its fork has moved (it fetches the
        // fork and records a push only if the head is new).
        const tool = msg.method === 'tools/call' ? String(msg.params?.name || '') : '';
        // A fetch per status call queues every agent behind every other (this object is serial): a
        // status polls an agent's fork at most every POLL_MS; a submit always does.
        const now = Date.now();
        const due = tool === 'submit' || (tool === 'status' && now - (this.lastPoll.get(who.agent_id) || 0) > POLL_MS);
        // Artifacts answered (outside this queue) that the fork is where the engine last saw it: skip
        // the fetch, which would cost the engine a network round trip while everyone else waits.
        const unmoved = forkHead !== undefined && forkHead === this.forkSeen.get(who.agent_id);
        if (who.role === 'worker' && due && !unmoved) {
          this.lastPoll.set(who.agent_id, now);
          try {
            const t0 = Date.now();
            const polled = await this.callEngine('/v1/push', { agent: who.agent_id, ref: `refs/heads/${this.getMeta('main_branch') || 'main'}`, poll: true });
            this.timingLog.push({ at: t0, what: 'fork-poll', wait_ms: 0, run_ms: Date.now() - t0 });
            this.record(polled.events);
            if (forkHead !== undefined) this.forkSeen.set(who.agent_id, forkHead);
          } catch { /* an unreachable fork: the call answers from what is known */ }
        }
        const r = await this.callEngine('/v1/mcp', { agent_id: who.agent_id, role: who.role, request: body });
        this.record(r.events);
        if (r.events?.some((e: any) => e.type === 'Submitted')) this.scheduleSweep(1); // collect the test run soon
        return r;
      }, label);
      res = await ask();
      // status {wait: true}: while the change is submitted and nothing has failed (checks pending, or
      // the merge train still to come), hold the call until something happens to it, then answer.
      if (msg.method === 'tools/call' && msg.params?.name === 'status' && msg.params?.arguments?.wait === true && who.role === 'worker') {
        const deadline = Date.now() + WAIT_STATUS_MS;
        for (let st = statusOf(res); st && awaitingLanding(st) && Date.now() < deadline; st = statusOf(res)) {
          await this.waitChange(who.agent_id, String(st.change_id || ''), Math.min(25_000, deadline - Date.now()));
          res = await ask();
        }
      }
    } catch (err: any) {
      // The detail (engine internals, a remote's URL) stays in the log; the agent gets a reference to it.
      const ref = crypto.randomUUID().slice(0, 8);
      console.error(`[${ref}] mcp ${msg.method}:`, redactSecrets(String(err?.stack || err), [this.env.ADMIN_KEY, this.env.ENGINE_SHARED_KEY]));
      return { status: 500, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: `converge engine error (ref ${ref}); try again` } }) };
    }
    this.scheduleSweep();
    if (!res.reply) return { status: 202, body: '' };
    if (msg.method === 'tools/list' && who.role === 'worker') {
      const reply = JSON.parse(res.reply);
      reply.result?.tools?.push(CREDENTIALS_TOOL);
      return { status: 200, body: JSON.stringify(reply) };
    }
    return { status: 200, body: res.reply };
  }

  private async gitCredentials(agentId: string): Promise<any> {
    const project = this.getMeta('name')!;
    let creds = this.getCreds(`creds:fork:${agentId}`);
    if (!creds) return { isError: true, content: [{ type: 'text', text: 'You have no fork (reviewers do not push).' }] };
    if (needsRefresh(creds.expiresAt) && this.env.ARTIFACTS) {
      const fresh = await refreshCredentials(this.env.ARTIFACTS, forkName(project, agentId));
      creds = { remote: fresh.remote, token: fresh.token, expiresAt: fresh.expiresAt };
      this.setMeta(`creds:fork:${agentId}`, JSON.stringify(creds));
    }
    const branch = this.getMeta('main_branch') || 'main';
    const data = { remote: creds.remote, token: creds.token, expires_at: creds.expiresAt, main_branch: branch, push_to: `git push ${creds.remote} HEAD:${branch}` };
    return { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }], ...data };
  }

  // ---- leases -----------------------------------------------------------------------------------

  private leaseMs(): number {
    const v = Number(this.env.LEASE_MS);
    return Number.isFinite(v) && v >= 1000 ? v : DEFAULT_LEASE_MS;
  }

  /** Keep one sweep pending while the project is active (`soon` seconds overrides the lease cadence). */
  private scheduleSweep(soon?: number): void {
    const at = Date.now() + 1000 * (soon ?? Math.max(30, Math.round(this.leaseMs() / 4000)));
    // One alarm: an earlier one already set stands; a sooner request moves it up.
    this.ctx.storage.getAlarm().then((cur) => {
      if (cur === null || at < cur) return this.ctx.storage.setAlarm(at);
    }).catch((err) => console.error('could not schedule the sweep:', err));
  }

  override async alarm(): Promise<void> {
    await this.sweepLeases();
  }

  private runnerCount(): number {
    return (this.getMeta('name') || '').startsWith('sandbox-') ? SANDBOX_RUNNERS : RUNNERS;
  }

  /** Wake every runner of this project (before a big run, so no check waits on a cold container). */
  async warmRunners(): Promise<{ warm: number; of: number }> {
    const name = this.getMeta('name');
    // Bounded: a runner that cannot start within a minute (the account's live-instance cap, a slow
    // start) is reported, not waited for; a cold runner still works, only its first check is slower.
    const one = (i: number) => Promise.race([
      this.env.RUNNER.get(this.env.RUNNER.idFromName(`${name}/${i}`)).warm().catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 60_000)),
    ]);
    const ok = await Promise.all(Array.from({ length: this.runnerCount() }, (_, i) => one(i)));
    return { warm: ok.filter(Boolean).length, of: this.runnerCount() };
  }

  /** A read-only question to the engine's live state in ASQL (one SELECT or SHOW; the engine refuses anything else). */
  async readSql(q: string): Promise<any> {
    return this.serial(() => this.callEngine(`/v1/read/sql?q=${encodeURIComponent(q)}`), 'read-sql');
  }

  /** The jail on this project's first runner, held to its promises (check-jail.sh, run in the container). */
  async jailReport(): Promise<Record<string, unknown>> {
    const runner = this.env.RUNNER.get(this.env.RUNNER.idFromName(`${this.getMeta("name")}/jail-${JAIL_IMAGE}`));
    if (!(await runner.warm())) throw new Error('the runner did not start');
    return runner.jailReport();
  }

  /** One sweep now, answering what the engine said (operator diagnostics). */
  async sweepNow(): Promise<any> {
    return this.serial(async () => {
      const res = await this.callEngine('/v1/sweep', { lease_ms: this.leaseMs() });
      this.record(res.events);
      return res;
    }, 'sweep');
  }

  async sweepLeases(): Promise<void> {
    const { claims, pending } = await this.serial(async () => {
      const res = await this.callEngine('/v1/sweep', { lease_ms: this.leaseMs() });
      this.record(res.events);
      return { claims: Number(res.leases) || 0, pending: Number(res.pending) || 0 };
    }, 'sweep');
    // A run's result brings its own sweep the moment it arrives (dispatchJobs); this is the fallback.
    if (pending > 0) this.scheduleSweep(this.runsInFlight > 0 ? 5 : 1);
    else if (claims > 0) this.scheduleSweep(); // someone still holds a lease: keep watching
  }

  // ---- WebSocket --------------------------------------------------------------------------------

  /** An event or snapshot as watchers see it: any credential an agent printed (its env, a URL) cut out. */
  private shown(ev: unknown): string {
    return redactSecrets(JSON.stringify(ev), [this.env.ADMIN_KEY, this.env.VIEW_KEY, this.env.ENGINE_SHARED_KEY]);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not Found', { status: 404 });
    // Capped per address (the Worker passes the one it saw) and per project.
    const netTag = `net:${(request.headers.get('X-Converge-Net') || 'unknown').slice(0, 64)}`;
    if (this.ctx.getWebSockets('view').length >= WS_PER_PROJECT) return new Response('too many watchers', { status: 503 });
    if (this.ctx.getWebSockets(netTag).length >= WS_PER_NET) return new Response('too many sockets from your address', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['view', netTag]);
    this.cachedState()
      .then((snapshot) => server.send(this.shown({ type: 'snapshot', ...snapshot })))
      .catch((err) => console.error('snapshot for new socket failed:', err));
    // A browser that offered its key as a subprotocol (auth.ts wsProtocolKey) must hear one back, or it drops the socket.
    const offered = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((x) => x.trim());
    const headers: Record<string, string> = offered.includes(WS_PROTOCOL) ? { 'Sec-WebSocket-Protocol': WS_PROTOCOL } : {};
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') ws.send('pong');
  }
}
