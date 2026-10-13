// The auth schema module is the single source of truth for the auth tables. These tests run it against a real ASQL
// (test/fixtures/asql-server.mjs), not a stand-in database: it must create every table, keep token values out of the
// database (only token_hash), enforce its constraints, and be safe to re-run on every boot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS, MIGRATIONS_TABLE, applyMigrations } from '../scripts/lib/auth/schema.mjs';
import { startAsql, asqlMissing } from './fixtures/asql-server.mjs';

const skip = asqlMissing();
const TABLES = ['converge_migrations', 'converge_users', 'converge_credentials', 'converge_sessions', 'converge_memberships', 'converge_tokens', 'converge_invites', 'converge_audit'];
let server;
before(async () => { if (!skip) server = await startAsql(); });
after(() => server?.stop());

const fresh = async () => {
  const c = server.client;
  for (const t of TABLES) await c.query(`DROP TABLE IF EXISTS ${t}`);
  return c;
};
const columns = async (c, table) => (await c.query(`SELECT * FROM ${table} LIMIT 0`)).columns.map((x) => x.name);
const rejects = (p, re = /duplicate|unique|constraint/i) => assert.rejects(p, re);

test('MIGRATIONS is an ordered array of {id, sql} with positive integer ids, in the MySQL dialect', () => {
  assert.ok(Array.isArray(MIGRATIONS) && MIGRATIONS.length >= 8);
  const ids = MIGRATIONS.map((m) => m.id);
  for (const m of MIGRATIONS) {
    assert.ok(Number.isInteger(m.id) && m.id > 0 && typeof m.sql === 'string' && m.sql.trim());
    // ASQL is MySQL-dialect: none of SQLite's spellings may come back.
    assert.doesNotMatch(m.sql, /datetime\('now'\)|AUTOINCREMENT|INSERT OR |CREATE (UNIQUE )?INDEX|PRAGMA/i, `migration ${m.id} is not MySQL`);
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test('applyMigrations creates every auth table and records each applied id', { skip }, async () => {
  const c = await fresh();
  assert.deepEqual(await applyMigrations(c), MIGRATIONS.map((m) => m.id));
  for (const t of TABLES) await c.query(`SELECT 1 FROM ${t} LIMIT 1`);
  const recorded = (await c.query(`SELECT id FROM ${MIGRATIONS_TABLE}`)).rows.map((r) => String(r.id));
  assert.deepEqual(recorded.sort(), MIGRATIONS.map((m) => String(m.id)).sort());
});

test('applyMigrations is idempotent, and re-runs only the ids missing from the ledger', { skip }, async () => {
  const c = await fresh();
  await applyMigrations(c);
  assert.deepEqual(await applyMigrations(c), []);
  const dropped = MIGRATIONS[2].id;
  await c.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [String(dropped)]);
  assert.deepEqual(await applyMigrations(c), [dropped]);
  assert.deepEqual(await applyMigrations(c), []);
});

test('sessions, tokens and invites keep only token_hash, never a plaintext token', { skip }, async () => {
  const c = await fresh(); await applyMigrations(c);
  for (const table of ['converge_sessions', 'converge_tokens', 'converge_invites']) {
    const cols = await columns(c, table);
    assert.ok(cols.includes('token_hash'), `${table} must have token_hash`);
    for (const bad of ['token', 'plaintext', 'secret', 'value']) assert.ok(!cols.includes(bad), `${table} must not store ${bad}`);
  }
});

test('the tables expose the columns the store reads', { skip }, async () => {
  const c = await fresh(); await applyMigrations(c);
  const want = { converge_memberships: ['user_id', 'project', 'role'], converge_users: ['email', 'name'], converge_credentials: ['user_id', 'kind', 'hash'], converge_audit: ['at', 'action'] };
  for (const [t, cols] of Object.entries(want)) { const have = await columns(c, t); for (const col of cols) assert.ok(have.includes(col), `${t} missing ${col}`); }
});

test('the constraints hold: unique email, unique token_hash, one role per user/project', { skip }, async () => {
  const c = await fresh(); await applyMigrations(c);
  const now = new Date().toISOString();
  await c.run('INSERT INTO converge_users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)', ['u1', 'a@example.com', now, now]);
  await rejects(c.run('INSERT INTO converge_users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)', ['u2', 'a@example.com', now, now]));
  await c.run('INSERT INTO converge_sessions (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)', ['s1', 'u1', 'h1', now]);
  await rejects(c.run('INSERT INTO converge_sessions (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)', ['s2', 'u1', 'h1', now]));
  await c.run('INSERT INTO converge_tokens (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)', ['t1', 'u1', 'th1', now]);
  await rejects(c.run('INSERT INTO converge_tokens (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)', ['t2', 'u1', 'th1', now]));
  await c.run('INSERT INTO converge_memberships (user_id, project, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['u1', 'p', 'owner', now, now]);
  await rejects(c.run('INSERT INTO converge_memberships (user_id, project, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['u1', 'p', 'member', now, now]));
  assert.equal((await c.run('SELECT role FROM converge_memberships WHERE user_id = ?', ['u1'])).rows[0].role, 'owner');
});

test('applyMigrations refuses a connection it cannot use', async () => {
  await assert.rejects(() => applyMigrations(null), TypeError);
  await assert.rejects(() => applyMigrations({}), TypeError);
});
