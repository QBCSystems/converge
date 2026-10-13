import fs from 'node:fs';
// Planned checks that can never pass are refused before any agent starts: the sandbox has no network (loopback
// included), and a double-quoted program may not hold double quotes of its own. Good checks stay untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkCannotPass } from '../agents/check-guard.mjs';

const bad = {
  'a server and curl': "node server.js & sleep 2 && curl -s http://localhost:3000/api/mealplan?type=Vegetarian | grep -q '7-day' && kill $!",
  'curl alone': 'curl -s https://example.com | grep -q ok',
  'localhost without curl': "node -e 'fetch(\"http://127.0.0.1:8080/\").then(()=>process.exit(0))'",
  'nested double quotes (the frontend check)': `node -e "import fs from 'fs'; const html = fs.readFileSync('public/index.html', 'utf8'); if (!html.includes('id="upload-input"')) process.exit(1);"`,
  'nested double quotes in python': 'python3 -c "print("ok")"',
};
const good = {
  'single-quoted program with double quotes inside': `node -e 'const h=require("fs").readFileSync("public/index.html","utf8"); process.exit(h.includes("id=\\"upload-input\\"")?0:1)'`,
  'double-quoted program, single quotes inside': `node -e "process.exit(require('./sum')(1,2)===3?0:1)" && echo ok`,
  'escaped double quotes inside': 'node -e "process.exit(\\"a\\"===\\"a\\"?0:1)"',
  'python one-liner': 'python3 -c "import sys; sys.exit(0)"',
  'test runner': 'node --test test/*.test.mjs',
  'compile and run': 'g++ -std=c++20 -Iinclude test/a.cpp -o /tmp/a && /tmp/a',
};

for (const [what, check] of Object.entries(bad)) test(`refused: ${what}`, () => assert.notEqual(checkCannotPass(check), ''));
for (const [what, check] of Object.entries(good)) test(`kept: ${what}`, () => assert.equal(checkCannotPass(check), ''));

// What the guard refuses is sh's quoting, shown with sh itself (on Windows an agent's shell is cmd.exe).
test('the refused frontend check really cannot pass, even on files holding exactly what it asks for', { skip: process.platform === 'win32' ? 'sh semantics: there is no sh to run it on Windows' : false }, () => {
  const check = bad['nested double quotes (the frontend check)'];
  const dir = spawnSync('mktemp', ['-d'], { encoding: 'utf8' }).stdout.trim();
  spawnSync('sh', ['-c', `mkdir public && printf '<input id="upload-input">' > public/index.html`], { cwd: dir });
  assert.equal(spawnSync('sh', ['-c', check], { cwd: dir }).status, 1);
  spawnSync('rm', ['-rf', dir]);
});

// The network refusal must catch the commands and addresses that cannot work in the sandbox, and nothing that merely
// contains the letters (an escape like \nc inside a string, a word like sync or once).
const NETWORK = [
  'curl http://example.test/x', 'wget -qO- https://example.test', 'nc -z host 80', 'ncat host 80',
  'echo hi | nc host 80', 'true; curl x', 'true && wget x', 'node -e "fetch(\'http://localhost:3000\')"',
  'node test.mjs --url=127.0.0.1:8080', 'python3 -m http.server 0.0.0.0', 'ping -c1 [::1]', 'node server.js & sleep 1',
];
const CLEAN = [
  `node --input-type=module -e "import { f } from './x.js'; if (f('a\\nc\\nb')!=='a') process.exit(1)"`,
  `node --test test/sync.test.mjs`, `node -e "console.log('once, since, func, ncurses, incr, enc-dec')"`,
  `node --test test/nc-helper.test.mjs`, `test -f src/logic/once.js`,
];
for (const c of NETWORK) test(`refused (network): ${c}`, () => assert.match(checkCannotPass(c), /network/));
for (const c of CLEAN) test(`allowed: ${c.slice(0, 60)}`, () => assert.equal(checkCannotPass(c), ''));

test('every check in the pocket demo tasks passes the guard', () => {
  const tasks = JSON.parse(fs.readFileSync(new URL('./fixtures/pocket-tasks.json', import.meta.url), 'utf8'));
  assert.equal(tasks.length, 20);
  for (const t of tasks) for (const c of t.accept) assert.equal(checkCannotPass(c), '', `${t.key}: ${c}`);
});
