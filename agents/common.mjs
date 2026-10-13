// What converge's agents and scripts share: the git identity converge commits as, an HTTP-ish error, and where the
// programs converge runs are found: the universal agent in agents/universal, and the kernel (aios, the engine and the
// jail) in kernel/<os>-<arch>, both shipped in this repository. Kept under agents/ because the sandbox image copies
// agents/*.mjs and nothing else.
//
//   UNIVERSAL_AGENT  the universal agent (universal-agent.cjs)    default agents/universal/universal-agent.cjs
//   CONVERGE_KERNEL  the kernel folder                             default kernel/<os>-<arch>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

// A machine with no git identity (a fresh install: no user.name / user.email anywhere) refused converge's own git work
// ("fatal: empty ident name not allowed": aios-git writes an identity into every reflog, a clone included), so planning
// failed before it began. converge then gives git one of its own, for its processes only; a machine that has one keeps it.
if (!process.env.GIT_COMMITTER_NAME) {
  const configured = (k) => spawnSync('git', ['config', '--get', k], { encoding: 'utf8' }).stdout.trim();
  if (!configured('user.name') || !configured('user.email')) {
    for (const who of ['COMMITTER']) {   // the author stays each agent's own (its repository's user.name)
      process.env[`GIT_${who}_NAME`] ||= 'converge';
      process.env[`GIT_${who}_EMAIL`] ||= 'converge@localhost';
    }
  }
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The identity converge's own commits carry (seeds, imports, merges), as git's environment variables. */
export const GIT_IDENT = { GIT_AUTHOR_NAME: 'converge', GIT_AUTHOR_EMAIL: 'converge@localhost', GIT_COMMITTER_NAME: 'converge', GIT_COMMITTER_EMAIL: 'converge@localhost' };

/**
 * What running a project's own tools writes beside the work and is never part of a change: language caches and
 * installed dependencies. An agent's working copy ignores them (.git/info/exclude, local to its clone), so running
 * a test does not count as the agent writing a file it has not claimed, and `git add -A` never commits them.
 */
export const GENERATED_IGNORE = ['__pycache__/', '*.py[cod]', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/', '*.egg-info/',
  '.venv/', 'venv/', 'node_modules/', '.DS_Store'];

/** An Error carrying the HTTP status to answer with. */
export const httpError = (status, message) => Object.assign(new Error(message), { status });

/** The universal agent that ships in this repository (agents/universal). */
const UA_IN_REPO = (root) => path.resolve(root, 'agents', 'universal', 'universal-agent.cjs');

/** The universal agent's path: $UNIVERSAL_AGENT when set, else the copy in this repository; '' when it is missing. */
export function findUniversalAgent(root = ROOT) {
  const p = process.env.UNIVERSAL_AGENT ? path.resolve(process.env.UNIVERSAL_AGENT) : UA_IN_REPO(root);
  return fs.existsSync(p) ? p : '';
}
/** The path to use or name: the one found, else where it was expected. */
export const universalAgentPath = (root = ROOT) => findUniversalAgent(root) || (process.env.UNIVERSAL_AGENT ? path.resolve(process.env.UNIVERSAL_AGENT) : UA_IN_REPO(root));
/** What to say when the universal agent is not where it should be. */
export const missingUniversalAgent = (root = ROOT) => process.env.UNIVERSAL_AGENT
  ? `no universal agent at ${path.resolve(process.env.UNIVERSAL_AGENT)} (UNIVERSAL_AGENT)`
  : `no universal agent at ${UA_IN_REPO(root)}: this checkout is incomplete`;

/**
 * The model providers (keys, models, accounts, hosts): one source for everything that starts an agent. From ASQL where
 * converge keeps them; a run on Cloudflare has no ASQL, so its container is handed them in CONVERGE_RUN_PROVIDERS (JSON).
 */
// Loaded on demand: the sandbox image carries agents/*.mjs only.
export async function providerConfig() {
  if (process.env.CONVERGE_RUN_PROVIDERS) return JSON.parse(process.env.CONVERGE_RUN_PROVIDERS);
  return (await import('../scripts/lib/provider-store.mjs')).readAsql();
}
/** The environment that hands those providers to the universal agent, which reads them instead of ~/.converge/config.json. */
export async function providerEnv() {
  return { CONVERGE_PROVIDERS_JSON: JSON.stringify(await providerConfig()) };
}

// The kernel shipped in this repository: kernel/<os>-<arch>/ with bin/converge-engine, bin/converge-jail,
// bin/aios-agent-control, bin/git (aios-git), bin/aios-sh and runtime/intelligence/ (aios's agent runtime).
const KERNEL_OS = { linux: 'linux', darwin: 'darwin' }[process.platform] || process.platform;
const KERNEL_ARCH = { x64: 'x64', arm64: 'arm64' }[process.arch] || process.arch;
/** This machine's kernel folder name (linux-x64, darwin-arm64, ...). */
export const kernelName = () => `${KERNEL_OS}-${KERNEL_ARCH}`;
/** Where this machine's kernel folder is: $CONVERGE_KERNEL, else kernel/<os>-<arch> in this repository. */
const kernelPath = (root) => path.resolve(process.env.CONVERGE_KERNEL || path.join(root, 'kernel', kernelName()));
/** This machine's kernel folder, '' when the repository has none for it. */
export function kernelDir(root = ROOT) {
  const dir = kernelPath(root);
  return fs.existsSync(path.join(dir, 'VERSION')) ? dir : '';
}
/** What to say when nothing fits this machine. */
export const kernelHint = (root = ROOT) => `no kernel at ${kernelPath(root)}: converge ships kernel/linux-x64, kernel/darwin-arm64 and kernel/win32-x64, and this checkout has none for ${kernelName()}`;

/** aios's tree as the agent runtime sees it: the kernel's runtime/ folder. */
export const aiosDir = (root = ROOT) => path.join(kernelPath(root), 'runtime');
/** The bridge (the mind that thinks through the universal agent's providers): the copy in this repository. */
export const aiosBridge = (root = ROOT) => path.resolve(root, 'agents', 'universal', 'bridge.cjs');
/** This machine's executable suffix: '.exe' on Windows (where every kernel binary carries one), else ''. */
export const EXE_EXT = process.platform === 'win32' ? '.exe' : '';
/** p, or p+EXE_EXT when only that exists (a Windows build names its binaries with the suffix, every other host without one). */
function withExeFallback(p) {
  return EXE_EXT && !fs.existsSync(p) && fs.existsSync(p + EXE_EXT) ? p + EXE_EXT : p;
}

/** The aios agent-control service binary: the kernel's. */
export const aiosControlBin = (root = ROOT) => withExeFallback(path.join(kernelPath(root), 'bin', 'aios-agent-control'));
/**
 * The kernel's bin/ first on PATH, for this process and every one it starts: `git` there is aios-git (aios's own git
 * library), and aios-sh is the shell, wherever converge or its agents run them. CONVERGE_GIT=host leaves the host's git.
 */
export function kernelOnPath(root = ROOT) {
  const k = kernelDir(root);
  if (!k || process.env.CONVERGE_GIT === 'host' || !fs.existsSync(path.join(k, 'bin', 'git' + EXE_EXT))) return;
  const bin = path.join(k, 'bin');
  const cur = process.env.PATH || '';
  if (!cur.split(path.delimiter).includes(bin)) process.env.PATH = cur ? bin + path.delimiter + cur : bin;
}
/** A kernel binary (converge-engine, converge-jail) for this machine, '' when the repository has none. */
export function kernelBin(name, root = ROOT) {
  const k = kernelDir(root);
  if (!k) return '';
  const p = withExeFallback(path.join(k, 'bin', name));
  return fs.existsSync(p) ? p : '';
}
/**
 * converge's engine (or its jail) for this machine: $CONVERGE_ENGINE_BIN (the jail: $CONVERGE_JAIL, else beside that
 * engine), else the kernel's. '' when there is none.
 */
export function engineBin(name = 'converge-engine', root = ROOT) {
  const env = name === 'converge-engine' ? process.env.CONVERGE_ENGINE_BIN
    : process.env.CONVERGE_JAIL || (process.env.CONVERGE_ENGINE_BIN && path.join(path.dirname(process.env.CONVERGE_ENGINE_BIN), name));
  if (env) return path.resolve(env);
  return kernelBin(name, root);
}
// Providers aios's own API mind (intelligence/minds/openai.cjs) can think with when the bridge is not there.
export const AIOS_API_PROVIDERS = new Set(['deepseek', 'openai', 'openrouter', 'ollama']);
/**
 * What this machine lacks to run an agent as an aios entity (agents/aios-runtime.mjs), one line each; [] = ready.
 * The runtime and agent-control decide every action, converge-jail (agents/fenced.mjs) fences every command underneath,
 * and the mind is the universal agent's model layer (the bridge), or aios's API mind for an API provider when there is
 * no bridge (a scripted agent, --script, needs neither: aios's script mind replays it).
 */
export function aiosMissing({ root = ROOT, provider = '', jail = '', script = false } = {}) {
  const out = [];
  const runtime = path.join(aiosDir(root), 'intelligence', 'runtime', 'agent.mjs');
  if (!fs.existsSync(runtime)) out.push(`no aios runtime at ${runtime}: ${kernelHint(root)}`);
  if (!fs.existsSync(aiosControlBin(root))) out.push(`no aios-agent-control at ${aiosControlBin(root)}: ${kernelHint(root)}`);
  if (!jail) out.push(`no converge-jail: aios decides each command, the jail runs it fenced (${kernelHint(root)})`);
  if (!script && !fs.existsSync(aiosBridge(root)) && !AIOS_API_PROVIDERS.has(provider)) out.push(`no bridge at ${aiosBridge(root)} (the mind a ${provider || 'CLI'} agent thinks through): this checkout is incomplete`);
  return out;
}

/** chown -R without the chown program: the directory and everything under it (links themselves, never what they point at). */
export function chownTree(uid, dir, gid = -1) {
  const one = (p) => { try { fs.lchownSync(p, uid, gid); } catch { /* not ours to change */ } };
  const walk = (p) => {
    one(p);
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (!st.isDirectory()) return;
    let names = [];
    try { names = fs.readdirSync(p); } catch { return; }
    for (const n of names) walk(path.join(p, n));
  };
  walk(dir);
}

/**
 * Every process on this machine as { pid, ppid, comm, args }: read from /proc on Linux; macOS has no /proc, so there it is
 * ps's table. Empty on Windows (nothing here lists processes there).
 */
export function processTable() {
  if (process.platform === 'win32') return [];
  if (process.platform === 'linux' && fs.existsSync('/proc/self/stat')) {
    const out = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const m = /^\d+ \((.*)\) \S (\d+)/.exec(stat);   // the name may hold spaces and parentheses: it ends at the last ')'
        const last = stat.lastIndexOf(')');
        const ppid = /^ \S (\d+)/.exec(stat.slice(last + 1))?.[1];
        if (!m || ppid === undefined) continue;
        const args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
        out.push({ pid: d, ppid, comm: stat.slice(stat.indexOf('(') + 1, last), args: args || `[${stat.slice(stat.indexOf('(') + 1, last)}]` });
      } catch { /* gone between listing and reading */ }
    }
    return out;
  }
  const out = [];
  for (const l of (spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
    if (m) out.push({ pid: m[1], ppid: m[2], comm: m[3], args: m[4] });
  }
  return out;
}

