// The verification runner: converge's engine hands this process a job, it checks out the commit
// the job names and runs the job's script fenced by converge-jail, then answers with the result.
//
//   import { runJob, createRunner } from './runner.mjs'
//   node runner/runner.mjs               an HTTP server: POST /run, GET /health, GET /jail
//                                        (/run only once the jail's startup probe has held)
//
// Node >= 18 built-ins only. Nothing here reaches the network on its own: the only network use is
// the `git fetch` of the job's remote, which the engine's token authorises.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import os, { cpus } from 'node:os';
import { join, resolve } from 'node:path';

const OUT_TAIL_BYTES = 8000;

// A workspace name goes into a path: keep it to the characters that cannot escape <root>.
function safeName(workspace) {
  return String(workspace ?? '').replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

// Spawn a command, collect stdout+stderr in arrival order, and kill the whole process group on
// timeout (the child is detached, so -pid is the group).
function exec(command, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true, // own process group, so a timeout kills grandchildren too
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, signal: null, timedOut: false, output: Buffer.alloc(0), spawnError: String(err && err.message || err) });
      return;
    }
    const chunks = [];
    let bytes = 0;
    const onData = (buf) => {
      chunks.push(buf);
      bytes += buf.length;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const started = Date.now();
    let timedOut = false;
    let timer = null;
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone */ }
        try {
          child.kill('SIGKILL');
        } catch { /* already gone */ }
      }, opts.timeoutMs);
      timer.unref?.();
    }
    child.on('error', (err) => {
      chunks.push(Buffer.from(String(err && err.message || err)));
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code === null ? -1 : code,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        output: Buffer.concat(chunks, bytes),
      });
    });
  });
}

async function git(args, opts, env) {
  // The workspace belongs to the jail's uid after a run; the runner's own git must still use it.
  return exec(opts.git || 'git', ['-c', 'safe.directory=*', ...args], {
    cwd: opts.cwd,
    env: { ...env },
    timeoutMs: 0,
  });
}

