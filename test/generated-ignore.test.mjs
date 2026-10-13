// Running a project's own tools (python3, pytest, npm) writes caches and dependencies. In an agent's working copy
// those are ignored, so the runtime does not count them as files the agent changed without claiming them, and
// `git add -A` does not commit them. Real source files still show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENERATED_IGNORE } from '../agents/common.mjs';

test('generated caches are invisible to git status in a working copy, real files are not', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-ignore-'));
  try {
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), `\n${GENERATED_IGNORE.join('\n')}\n`);
    const put = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
    for (const rel of ['__pycache__/clock.cpython-314.pyc', 'pkg/__pycache__/m.cpython-312.pyc', 'a.pyc', '.pytest_cache/v/x', 'node_modules/left-pad/index.js', '.venv/bin/python', 'lib.egg-info/PKG-INFO', '.DS_Store']) put(rel);
    put('clock.py', 'x = 1\n'); put('src/app.js', 'x\n'); put('docs/node_modules_notes.md', 'x\n');
    const seen = git('status', '--porcelain', '-z', '--untracked-files=all').split('\0').filter(Boolean).map((r) => r.slice(3)).sort();
    assert.deepEqual(seen, ['clock.py', 'docs/node_modules_notes.md', 'src/app.js']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