// A request sent on a connection the server has already closed fails before the server reads a byte of it. That is
// what happens to the first call after this process blocked for longer than the server keeps an idle connection (a
// synchronous `git clone` of a large main: 14 s for converge itself, against 5 s): the pooled socket is dead, the
// request goes out on it, and fetch throws "other side closed". It crashed a whole run before any agent started.
// Such a request is sent once more, on a new connection. Anything else (a refusal, a timeout, an answer) is not retried.
const rawFetch = globalThis.fetch;
if (rawFetch && !rawFetch.convergeRetries) {
  const dead = (e) => ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(e?.cause?.code) || /other side closed/i.test(String(e?.cause?.message || ''));
  const steady = async (input, init) => {
    try { return await rawFetch(input, init); }
    catch (e) {
      if (!dead(e) || (init?.body && typeof init.body !== 'string')) throw e;
      return rawFetch(input, init);
    }
  };
  steady.convergeRetries = true;
  globalThis.fetch = steady;
}

/**
 * A repository taken straight from the platform's store when that store is on this machine (the local platform's
 * always is), with nothing travelling over HTTP. Its origin is then `remote`, so pushes still go through the git host.
 *
 * On Linux the new repository borrows the store's objects (git clone --shared: objects/info/alternates) and holds
 * only what its owner adds: an agent's copy of converge is its work tree, not another 400 MB of history, and ten
 * agents cost ten work trees. The store is only ever read (an agent's sandbox there sees the disk read-only outside
 * its own folders, and the aios runtime is given the store's objects folder to read: sharedObjects). Elsewhere the
 * sandbox hides the platform's folder from the agent, so the files are copied (never linked: nothing the owner can
 * write is a file the platform reads).
 *
 * false when there is no such store here (or CONVERGE_CLONE=http), or the copy failed: the caller clones over HTTP.
 */
