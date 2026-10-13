'use strict';

// The process-independent harness core.  CLI, GUI, and fleet adapters may
// choose their own transport, but lifecycle, durable state, events, execution,
// and error normalization belong here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { LifecycleBus } = require('./lifecycle-bus.cjs');
const { killTree } = require('./kill-tree.cjs');
const aiosStorage = (() => {
  try { return require('./aios-storage-bridge.cjs'); } catch { return null; }
})();

function defaultId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeError(error, context = {}) {
  const source = error instanceof Error ? error : new Error(String(error));
  return {
    name: source.name || 'Error',
    message: source.message || String(error),
    code: source.code == null ? null : source.code,
    retryable: context.retryable == null ? false : Boolean(context.retryable),
    phase: context.phase || null,
    details: context.details || null,
  };
}

class HarnessService {
  constructor(options = {}) {
    if (!options.stateDir) throw new TypeError('stateDir is required');
    this.stateDir = path.resolve(options.stateDir);
    this.bus = options.bus || new LifecycleBus();
    this.executor = options.executor || null;
    this.now = options.now || (() => new Date().toISOString());
    this.idFactory = options.idFactory || defaultId;
    this.onPersist = options.onPersist || null;
    this.state = null;
    this.seq = 0;
  }

  get id() { return this.state && this.state.taskId; }
  get dir() { return this.id ? path.join(this.stateDir, 'tasks', this.id) : null; }
  _statePath() { return path.join(this.dir, 'state.json'); }
  _eventsPath() { return path.join(this.dir, 'events.jsonl'); }

  _persistIndex() {
    const file = path.join(this.stateDir, 'index.json');
    let index = {};
    try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (Object.keys(index).length === 0 && aiosStorage && aiosStorage.globalTaskStore) {
      const cached = aiosStorage.globalTaskStore.get('index:tasks');
      if (cached && typeof cached === 'object') index = { ...cached };
    }
    const state = this.state;
    index[state.taskId] = {
      ...(index[state.taskId] || {}),
      workdir: state.workdir,
      runKey: state.runKey,
      // `kind` distinguishes a conversational turn from a gated run, and
      // `conversation` is the reverse map from a chat file to its task. Both are
      // here rather than only in state.json so a reader answering "is this
      // conversation busy?" needs ONE file read instead of a scan of every task.
      // Omitted keys stay absent (rather than writing nulls) so a run's row looks
      // exactly as it always did.
      ...(state.kind ? { kind: state.kind } : {}),
      ...(state.conversation ? { conversation: state.conversation } : {}),
      provider: state.provider,
      model: state.model,
      priority: state.priority || 'normal',
      objective: String(state.objective || '').slice(0, 100),
      status: state.status,
      step: state.step,
      tokensIn: state.tokens.in,
      tokensOut: state.tokens.out,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
    if (aiosStorage && aiosStorage.globalTaskStore) {
      aiosStorage.globalTaskStore.set('index:tasks', index);
    }
    fs.mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, file);
  }

