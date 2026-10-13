// The guard every project's checks start with: each file a change adds or modifies (against main's head when the run
// started, CONVERGE_BASE: converge-engine passes it) must still parse. A change that leaves a file that cannot load
// lands nowhere, whatever its task's own checks say, and the project's own tests (detectTests) run after it.
//
// It runs inside the check's jail with only what the checkout has, so the program travels with the command: written
// to the run's TMPDIR, then run with node. node, git and python3 are what checks already count on.
import fs from 'node:fs';
import path from 'node:path';

const PROGRAM = String.raw`'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const base = process.env.CONVERGE_BASE;
if (!base) { console.log('guard: no base commit was given: nothing to compare with'); process.exit(0); }
let files;
try { files = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', '-z', base, 'HEAD'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean); }
catch (e) { console.log('guard: cannot compare with ' + base.slice(0, 8) + ': ' + String(e.stderr || e.message).split('\n')[0]); process.exit(0); }
const bad = [];
let checked = 0;
for (const f of files) {
  let st; try { st = fs.lstatSync(f); } catch { continue; }
  if (!st.isFile() || st.size > 8 << 20) continue;
  let r = null;
  if (/\.(c|m)?js$/.test(f)) r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  else if (/\.json$/.test(f)) { try { JSON.parse(fs.readFileSync(f, 'utf8')); r = { status: 0 }; } catch (e) { r = { status: 1, stderr: e.message }; } }
  else if (/\.py$/.test(f)) r = spawnSync('python3', ['-c', 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")', f], { encoding: 'utf8' });
  if (!r) continue;
  if (r.error && r.error.code === 'ENOENT') continue;   // python3 not installed here: not this change's fault
  checked++;
  if (r.status !== 0) bad.push(f + ':\n' + String((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'));
}
if (bad.length) { console.log('FAIL guard: ' + bad.length + ' changed file(s) no longer parse:\n' + bad.join('\n')); process.exit(1); }
console.log('PASS guard: ' + checked + ' changed file(s) parse (' + files.length + ' changed)');
`;

/** The guard as a test command (sh, aios-sh included). */
export const GUARD = `printf %s '${Buffer.from(PROGRAM).toString('base64')}' | base64 -d > "$TMPDIR/converge-guard.cjs" && node "$TMPDIR/converge-guard.cjs"`;
const MARK = 'converge-guard.cjs';

/** Whether a test command starts with the guard; its readable name for messages (the command itself is mostly base64). */
export const hasGuard = (cmd) => String(cmd || '').includes(MARK);
export const describeTestCommand = (cmd) => {
  const s = String(cmd || '');
  if (!hasGuard(s)) return s;
  const rest = s.slice(s.indexOf(`"$TMPDIR/${MARK}"`) + MARK.length + 10).replace(/^\s*&&\s*/, '').trim();
  return rest ? `converge's syntax guard, then ${rest}` : "converge's syntax guard of the changed files";
};
/** The guard followed by a project's own tests (empty: the guard alone). */
export const withGuard = (tests) => (tests ? `${GUARD} && ( ${tests} )` : GUARD);

/** The project's own test command, by what its main holds: package.json's test script (not npm's placeholder),
 *  pytest, cargo or go. '' when there is none. Tried on main before it is used (local-api / dev-server). */
export function detectTests(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const t = pkg?.scripts?.test;
    if (t && !/no test specified/.test(t)) return 'npm test --silent';
  } catch { /* no package.json */ }
  if (has('pytest.ini') || has('conftest.py') || (has('pyproject.toml') && /\[tool\.pytest/.test(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8')))) return 'python3 -m pytest -q';
  if (has('Cargo.toml')) return 'cargo test -q';
  if (has('go.mod')) return 'go test ./...';
  return '';
}
