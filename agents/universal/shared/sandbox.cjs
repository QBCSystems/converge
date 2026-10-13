'use strict';
// Optional OS-level sandbox for run_command. Zero dependencies.
//
// The validation gate catches *result* errors after the fact, but it cannot
// undo a command that already wrote outside the task — `rm -rf ~`, a stray
// `>/etc/hosts`, a build script that scribbles into $HOME. That is the standing
// tension behind YOLO: turning off the destructive-command refusal is necessary
// for real work, but it removes the only guard. This module closes the gap by
// confining filesystem WRITES to the workdir (plus an ephemeral /tmp) while
// leaving the rest of the system readable, so tools like node/git/rg still work.
//
// Backends, best-first:
//   - bubblewrap (`bwrap`): rootless, no SUID, ubiquitous on Linux CI.
//   - firejail:   SUID, common on desktops.
// If neither is present the CALLER decides: mode 'require' hard-fails the
// command (the user asked for a sandbox and must get one); mode 'auto' proceeds
// unconfined after a one-time notice. Default mode is 'off' — behavior unchanged.

const cp = require('child_process');

// Normalize the AGENT_SANDBOX value (env / config) to one of off | auto | require.
function resolveMode(raw) {
  if (raw === true) return 'require';
  if (raw === false || raw == null || raw === '') return 'off';
  const s = String(raw).trim().toLowerCase();
  if (['1', 'on', 'strict', 'require', 'required', 'yes', 'true'].includes(s)) return 'require';
  if (['auto', 'best-effort', 'try'].includes(s)) return 'auto';
  return 'off'; // '0', 'off', 'no', 'false', or anything unrecognized
}

// Network is ALLOWED by default (npm/git/tests routinely need it). Only an
// explicit off-ish AGENT_SANDBOX_NET value ('0'/'off'/'none'/'no') blocks it;
// 'on'/'1' and anything unrecognized leave the network up.
function netBlocked(raw) {
  if (raw == null || raw === '') return false;
  return /^(0|off|none|no|false|block|blocked)$/i.test(String(raw).trim());
}

let _cached;
// Probe PATH for a usable backend. `probe` is injectable for tests.
function detectBackend(probe) {
  if (!probe && _cached !== undefined) return _cached;
  if (probe) {
    let found = null;
    if (probe('bwrap')) found = { bin: 'bwrap', kind: 'bubblewrap' };
    else if (probe('firejail')) found = { bin: 'firejail', kind: 'firejail' };
    return found;
  }
  let found = null;
  // A binary might be on PATH and pass `--version`, but fail at runtime due to kernel
  // restrictions (e.g. unprivileged user namespaces disabled, yielding "loopback: Failed
  // RTM_NEWADDR: Operation not permitted" or "setting up uid map: Permission denied").
  // Probe with a minimal dry run to ensure the sandbox backend can actually isolate and execute.
  try {
    const res = cp.spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', '/bin/true'], { timeout: 3000, stdio: 'ignore' });
    if (res.status === 0) found = { bin: 'bwrap', kind: 'bubblewrap' };
  } catch {}
  if (!found) {
    try {
      const res = cp.spawnSync('firejail', ['--quiet', '--noprofile', '--read-only=/', '/bin/true'], { timeout: 3000, stdio: 'ignore' });
      if (res.status === 0) found = { bin: 'firejail', kind: 'firejail' };
    } catch {}
  }
  _cached = found;
  return found;
}
function _resetCacheForTest() { _cached = undefined; }

// Build the argv PREFIX that wraps a command. Returns [] when there is nothing
// to wrap. The caller runs:  spawn(prefix[0]||'/bin/bash', [...prefix.slice(1),
// '/bin/bash', '-o', 'pipefail', '-c', command]).
// `keep`: read-only paths bound back over the tmpfs when they live under /tmp (the shell itself, when it is installed
// there: hidden, every command failed with "bwrap: execvp ...: No such file or directory").
function sandboxArgv({ backend, workdir, netOff, keep = [] }) {
  if (!backend || !workdir) return [];
  if (backend.kind === 'bubblewrap') {
    const a = [
      backend.bin,
      '--ro-bind', '/', '/',         // the whole system is readable...
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',             // scratch space, writable but ephemeral
    ];
    for (const k of keep) if (k && /^\/tmp\//.test(k)) a.push('--ro-bind', k, k);
    a.push(
      '--bind', workdir, workdir,    // ...only the workdir is writable. Bound AFTER
      '--chdir', workdir,            //    the tmpfs so a workdir under /tmp survives.
      '--die-with-parent',           // never outlive the harness
    );
    if (netOff) a.push('--unshare-net');
    a.push('--');
    return a;
  }
  if (backend.kind === 'firejail') {
    const a = [backend.bin, '--quiet', '--noprofile',
      '--read-only=/', `--read-write=${workdir}`, '--read-write=/tmp'];
    if (netOff) a.push('--net=none');
    return a;
  }
  return [];
}

// One-line human description of the active confinement, for logs/telemetry.
function describe({ mode, backend, netOff }) {
  if (mode === 'off') return 'off';
  if (!backend) return mode === 'require' ? 'REQUIRED but no backend available' : 'auto (no backend — running unconfined)';
  return `${backend.kind}${netOff ? ', network blocked' : ''}`;
}

module.exports = { resolveMode, netBlocked, detectBackend, sandboxArgv, describe, _resetCacheForTest };