  start(input = {}) {
    if (this.state) throw new Error('harness already started');
    const at = this.now();
    const { startEvent, tokens, timings_ms: timings, ...stateInput } = input;
    this.state = {
      ...stateInput,
      v: stateInput.v || 2,
      taskId: stateInput.taskId || this.idFactory(),
      status: stateInput.status || 'running',
      step: stateInput.step !== undefined ? stateInput.step : 1,
      createdAt: stateInput.createdAt || at,
      updatedAt: null,
      tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, ...(tokens || {}) },
      timings_ms: { model: 0, tools: 0, validation: 0, ...(timings || {}) },
    };
    this.seq = Number(this.state._seq) || 0;
    this.event('run_start', startEvent || {});
    this.save();
    return this.state;
  }

  resume(taskId) {
    if (this.state) throw new Error('harness already started');
    const file = path.join(this.stateDir, 'tasks', String(taskId), 'state.json');
    try {
      this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (aiosStorage && aiosStorage.globalTaskStore) {
        const cached = aiosStorage.globalTaskStore.get(`state:${taskId}`);
        if (cached && cached.taskId) {
          this.state = cached;
          this.seq = Number(this.state._seq) || 0;
          return this.state;
        }
      }
      throw new Error(`cannot load state for task ${taskId}: ${e.message}`);
    }
    this.seq = Number(this.state._seq) || 0;
    if (aiosStorage && aiosStorage.globalTaskStore) {
      aiosStorage.globalTaskStore.set(`state:${taskId}`, this.state);
    }
    return this.state;
  }

  save(patch) {
    if (!this.state) throw new Error('harness has not started');
    if (patch) Object.assign(this.state, patch);
    this.state.updatedAt = this.now();
    this.state._seq = this.seq;
    if (aiosStorage && aiosStorage.globalTaskStore) {
      aiosStorage.globalTaskStore.set(`state:${this.id}`, this.state);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this._statePath();
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, target);
    this._persistIndex();
    if (this.onPersist) this.onPersist(this.state);
    return this.state;
  }

  event(type, data = {}) {
    if (!this.state) throw new Error('harness has not started');
    const record = { seq: ++this.seq, ts: this.now(), type, ...data };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this._eventsPath(), `${JSON.stringify(record)}\n`);
    // Durable append happens first: listeners can fail without losing truth.
    Promise.resolve(this.bus.emit(type, record)).catch(() => {});
    return record;
  }

  transition(status, patch = {}) {
    const previous = this.state && this.state.status;
    this.save({ ...patch, status });
    this.event('state_transition', { previous, status });
    this.save();
    return this.state;
  }

  addTokens(usage = {}) {
    const tokens = this.state.tokens;
    tokens.in += usage.in || 0;
    tokens.out += usage.out || 0;
    tokens.cacheRead += usage.cacheRead || 0;
    tokens.cacheWrite += usage.cacheWrite || 0;
    return tokens;
  }

  setTokens(usage = {}) {
    if (!this.state) return null;
    this.state.tokens = {
      in: usage.in || 0,
      out: usage.out || 0,
      cacheRead: usage.cacheRead || 0,
      cacheWrite: usage.cacheWrite || 0,
    };
    return this.state.tokens;
  }

  addTiming(kind, milliseconds) {
    this.state.timings_ms[kind] = (this.state.timings_ms[kind] || 0) + milliseconds;
    return this.state.timings_ms[kind];
  }

  async execute(request, executor = this.executor) {
    if (typeof executor !== 'function') throw new TypeError('executor is required');
    const started = Date.now();
    this.event('execution_started', { request });
    try {
      const result = await executor(request, this.state);
      this.event('execution_succeeded', { ms: Date.now() - started });
      return result;
    } catch (error) {
      const normalized = normalizeError(error, { phase: 'execution' });
      this.event('execution_failed', { ms: Date.now() - started, error: normalized });
      throw Object.assign(error instanceof Error ? error : new Error(normalized.message), { harnessError: normalized });
    }
  }

  fail(error, context = {}) {
    const normalized = normalizeError(error, context);
    this.save({ status: context.status || 'failed', error: normalized });
    this.event('error', { error: normalized });
    this.save();
    return normalized;
  }

  events() {
    try {
      return fs.readFileSync(this._eventsPath(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch { return []; }
  }
}

// Transport used by terminal surfaces. It deliberately contains no rendering or
// command parsing: callers select a verb, while this client owns state lookup,
// event decoding, child lifecycle, cancellation, and the shared error shape.
class HarnessClient {
  constructor(options = {}) {
    if (!options.harnessPath) throw new TypeError('harnessPath is required');
    this.harnessPath = path.resolve(options.harnessPath);
    this.stateDir = path.resolve(options.stateDir || path.join(require('os').homedir(), '.universal-agent'));
    this.node = options.node || process.execPath;
    this.spawn = options.spawn || spawn;
    this.active = null;
    this.children = new Set(); // every live child, so more than one turn can run
  }

  list({ limit = 12, statuses } = {}) {
    let index = {};
    try { index = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'index.json'), 'utf8')); }
    catch (error) {
      if (error && error.code !== 'ENOENT') throw Object.assign(new Error(`cannot read harness state: ${error.message}`), { harnessError: normalizeError(error, { phase: 'state' }) });
    }
    if (Object.keys(index).length === 0 && aiosStorage && aiosStorage.globalTaskStore) {
      const cached = aiosStorage.globalTaskStore.get('index:tasks');
      if (cached && typeof cached === 'object') index = cached;
    }
    if (aiosStorage && aiosStorage.globalTaskStore && Object.keys(index).length > 0) {
      aiosStorage.globalTaskStore.set('index:tasks', index);
    }
    const allowed = statuses && new Set(statuses);
    return Object.entries(index)
      .map(([id, state]) => ({ id, ...state }))
      .filter((state) => !allowed || allowed.has(state.status))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, limit);
  }

  get(taskId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'tasks', String(taskId), 'state.json'), 'utf8'));
      if (aiosStorage && aiosStorage.globalTaskStore) {
        aiosStorage.globalTaskStore.set(`state:${taskId}`, parsed);
      }
      return parsed;
    }
    catch (error) {
      if (aiosStorage && aiosStorage.globalTaskStore) {
        const cached = aiosStorage.globalTaskStore.get(`state:${taskId}`);
        if (cached && cached.taskId) return cached;
      }
      const missing = error && error.code === 'ENOENT';
      throw Object.assign(new Error(missing ? `no harness task "${taskId}"; use list to see available tasks` : `cannot read task "${taskId}": ${error.message}`), {
        harnessError: normalizeError(error, { phase: 'state', details: { taskId: String(taskId) } }),
      });
    }
  }

  events(taskId) {
    this.get(taskId); // actionable not-found behavior instead of an empty trace
    const file = path.join(this.stateDir, 'tasks', String(taskId), 'events.jsonl');
    try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw Object.assign(new Error(`cannot read events for "${taskId}": ${error.message}`), { harnessError: normalizeError(error, { phase: 'events' }) });
    }
  }

  events(taskId) {
    this.get(taskId); // actionable not-found behavior instead of an empty trace
    const file = path.join(this.stateDir, 'tasks', String(taskId), 'events.jsonl');
    try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw Object.assign(new Error(`cannot read events for "${taskId}": ${error.message}`), { harnessError: normalizeError(error, { phase: 'events' }) });
    }
  }

  latest(statuses) { return this.list({ limit: 1, statuses })[0] || null; }

  // ONE PLACE A HARNESS CHILD IS CREATED.
  //
  // CONCURRENCY. This used to refuse outright while a child was running — one
  // harness command per client, which is right for a terminal (the CLI has one
  // foreground command and `cancel` means "that one") and wrong for every other
  // caller: gui/server.js deliberately runs several unrelated turns at once on
  // one machine, which is the entire reason its status push reports a LIST of
  // active workdirs rather than a busy boolean. Routing those spawns through here
  // would have thrown on the second turn. Children are tracked in a Set now, and
  // `active` keeps meaning "the most recent one" so cancel()'s existing
  // single-child contract is unchanged for the CLI.
  //
  // DETACHED is a caller's choice, and both choices are load-bearing: the CLI
  // wants its child to die with it, while gui/server.js wants children that
  // OUTLIVE a server restart (its busy state is derived from what those detached
  // children keep writing). cancel() already reaches the real tree either way via
  // killTree, rather than assuming a process group exists.
  // The spawn itself, returned SYNCHRONOUSLY.
  //
  // execute() owns a child's whole lifetime — it parses stdout into events and
  // resolves on close — which suits a caller that just wants the result. It does
  // not suit gui/server.js, whose streaming paths hold the child object, attach
  // their own stdout/stderr handlers, write to its stdin (steering, {t:'wrap'})
  // and hand it to a turn record. Those callers were therefore each assembling
  // the argv and spawn options themselves, which is how "one place a turn is
  // created" was still nine places.
  //
  // So the argv assembly, the tracking and the kill path live here, and both
  // shapes are built on it: execute() for "run it and tell me how it went",
  // spawnChild() for "give me the child, I am streaming it".
  spawnChild(args, options = {}) {
    if (this.active && options.concurrent !== true) throw new Error('a harness command is already running');
    const isElectron = Boolean(
      (process.versions && process.versions.electron) ||
      process.env.ELECTRON_RUN_AS_NODE ||
      /electron/i.test(path.basename(this.node || ''))
    );
    const childEnv = {
      ...(options.env || process.env),
      ...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    const child = this.spawn(this.node, [this.harnessPath, ...args], {
      cwd: options.cwd || process.cwd(),
      env: childEnv,
      detached: options.detached === true,
      // 'pipe', NOT 'inherit'. A streaming caller holds this child to read its
      // stdout and write steers to its stdin, so inheriting would hand it no pipes
      // at all — `child.stdout` comes back null and the first listener throws
      // (crashed the GUI on its first chat turn when this defaulted the other
      // way). execute() passes its own resolved stdio, which keeps 'inherit' as
      // the terminal shape's default.
      stdio: options.stdio || 'pipe',
    });
    this.active = child;
    this.children.add(child);
    // Bookkeeping is released on close no matter which shape spawned the child;
    // execute() adds its own close handler for the result, and both are safe
    // because `delete` on a Set is idempotent.
    child.once('close', () => {
      this.children.delete(child);
      if (this.active === child) this.active = this.children.size ? [...this.children][this.children.size - 1] : null;
    });
    if (options.onStart) options.onStart(child);
    return child;
  }
  execute(args, options = {}) {
    const stdio = options.stdio || 'inherit';
    let child;
    try {
      child = this.spawnChild(args, { ...options, stdio });
    } catch (error) {
      if (/already running/.test(error.message)) throw error; // the caller's contract, not a spawn failure
      return Promise.reject(Object.assign(error, { harnessError: normalizeError(error, { phase: 'start', retryable: true }) }));
    }
    let buffer = '';
    const emitLine = (line) => {
      if (options.onEvent) {
        try { options.onEvent(JSON.parse(line)); return; } catch {}
      }
      if (options.onOutput) options.onOutput(line);
    };
    if (stdio !== 'inherit' && child.stdout && (options.onEvent || options.onOutput)) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          emitLine(line);
        }
      });
    }
    return new Promise((resolve, reject) => {
      let stderr = '';
      if (child.stderr && stdio !== 'inherit') { child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; if (options.onErrorOutput) options.onErrorOutput(chunk); }); }
      child.once('error', (error) => {
        // Same rule as the close handler: dropping a failed child must not clear a
        // newer live one.
        this.children.delete(child);
        if (this.active === child) this.active = this.children.size ? [...this.children][this.children.size - 1] : null;
        const wrapped = Object.assign(error, { harnessError: normalizeError(error, { phase: 'execution', retryable: true }) });
        if (options.onError) options.onError(wrapped.harnessError);
        reject(wrapped);
      });
      child.once('close', (code, signal) => {
        if (stdio !== 'inherit' && buffer.trim()) {
          const line = buffer.trim();
          emitLine(line);
        }
        this.children.delete(child);
        // `active` names the MOST RECENT child; a finishing child must not clear a
        // newer one that is still running, or cancel() would report "nothing is
        // running" about live work.
        if (this.active === child) this.active = this.children.size ? [...this.children][this.children.size - 1] : null;
        const result = { code: code == null ? 1 : code, signal: signal || null, canceled: Boolean(signal), stderr: stderr.trim() };
        if (options.onClose) options.onClose(result);
        resolve(result);
      });
    });
  }

  cancel(signal = 'SIGKILL') {
    const child = this.active;
    if (!child) return { canceled: false, reason: 'no harness command is running' };
    // execute() spawns this child WITHOUT detached:true (unlike gui/server.js's
    // spawnTracked), so it is never a process-group leader — `-child.pid` names
    // a group that doesn't exist, throws ESRCH, and the old code silently fell
    // back to signalling only the harness's own top-level process. Real work it
    // launched (a shell tool command, a CLI provider subprocess) kept running
    // after "cancel" reported success. killTree() walks /proc for the actual
    // descendant tree instead of depending on a process group existing, so it
    // reaches the same work regardless of how the child was spawned.
    try {
      const hit = killTree(child.pid, signal);
      return { canceled: true, pid: child.pid, signal, killed: hit };
    } catch (error) {
      throw Object.assign(new Error(`could not cancel harness command: ${error.message}`), { harnessError: normalizeError(error, { phase: 'cancel' }) });
    }
  }
}

module.exports = { HarnessService, HarnessClient, normalizeError };