export function cloneFromDisk(local, remote, dest) {
  if (!local || process.env.CONVERGE_CLONE === 'http' || !fs.existsSync(path.join(local, 'HEAD'))) return false;
  const how = process.platform === 'linux' && process.env.CONVERGE_CLONE !== 'copy' ? '--shared' : '--no-hardlinks';
  const a = spawnSync('git', ['clone', '-q', how, local, dest], { stdio: 'ignore' });
  const b = a.status === 0 && remote ? spawnSync('git', ['-C', dest, 'remote', 'set-url', 'origin', remote], { stdio: 'ignore' }) : a;
  if (a.status === 0 && b.status === 0) return true;
  fs.rmSync(dest, { recursive: true, force: true });
  return false;
}
/** The object folders a repository borrows from (objects/info/alternates, followed), for a sandbox to be let read them. */
export function sharedObjects(repo) {
  const out = [];
  const walk = (objects, depth) => {
    let text = '';
    try { text = fs.readFileSync(path.join(objects, 'info', 'alternates'), 'utf8'); } catch { return; }
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const dir = path.isAbsolute(line) ? line : path.resolve(objects, line);
      if (out.includes(dir) || depth > 5) continue;
      out.push(dir);
      walk(dir, depth + 1);
    }
  };
  walk(path.join(repo, '.git', 'objects'), 0);
  return out;
}

