// The account layer of auth core, driven over an in-memory SQLite store (node:sqlite): the users API
// (GET/POST /api/auth/users, DELETE /api/auth/users/<email>), password-confirmed account deletion,
// service tokens in converge_tokens, and the first-install owner bootstrap. No HTTP server, no network:
// these tests exercise the pure store functions against a real database engine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { hashToken, verifyPassword } from '../scripts/lib/auth/core.mjs';
import {
  createUser,
  addMembership,
  revokeSession,
  findUserByName,
  findUserById,
  createSession,
  createServiceToken,
  revokeServiceToken,
  resolveRequestActor,
  listUsers,
  addUser,
  changeRole,
  deleteUser,
  bootstrapOwner,
} from '../scripts/lib/auth/store.mjs';

// The store speaks ASQL's run(sql, params) contract; node:sqlite spells the same calls
// StatementSync.run()/all(). This adapter is the only dialect difference the tests paper over.
function sqliteConn() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE converge_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE converge_credentials (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'password', algo TEXT NOT NULL DEFAULT 'scrypt', hash TEXT NOT NULL, params TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (user_id, kind));
    CREATE TABLE converge_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT);
    CREATE TABLE converge_memberships (user_id TEXT NOT NULL, project TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, project));
    CREATE TABLE converge_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, token_hash TEXT NOT NULL UNIQUE, scopes TEXT, created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT, revoked_at TEXT);
    CREATE TABLE converge_invites (id TEXT PRIMARY KEY, project TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT NOT NULL UNIQUE, invited_by TEXT, created_at TEXT NOT NULL, expires_at TEXT, accepted_at TEXT);
    CREATE TABLE converge_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, project TEXT, action TEXT NOT NULL, target TEXT, detail TEXT);
  `);
  return {
    db,
    async run(sql, params = []) {
      const stmt = db.prepare(sql);
      if (/^\s*select/i.test(sql)) return { rows: stmt.all(...params.map(norm)) };
      const r = stmt.run(...params.map(norm));
      return { rows: [], affectedRows: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    all(sql, params = []) { return db.prepare(sql).all(...params.map(norm)); },
    one(sql, params = []) { return db.prepare(sql).all(...params.map(norm))[0] || null; },
  };
}
// node:sqlite rejects undefined and booleans; the store only ever binds strings and nulls.
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

let conn;
beforeEach(() => { conn = sqliteConn(); });

const pass = 'correct horse battery staple';

async function withUser(overrides = {}) {
  return createUser(conn, { email: 'ada@example.com', name: 'Ada', password: pass, ...overrides });
}

test('bootstrapOwner makes the very first user an owner of * and only then', async () => {
  const owner = await bootstrapOwner(conn, { email: 'root@example.com', name: 'Root', password: pass });
  assert.ok(owner, 'the first bootstrap must create a user');
  assert.match(owner.id, /^user_/);
  const memberships = await conn.all('SELECT project, role FROM converge_memberships WHERE user_id = ?', [owner.id]);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].project, '*');
  assert.equal(memberships[0].role, 'owner');

  const again = await bootstrapOwner(conn, { email: 'second@example.com', name: 'Second', password: pass });
  assert.equal(again, null, 'once a user exists bootstrap must not create another owner');
  assert.equal(await findUserByName(conn, 'second@example.com'), null);
  assert.equal((await listUsers(conn)).length, 1);
});

test('addUser stores a scrypt hash, listUsers returns the public shape, changeRole re-roles a membership', async () => {
  await withUser({ email: 'admin@example.com', name: 'Admin' });
  const invited = await addUser(conn, { email: 'bob@example.com', name: 'Bob', password: 'hunter2hunter2', role: 'viewer', project: 'converge' });
  assert.equal(invited.email, 'bob@example.com');
  const cred = await conn.one('SELECT algo, hash FROM converge_credentials WHERE user_id = ?', [invited.id]);
  assert.equal(cred.algo, 'scrypt');
  assert.ok(!cred.hash.includes('hunter2hunter2'));
  assert.equal(await verifyPassword('hunter2hunter2', cred.hash), true);

  const users = await listUsers(conn);
  assert.equal(users.length, 2);
  const bob = users.find((u) => u.email === 'bob@example.com');
  assert.equal(bob.name, 'Bob');
  assert.deepEqual(bob.roles, { converge: 'viewer' });
  for (const u of users) assert.ok(!('hash' in u) && !('credential' in u), 'a listed user must not carry its credential');

  const changed = await changeRole(conn, 'bob@example.com', 'converge', 'maintainer');
  assert.equal(changed.role, 'maintainer');
  const after = (await listUsers(conn)).find((u) => u.email === 'bob@example.com');
  assert.deepEqual(after.roles, { converge: 'maintainer' });
  await assert.rejects(() => changeRole(conn, 'bob@example.com', 'converge', 'superuser'), /unknown role/);
});

test('createServiceToken stores only the hash and revokeServiceToken retires it', async () => {
  const user = await withUser();
  const token = await createServiceToken(conn, user.id, { name: 'ci', scopes: ['push'] });
  assert.match(token.id, /^token_/);
  assert.equal(token.tokenHash, hashToken(token.token));
  const row = await conn.one('SELECT token_hash, scopes, revoked_at FROM converge_tokens WHERE id = ?', [token.id]);
  assert.equal(row.token_hash, hashToken(token.token));
  assert.equal(row.token_hash.includes(token.token), false);
  assert.deepEqual(JSON.parse(row.scopes), ['push']);
  assert.equal(row.revoked_at, null);

  assert.equal(await revokeServiceToken(conn, token.token), true);
  const after = await conn.one('SELECT revoked_at FROM converge_tokens WHERE id = ?', [token.id]);
  assert.ok(after.revoked_at);
  assert.equal(await revokeServiceToken(conn, token.token), false, 'an already revoked token is not revoked twice');
  assert.equal(await revokeServiceToken(conn, 'no such token'), false);
});

test('resolveRequestActor accepts a Bearer session or a service token and carries the memberships', async () => {
  const user = await withUser();
  await addMembership(conn, user.id, 'converge', 'maintainer');

  const session = await createSession(conn, user.id);
  const bySession = await resolveRequestActor(conn, { authorization: `Bearer ${session.token}` });
  assert.equal(bySession.actor.id, user.id);
  assert.equal(bySession.actor.email, 'ada@example.com');
  assert.equal(bySession.via, 'session');
  assert.deepEqual(bySession.roles, { converge: 'maintainer' });
  assert.equal(bySession.tokenId, session.id);

  const service = await createServiceToken(conn, user.id, { name: 'ci' });
  const byToken = await resolveRequestActor(conn, { authorization: `Bearer ${service.token}` });
  assert.equal(byToken.actor.id, user.id);
  assert.equal(byToken.via, 'token');
  assert.equal(byToken.tokenId, service.id);
  assert.deepEqual(byToken.roles, { converge: 'maintainer' });

  assert.equal(await resolveRequestActor(conn, { authorization: 'Bearer not-a-real-token' }), null);
  assert.equal(await resolveRequestActor(conn, {}), null);
  assert.equal(await resolveRequestActor(conn, null), null);

  await revokeSession(conn, session.id);
  assert.equal(await resolveRequestActor(conn, { authorization: `Bearer ${session.token}` }), null, 'a revoked session stops resolving');
  await revokeServiceToken(conn, service.token);
  assert.equal(await resolveRequestActor(conn, { authorization: `Bearer ${service.token}` }), null, 'a revoked service token stops resolving');
});

test('deleteUser removes the account and everything acting as it, and refuses the last platform admin', async () => {
  const owner = await bootstrapOwner(conn, { email: 'root@example.com', name: 'Root', password: pass });
  const bob = await addUser(conn, { email: 'bob@example.com', name: 'Bob', password: pass });
  await addMembership(conn, bob.id, 'converge', 'member');
  const session = await createSession(conn, bob.id);
  const service = await createServiceToken(conn, bob.id, { name: 'ci' });

  const removed = await deleteUser(conn, 'bob@example.com', { actor: owner.email });
  assert.deepEqual(removed, { id: bob.id, email: 'bob@example.com' });
  assert.equal(await findUserById(conn, bob.id), null);
  assert.equal((await conn.all('SELECT id FROM converge_sessions WHERE user_id = ?', [bob.id])).length, 0);
  assert.equal((await conn.all('SELECT id FROM converge_tokens WHERE user_id = ?', [bob.id])).length, 0);
  assert.equal((await conn.all('SELECT id FROM converge_credentials WHERE user_id = ?', [bob.id])).length, 0);
  assert.equal((await conn.all('SELECT project FROM converge_memberships WHERE user_id = ?', [bob.id])).length, 0);
  assert.equal(await resolveRequestActor(conn, { authorization: `Bearer ${session.token}` }), null);
  assert.equal(await resolveRequestActor(conn, { authorization: `Bearer ${service.token}` }), null);

  await assert.rejects(() => deleteUser(conn, owner.email), /last owner or admin/);
});

test('a password-confirmed self-delete removes only the caller', async () => {
  const me = await withUser();
  const other = await addUser(conn, { email: 'grace@example.com', name: 'Grace', password: pass });
  const full = await findUserByName(conn, me.email);
  assert.equal(await verifyPassword(pass, full.credential.hash), true, 'the caller can prove the password before self-delete');

  const removed = await deleteUser(conn, me.id, { actor: me.email });
  assert.deepEqual(removed, { id: me.id, email: 'ada@example.com' });
  assert.equal(await findUserById(conn, me.id), null);
  assert.ok(await findUserById(conn, other.id), 'the other account is untouched');
});
