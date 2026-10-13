// The auth store is the ASQL data-access half of converge auth. These tests drive it over a real ASQL
// (test/fixtures/asql-server.mjs): users round-trip through converge_users, a session or service token is
// stored by token hash only, and a revoked or expired session stops being active.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyMigrations } from '../scripts/lib/auth/schema.mjs';
import { hashToken, verifyPassword } from '../scripts/lib/auth/core.mjs';
import {
  createUser,
  findUserByName,
  findUserById,
  createSession,
  findSessionByTokenHash,
  revokeSession,
  addMembership,
  listMemberships,
  createServiceToken,
} from '../scripts/lib/auth/store.mjs';
import { startAsql, asqlMissing } from './fixtures/asql-server.mjs';

const skip = asqlMissing();
let server;
before(async () => { if (!skip) server = await startAsql(); });
after(() => server?.stop());

// A clean set of auth tables on the real ASQL, per test.
async function connect() {
  const c = server.client;
  for (const t of ['converge_audit', 'converge_invites', 'converge_tokens', 'converge_memberships', 'converge_sessions', 'converge_credentials', 'converge_users', 'converge_migrations']) await c.query(`DROP TABLE IF EXISTS ${t}`);
  await applyMigrations(c);
  return c;
}
const one = async (c, sql, params) => (await c.run(sql, params)).rows[0];

function withUser(conn, overrides = {}) {
  return createUser(conn, {
    email: 'ada@example.com',
    name: 'Ada',
    password: 'correct horse battery staple',
    ...overrides,
  });
}

test('createUser stores a scrypt hash, never the password, and findUserByName reads it back', { skip }, async () => {
  const conn = await connect();
  const user = await createUser(conn, {
    email: 'ada@example.com',
    name: 'Ada',
    password: 'correct horse battery staple',
  });
  assert.match(user.id, /^user_/);
  assert.equal(user.email, 'ada@example.com');
  assert.equal(user.name, 'Ada');
  assert.ok(user.createdAt);

  const row = await one(conn, 'SELECT algo, hash FROM converge_credentials WHERE user_id = ?', [user.id]);
  assert.equal(row.algo, 'scrypt');
  assert.ok(
    !row.hash.includes('correct horse battery staple'),
    'the password itself must not be in the stored hash',
  );
  assert.equal(await verifyPassword('correct horse battery staple', row.hash), true);
  assert.equal(await verifyPassword('not the password', row.hash), false);

  const byName = await findUserByName(conn, 'Ada');
  assert.equal(byName.id, user.id);
  assert.equal(byName.email, 'ada@example.com');
  assert.deepEqual(byName.memberships, []);
  assert.equal(byName.credential.algo, 'scrypt');
  assert.equal(byName.credential.hash, row.hash);

  const byEmail = await findUserByName(conn, 'ada@example.com');
  assert.equal(byEmail.id, user.id);
  assert.equal(await findUserByName(conn, 'nobody at all'), null);
});

test('createSession stores only the token hash and findSessionByTokenHash accepts token or hash', { skip }, async () => {
  const conn = await connect();
  const user = await withUser(conn);
  const session = await createSession(conn, user.id);
  assert.match(session.id, /^session_/);
  assert.equal(session.userId, user.id);
  assert.ok(session.token.length >= 32);
  assert.equal(session.tokenHash, hashToken(session.token));

  const row = await one(conn, 'SELECT token_hash, user_id, expires_at FROM converge_sessions WHERE id = ?', [session.id]);
  assert.equal(row.token_hash, createHash('sha256').update(session.token).digest('hex'));
  assert.ok(
    !JSON.stringify(row).includes(session.token),
    'the plaintext token must not be stored',
  );
  assert.equal(row.user_id, user.id);
  assert.equal(row.expires_at, session.expiresAt);

  const found = await findSessionByTokenHash(conn, session.token);
  assert.equal(found.id, session.id);
  assert.equal(found.userId, user.id);
  assert.equal(found.active, true);
  assert.equal(found.revoked, false);
  assert.equal(found.expired, false);

  const byHash = await findSessionByTokenHash(conn, session.tokenHash);
  assert.equal(byHash.id, session.id);

  assert.equal(await findSessionByTokenHash(conn, 'no such session'), null);
});

test('revokeSession revokes a live session once and reports whether it matched', { skip }, async () => {
  const conn = await connect();
  const user = await withUser(conn);
  const session = await createSession(conn, user.id);

  assert.equal(await revokeSession(conn, session.token), true);
  const after = await findSessionByTokenHash(conn, session.token);
  assert.equal(after.revoked, true);
  assert.equal(after.active, false);
  assert.ok(after.revokedAt);

  assert.equal(await revokeSession(conn, session.token), false);
  assert.equal(await revokeSession(conn, session.id), false);
  assert.equal(await revokeSession(conn, 'nothing to revoke'), false);
  await assert.rejects(() => revokeSession(conn, ''), TypeError);
});

test('a session past its expiresAt is found but no longer active', { skip }, async () => {
  const conn = await connect();
  const user = await withUser(conn);
  const past = new Date(Date.now() - 60_000).toISOString();
  const session = await createSession(conn, user.id, { token: 'expired token', expiresAt: past });
  assert.equal(session.expiresAt, past);

  const found = await findSessionByTokenHash(conn, 'expired token');
  assert.equal(found.id, session.id);
  assert.equal(found.expired, true);
  assert.equal(found.revoked, false);
  assert.equal(found.active, false);

  const live = await createSession(conn, user.id, { token: 'live token', ttlSeconds: 60 });
  assert.ok(new Date(live.expiresAt).getTime() > Date.now());
  assert.equal((await findSessionByTokenHash(conn, 'live token')).active, true);
});