/** Stops a process and everything it started. A run's agents are their own process group on Linux and macOS (the
 *  group is signalled); Windows has no process groups to signal (process.kill(-pid) did nothing there, and Stop left
 *  every agent running), so there the whole tree is ended with taskkill. */
export function killGroup(pid, sig = 'SIGTERM') {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, sig); } catch { /* gone */ }
}

/** Claude Code's hidden thinking budget (MAX_THINKING_TOKENS) for an effort picked in the dashboard: a step of a coding
 *  agent or a plan is short work. Unset, it was whatever the machine's environment held (31,999 on one: a two-task plan
 *  wrote 10,000 tokens and took 47 s). CONVERGE_THINKING_TOKENS overrides; high effort keeps Claude Code's own. */
export function thinkingBudget(effort) {
  if (process.env.CONVERGE_THINKING_TOKENS) return process.env.CONVERGE_THINKING_TOKENS;
  return { off: '0', minimal: '1024', low: '4000', medium: '12000' }[String(effort || 'low')] || '';
}

/** The commit a ref of a repository's git folder points at, read from its files: converge's own git takes longer to
 *  start than this takes to read. `ref` defaults to what HEAD names. '' when it cannot be read. */
export function commitOf(gitDir, ref = '') {
  try {
    if (!ref) {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40,64}$/.test(head)) return head;
      ref = /^ref: (\S+)$/.exec(head)?.[1] || '';
      if (!ref) return '';
    }
    try { return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim(); } catch { /* packed */ }
    const line = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : '';
  } catch { return ''; }
}

/** Main's commit now, for a project's /main answer (m): read from the platform's repository on disk when there is one,
 *  else asked of its git server. '' when neither answers, which callers take as "main may have moved". */
export function mainCommitNow(m) {
  if (!m) return '';
  const ref = m.main_branch ? `refs/heads/${m.main_branch}` : 'HEAD';
  const local = m.main_local ? commitOf(m.main_local, m.main_branch ? ref : '') : '';
  if (local) return local;
  const auth = `http.extraHeader=Authorization: Basic ${Buffer.from(`x:${m.main_token}`).toString('base64')}`;
  return (spawnSync('git', ['-c', auth, 'ls-remote', m.main_remote, ref], { encoding: 'utf8', timeout: 30_000 }).stdout || '').split(/\s/)[0];
}

/** Whether main moved away from the commit a clone of it (its git folder) is at: true too when main's commit cannot be
 *  read, so a caller clones afresh rather than trust a clone it cannot vouch for. */
export const mainMoved = (m, gitDir) => { const now = mainCommitNow(m); return !now || commitOf(gitDir) !== now; };

/**
 * An agent's own signing key: a new Ed25519 key in OpenSSH's format (what git's gpg.format=ssh signs with), written to
 * `file` (0600) with its public line beside it (`file.pub`). The private half never leaves the agent's machine; converge
 * learns only the public line (the signing_key tool), and its landing receipts then name the key the landed head was
 * signed with, so anyone can check with `git verify-commit` that what landed is what that agent signed.
 */
export function makeSigningKey(file, comment) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const str = (b) => Buffer.concat([u32(b.length), Buffer.isBuffer(b) ? b : Buffer.from(b)]);
  const blob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  const pad = [];
  for (let i = 1; (priv.length + pad.length) % 8; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(blob), str(priv)]).toString('base64');
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pem, { mode: 0o600 });
  const line = `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
  fs.writeFileSync(`${file}.pub`, line + '\n');
  return { file, publicLine: line };
}
