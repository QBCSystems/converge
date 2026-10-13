import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldResume, runOutcome } from '../agents/resume.mjs';

const base = { finished: false, state: 'submitted', resumesLeft: 1, role: 'worker' };
const c = (o) => shouldResume({ ...base, ...o });

test('a stopped worker with work left is resumed', () => {
  assert.equal(c({}), true);
});

test('a finished entity is not resumed', () => {
  assert.equal(c({ finished: true }), false);
});

test('a landed change is not resumed', () => {
  assert.equal(c({ state: 'landed' }), false);
});

test('a superseded change is not resumed', () => {
  assert.equal(c({ state: 'superseded' }), false);
});

test('no resumes left: not resumed', () => {
  assert.equal(c({ resumesLeft: 0 }), false);
  assert.equal(c({ resumesLeft: -1 }), false);
});

test('a reviewer is never resumed', () => {
  assert.equal(c({ role: 'reviewer' }), false);
});

test('a worker that said done with checks outstanding (after three refusals) did not finish: failed, with the reason, and resumable', () => {
  const o = runOutcome({ finished: { summary: 'all good', outstanding: ['verified failed'] }, state: 'submitted', role: 'worker' });
  assert.equal(o.done, false);
  assert.match(o.reason, /^failed: .*verified failed/);
  assert.equal(shouldResume({ finished: o.done, state: 'submitted', resumesLeft: 1, role: 'worker' }), true);
});

test('done with nothing outstanding, or a landed change, is done', () => {
  assert.equal(runOutcome({ finished: { summary: 's', outstanding: [] }, state: 'submitted', role: 'worker' }).done, true);
  assert.equal(runOutcome({ finished: null, state: 'landed', role: 'worker' }).done, true);
  assert.equal(runOutcome({ finished: true, state: 'submitted', role: 'worker' }).done, true);
  assert.equal(runOutcome({ finished: null, state: 'working', role: 'worker' }).done, false);
});
