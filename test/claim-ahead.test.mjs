// A lean worker claims the files its task names before its model starts, and is told who else holds them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { namedFiles, claimAhead } from '../agents/run.mjs';

function repoWith(files) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claim-ahead-')));
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), 'x\n'); }
  return repo;
}

test('only real files, or new files in a real directory, are claimed', () => {
  const repo = repoWith(['src/tools.js', 'index.html']);
  const t = { title: 'Add a tip tool', description: 'Edit src/tools.js and index.html, add src/tip.js. See node.js docs, e.g. v1.2, and ../../etc/passwd.txt' };
  assert.deepEqual(namedFiles(t, repo).sort(), ['index.html', 'src/tip.js', 'src/tools.js']);
});

test('the claim is made before work starts and the holders are told to the agent', async () => {
  const repo = repoWith(['src/tools.js']);
  const calls = [];
  const claim = async (agent, name, args) => { calls.push([name, args]); return { overlaps: [{ agent_id: 'a-2', paths: ['src/tools.js'], summary: 'units tool', collides: true }], in_flight: [] }; };
  const said = await claimAhead({ agent_id: 'a-1' }, { title: 'Tip tool', description: 'in src/tools.js' }, repo, claim);
  assert.deepEqual(calls, [['claim', { paths: ['src/tools.js'], summary: 'Tip tool' }]]);
  assert.match(said, /a-2 holds src\/tools\.js \(units tool\)/);
});

test('nothing named, or a refused claim, says nothing and does not stop the run', async () => {
  const repo = repoWith(['src/tools.js']);
  assert.equal(await claimAhead({}, { title: 'Tidy up', description: '' }, repo, async () => { throw new Error('never called'); }), '');
  assert.equal(await claimAhead({}, { title: 'x', description: 'src/tools.js' }, repo, async () => { throw new Error('claim refused'); }), '');
  assert.equal(await claimAhead({}, { title: 'x', description: 'src/tools.js' }, repo, async () => ({ overlaps: [], in_flight: [] })), '');
});
