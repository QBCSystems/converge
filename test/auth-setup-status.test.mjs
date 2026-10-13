import test from 'node:test';
import assert from 'node:assert/strict';
import { setupStatus } from '../scripts/lib/auth/setup.mjs';

test('setupStatus needs setup only while no user exists', async () => {
  assert.deepEqual(await setupStatus({ countUsers: async () => 0 }), { needsSetup: true });
  assert.deepEqual(await setupStatus({ countUsers: async () => 1 }), { needsSetup: false });
  assert.deepEqual(await setupStatus({ countUsers: async () => 2 }), { needsSetup: false });
});