test('addMembership refuses an unknown role before it touches the connection', { skip }, async () => {
  const conn = await connect();
  await assert.rejects(() => addMembership(conn, 'user_1', 'converge', 'wizard'), /unknown role/);
  assert.equal(Number((await one(conn, 'SELECT COUNT(*) AS n FROM converge_memberships', [])).n), 0);
});

test('listMemberships maps the rows of one user, or of every user', { skip }, async () => {
  const conn = await connect();
  const user = await withUser(conn);
  await createUser(conn, { id: 'user_other', email: 'other@example.com' });
  await addMembership(conn, user.id, 'zeta', 'owner');
  await addMembership(conn, user.id, 'alpha', 'member');
  await addMembership(conn, 'user_other', 'alpha', 'viewer');

  const mine = await listMemberships(conn, user.id);
  assert.deepEqual(mine.map((m) => [m.project, m.role]), [['alpha', 'member'], ['zeta', 'owner']]);
  assert.equal(mine[0].userId, user.id);

  const all = await listMemberships(conn);
  assert.deepEqual(
    all.map((m) => `${m.userId}:${m.project}`).sort(),
    [`${user.id}:alpha`, `${user.id}:zeta`, 'user_other:alpha'].sort(),
  );
  assert.deepEqual(await listMemberships(conn, 'user_none'), []);

  const found = await findUserByName(conn, user.email);
  assert.equal(found.memberships.length, 2);
  assert.deepEqual(found.memberships.map((m) => m.project), ['alpha', 'zeta']);
});

test('createServiceToken stores the token hash and its scopes, never the token', { skip }, async () => {
  const conn = await connect();
  const user = await withUser(conn);
  const token = await createServiceToken(conn, user.id, {
    name: 'ci',
    scopes: ['read', 'push'],
    ttlSeconds: 3600,
  });
  assert.match(token.id, /^token_/);
  assert.equal(token.userId, user.id);
  assert.equal(token.name, 'ci');
  assert.deepEqual(token.scopes, ['read', 'push']);
  assert.equal(token.tokenHash, hashToken(token.token));

  const row = await one(conn, 'SELECT token_hash, scopes, name FROM converge_tokens WHERE id = ?', [token.id]);
  assert.equal(row.token_hash, hashToken(token.token));
  assert.equal(row.scopes, JSON.stringify(['read', 'push']));
  assert.ok(!JSON.stringify(row).includes(token.token), 'the plaintext token must not be stored');
  assert.equal(row.name, 'ci');

  const bare = await createServiceToken(conn, user.id);
  assert.equal(bare.name, null);
  assert.equal(bare.scopes, null);
  assert.equal(bare.expiresAt, null);
  const bareRow = await one(conn, 'SELECT scopes, expires_at FROM converge_tokens WHERE id = ?', [bare.id]);
  assert.equal(bareRow.scopes, null);
  assert.equal(bareRow.expires_at, null);

  await assert.rejects(() => createServiceToken(conn, ''), TypeError);
});

test('findUserById reads a session\'s user back, and a shared display name never picks an account', { skip }, async () => {
  const conn = await connect();
  const ada = await withUser(conn);
  await addMembership(conn, ada.id, '*', 'owner');
  const byId = await findUserById(conn, ada.id);
  assert.equal(byId.email, 'ada@example.com');
  assert.deepEqual(byId.memberships.map((m) => [m.project, m.role]), [['*', 'owner']]);
  assert.equal(await findUserById(conn, 'user_none'), null);

  // Two accounts named "Sam": the name alone must not sign in as either. An email still does.
  await createUser(conn, { email: 'sam1@example.com', name: 'Sam', password: 'a long enough password' });
  await createUser(conn, { email: 'sam2@example.com', name: 'Sam', password: 'a long enough password' });
  assert.equal(await findUserByName(conn, 'Sam'), null);
  assert.equal((await findUserByName(conn, 'sam2@example.com')).email, 'sam2@example.com');
  // A name equal to someone's email loses to that email.
  await createUser(conn, { email: 'eve@example.com', name: 'ada@example.com' });
  assert.equal((await findUserByName(conn, 'ada@example.com')).id, ada.id);
});

test('values with quotes, backslashes and SQL in them are data, and numbers read back as numbers', { skip }, async () => {
  const conn = await connect();
  const evil = "x'; DROP TABLE converge_users; -- \\";
  const u = await createUser(conn, { email: 'q@example.com', name: evil });
  assert.equal((await findUserById(conn, u.id)).name, evil);
  await conn.query('CREATE TABLE IF NOT EXISTS t_types (id BIGINT, f DOUBLE, d DATETIME, s SMALLINT)');
  await conn.query('DELETE FROM t_types');
  await conn.run('INSERT INTO t_types (id, f, d, s) VALUES (?, ?, ?, ?)', [9007199254740993n, 1.5, '2026-10-06 12:34:56', -7]);
  const row = (await conn.run('SELECT id, f, d, s FROM t_types WHERE id = ?', [9007199254740993n])).rows[0];
  assert.deepEqual(row, { id: '9007199254740993', f: '1.5', d: '2026-10-06 12:34:56', s: '-7' });
  await conn.query('DROP TABLE t_types');
});
