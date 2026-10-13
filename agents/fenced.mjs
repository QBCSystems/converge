// Run a check command fenced by converge-jail: it may write only its own directory (and a scratch
// directory), read the system's programs and libraries, and reach no network. Checks can be written
// by a model (the planner), so they never run unfenced on the owner's machine.
//
// runFenced(command, cwd, { timeoutMs }) -> { status, stdout, stderr, fenced }
// When there is no jail here, nothing runs: { status: -1, fenced: false, stderr: why }.
// (converge-jail is Landlock on Linux and Seatbelt, sandbox-exec, on macOS: the same flags either way.)
//
// The agents' own fence on macOS is here too: on Linux the universal agent fences each command it runs with
// bubblewrap (its shared/sandbox.cjs: the whole system readable, only its work tree and a private /tmp writable,
// network allowed). A Mac has no bubblewrap, so there the whole agent runs under Seatbelt with the same policy
// (seatbeltProfile, agentFence): write its work tree, its run directory, tmp and its own state dirs only; read
// everything but the obvious secrets; network allowed (it must reach its model and converge).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kernelBin, kernelHint, chownTree, sharedObjects } from './common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// $CONVERGE_JAIL, else the repository's kernel/<os>-<arch>/bin.
const JAIL_CANDIDATES = [process.env.CONVERGE_JAIL, kernelBin('converge-jail', ROOT)];

export function jailPath() {
  return JAIL_CANDIDATES.find((p) => p && fs.existsSync(p)) || '';
}

// Where the kernel has no Landlock (Cloudflare's container VMs) and we are root, the jail runs the check
// as an unprivileged user of its own instead (files and other processes closed to it, no network fence).
function fallbackUid(jail) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return 0;
  const abi = Number(String(spawnSync(jail, ['--abi'], { encoding: 'utf8' }).stdout || '').trim()) || 0;
  return abi >= 4 ? 0 : 61999;
}

// ---- macOS: Seatbelt ----
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Secrets under $HOME an agent never reads (the bubblewrap fence leaves them readable; Seatbelt can do better). */
export const AGENT_SECRETS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  '.config/gh', '.config/gcloud', '.azure', '.converge-local', '.converge'];
/** State an agent and its CLI provider write under $HOME (logs, sessions, caches). */
export const AGENT_STATE = ['.converge', '.converge-console', '.universal-agent', '.claude', '.codex', '.gemini', '.cursor', '.npm', '.cache', 'Library/Caches'];
/** In those, what would run later outside the fence (hooks, settings, provider addresses): never written by an agent. */
export const AGENT_PROTECTED = ['.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md', '.claude/hooks', '.claude/agents',
  '.claude/commands', '.claude/skills', '.claude/plugins', '.codex/config.toml', '.codex/AGENTS.md', '.gemini/settings.json', '.converge/config.json'];

