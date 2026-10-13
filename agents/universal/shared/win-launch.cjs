'use strict';
// Launching a CLI provider on Windows.
//
// Node 18.20.2 / 20.12.2 closed CVE-2024-27980 by REFUSING to spawn a .cmd or
// .bat file unless `shell` is set. Every CLI we drive — codex, claude,
// cursor-agent — installs on Windows as exactly that: an npm shim called
// `codex.cmd`. So `spawn('codex', args)` no longer fails with a readable
// ENOENT; it throws
//
//   Error: spawn EINVAL  { errno: -4071, code: 'EINVAL', syscall: 'spawn' }
//
// with a stack pointing into node:internal/child_process and nothing naming the
// program that could not start. Reported live 2026-08-02 from a Windows box
// (Node v20.18.3): the operator got that stack with no indication that it meant
// "the codex CLI is not launchable here".
//
// Two jobs, then:
//   1. Resolve the real file behind a bare command name, using PATH + PATHEXT
//      the way the shell would.
//   2. Decide how to start it — and when the only way would be unsafe, say so
//      instead of doing it.
//
// On the safety of `shell: true`: it is the documented way to run a .cmd, and
// it is also exactly what the CVE was about — arguments go through cmd.exe,
// where `&`, `|`, `>` and friends are syntax. Our provider arguments are flags,
// a model name and image paths (the prompt travels over stdin), so they are
// normally inert. "Normally" is not a guarantee, so an argument carrying cmd
// metacharacters REFUSES rather than runs. A provider that will not start is a
// bad afternoon; a provider that runs an injected command is a bad year.

const fs = require('fs');
const path = require('path');

// cmd.exe syntax. `%` is included because %VAR% expands, which can leak
// environment values into an argument.
const CMD_META = /[&|<>^%"`]/;

function isWindows() { return process.platform === 'win32'; }

// What the shell would find for a bare name. Returns an absolute path, or ''.
function resolveExecutable(binary, env = process.env) {
  const name = String(binary || '');
  if (!name) return '';
  // Already a path: trust it if it exists (and, on Windows, try PATHEXT too —
  // `C:\tools\codex` may really be `codex.cmd`).
  if (name.includes('/') || name.includes('\\')) {
    if (fs.existsSync(name) && fs.statSync(name).isFile()) return name;
    if (!isWindows()) return '';
    for (const ext of pathExts(env)) {
      const withExt = name + ext;
      if (fs.existsSync(withExt)) return withExt;
    }
    return '';
  }
  // ';' explicitly on Windows rather than path.delimiter: identical on a real
  // Windows host, and it lets the test exercise this branch from Linux instead
  // of leaving the whole Windows path unverified.
  const dirs = String(env.PATH || env.Path || '').split(isWindows() ? ';' : path.delimiter).filter(Boolean);
  const exts = isWindows() ? pathExts(env) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch { /* unreadable PATH entry */ }
    }
  }
  return '';
}

function pathExts(env = process.env) {
  const raw = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD');
  // '' first so an exact filename still wins over an extension guess.
  return ['', ...raw.split(';').map((e) => e.trim()).filter(Boolean).flatMap((e) => [e.toLowerCase(), e.toUpperCase()])];
}

// How to start `binary` with `args`.
//
//   { ok: true,  binary, args, shell }              -> hand straight to spawn()
//   { ok: false, reason }                           -> a sentence to show a human
//
// A .js entry is run through this Node rather than the shim, which is both
// safer and faster; a .cmd/.bat needs the shell; anything else runs directly.
function planLaunch(binary, args = [], opts = {}) {
  const env = opts.env || process.env;
  const name = String(binary || '');
  if (!name) return { ok: false, reason: 'no executable was configured' };
  if (!isWindows()) return { ok: true, binary: name, args, shell: false };

  const resolved = resolveExecutable(name, env);
  if (!resolved) {
    return { ok: false, notFound: true, reason: `\`${name}\` was not found on PATH` };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    const node = nodeExecutable(env);
    if (!node) return { ok: false, reason: `\`${resolved}\` needs Node to run and no node.exe could be located` };
    return { ok: true, binary: node, args: [resolved, ...args], shell: false };
  }
  if (ext !== '.cmd' && ext !== '.bat') {
    return { ok: true, binary: resolved, args, shell: false };
  }
  // A shim. It can only go through cmd.exe, so every argument is now shell
  // input — check them before handing them over.
  const bad = args.find((a) => CMD_META.test(String(a)));
  if (bad !== undefined) {
    return {
      ok: false,
      unsafe: true,
      reason: `\`${path.basename(resolved)}\` is a Windows shim, which can only be started through cmd.exe, and an argument contains characters cmd.exe would treat as syntax (${String(bad).slice(0, 60)}). Refusing rather than risk running it.`,
    };
  }
  return { ok: true, binary: resolved, args, shell: true };
}

function nodeExecutable(env = process.env) {
  const candidates = [
    env.npm_node_execpath,
    env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs', 'node.exe'),
    // Only when we are already running under node (in Electron this is
    // electron.exe, which cannot run an arbitrary script).
    path.basename(process.execPath).toLowerCase().startsWith('node') ? process.execPath : '',
  ].filter(Boolean);
  return candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || '';
}

// Turn a spawn failure into something a human can act on. The raw errors name
// nothing: EINVAL in particular reads as a bug in the caller.
function explainSpawnError(err, { provider = 'the CLI', binary = '', envVar = '' } = {}) {
  const code = err && err.code;
  const what = binary ? `\`${binary}\`` : 'it';
  if (code === 'EINVAL' && isWindows()) {
    return `${provider}: Windows refused to start ${what}. Node will not spawn a .cmd/.bat shim directly (CVE-2024-27980), which is how npm installs these CLIs. `
      + `Point ${envVar || 'the provider binary setting'} at the tool's .js entry (e.g. %APPDATA%\\npm\\node_modules\\...\\bin\\cli.js) or at a real .exe.`;
  }
  if (code === 'ENOENT') {
    return `${provider}: ${what} is not installed, or not on this machine's PATH.`;
  }
  if (code === 'EACCES') return `${provider}: ${what} is not executable by this user.`;
  return `${provider}: could not start ${what} (${(err && err.message) || code || 'unknown error'}).`;
}

module.exports = { planLaunch, resolveExecutable, explainSpawnError, nodeExecutable, CMD_META };
