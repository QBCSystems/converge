// The local server with no ADMIN_KEY treats every caller as admin (start runs that spend provider keys, write into folders):
// it may only listen on this machine's loopback. Anywhere else it refuses to start unless a key is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeBind, isLoopback } from '../scripts/lib/dev-context.mjs';

test('loopback addresses are loopback, others are not', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', 'LOCALHOST']) assert.equal(isLoopback(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.2', 'example.com', '', undefined, '127.0.0.1.evil.com']) assert.equal(isLoopback(h), false, String(h));
});

test('no key and not loopback: refused, naming the setting', () => {
  assert.throws(() => assertSafeBind('0.0.0.0', ''), /CONVERGE_HOST=0\.0\.0\.0.*ADMIN_KEY/);
  assert.throws(() => assertSafeBind('192.168.1.5', ''), /ADMIN_KEY/);
});

test('a key, or loopback, is allowed', () => {
  assert.doesNotThrow(() => assertSafeBind('0.0.0.0', 'a-real-key'));
  assert.doesNotThrow(() => assertSafeBind('127.0.0.1', ''));
  assert.doesNotThrow(() => assertSafeBind('localhost', ''));
});

test('no key: only requests addressed to, and coming from, loopback are answered', async () => {
  const { assertLocalRequest } = await import('../scripts/lib/dev-context.mjs');
  const ok = (headers, key = '') => assert.doesNotThrow(() => assertLocalRequest({ headers }, key));
  const no = (headers, key = '') => assert.throws(() => assertLocalRequest({ headers }, key), (e) => e.status === 403);
  ok({ host: '127.0.0.1:8787' });
  ok({ host: 'localhost:8787', origin: 'http://localhost:5173' });
  ok({ host: '[::1]:8787', origin: 'http://127.0.0.1:8787' });
  no({ host: '127.0.0.1:8787', origin: 'https://evil.example' });
  no({ host: '127.0.0.1:8787', origin: 'null' });
  no({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1.evil.com' });
  no({ host: 'rebind.evil.example:8787' });
  no({});
  ok({ host: 'rebind.evil.example', origin: 'https://evil.example' }, 'a-real-key'); // a key is the gate then
});
