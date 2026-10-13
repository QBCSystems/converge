// Credentials in ASQL are encrypted at rest: the stored value is never the key, it round-trips, tampering and a wrong
// key are refused, and rows written before encryption are converted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seal, open, isEncrypted } from '../scripts/lib/secrets.mjs';
import { isPrivate } from '../scripts/lib/private-file.mjs';
import { setAsqlProvider, readAsql, saveAsqlCloudflare, readAsqlCloudflare, encryptStored, ensureAsqlTables } from '../scripts/lib/provider-store.mjs';
import { getAsql } from '../scripts/lib/asql.mjs';
import { startAsql, asqlMissing } from './fixtures/asql-server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-secrets-'));
process.env.CONVERGE_SECRET_KEY_FILE = path.join(dir, 'secret.key');
process.env.CONVERGE_CONFIG = path.join(dir, 'assay-config.json'); // setAsqlProvider mirrors keys to the assay config: never the real one
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('seal/open round-trip, the key file is 0600, and nothing readable is stored', () => {
  const blob = seal('sk-live-abc123');
  assert.ok(isEncrypted(blob) && !blob.includes('abc123'));
  assert.equal(open(blob), 'sk-live-abc123');
  assert.notEqual(seal('sk-live-abc123'), blob, 'a fresh iv every time');
  assert.equal(seal(''), '');
  assert.equal(seal(blob), blob, 'already sealed is left alone');
  assert.equal(open('plain-old-key'), 'plain-old-key', 'a pre-encryption value still reads');
  // Only its owner can read it: mode 0600, or on Windows (no mode bits) an ACL of this user alone.
  if (process.platform !== 'win32') assert.equal(fs.statSync(process.env.CONVERGE_SECRET_KEY_FILE).mode & 0o777, 0o600);
  assert.ok(isPrivate(process.env.CONVERGE_SECRET_KEY_FILE), 'the key file is readable by its owner only');
});

test('a tampered blob and a different key are refused', () => {
  const blob = seal('secret');
  const raw = Buffer.from(blob.slice(5), 'base64'); raw[raw.length - 1] ^= 1;
  assert.throws(() => open(`enc1:${raw.toString('base64')}`), /cannot be decrypted/);
  assert.throws(() => open('enc1:AAAA'), /truncated/);
});

test('provider keys and the Cloudflare config are encrypted in ASQL and read back whole', { skip: asqlMissing() }, async () => {
  const server = await startAsql();
  const real = getAsql();
  try {
    // point the process client at the test server
    Object.assign(real, { host: server.client.host, port: server.client.port, password: server.client.password, user: 'root', passwordFromFiles: false, socketPath: server.client.socketPath || '/nonexistent', socket: null, connected: false });
    await ensureAsqlTables();
    await setAsqlProvider('deepseek', 'sk-deepseek-xyz', [{ model: 'm1' }]);
    await saveAsqlCloudflare({ account_id: 'a'.repeat(32), api_token: 'cf-token-123', admin_key: 'admin-key-456', worker_url: 'https://w.example' });

    const stored = (await real.query('SELECT api_key FROM converge_provider_keys')).rows[0].api_key;
    assert.ok(isEncrypted(stored) && !stored.includes('xyz'));
    const cf = (await real.query('SELECT api_token, admin_key FROM converge_cloudflare_config')).rows[0];
    assert.ok(isEncrypted(cf.api_token) && isEncrypted(cf.admin_key));

    assert.equal((await readAsql()).apiKeys.deepseek, 'sk-deepseek-xyz');
    const back = await readAsqlCloudflare();
    assert.equal(back.api_token, 'cf-token-123');
    assert.equal(back.admin_key, 'admin-key-456');

    // a plaintext row from before encryption is converted, once
    await real.run("REPLACE INTO converge_provider_keys (provider, api_key, host, updated_at) VALUES ('old', 'plain-key', '', 1)", []);
    assert.equal(await encryptStored(), 1);
    assert.equal(await encryptStored(), 0);
    assert.equal((await readAsql()).apiKeys.old, 'plain-key');
  } finally { real.close(); server.stop(); }
});
