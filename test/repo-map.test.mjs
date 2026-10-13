// Tests for agents/repo-map.mjs: a map of a git repository's files and what they define.
// Each test builds a throwaway git repo under a temp dir, so nothing here touches the project.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoMap } from '../agents/repo-map.mjs';

/** A temporary git repo with the given files (path -> contents), added to the index. */
function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  git('add', '-A');
  return dir;
}

test('maps JS, TS, Python, C++ and CSS files, sorted by path', () => {
  const dir = makeRepo({
    'src/ledger.js': 'export function addExpense() {}\nexport const total = 1;\nexport default function x() {}\n',
    'src/other.mjs': 'export { a, b };\n',
    'src/types.ts': 'export async function load() {}\nexport class Store {}\n',
    'py/tool.py': 'def run():\n  pass\nclass Thing:\n  def inner(self): pass\n',
    'src/a.hpp': 'struct Foo {};\nclass Bar {};\n',
    'src/b.h': 'class Baz {};\n',
    'src/s.css': 'body{}',
    'README.md': 'no names here\n',
  });

  const text = repoMap(dir);
  const lines = text.split('\n');
  assert.deepEqual(lines, [...lines].sort(), 'lines are sorted by path');

  assert.match(text, /^README\.md$/m);
  assert.match(text, /^py\/tool\.py: run, Thing$/m);
  assert.match(text, /^src\/a\.hpp: Foo, Bar$/m);
  assert.match(text, /^src\/b\.h: Baz$/m);
  assert.match(text, /^src\/ledger\.js: addExpense, total, default$/m);
  assert.match(text, /^src\/s\.css$/m);
  assert.match(text, /^src\/types\.ts: load, Store$/m);
  assert.match(text, /^src\/other\.mjs: a, b$/m);

  assert.ok(!text.includes('inner'), 'nested defs are not named');
});

test('a binary file is listed alone and does not throw', () => {
  const dir = makeRepo({ 'bin.dat': '\u0000\u0001\u0002', 'ok.js': 'export const x = 1;\n' });
  const text = repoMap(dir);
  assert.match(text, /^bin\.dat$/m);
  assert.match(text, /^ok\.js: x$/m);
});

test('cuts whole lines and ends with a count when over maxBytes', () => {
  const files = {};
  for (let i = 0; i < 40; i++) files[`src/file${String(i).padStart(2, '0')}.js`] = `export const name${i} = ${i};\n`;
  const dir = makeRepo(files);
  const text = repoMap(dir, { maxBytes: 120 });
  assert.ok(text.length <= 200, 'stays near the budget');
  assert.match(text, /\.\.\. \(\d+ more files\)$/);
  assert.ok(!text.includes('undefined'), 'no partial lines');
});

test('a non-git directory returns an empty string', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-nogit-'));
  assert.equal(repoMap(dir), '');
});
