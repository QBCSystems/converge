// Sign-in over HTTP against a real ASQL: login, the session route, logout, and what a session may do
// (an owner of the platform administers; a member sees only their own project; nobody else gets in).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startAsql, asqlMissing } from './fixtures/asql-server.mjs';

process.env.ADMIN_KEY = 'test-admin-key';
process.env.VIEW_KEY = 'test-view-key';
const skip = asqlMissing();
let asql, server, base, ctx, store, schema, authHttp, real;

before(async () => {
  if (skip) return;
  asql = await startAsql();
  real = (await import('../scripts/lib/asql.mjs')).getAsql();
  Object.assign(real, { host: asql.client.host, port: asql.client.port, password: asql.client.password, user: 'root', passwordFromFiles: false, socketPath: asql.client.socketPath || '/nonexistent', socket: null, connected: false });
  schema = await import('../scripts/lib/auth/schema.mjs');
  store = await import('../scripts/lib/auth/store.mjs');
  authHttp = await import('../scripts/lib/auth/http.mjs');
  ctx = await import('../scripts/lib/dev-context.mjs');
  await schema.applyMigrations(real);
  const owner = await store.createUser(real, { email: 'owner@example.com', name: 'Owner', password: 'a long owner password' });
  await store.addMembership(real, owner.id, '*', 'owner');
  const member = await store.createUser(real, { email: 'member@example.com', name: 'Member', password: 'a long member password' });
  await store.addMembership(real, member.id, 'app', 'member');
  // A tiny server wired the way dev-server.mjs is: the principal first, then the auth routes, then two guarded routes.
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      req.principal = await authHttp.principalFor(req, url);
      if (await authHttp.authRoutes(req, res, url)) return;
      if (url.pathname === '/admin') { ctx.requireAdmin(req); return ctx.send(res, 200, { ok: true }); }
      if (url.pathname.startsWith('/api/projects/')) { ctx.requireView(req, url); return ctx.send(res, 200, { ok: true }); }
      ctx.send(res, 404, { error: 'no' });
    } catch (e) { ctx.send(res, e.status || 500, { error: e.message }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); real?.close(); asql?.stop(); });

const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const login = (identifier, password) => call('/api/auth/login', { method: 'POST', body: { identifier, password } });

test('login: right password gives a session and the admin flag; wrong password and unknown user look the same', { skip }, async () => {
  const ok = await login('owner@example.com', 'a long owner password');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.admin, true);
  assert.equal(ok.json.user.email, 'owner@example.com');
  assert.match(ok.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await login('member@example.com', 'a long member password')).json.admin, false);

  const bad = await login('owner@example.com', 'not the password');
  const ghost = await login('ghost@example.com', 'not the password');
  assert.equal(bad.status, 401);
  assert.deepEqual(ghost, bad, 'an unknown user must not be distinguishable from a wrong password');
});

test('session: a valid token returns the user, a bad one is 401, and logout ends it', { skip }, async () => {
  const { json } = await login('member@example.com', 'a long member password');
  const me = await call('/api/auth/session', { token: json.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.user.memberships.map((m) => m.project), ['app']);
  assert.equal((await call('/api/auth/session', { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await call('/api/auth/session')).status, 401);
  assert.equal((await call('/api/auth/logout', { method: 'POST', token: json.token })).status, 200);
  assert.equal((await call('/api/auth/session', { token: json.token })).status, 401);
});

test('what a session may do: owner administers, member views only their project, a key still works', { skip }, async () => {
  const owner = (await login('owner@example.com', 'a long owner password')).json.token;
  const member = (await login('member@example.com', 'a long member password')).json.token;

  assert.equal((await call('/admin', { token: owner })).status, 200);
  assert.equal((await call('/admin', { token: member })).status, 401);
  assert.equal((await call('/admin')).status, 401);
  assert.equal((await call('/admin', { headers: { 'x-admin-key': 'test-admin-key' } })).status, 200, 'machine keys keep working');

  assert.equal((await call('/api/projects/app/state', { token: member })).status, 200);
  assert.equal((await call('/api/projects/other/state', { token: member })).status, 401);
  assert.equal((await call('/api/projects/other/state', { token: owner })).status, 200);
  assert.equal((await call('/api/projects/other/state')).status, 401);
});