// The result shape the engine reads. Never thrown: a failed fetch or checkout is exit_code -1 with
// git's message in output_tail.
function result(job, { exitCode, timedOut, durationMs, output }) {
  const buf = Buffer.isBuffer(output) ? output : Buffer.from(String(output ?? ''), 'utf8');
  const tail = buf.length > OUT_TAIL_BYTES ? buf.subarray(buf.length - OUT_TAIL_BYTES) : buf;
  return {
    kind: job.kind ?? null,
    change_id: job.change_id ?? null,
    commit: job.commit ?? null,
    command: job.script ?? '',
    exit_code: exitCode,
    timed_out: Boolean(timedOut),
    duration_ms: durationMs,
    output_tail: tail.toString('utf8'),
    output_sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

// Run one job. opts: { root, jail, uid, git }
//   root  workspaces live in <root>/ws-<workspace>
//   jail  path to converge-jail, or '' to run unfenced (tests only)
//   uid   passed to the jail as --fallback-uid
//   git   the git binary (default 'git')
//   chown a function used to give the uid the workspace when running as root (tests can stub it)
export async function runJob(job, opts = {}) {
  const root = opts.root || '/work';
  const jail = opts.jail === undefined ? '' : opts.jail;
  const gitBin = opts.git || 'git';
  const ws = join(root, 'ws-' + safeName(job.workspace));
  const started = Date.now();

  // 1. the workspace: create it and make it a git repo if it is not one yet.
  try {
    mkdirSync(ws, { recursive: true });
  } catch (err) {
    return result(job, { exitCode: -1, timedOut: false, durationMs: Date.now() - started,
      output: Buffer.from('cannot create workspace ' + ws + ': ' + String(err && err.message || err)) });
  }
  if (!existsSync(join(ws, '.git'))) {
    const init = await git(['init', '-q'], { cwd: ws, git: gitBin }, process.env);
    if (init.code !== 0) {
      return result(job, { exitCode: -1, timedOut: false, durationMs: Date.now() - started, output: init.output });
    }
  }

  // 2. fetch and check out the commit. A failure here is a result, not a throw.
  const fetchEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const fetchArgs = [];
  if (job.token) {
    fetchArgs.push('-c', 'http.extraHeader=Authorization: Basic ' + b64('x:' + job.token));
  }
  fetchArgs.push('fetch', '-q', '--no-tags', job.remote, job.ref || job.commit);
  const fetched = await git(fetchArgs, { cwd: ws, git: gitBin }, fetchEnv);
  if (fetched.code !== 0) {
    return result(job, { exitCode: -1, timedOut: false, durationMs: Date.now() - started, output: fetched.output });
  }
  const checkout = await git(['checkout', '-q', '-f', '--detach', job.commit], { cwd: ws, git: gitBin }, fetchEnv);
  if (checkout.code !== 0) {
    return result(job, { exitCode: -1, timedOut: false, durationMs: Date.now() - started, output: checkout.output });
  }
  const clean = await git(['clean', '-q', '-ffdx'], { cwd: ws, git: gitBin }, fetchEnv);
  if (clean.code !== 0) {
    return result(job, { exitCode: -1, timedOut: false, durationMs: Date.now() - started, output: clean.output });
  }

  const script = job.script ?? '';
  const timeoutS = Number(job.timeout_s);
  const timeoutMs = Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS * 1000 : 0;

  // 3. run the script. With a jail: --rw the workspace and /dev/null, --ro the system dirs that
  // exist, then the command. Without one (tests only) run /bin/sh directly.
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: ws };
  let spawnCmd;
  let spawnArgs;
  if (jail) {
    if (opts.uid && typeof process.getuid === 'function' && process.getuid() === 0) {
      const chown = opts.chown || defaultChown;
      await chown(ws, opts.uid);
    }
    const args = ['--rw', ws, '--rw', '/dev/null'];
    for (const d of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/proc', '/dev']) {
      if (existsSync(d)) args.push('--ro', d);
    }
    if (opts.uid) args.push('--fallback-uid', String(opts.uid));
    args.push('--', '/bin/sh', '-c', script);
    spawnCmd = jail;
    spawnArgs = args;
  } else {
    spawnCmd = '/bin/sh';
    spawnArgs = ['-c', script];
  }
  const run = await exec(spawnCmd, spawnArgs, { cwd: ws, env, timeoutMs });

  // A signal death reads as 128 + n (POSIX); a plain exit keeps its code.
  const exitCode = run.signal ? 128 + signalNumber(run.signal) : run.code;
  return result(job, {
    exitCode,
    timedOut: run.timedOut,
    durationMs: Date.now() - started,
    output: run.output,
  });
}

const SIGNALS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23,
  SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30,
  SIGSYS: 31,
};

function signalNumber(signal) {
  if (typeof signal === 'number') return signal;
  return SIGNALS[String(signal)] || 0;
}

async function defaultChown(path, uid) {
  try {
    const { spawnSync } = await import('node:child_process');
    spawnSync('chown', ['-R', String(uid), path], { stdio: 'ignore' });
  } catch { /* chown is best-effort: a failure shows up when the script cannot write */ }
}

// A queue that runs at most `parallel` jobs at once and at most one at a time per workspace, in
// submission order.
export function createRunner(opts = {}) {
  const parallel = Math.max(1, Number(opts.parallel) || (cpus().length || 1));
  let running = 0;
  const queue = [];
  const busy = new Set(); // workspaces with a job currently running
  // With a jail, each running job gets a uid of its own (opts.uidBase + 1, + 2, ...), back in the pool
  // when it finishes: no two concurrent runs share one, and the numbers stay few.
  const freeUids = [];
  for (let i = parallel; i >= 1; i--) freeUids.push((Number(opts.uidBase) || 61000) + i);

  function pump() {
    while (running < parallel) {
      const idx = queue.findIndex((e) => !busy.has(e.key));
      if (idx < 0) return;
      const entry = queue.splice(idx, 1)[0];
      running += 1;
      busy.add(entry.key);
      const uid = opts.jail ? freeUids.pop() : undefined;
      Promise.resolve()
        .then(() => runJob(entry.job, { ...opts, uid, workspace: entry.job.workspace }))
        .catch((err) => ({
          kind: entry.job.kind ?? null,
          change_id: entry.job.change_id ?? null,
          commit: entry.job.commit ?? null,
          command: entry.job.script ?? '',
          exit_code: -1,
          timed_out: false,
          duration_ms: 0,
          output_tail: String(err && err.stack || err),
          output_sha256: createHash('sha256').update(String(err && err.stack || err)).digest('hex'),
        }))
        .then((res) => {
          running -= 1;
          busy.delete(entry.key);
          if (uid !== undefined) freeUids.push(uid);
          entry.resolve(res);
          pump();
        });
    }
  }

  return {
    submit(job) {
      return new Promise((resolve) => {
        const key = safeName(job.workspace);
        queue.push({ job, key, resolve });
        pump();
      });
    },
    stats() {
      return { running, queued: queue.length };
    },
  };
}

