// worker/engine.wasm through worker/engine-wasm.ts, as the Project Durable Object drives it: the receipt
// seed contract of cv_init and the cells-edges answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The Worker imports './engine.wasm' as a compiled module (wrangler does that); here a loader does.
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (!url.endsWith('.wasm')) return next(url, context);
  return { format: 'module', shortCircuit: true,
    source: 'import { readFileSync } from "node:fs"; export default await WebAssembly.compile(readFileSync(new URL(' + JSON.stringify(url) + ')));' };
}`));

// Node without JSPI: none of these calls reaches the network, so no import ever has to suspend.
if (!WebAssembly.Suspending) {
  WebAssembly.Suspending = function (fn) { return fn; };
  WebAssembly.promising = (fn) => (...args) => Promise.resolve(fn(...args));
}

const { Engine } = await import('../worker/engine-wasm.ts');
const KEY = 'test-engine-key';

async function receiptKey(e) {
  const health = await (await e.request('/v1/state', { headers: { 'X-Engine-Key': KEY, 'X-State-Version': '0' } })).json();
  return JSON.stringify(health).match(/"receipt_key"\s*:\s*"([^"]*)"/)?.[1];
}

test('init without a seed hands one back; init with it keeps the receipt key', async () => {
  const a = await Engine.create({ engine_key: KEY, receipt_seed: '' });
  assert.match(a.generatedSeed, /^[0-9a-f]{64}$/);
  const key = await receiptKey(a);
  assert.ok(key, 'health reports a receipt_key');
  const b = await Engine.create({ engine_key: KEY, receipt_seed: a.generatedSeed });
  assert.equal(b.generatedSeed, '', 'given a seed, the engine makes none');
  assert.equal(await receiptKey(b), key);
});

test('edges answers {"edges","fired","seen"} at once', async () => {
  const e = await Engine.create({ engine_key: KEY, receipt_seed: '' });
  const res = await e.request('/v1/edges?seen=0&timeout_ms=1000', { headers: { 'X-Engine-Key': KEY, 'X-State-Version': '0' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.edges, 'number');
  assert.equal(body.seen, 0);
  assert.equal(body.fired, body.edges !== 0);
  const again = await (await e.request(`/v1/edges?seen=${body.edges + 5}`, { headers: { 'X-Engine-Key': KEY, 'X-State-Version': '0' } })).json();
  assert.equal(again.fired, true, 'an engine behind the caller (restarted) fires');
  assert.equal(again.seen, body.edges + 5);
});