const sbq = (p) => `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const reEsc = (p) => String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sub = (paths) => paths.map((p) => ` (subpath ${sbq(p)})`).join('');

/**
 * A Seatbelt (sandbox-exec) profile, as a string. Pure: paths must already be resolved (macOS matches the real path:
 * /tmp is /private/tmp, /var is /private/var); resolveForSeatbelt does that.
 *   writable   directories (or files) the sandbox may write, and read even under a hidden one
 *   writableRe regular expressions of paths it may write (a file that is replaced by rename: ~/.claude.json*)
 *   hidden     paths it may not read (nor write)
 *   protect    paths it may not write even inside a writable one
 *   network    true: any; false: no TCP/UDP at all; [ports]: connecting out to those ports only
 */
export function seatbeltProfile({ writable = [], writableRe = [], hidden = [], protect = [], network = true } = {}) {
  const lines = ['(version 1)', '(allow default)'];
  if (hidden.length) lines.push(`(deny file-read* file-write*${sub(hidden)})`);
  lines.push('(deny file-write*)');
  if (writable.length || writableRe.length) lines.push(`(allow file-write*${sub(writable)}${writableRe.map((r) => ` (regex #"${String(r).replace(/"/g, '')}")`).join('')})`);
  if (writable.length) lines.push(`(allow file-read*${sub(writable)})`);
  // The folders between a hidden one and a writable one inside it (~/.converge, ~/.converge/local/runs, ... above an
  // agent's work tree) can be looked up, not read: resolving a path (node does, for every module it loads) stats each
  // folder on the way, and denied there it failed with EPERM, so no program could run in the work tree. Their listing
  // and their other contents stay hidden.
  const between = new Set();
  for (const w of writable) for (const h of hidden) {
    if (!w.startsWith(h + '/')) continue;
    for (let d = w; d.length >= h.length; d = path.dirname(d)) { if (d !== w) between.add(d); if (d === h) break; }
  }
  if (between.size) lines.push(`(allow file-read-metadata${[...between].map((d) => ` (literal ${sbq(d)})`).join('')})`);
  lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))');
  if (protect.length) lines.push(`(deny file-write*${sub(protect)})`);
  if (network !== true) {
    lines.push('(deny network-outbound (remote ip "*:*") (remote ip "localhost:*"))', '(deny network-bind (local ip "*:*") (local ip "localhost:*"))',
      '(deny network-inbound (local ip "*:*") (local ip "localhost:*"))');
    for (const port of Array.isArray(network) ? network : []) lines.push(`(allow network-outbound (remote ip "*:${Number(port)}") (remote ip "localhost:${Number(port)}"))`);
  }
  // Nothing outside the sandbox is signalled, driven by Apple Events, or started through launchd/LaunchServices
  // (a program started that way runs outside any fence).
  lines.push('(deny signal)', '(allow signal (target same-sandbox))', '(deny appleevent-send)',
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl"))');
  return lines.join('\n') + '\n';
}

/** The agent's policy (seatbeltProfile's input) for a home, its work tree, its run directory and its scratch/tmp dirs. */
export function agentPolicy({ home, workdir, stateDir, tmp = [], network = true }) {
  const h = home.replace(/\/+$/, '');
  return {
    writable: [workdir, stateDir, ...tmp, ...AGENT_STATE.map((d) => `${h}/${d}`)].filter(Boolean),
    writableRe: [`^${reEsc(h)}/\\.claude\\.json`],   // a regex literal (#"..."): one backslash escapes
    hidden: AGENT_SECRETS.map((d) => `${h}/${d}`),
    protect: AGENT_PROTECTED.map((d) => `${h}/${d}`),
    network,
  };
}

/** A path as Seatbelt sees it (its real path), or its nearest existing parent's real path joined with the rest. */
export function resolveForSeatbelt(p) {
  let head = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) { rest.unshift(path.basename(head)); head = path.dirname(head); }
  try { head = fs.realpathSync(head); } catch { /* keep it */ }
  return path.join(head, ...rest);
}

let seatbeltOk;
/** Whether sandbox-exec works here (macOS): it applies a profile and runs a program under it. */
export function seatbeltWorks() {
  if (process.platform !== 'darwin') return false;
  // A profile with every construct the real ones use (subpath, regex, ports), so one this macOS refuses shows here.
  const probe = seatbeltProfile({ ...agentPolicy({ home: resolveForSeatbelt(os.homedir()), workdir: resolveForSeatbelt(os.tmpdir()), stateDir: resolveForSeatbelt(os.tmpdir()) }), network: [443] });
  seatbeltOk ??= fs.existsSync(SANDBOX_EXEC) && spawnSync(SANDBOX_EXEC, ['-p', probe, '--', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' }).status === 0;
  return seatbeltOk;
}

// ---- Windows: converge-jail --agent (low integrity) ----
// The whole agent runs at low integrity under a job object (converge-jail --agent): it writes only what is
// labelled low (its work tree, its run directory, tmp, its own state dirs), reads everything but the hidden
// secrets (labelled no-read-up), never writes the protected files, and keeps the network (its model, converge).
// Git for Windows' bash cannot run at low integrity (its runtime needs objects only a medium process may make),
// so a fenced agent's shell is aios-sh (kernel/win32-x64/bin): aios' own POSIX shell, with the bash an agent
// writes ([[ ]], arrays, brace expansion, pipefail). Without it, cmd.exe (CONVERGE_BASH=none). Every other host runs the same
// shell, so a command means the same thing on all three.
/** A command line to run in the platform's sh: aios-sh (the kernel bundle's) on every host; without it /bin/sh, or cmd.exe on Windows. */
export function shellArgv(command) {
  const sh = kernelBin('aios-sh', ROOT);
  if (sh) return [sh, '-c', command];
  return process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command];
}
export function agentShell() {
  return kernelBin('aios-sh', ROOT) || 'none';
}
/** Under a Windows home, the same secrets and state as elsewhere, plus where Windows keeps them. */
// .converge/config.json holds the provider keys: the agent gets its providers from converge (CONVERGE_PROVIDERS_JSON), so
// here it is hidden as well as protected (the checks' fence hides it too).
const WIN_SECRETS = [...AGENT_SECRETS, 'AppData/Roaming/GitHub CLI', 'AppData/Roaming/gcloud', 'AppData/Roaming/npm/etc/npmrc', '.converge/config.json'];
const WIN_STATE = [...AGENT_STATE.filter((d) => d !== 'Library/Caches'), 'AppData/Local/npm-cache'];

/**
 * The folders to hide so that `keep` stays reachable. A hidden folder (labelled no-read-up) cannot even be looked at
 * from inside the fence, and node looks at every parent of a script it loads: with ~/.converge hidden, an agent whose
 * work tree is ~/.converge/local/runs/<run>/... failed every `node` it ran (EPERM on ~/.converge/local). So a hidden
 * folder that holds a kept path is not hidden itself: its other entries are, and so on down to the kept path.
 */
export function hideAround(dirs, keep) {
  const inside = (p, d) => { const r = path.relative(d, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  const out = [];
  const walk = (d) => {
    const k = keep.filter((p) => inside(p, d));
    if (!k.length) { out.push(d); return; }
    if (k.some((p) => path.relative(d, p) === '')) return;   // d is kept itself
    let entries = [];
    try { entries = fs.readdirSync(d); } catch { return; }
    for (const e of entries) walk(path.join(d, e));
  };
  for (const d of dirs) walk(d);
  return out;
}

/** The folders hideAround opened up: the hidden folders on the way down to a kept path, each one itself (not what is
 *  under it) back to the ordinary medium label. An earlier fence labelled the whole of ~/.converge no-read-up, and the
 *  jail only ever adds labels: without this, those folders stayed unreadable from inside the fence. */
function reopenParents(dirs, keep) {
  if (process.platform !== 'win32') return;
  const inside = (p, d) => { const r = path.relative(d, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  const open = new Set();
  for (const d of dirs) for (const k of keep) {
    if (!inside(k, d)) continue;
    for (let p = path.dirname(k); inside(p, d); p = path.dirname(p)) { open.add(p); if (p === d) break; }
  }
  for (const p of open) if (fs.existsSync(p)) spawnSync('icacls', [p, '/setintegritylevel', 'M'], { stdio: 'ignore', windowsHide: true });
}

/** Windows: every folder above these paths, up to the home folder, readable from inside the fence (a hidden,
 *  no-read-up label on one is set back to the ordinary medium one; nothing else about it changes). Once per folder. */
const reopened = new Set();
export function reopenAbove(paths) {
  if (process.platform !== 'win32') return;
  const home = path.resolve(os.homedir());
  for (const p of paths) {
    if (!p || !path.isAbsolute(p)) continue;
    for (let d = path.dirname(path.resolve(p)); d.length > home.length && d.toLowerCase().startsWith(home.toLowerCase()); d = path.dirname(d)) {
      if (reopened.has(d)) continue;
      reopened.add(d);
      const r = spawnSync('icacls', [d], { encoding: 'utf8', windowsHide: true });
      if (/Mandatory Label[^\n]*NR/.test(String(r.stdout))) spawnSync('icacls', [d, '/setintegritylevel', 'M'], { stdio: 'ignore', windowsHide: true });
    }
  }
}

let lowilOk;
/** Whether converge-jail --agent fences here (Windows): a write inside the fence works and one outside it does not. */
export function lowIntegrityWorks() {
  if (process.platform !== 'win32') return false;
  if (lowilOk !== undefined) return lowilOk;
  const jail = jailPath();
  if (!jail) return (lowilOk = false);
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-agent-probe-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-agent-escape-'));
  try {
    const script = "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.argv[1],'in'),'1');try{fs.writeFileSync(p.join(process.argv[2],'out'),'1')}catch{}";
    const r = spawnSync(jail, ['--agent', '--rw', inside, '--', process.execPath, '-e', script, inside, outside], { timeout: 20000, stdio: 'ignore', windowsHide: true });
    lowilOk = r.status === 0 && fs.existsSync(path.join(inside, 'in')) && !fs.existsSync(path.join(outside, 'out'));
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
  return lowilOk;
}

export const BWRAP_INSTALL = 'install bubblewrap (Debian/Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap; Arch: sudo pacman -S bubblewrap)';
let bwrapOk;
/** The fence agents get on this machine: { ok, kind: 'seatbelt' | 'bubblewrap' | 'lowil' | '', why }. */
export function agentSandbox() {
  if (process.platform === 'darwin') return seatbeltWorks() ? { ok: true, kind: 'seatbelt', why: '' } : { ok: false, kind: '', why: `${SANDBOX_EXEC} does not work here` };
  if (process.platform === 'win32') {
    return lowIntegrityWorks() ? { ok: true, kind: 'lowil', why: '' }
      : { ok: false, kind: '', why: jailPath() ? 'converge-jail --agent did not hold (a probe write outside it succeeded, or it could not run)' : 'no converge-jail here (kernel/win32-x64/bin)' };
  }
  bwrapOk ??= spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', '/bin/true'], { timeout: 3000, stdio: 'ignore' }).status === 0;
  if (bwrapOk) return { ok: true, kind: 'bubblewrap', why: '' };
  const has = spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status === 0;
  return { ok: false, kind: '', why: has ? 'bubblewrap is installed but cannot sandbox here (unprivileged user namespaces are off: sudo sysctl kernel.unprivileged_userns_clone=1, or on Ubuntu 24.04+ kernel.apparmor_restrict_unprivileged_userns=0)' : `no bubblewrap here: ${BWRAP_INSTALL}` };
}

/**
 * How to start an agent fenced on this machine: { cmd, args, env, how } with cmd/args wrapping the given ones.
 * macOS: under Seatbelt (agentPolicy), and the agent's own per-command sandbox off (Seatbelt does not nest, and the
 * whole agent is fenced already). Elsewhere: unchanged (the universal agent fences each command with bubblewrap).
 * Throws on macOS when sandbox-exec does not work (an agent never runs unfenced there unless AGENT_SANDBOX=off).
 */
/** bubblewrap's arguments for a whole agent (agentPolicy, in mounts): everything read-only, the secrets hidden, then
 *  the writable places bound back in, then what in them stays read-only. Pure but for which paths exist. */
export function bwrapAgentArgs({ home, workdir, stateDir, tmp, meter = [] }) {
  const h = home.replace(/\/+$/, '');
  const exists = (p) => { try { return fs.statSync(p); } catch { return null; } };
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent'];
  for (const s of AGENT_SECRETS.map((d) => `${h}/${d}`)) {
    const st = exists(s);
    if (st?.isDirectory()) a.push('--tmpfs', s); else if (st) a.push('--ro-bind', '/dev/null', s);
  }
  // The object stores the work tree borrows from (git alternates, followed down the chain: its fork's, the project's),
  // read-only. They live under ~/.converge, hidden above: without them every commit of main was "absent from the
  // object store" and the agent could not commit at all.
  const stores = [];
  for (let q = [path.join(workdir, '.git', 'objects')]; q.length;) {
    const o = q.shift();
    let alt = '';
    try { alt = fs.readFileSync(path.join(o, 'info', 'alternates'), 'utf8'); } catch { continue; }
    for (const line of alt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
      const d = path.resolve(o, line);
      if (!stores.includes(d) && exists(d)?.isDirectory()) { stores.push(d); q.push(d); }
    }
  }
  for (const d of stores) a.push('--ro-bind', d, d);
  // /tmp first: a work tree or state dir that is itself under /tmp is bound over it afterwards, not hidden by it.
  a.push('--bind', tmp, '/tmp');
  // ...and converge itself when it is installed under /tmp (a CI checkout, a throwaway install): read-only, bound back
  // over the private /tmp, or the agent's shell (kernel/<os>-<arch>/bin/aios-sh) was "No such file" and no command ran.
  const tmpOf = (p) => /^\/tmp\//.test(p);
  for (const p of [ROOT, process.env.UNIVERSAL_AGENT ? path.dirname(path.dirname(process.env.UNIVERSAL_AGENT)) : ''].filter(Boolean))
    if (tmpOf(p) && exists(p)) a.push('--ro-bind', p, p);
  const rw = [...AGENT_STATE.map((d) => `${h}/${d}`).filter((p) => exists(p)?.isDirectory()), workdir, stateDir, ...meter];
  for (const p of rw) a.push('--bind', p, p);
  // Claude Code's own settings file, beside ~/.claude: it writes it (sessions, trust) by replacing it, which a bind of
  // the file alone refuses; the CLI reads CLAUDE_CONFIG_DIR's copy otherwise. Bound as it is: written in place.
  for (const f of [`${h}/.claude.json`]) if (exists(f)?.isFile()) a.push('--bind', f, f);
  // A hosted Claude Code container puts each Bash command of the CLI in a cgroup of its own under this folder, and the
  // command fails before it starts (EROFS, clone3) when the folder is read-only. Only there; nothing else of /sys.
  if (exists('/sys/fs/cgroup/memory/process_api')?.isDirectory()) a.push('--bind', '/sys/fs/cgroup/memory/process_api', '/sys/fs/cgroup/memory/process_api');
  for (const p of AGENT_PROTECTED.map((d) => `${h}/${d}`)) if (exists(p)) a.push('--ro-bind', p, p);
  return a;
}

function fenceAgent({ cmd, args, env, workdir, stateDir }) {
  // The run's meter (CONVERGE_REGISTRY_DIR, the swarm's usage folder): the agent appends a line there per model call. Fenced
  // out of it, every write was refused without a word and the run's budget saw $0 spent while the agents spent.
  const meter = env.CONVERGE_REGISTRY_DIR && path.isAbsolute(env.CONVERGE_REGISTRY_DIR) ? [env.CONVERGE_REGISTRY_DIR] : [];
  for (const d of meter) fs.mkdirSync(d, { recursive: true });
  if (String(env.AGENT_SANDBOX || '').toLowerCase() === 'off' || env.AGENT_SANDBOX === '0') return { cmd, args, env, how: '' };
  if (process.platform === 'win32') {
    if (!lowIntegrityWorks()) throw new Error('converge-jail --agent does not fence here: agents do not run unfenced (AGENT_SANDBOX=off overrides)');
    const home = os.homedir();
    const tmp = path.join(stateDir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const under = (list) => list.map((d) => path.join(home, d));
    const flag = (f, list) => list.flatMap((p) => [f, p]);
    return {
      cmd: jailPath(),
      args: ['--agent', ...flag('--rw', [workdir, stateDir, tmp, ...meter, ...under(WIN_STATE)]), ...flag('--protect', under(AGENT_PROTECTED)),
        ...flag('--hide', (reopenParents(under(WIN_SECRETS), [workdir, stateDir, tmp]), hideAround(under(WIN_SECRETS), [workdir, stateDir, tmp]))), '--', cmd, ...args],
      env: { ...env, AGENT_SANDBOX: 'off', CONVERGE_BASH: agentShell(), TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      how: 'converge-jail --agent (low integrity)',
    };
  }
  // Linux, an agent that runs its own commands (Claude Code with its own tools: one session for the whole task, instead
  // of a CLI launch per tool call): the harness never sees those commands, so its per-command bubblewrap cannot fence
  // them. The whole agent goes into bubblewrap instead, with the macOS policy: the work tree, its state, a tmp of its
  // own and the CLIs' state writable; secrets hidden; settings and hooks read-only; the network as it is (the model,
  // and converge's MCP on this machine).
  if (process.platform === 'linux' && env.CONVERGE_CLAUDE_NATIVE_TOOLS === '1') {
    const tmp = path.join(stateDir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    return { cmd: 'bwrap', args: [...bwrapAgentArgs({ home: os.homedir(), workdir, stateDir, tmp, meter }), '--', cmd, ...args],
      env: { ...env, AGENT_SANDBOX: 'off', TMPDIR: tmp }, how: 'bubblewrap (the whole agent)' };
  }
  if (process.platform !== 'darwin') return { cmd, args, env, how: '' };
  if (!seatbeltWorks()) throw new Error(`no working Seatbelt here (${SANDBOX_EXEC}): agents do not run unfenced (AGENT_SANDBOX=off overrides)`);
  const tmp = path.join(stateDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const userTmp = resolveForSeatbelt(os.tmpdir());   // /private/var/folders/xx/yyy/T: its parent holds the user's caches (C/) too
  const policy = agentPolicy({ home: resolveForSeatbelt(os.homedir()), workdir: resolveForSeatbelt(workdir), stateDir: resolveForSeatbelt(stateDir),
    tmp: ['/private/tmp', /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(userTmp) ? path.dirname(userTmp) : userTmp, ...meter.map(resolveForSeatbelt)] });
  return { cmd: SANDBOX_EXEC, args: ['-p', seatbeltProfile(policy), '--', cmd, ...args], env: { ...env, AGENT_SANDBOX: 'off', TMPDIR: tmp }, how: 'seatbelt' };
}

/** The agent's command line under its fence; whatever the host, its shell is aios-sh (CONVERGE_BASH) when the kernel bundle has one. */
export function agentFence(opts) {
  const f = fenceAgent(opts);
  const sh = agentShell();
  return sh === 'none' || f.env.CONVERGE_BASH ? f : { ...f, env: { ...f.env, CONVERGE_BASH: sh } };
}

/**
 * A check's environment: node and the shell on PATH, its own scratch dir as home and temp. Windows separates PATH entries
 * with ";" and its programs need SystemRoot (Winsock, crypto), TEMP/TMP and USERPROFILE: the Unix form (":"-joined
 * /usr/bin...) left aios-sh unable to find node, so every check failed and the platform refused every run.
 */
function checkEnv(scratch) {
  if (process.platform !== 'win32') return { PATH: `${path.dirname(process.execPath)}:${process.platform === 'darwin' ? '/opt/homebrew/bin:' : ''}/usr/local/bin:/usr/bin:/bin`, HOME: scratch, TMPDIR: scratch, LANG: 'C.UTF-8' };
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const dirs = [path.dirname(process.execPath), path.dirname(shellArgv('')[0]), path.join(sys, 'System32'), sys];
  return {
    PATH: [...new Set(dirs)].join(';'), HOME: scratch, TMPDIR: scratch, TEMP: scratch, TMP: scratch, USERPROFILE: scratch, LANG: 'C.UTF-8',
    SystemRoot: sys, windir: sys, SystemDrive: process.env.SystemDrive || 'C:', ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    // The checkout belongs to whoever runs converge (elevated: Administrators); the check runs as the user, so git would
    // refuse it as "dubious ownership". The fence is what guards it.
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
  };
}

/**
 * Where a check runs as the fallback uid (root, and no Landlock: Cloudflare's containers), it must pass through the
 * folders above its own to reach it. converge's temp folders are mkdtemp's (0700, root's), so the check could not
 * reach its folder at all: its shell died before printing anything (exit 126), and a task's checks "failed on main"
 * for that alone. Opened to pass through only (o+x, never o+r), and only inside the system temp folder.
 */
function passThroughTemp(dir) {
  let tmp;
  try { tmp = fs.realpathSync(os.tmpdir()); } catch { return; }
  for (let d = path.dirname(fs.realpathSync(dir)); d.startsWith(tmp + path.sep); d = path.dirname(d)) {
    try { const st = fs.statSync(d); if (!(st.mode & 0o001)) fs.chmodSync(d, (st.mode & 0o7777) | 0o001); } catch { /* not ours to change */ }
  }
}

/** runFenced without blocking: the same fence, run, result and cleanup; several can run at once (in different folders). */
export function runFencedAsync(command, cwd, { timeoutMs = 60_000 } = {}) {
  const jail = jailPath();
  if (!jail) return Promise.resolve({ status: -1, stdout: '', stderr: `no converge-jail here: ${kernelHint(ROOT)}`, fenced: false });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-check-'));
  const uid = fallbackUid(jail);
  if (uid) { for (const d of [path.resolve(cwd), scratch]) chownTree(uid, d); passThroughTemp(cwd); }
  const nodeDir = path.dirname(path.dirname(process.execPath));
  // The object stores the checkout borrows from (git clone --shared): without them every git command in a check (git grep,
  // git diff) failed with "unable to access .../objects/info/alternates: Permission denied", and a "! git grep" passed.
  const ro = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/proc', '/dev', nodeDir, path.dirname(shellArgv('')[0]), ...sharedObjects(path.resolve(cwd))].filter((p) => fs.existsSync(p));
  const args = ['--rw', path.resolve(cwd), '--rw', scratch, '--rw', '/dev/null', ...ro.flatMap((p) => ['--ro', p]), ...(uid ? ['--fallback-uid', String(uid)] : []), '--', ...shellArgv(command)];
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;
    const child = spawn(jail, args, { cwd, env: checkEnv(scratch) });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const done = (status, err) => {
      clearTimeout(timer);
      for (const pid of (fs.existsSync('/proc') ? fs.readdirSync('/proc') : []).filter((d) => /^[0-9]+$/.test(d))) {
        try {
          const where = fs.readlinkSync(`/proc/${pid}/cwd`);
          if (Number(pid) !== process.pid && [path.resolve(cwd), scratch].some((d) => where === d || where.startsWith(d + path.sep))) process.kill(Number(pid), 'SIGKILL');
        } catch { /* gone, or not ours */ }
      }
      fs.rmSync(scratch, { recursive: true, force: true });
      resolve({ status: timedOut ? null : status ?? -1, stdout, stderr: stderr || (err ? String(err.message) : ''), fenced: true, timedOut });
    };
    child.on('error', (e) => done(-1, e));
    child.on('close', (code) => done(code));
  });
}

export function runFenced(command, cwd, { timeoutMs = 60_000 } = {}) {
  const jail = jailPath();
  if (!jail) return { status: -1, stdout: '', stderr: `no converge-jail here: ${kernelHint(ROOT)}`, fenced: false };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-check-'));
  const uid = fallbackUid(jail);
  if (uid) { for (const d of [path.resolve(cwd), scratch]) chownTree(uid, d); passThroughTemp(cwd); }
  const nodeDir = path.dirname(path.dirname(process.execPath));   // node's own install (nvm puts it in $HOME)
  // The object stores the checkout borrows from (git clone --shared): without them every git command in a check (git grep,
  // git diff) failed with "unable to access .../objects/info/alternates: Permission denied", and a "! git grep" passed.
  const ro = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/proc', '/dev', nodeDir, path.dirname(shellArgv('')[0]), ...sharedObjects(path.resolve(cwd))].filter((p) => fs.existsSync(p));
  const args = ['--rw', path.resolve(cwd), '--rw', scratch, '--rw', '/dev/null', ...ro.flatMap((p) => ['--ro', p]), ...(uid ? ['--fallback-uid', String(uid)] : []), '--', ...shellArgv(command)];
  try {
    const r = spawnSync(jail, args, {
      cwd, encoding: 'utf8', timeout: timeoutMs,
      env: checkEnv(scratch),
    });
    return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : ''), fenced: true, timedOut: r.error?.code === 'ETIMEDOUT' || (r.status === null && Boolean(r.signal)) };
  } finally {
    // A timeout stops the jail, not what the check started under it: stop anything still working in
    // the check's directories (a server, an agent the command launched).
    for (const pid of (fs.existsSync('/proc') ? fs.readdirSync('/proc') : []).filter((d) => /^[0-9]+$/.test(d))) { // no /proc off Linux (nor a fence)
      try {
        const where = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (Number(pid) !== process.pid && [path.resolve(cwd), scratch].some((d) => where === d || where.startsWith(d + path.sep))) process.kill(Number(pid), 'SIGKILL');
      } catch { /* gone, or not ours */ }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
