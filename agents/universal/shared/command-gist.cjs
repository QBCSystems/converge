'use strict';
// What to call a shell command in one short line.
//
// Tool rows label a run as `run · <first 50 chars of the command>`. That is fine
// until an interpreter is invoked by absolute path, and on Windows it always is:
//
//   "C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command Get-Content big.txt
//
// The first 50 characters are `"C:\WINDOWS\System32\WindowsPowerShell\v1.0\pow` —
// no information at all, and IDENTICAL for every command the machine runs.
// Reported from a phone 2026-08-02: five consecutive rows reading
// `run · "C:\WINDOWS\System32\WindowsP…`, indistinguishable from each other.
// It is worse than it looks, because the console flexes `.ct-detail` (which
// holds the full command) to zero width on a narrow screen — so the label is
// the ONLY thing a phone shows.
//
// So: name the interpreter, then show what it was asked to do.
//
//   powershell: Get-Content big.txt
//   bash: cd /srv/app && npm run build
//   node: console.log(1)
//
// Deliberately conservative — it only rewrites when it is sure:
//   - the leading token's basename is a known interpreter, AND
//   - a flag follows whose meaning is "everything after me is the command"
//     (-Command, -c, -lc, /c, -e …).
// `node scripts/build.js` has no such flag and is already perfectly readable,
// so it is returned untouched. Anything unrecognised is returned untouched too:
// a bad guess here renames the wrong thing on every row, which is worse than a
// long label.

// Basename (no extension) => the name to show. Everything here is a program
// whose whole job is running something else, which is why its own path is noise.
// NOT included: sudo, ssh, docker, env, wsl. They are wrappers, not
// interpreters — the thing that matters about `sudo …` is the sudo, and
// `ssh host cmd` names a DIFFERENT MACHINE. Peeling those would drop the part
// of the line a reader most needs. `sudo bash -c 'systemctl restart nginx'`
// reads perfectly well already, so it is left exactly as typed.
const INTERPRETERS = new Set([
  'powershell', 'pwsh', 'cmd', 'command',
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish',
  'node', 'deno', 'bun', 'python', 'python2', 'python3', 'perl', 'ruby', 'php',
]);

// After one of these, the rest of the line IS the command.
const PAYLOAD_FLAGS = new Set([
  '-command', '-c', '-lc', '-ec', '-e', '--command', '--eval', '-eval',
  '/c', '/k', '-encodedcommand',
]);

// Flags that swallow the NEXT token as their value, so it must not be mistaken
// for the payload.
const VALUE_FLAGS = new Set([
  '-executionpolicy', '-file', '-inputformat', '-outputformat',
  '-windowstyle', '-version', '-psconsolefile', '-configurationname',
]);

// Leading token, honouring one level of quoting: "C:\Program Files\x\y.exe".
const HEAD = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*/;

function basename(tok) {
  const cleaned = String(tok || '').replace(/\\/g, '/');
  const last = cleaned.slice(cleaned.lastIndexOf('/') + 1).toLowerCase();
  return last.replace(/\.(exe|cmd|bat|com)$/, '');
}

// Strip one layer of wrapping quotes from a payload, so `-Command "Get-Foo"`
// reads as `Get-Foo`. Only when they wrap the WHOLE thing — `echo "a" "b"` must
// keep its quotes or it stops being the command that ran.
function unwrap(s) {
  const t = String(s || '').trim();
  if (t.length < 2) return t;
  const q = t[0];
  if ((q !== '"' && q !== "'") || t[t.length - 1] !== q) return t;
  const inner = t.slice(1, -1);
  return inner.includes(q) ? t : inner;
}

// The one-line identity of a command. Returns the original (whitespace
// collapsed) when there is nothing worth rewriting.
function commandGist(command) {
  const flat = String(command == null ? '' : command).replace(/\s+/g, ' ').trim();
  if (!flat) return '';

  let rest = flat;
  let name = '';
  // `sudo bash -lc '…'` and `docker exec -it x sh -c '…'` nest, so peel a few.
  for (let depth = 0; depth < 3; depth++) {
    const m = HEAD.exec(rest);
    if (!m) break;
    const tok = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
    const base = basename(tok);
    if (!INTERPRETERS.has(base)) break;

    // Windows switch syntax (/c) only where it is real syntax. On POSIX a
    // payload legitimately starts with a path — treating `/usr/bin/foo` as a
    // switch would eat the very thing we are trying to show.
    const winSwitches = base === 'cmd' || base === 'command';
    let after = rest.slice(m[0].length);
    let payload = null;
    // `deno eval "<code>"`: `eval` is the payload marker only as the first argument.
    const denoEval = base === 'deno' ? /^\s*eval\s+/.exec(after) : null;
    if (denoEval) after = after.slice(denoEval[0].length), payload = after;
    for (; payload == null;) {
      const f = winSwitches ? /^\s*([-/][A-Za-z][\w-]*)\s*/.exec(after) : /^\s*(-{1,2}[A-Za-z][\w-]*)\s*/.exec(after);
      if (!f) break;
      const flag = f[1].toLowerCase();
      after = after.slice(f[0].length);
      if (PAYLOAD_FLAGS.has(flag)) { payload = after; break; }
      if (VALUE_FLAGS.has(flag)) { const v = HEAD.exec(after); if (v) after = after.slice(v[0].length); }
    }
    // No "run this" flag: the interpreter is being handed a script or a
    // subcommand, which reads fine as-is. Leave the whole thing alone.
    if (payload == null) break;
    name = base;
    rest = unwrap(payload);
    if (!rest) { rest = flat; name = ''; break; } // `-Command` with nothing after it
  }

  if (!name) return flat;
  return `${name}: ${rest}`;
}

// The label a tool row shows. Kept here so the harness (which mints the label)
// and the console (which re-derives it for machines running an older harness)
// cannot drift.
function runLabel(command, max = 50) {
  const gist = commandGist(command);
  if (!gist) return 'run';
  return `run · ${gist.length > max ? `${gist.slice(0, max - 1)}…` : gist}`;
}

module.exports = { commandGist, runLabel, INTERPRETERS, PAYLOAD_FLAGS };