// --- the jail, held to what it promises on this machine ----------------------------------------
// GET /jail: scripts/check-jail.sh (shipped in the image) run against this runner's converge-jail,
// once per container: the kernel's own answers (write, read, symlink, network, uid) as ok/FAIL lines.
let jailReportPromise = null;
function jailReport(jail) {
  const script = process.env.CHECK_JAIL || '/check-jail.sh';
  if (!jail || !existsSync(jail) || !existsSync(script)) return Promise.resolve({ jail: jail || '', available: false });
  if (!jailReportPromise) {
    jailReportPromise = new Promise((resolve) => {
      const t0 = Date.now();
      execFile('bash', [script, jail], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const lines = String(stdout).split('\n').filter(Boolean);
        const checks = lines.filter((l) => /^(ok|FAIL) /.test(l)).map((l) => ({ ok: l.startsWith('ok'), name: l.replace(/^(ok|FAIL)\s+/, '') }));
        resolve({ jail, available: true, mode: (lines.find((l) => l.startsWith('mode:')) || '').slice(6), checks, failed: checks.filter((c) => !c.ok).length,
          skipped: lines.filter((l) => l.startsWith('SKIPPED ')).map((l) => l.slice(8)),
          exit_code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, output: lines.join('\n') + (stderr ? '\n' + String(stderr).slice(0, 2000) : ''),
          kernel: os.release(), uid: process.getuid?.() ?? -1, at: new Date().toISOString(), ms: Date.now() - t0 });
      });
    });
  }
  return jailReportPromise;
}

// --- the fence probe, before any job runs -------------------------------------------------------
// At startup the runner holds its jail to its promises (check-jail.sh when the image carries it, else a
// write-inside / write-outside probe of its own, as the engine's local verifier does) and serves /run only
// when the fence held: no failed check and at least one that ran. Without a jail it refuses /run unless
// RUNNER_ALLOW_UNFENCED=1 (tests and local experiments only).
async function ownProbe(jail, rootIn) {
  const root = resolve(rootIn);
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, '.jail-probe-'));
  const escape = join(root, '.jail-escape-' + process.pid);
  const uid = 61000;
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) await defaultChown(dir, uid);
    writeFileSync(join(root, '.jail-secret-' + process.pid), 'secret\n', { mode: 0o600 });
    const args = ['--rw', dir, '--rw', '/dev/null'];
    for (const d of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/proc', '/dev']) if (existsSync(d)) args.push('--ro', d);
    args.push('--fallback-uid', String(uid), '--', '/bin/sh', '-c',
      `echo ok > ${dir}/in && ! echo no > ${escape} 2>/dev/null && ! cat ${root}/.jail-secret-${process.pid} 2>/dev/null`);
    const r = await exec(jail, args, { cwd: dir, env: { PATH: process.env.PATH || '/usr/bin:/bin' }, timeoutMs: 20_000 });
    const inside = existsSync(join(dir, 'in'));
    const escaped = existsSync(escape);
    const checks = [
      { ok: r.code === 0 && inside, name: 'writes inside its read-write paths' },
      { ok: !escaped, name: 'cannot write outside them' },
      { ok: r.code === 0, name: "cannot read the runner's private files" },
    ];
    return { checks, failed: checks.filter((c) => !c.ok).length, output: r.output.toString('utf8').slice(0, 2000) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(escape, { force: true });
    rmSync(join(root, '.jail-secret-' + process.pid), { force: true });
  }
}

