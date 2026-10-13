import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirstAccount } from '../scripts/lib/auth/first-user.mjs';

const input = { name: 'Ann', email: 'ann@example.com', password: 'correct-horse-9' };

test('the first account is created as admin', async () => {
  let got = null;
  const r = await createFirstAccount({ countUsers: async () => 0, createUser: async (u) => { got = u; return { id: 1, ...u }; } }, input);
  assert.equal(r.ok, true);
  assert.equal(got.role, 'admin');
  assert.equal(got.email, 'ann@example.com');
});

test('a second account is refused with 409 and nothing is created', async () => {
  let calls = 0;
  const r = await createFirstAccount({ countUsers: async () => 1, createUser: async () => { calls++; return {}; } }, input);
  assert.deepEqual(r, { ok: false, status: 409 });
  assert.equal(calls, 0);
});