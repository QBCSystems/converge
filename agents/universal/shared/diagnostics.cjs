'use strict';
// Project diagnostics without an LSP daemon: detect lint/typecheck commands
// the repo already declares, run them, return structured findings. Zero npm
// deps — shells out to whatever the project installed (tsc, eslint, …).

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

// Is a binary runnable? Cached per process — detection must never cost more
// than the check it enables, and a missing linter must mean "skip", never a
// noisy failed check ("No module named flake8" is not a lint finding).
const _binCache = new Map();
function binAvailable(bin, args = ['--version']) {
  if (_binCache.has(bin)) return _binCache.get(bin);
  let ok = false;
  try { execFileSync(bin, args, { stdio: 'ignore', timeout: 8000 }); ok = true; } catch { ok = false; }
  _binCache.set(bin, ok);
  return ok;
}

function detectCheckers(dir) {
  const commands = [];
  const pkgPath = path.join(dir, 'package.json');
  if (exists(pkgPath)) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts || {}; } catch {}
    const manager = exists(path.join(dir, 'yarn.lock')) ? 'yarn'
      : exists(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm run';
    if (scripts.lint) commands.push({ name: 'lint', cmd: `${manager} lint`, type: 'lint' });
    if (scripts.typecheck) commands.push({ name: 'typecheck', cmd: `${manager} typecheck`, type: 'typecheck' });
    if (scripts['type-check'] && !commands.find((c) => c.type === 'typecheck')) {
      commands.push({ name: 'typecheck', cmd: `${manager} type-check`, type: 'typecheck' });
    }
    if (!commands.find((c) => c.type === 'typecheck') && exists(path.join(dir, 'tsconfig.json'))) {
      commands.push({ name: 'typecheck', cmd: 'npx --no-install tsc --noEmit', type: 'typecheck' });
    }
    const eslintCfgs = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];
    if (!commands.find((c) => c.type === 'lint') && eslintCfgs.some((f) => exists(path.join(dir, f)))) {
      commands.push({ name: 'lint', cmd: 'npx --no-install eslint . --max-warnings 0', type: 'lint' });
    }
  } else if (exists(path.join(dir, 'tsconfig.json'))) {
    commands.push({ name: 'typecheck', cmd: 'npx --no-install tsc --noEmit', type: 'typecheck' });
  }
  if (exists(path.join(dir, 'composer.json'))) {
    if (exists(path.join(dir, 'vendor/bin/phpstan'))) {
      commands.push({ name: 'typecheck', cmd: './vendor/bin/phpstan analyse --no-progress', type: 'typecheck' });
    }
    if (exists(path.join(dir, 'vendor/bin/phpcs'))) {
      commands.push({ name: 'lint', cmd: './vendor/bin/phpcs', type: 'lint' });
    }
  }
  const pyProject = exists(path.join(dir, 'pyproject.toml'));
  if (pyProject || exists(path.join(dir, 'requirements.txt')) || exists(path.join(dir, 'setup.py'))) {
    // Pick the first linter that's actually RUNNABLE (ruff → flake8): the old
    // unconditional `python -m flake8` reported "No module named flake8" as a
    // failed lint on every box without it — noise, not a finding.
    if (!commands.find((c) => c.type === 'lint')) {
      if (binAvailable('ruff')) commands.push({ name: 'lint', cmd: 'ruff check .', type: 'lint' });
      else if (binAvailable('flake8')) commands.push({ name: 'lint', cmd: 'flake8 . --count', type: 'lint' });
    }
    // mypy only when the project configured it — running it unconfigured on a
    // random repo produces hundreds of irrelevant errors.
    const pyToml = pyProject ? (() => { try { return fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'); } catch { return ''; } })() : '';
    if (!commands.find((c) => c.type === 'typecheck') && binAvailable('mypy')
      && (exists(path.join(dir, 'mypy.ini')) || exists(path.join(dir, '.mypy.ini')) || pyToml.includes('[tool.mypy]'))) {
      commands.push({ name: 'typecheck', cmd: 'mypy . --no-error-summary', type: 'typecheck' });
    }
  }
  if (exists(path.join(dir, 'go.mod')) && binAvailable('go', ['version'])) {
    commands.push({ name: 'typecheck', cmd: 'go vet ./...', type: 'typecheck' });
  }
  if (exists(path.join(dir, 'Cargo.toml')) && binAvailable('cargo')) {
    commands.push({ name: 'typecheck', cmd: 'cargo check --quiet', type: 'typecheck' });
  }
  return commands;
}

function runChecker(cmd, cwd, timeoutMs) {
  const start = Date.now();
  // NO_COLOR + FORCE_COLOR *removed* (not set to "0" — several tools, ruff
  // included, treat FORCE_COLOR existing at all as force-on): ANSI codes in
  // checker output waste tokens and break weak models' parsing.
  const env = { ...process.env, CI: '1', NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  try {
    const output = execSync(cmd, {
      cwd, timeout: timeoutMs || 45000, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    return { passed: true, output: String(output || '').trim().slice(0, 4000), ms: Date.now() - start };
  } catch (err) {
    const out = `${err.stdout || ''}\n${err.stderr || ''}`.trim().slice(0, 6000);
    return { passed: false, output: out || String(err.message || 'failed'), ms: Date.now() - start, exitCode: err.status };
  }
}

function syntaxCheckFile(abs) {
  if (!exists(abs)) return null;
  try {
    if (/\.(c|m)?js$/.test(abs)) {
      execFileSync(process.execPath, ['--check', abs], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      return { ok: true, kind: 'syntax' };
    }
    if (/\.json$/.test(abs)) {
      JSON.parse(fs.readFileSync(abs, 'utf8'));
      return { ok: true, kind: 'json' };
    }
    // Interpreter-backed checks: only when the interpreter is actually on this
    // box — a missing binary means "no check", never a fake syntax failure.
    if (/\.py$/.test(abs)) {
      const py = binAvailable('python3') ? 'python3' : binAvailable('python') ? 'python' : null;
      if (!py) return null;
      execFileSync(py, ['-m', 'py_compile', abs], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      return { ok: true, kind: 'syntax' };
    }
    if (/\.php$/.test(abs)) {
      if (!binAvailable('php')) return null;
      execFileSync('php', ['-l', abs], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      return { ok: true, kind: 'syntax' };
    }
  } catch (e) {
    const msg = String((e.stderr && e.stderr.toString()) || (e.stdout && e.stdout.toString()) || e.message || '').split('\n').filter(Boolean).slice(0, 6).join('\n');
    return { ok: false, kind: 'syntax', message: msg };
  }
  return null;
}

function runDiagnostics(dir, opts = {}) {
  const checkers = detectCheckers(dir);
  const types = opts.types || ['lint', 'typecheck'];
  const selected = checkers.filter((c) => types.includes(c.type));
  // Per-file syntax pass (opts.files: paths relative to dir or absolute) — the
  // fallback loop for projects with no configured checkers, and a fast focused
  // check on exactly the files a run just touched.
  const fileResults = [];
  for (const f of opts.files || []) {
    const abs = path.isAbsolute(f) ? f : path.join(dir, f);
    const r = syntaxCheckFile(abs);
    if (r) fileResults.push({ file: path.relative(dir, abs) || f, ...r });
  }
  const fileFailed = fileResults.filter((r) => !r.ok);
  const fileLine = fileResults.length
    ? (fileFailed.length
      ? `${fileFailed.length}/${fileResults.length} file syntax check(s) FAILED:\n` + fileFailed.map((r) => `--- ${r.file} ---\n${r.message}`).join('\n\n')
      : `${fileResults.length} file syntax check(s) passed: ${fileResults.map((r) => r.file).join(', ')}`)
    : '';
  if (!selected.length) {
    const summary = fileLine || 'No project lint/typecheck commands detected (package.json scripts, tsconfig, eslint, ruff, go vet, cargo check, etc.), and no checkable files were given.';
    return { checkers: [], results: [], fileResults, summary };
  }
  const results = selected.map((c) => ({ ...c, ...runChecker(c.cmd, dir, opts.timeoutMs) }));
  const failed = results.filter((r) => !r.passed);
  let summary = failed.length
    ? `${failed.length}/${results.length} check(s) failed:\n` + failed.map((r) => `--- ${r.name} (${r.cmd}) ---\n${r.output}`).join('\n\n')
    : `${results.length} check(s) passed: ${results.map((r) => r.name).join(', ')}`;
  if (fileLine) summary += `\n\n${fileLine}`;
  return { checkers: selected, results, fileResults, summary };
}

module.exports = { detectCheckers, runChecker, runDiagnostics, syntaxCheckFile };