// { state: 'pending' | 'held' | 'failed' | 'unfenced', reason, report }
export async function probeFence(jail, root, { allowUnfenced = false } = {}) {
  if (!jail) {
    return allowUnfenced ? { state: 'unfenced', reason: 'no jail; RUNNER_ALLOW_UNFENCED=1 lets jobs run unfenced' }
      : { state: 'failed', reason: 'no converge-jail in this runner (set CONVERGE_JAIL, or RUNNER_ALLOW_UNFENCED=1 for tests)' };
  }
  if (!existsSync(jail)) return { state: 'failed', reason: `the jail ${jail} does not exist` };
  let report = await jailReport(jail);
  // No check script in the image (or it ran no check): the runner's own probe decides.
  if (!report.available || !(report.checks || []).length) report = { jail, available: true, probe: 'runner', ...(report.output ? { script_output: report.output } : {}), ...(await ownProbe(jail, root)) };
  const ran = (report.checks || []).length;
  if (!ran) return { state: 'failed', reason: 'the fence probe ran no check', report };
  if (report.failed > 0) {
    const names = report.checks.filter((c) => !c.ok).map((c) => c.name).join('; ');
    return { state: 'failed', reason: `the fence does not hold here: ${report.failed} of ${ran} checks failed (${names})`, report };
  }
  return { state: 'held', reason: `${ran} checks held${report.mode ? ` (mode ${report.mode})` : ''}`, report };
}

// --- the container entry point ---------------------------------------------------------------
// node runner/runner.mjs: an HTTP server the engine posts jobs to.
async function main() {
  const root = process.env.RUNNER_ROOT || '/work';
  const jailEnv = process.env.CONVERGE_JAIL;
  const jail = jailEnv !== undefined ? jailEnv : (existsSync('/converge-jail') ? '/converge-jail' : '');
  const key = process.env.RUNNER_KEY || '';
  const port = Number(process.env.PORT) || 8080;
  const runner = createRunner({ parallel: Number(process.env.RUNNER_PARALLEL) || undefined, root, jail, git: 'git' });
  // The fence is probed once, now, before any job: /run waits for the verdict and refuses if it failed.
  let fence = { state: 'pending', reason: 'the fence probe is running' };
  const fenceReady = probeFence(jail, root, { allowUnfenced: process.env.RUNNER_ALLOW_UNFENCED === '1' })
    .catch((err) => ({ state: 'failed', reason: 'the fence probe crashed: ' + String(err && err.message || err) }))
    .then((f) => {
      fence = f;
      // eslint-disable-next-line no-console
      console.log('runner fence: ' + f.state + ' (' + f.reason + ')');
      return f;
    });
  const fenceView = () => ({ state: fence.state, reason: fence.reason });

  const server = createServer((req, res) => {
    const send = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (key && req.headers['x-runner-key'] !== key) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/health') {
      const st = runner.stats();
      // ok: the process answers (the Container's start check); fenced: whether /run will run jobs.
      return send(200, { ok: true, fenced: fence.state === 'held' || fence.state === 'unfenced', fence: fenceView(), running: st.running, queued: st.queued });
    }
    if (req.method === 'GET' && req.url === '/jail') {
      fenceReady.then((f) => send(200, { ...(f.report || { jail, available: false }), fence: { state: f.state, reason: f.reason } }),
        (err) => send(500, { error: String(err && err.message || err) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/run') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let job;
        try {
          job = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          return send(400, { error: 'bad json' });
        }
        const f = await fenceReady;
        if (f.state !== 'held' && f.state !== 'unfenced') {
          return send(503, { error: 'this runner refuses to run jobs: ' + f.reason, fence: { state: f.state, reason: f.reason } });
        }
        try {
          // Through the queue: at most RUNNER_PARALLEL at once, one at a time per workspace.
          const out = await runner.submit(job);
          send(200, out);
        } catch (err) {
          send(500, { error: String(err && err.message || err) });
        }
      });
      return;
    }
    return send(404, { error: 'not found' });
  });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('runner listening on ' + port + (jail ? ' (jail ' + jail + ')' : ' (unfenced)'));
  });
}

const isMain = process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
