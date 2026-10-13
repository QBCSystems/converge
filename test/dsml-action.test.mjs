// A model's tool-call markup is read as the JSON action it stands for (agents/dsml.mjs); the loop itself only reads JSON.
// The samples are replies a real run's agent sent (DeepSeek flash), which the loop answered with "not an action".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dsmlToAction, normalizeAnswer } from '../agents/dsml.mjs';

const call = (name, params) => `<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="${name}">\n${params}\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`;
const param = (n, v, str = true) => `<｜｜DSML｜｜ parameter name="${n}" string="${str}">${v}</｜｜DSML｜｜ parameter>`;

test('a run call becomes the run action, its shell command kept exactly', () => {
  const cmd = `cd "$(git rev-parse --show-toplevel)" && echo '== package.json ==' && cat package.json && grep -rn "ui/js" test/ | head -30`;
  assert.deepEqual(JSON.parse(dsmlToAction(call('run', param('command', cmd)))), { action: 'run', command: cmd });
});

test('string="false" values are parsed (numbers, objects), string="true" ones are text', () => {
  const r = JSON.parse(dsmlToAction(call('read', [param('path', 'ui/js/main.js'), param('start', '1000', false), param('end', '1060', false)].join('\n'))));
  assert.deepEqual(r, { action: 'read', path: 'ui/js/main.js', start: 1000, end: 1060 });
  const c = JSON.parse(dsmlToAction(call('converge', [param('tool', 'status'), param('arguments', '{"wait":true}', false)].join('\n'))));
  assert.deepEqual(c, { action: 'converge', tool: 'status', arguments: { wait: true } });
});

test('an edit keeps its old and new text, quotes and newlines included', () => {
  const old = 'const a = "x";\nconst b = 1;', neu = "const a = 'y';\n";
  const r = JSON.parse(dsmlToAction(call('edit', [param('path', 'f.js'), param('old', old), param('new', neu)].join('\n'))));
  assert.deepEqual(r, { action: 'edit', path: 'f.js', old, new: neu });
});

test('a reply that already holds a JSON action is left alone, even with markup after it', () => {
  const both = `{"action":"read","path":"a.js"}\n\n${call('read', param('path', 'b.js'))}`;
  assert.equal(dsmlToAction(both), null);
  assert.equal(normalizeAnswer(both), both);
});

test('prose, empty and non-call text come back unchanged', () => {
  for (const t of ['I will read the file next.', '', undefined, '<div>invoke</div>']) assert.equal(normalizeAnswer(t), t);
});
