// Auth store: ASQL-backed data access for converge auth.
//
// Every function here takes an open AsqlClient as its first argument and runs
// its statements through its run(sql, params): each statement is prepared once
// and the values are bound, never spliced into the SQL text. Passing null or
// undefined uses the process-wide client from getAsql().
//
// The tables are the ones ./schema.mjs migrates: converge_users,
// converge_credentials, converge_sessions, converge_memberships and
// converge_tokens. Secrets never reach storage in the clear: a password is
// stored as the self-describing scrypt string hashPassword() returns, and a
// session or service token is stored only as hashToken(value) in its
// token_hash column. The plaintext value leaves createSession() /
// createServiceToken() exactly once, for the caller to hand to the client; it
// is never a parameter of any other statement and never read back out of a row.

import { randomUUID } from 'node:crypto';
import { getAsql } from '../asql.mjs';
import { hashPassword, hashToken, mintSession, ROLE_ACTIONS, verifyPassword } from './core.mjs';

/** Sessions live a week unless the caller passes ttlSeconds or expiresAt. */
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const SHA256_HEX = /^[0-9a-f]{64}$/;

function nowIso() {
  return new Date().toISOString();
}

function isoIn(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000).toISOString();
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function text(value) {
  return value === undefined || value === null ? null : String(value);
}

function resolveConnection(conn) {
  if (conn === undefined || conn === null) return getAsql();
  if (typeof conn === 'object') return conn;
  throw new TypeError(`auth/store: an ASQL connection is required, got ${typeof conn}`);
}

// Run one statement on `conn` and return the engine's result object.
async function run(conn, sql, params = []) {
  const connection = resolveConnection(conn);
  if (typeof connection.run !== 'function') throw new TypeError('auth/store: the connection must offer run(sql, params) (an AsqlClient)');
  return connection.run(sql, params);
}

// ASQL answers rows keyed by the column name it chose; look a column up
// case-insensitively so names that arrive upper-cased still map cleanly.
function field(row, name) {
  if (!row) return null;
  if (row[name] !== undefined && row[name] !== null) return row[name];
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === wanted && row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
  }
  return null;
}

function firstRow(result) {
  if (!result) return null;
  if (Array.isArray(result)) return result[0] || null;
  if (Array.isArray(result.rows)) return result.rows[0] || null;
  return null;
}

function allRows(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rows)) return result.rows;
  return [];
}

function affectedRows(result) {
  if (!result) return 0;
  if (typeof result.affectedRows === 'number') return result.affectedRows;
  if (typeof result.affectedRows === 'string') return Number(result.affectedRows);
  if (Array.isArray(result.rows)) return result.rows.length;
  return 0;
}

// Parse the timestamps the auth tables carry: ISO from this module, or the
// engine's `YYYY-MM-DD HH:MM:SS` (UTC) if a row was written by hand.
function parseTime(value) {
  if (!value) return NaN;
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  return Date.parse(iso);
}

// A token value leaves the caller as plaintext and reaches storage only as its
// sha256 hex digest. Callers that already hold the digest may pass it through.
function digestOf(value) {
  const raw = String(value);
  return SHA256_HEX.test(raw) ? raw.toLowerCase() : hashToken(raw);
}

function resolveExpiry(options, defaultTtlSeconds) {
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.expiresAt !== undefined && opts.expiresAt !== null) {
    const when = opts.expiresAt instanceof Date
      ? opts.expiresAt
      : new Date(String(opts.expiresAt));
    return Number.isNaN(when.getTime()) ? null : when.toISOString();
  }
  const ttl = opts.ttlSeconds !== undefined && opts.ttlSeconds !== null
    ? Number(opts.ttlSeconds)
    : Number(defaultTtlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return isoIn(ttl);
}

function normalizeRole(role) {
  const chosen = String(
    role === undefined || role === null || role === '' ? 'member' : role,
  ).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ROLE_ACTIONS, chosen)) {
    throw new RangeError(`addMembership: unknown role '${chosen}'`);
  }
  return chosen;
}

function normalizeScopes(scopes) {
  if (scopes === undefined || scopes === null) return null;
  if (Array.isArray(scopes)) {
    return scopes.length ? JSON.stringify(scopes.map((scope) => String(scope))) : null;
  }
  if (typeof scopes === 'string') return scopes.trim() || null;
  return JSON.stringify(scopes);
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: field(row, 'id'),
    email: field(row, 'email'),
    name: field(row, 'name'),
    createdAt: field(row, 'created_at'),
    updatedAt: field(row, 'updated_at'),
  };
}

function mapMembership(row) {
  return {
    userId: field(row, 'user_id'),
    project: field(row, 'project'),
    role: field(row, 'role'),
    createdAt: field(row, 'created_at'),
    updatedAt: field(row, 'updated_at'),
  };
}

// A session row plus the two questions every caller asks of it. A session with
// no expires_at never expires; one whose timestamp cannot be read is reported
// as expired, because the store cannot prove it is still live.
function mapSession(row) {
  if (!row) return null;
  const expiresAt = field(row, 'expires_at');
  const revokedAt = field(row, 'revoked_at');
  const expiry = parseTime(expiresAt);
  const expired = Boolean(expiresAt) && !(Number.isFinite(expiry) && expiry > Date.now());
  return {
    id: field(row, 'id'),
    userId: field(row, 'user_id'),
    tokenHash: field(row, 'token_hash'),
    createdAt: field(row, 'created_at'),
    expiresAt: expiresAt || null,
    revokedAt: revokedAt || null,
    revoked: Boolean(revokedAt),
    expired,
    active: !revokedAt && !expired,
  };
}

// Create a user, and -- when a password is given -- its password credential.
// The password itself is never stored: hashPassword() produces the
// self-describing scrypt string that goes into converge_credentials.hash.
// Returns the public user shape (id, email, name, timestamps), no secret.
export async function createUser(conn, input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const email = text(source.email);
  if (!email) throw new TypeError('createUser: input.email is required');
  const id = text(source.id) || newId('user');
  const name = text(source.name);
  const now = nowIso();

  await run(
    conn,
    'INSERT INTO converge_users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, email, name, now, now],
  );

  if (source.password !== undefined && source.password !== null && source.password !== '') {
    const hash = await hashPassword(source.password);
    await run(
      conn,
      'INSERT INTO converge_credentials (id, user_id, kind, algo, hash, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [newId('cred'), id, 'password', 'scrypt', hash, null, now, now],
    );
  }

  return { id, email, name, createdAt: now, updatedAt: now };
}

// Look a user up by email or by name (a sign-in form accepts either) and hand
// back the in-memory shape lib/auth/core.mjs works with: the user's rows, its
// memberships, and the stored credential (a scrypt hash, never a password).
export async function findUserByName(conn, name) {
  const wanted = text(name);
  if (!wanted) return null;

  // An email is unique and wins. A display name is accepted only while exactly one user carries it:
  // a name that two accounts share (or that is another account's email) never picks one of them.
  const cols = 'id, email, name, created_at, updated_at';
  let row = firstRow(await run(conn, `SELECT ${cols} FROM converge_users WHERE email = ? LIMIT 1`, [wanted]));
  if (!row) {
    const byName = allRows(await run(conn, `SELECT ${cols} FROM converge_users WHERE name = ? LIMIT 2`, [wanted]));
    if (byName.length === 1) row = byName[0];
  }
  const result = row;
  const user = mapUser(result);
  if (!user) return null;

  user.memberships = await listMemberships(conn, user.id);

  const credential = firstRow(await run(
    conn,
    'SELECT algo, hash, params FROM converge_credentials WHERE user_id = ? LIMIT 1',
    [user.id],
  ));
  user.credential = credential
    ? {
      algo: field(credential, 'algo'),
      hash: field(credential, 'hash'),
      params: field(credential, 'params'),
    }
    : null;

  return user;
}

// The same in-memory shape as findUserByName, looked up by user id (what a session row carries).
export async function findUserById(conn, id) {
  const wanted = text(id);
  if (!wanted) return null;
  const row = firstRow(await run(conn, 'SELECT id, email, name, created_at, updated_at FROM converge_users WHERE id = ? LIMIT 1', [wanted]));
  const user = mapUser(row);
  if (!user) return null;
  user.memberships = await listMemberships(conn, user.id);
  return user;
}

// Mint a session for `userId`. The plaintext token is returned once, in the
// result's `token` field; the row keeps only hashToken(token). Pass
// { token } to store a caller-supplied value, { ttlSeconds } or
// { expiresAt } to set the deadline; the default is one week.
export async function createSession(conn, userId, options = {}) {
  const owner = text(userId);
  if (!owner) throw new TypeError('createSession: a user id is required');
  const opts = options && typeof options === 'object' ? options : {};
  const token = text(opts.token) || mintSession();
  const tokenHash = hashToken(token);
  const id = text(opts.id) || newId('session');
  const now = nowIso();
  const expiresAt = resolveExpiry(opts, DEFAULT_SESSION_TTL_SECONDS);

  await run(
    conn,
    'INSERT INTO converge_sessions (id, user_id, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, owner, tokenHash, now, expiresAt, null],
  );

  return { id, userId: owner, token, tokenHash, createdAt: now, expiresAt };
}

// Find the session a token (or its digest) names. The plaintext token is
// hashed here before it reaches SQL, so the query only ever compares digests.
// Returns null when nothing matches, otherwise the row plus revoked/expired.
export async function findSessionByTokenHash(conn, tokenOrHash) {
  const identifier = text(tokenOrHash);
  if (!identifier) return null;
  const tokenHash = digestOf(identifier);

  const result = await run(
    conn,
    'SELECT id, user_id, token_hash, created_at, expires_at, revoked_at FROM converge_sessions WHERE token_hash = ? LIMIT 1',
    [tokenHash],
  );
  return mapSession(firstRow(result));
}

// Revoke a session by its id or by its token (the value or the digest).
// Returns true when a live row was updated, false when nothing matched.
export async function revokeSession(conn, sessionIdOrToken) {
  const identifier = text(sessionIdOrToken);
  if (!identifier) {
    throw new TypeError('revokeSession: a session id or token is required');
  }
  const now = nowIso();
  const result = await run(
    conn,
    'UPDATE converge_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND (token_hash = ? OR id = ?)',
    [now, digestOf(identifier), identifier],
  );
  return affectedRows(result) > 0;
}

// Grant (or re-role) one membership. A role outside ROLE_ACTIONS is refused
// rather than stored, so converge_memberships.role always carries a role that
// lib/auth/core.mjs can() knows how to read.
export async function addMembership(conn, userId, project, role = 'member') {
  const owner = text(userId);
  const name = text(project);
  if (!owner) throw new TypeError('addMembership: a user id is required');
  if (!name) throw new TypeError('addMembership: a project is required');
  const chosen = normalizeRole(role);
  const now = nowIso();

  // Portable upsert: MySQL's ON DUPLICATE KEY UPDATE is not SQLite's syntax,
  // and the store runs over both (ASQL in production, node:sqlite in tests).
  // One row per (user_id, project), so an UPDATE-then-INSERT is enough.
  const updated = await run(
    conn,
    'UPDATE converge_memberships SET role = ?, updated_at = ? WHERE user_id = ? AND project = ?',
    [chosen, now, owner, name],
  );
  if (affectedRows(updated) === 0) {
    await run(
      conn,
      'INSERT INTO converge_memberships (user_id, project, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [owner, name, chosen, now, now],
    );
  }

  return { userId: owner, project: name, role: chosen, createdAt: now, updatedAt: now };
}

// The memberships of one user, or of every user when no id is given, oldest
// ordering left to the database (sorted by project / user for stable output).
export async function listMemberships(conn, userId) {
  const owner = text(userId);
  const columns = 'user_id, project, role, created_at, updated_at';
  const result = owner
    ? await run(
      conn,
      `SELECT ${columns} FROM converge_memberships WHERE user_id = ? ORDER BY project`,
      [owner],
    )
    : await run(
      conn,
      `SELECT ${columns} FROM converge_memberships ORDER BY user_id, project`,
      [],
    );
  return allRows(result).map(mapMembership);
}

// Mint a long-lived service token for `userId`. Like a session, the plaintext
// leaves exactly once and the row keeps only hashToken(token); scopes are
// stored as a JSON array. No deadline unless ttlSeconds / expiresAt is given.
export async function createServiceToken(conn, userId, options = {}) {
  const owner = text(userId);
  if (!owner) throw new TypeError('createServiceToken: a user id is required');
  const opts = options && typeof options === 'object' ? options : {};
  const token = text(opts.token) || mintSession();
  const tokenHash = hashToken(token);
  const id = text(opts.id) || newId('token');
  const name = text(opts.name);
  const scopes = normalizeScopes(opts.scopes);
  const now = nowIso();
  const expiresAt = resolveExpiry(opts, null);

  await run(
    conn,
    'INSERT INTO converge_tokens (id, user_id, name, token_hash, scopes, created_at, last_used_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, owner, name, tokenHash, scopes, now, null, expiresAt, null],
  );

  return {
    id,
    userId: owner,
    name,
    token,
    tokenHash,
    scopes: scopes ? JSON.parse(scopes) : null,
    createdAt: now,
    expiresAt,
  };
}

// Retire a service token by its id or by its value (the plaintext or its digest).
// Returns true when a live row was updated, false when nothing matched.
export async function revokeServiceToken(conn, tokenIdOrValue) {
  const identifier = text(tokenIdOrValue);
  if (!identifier) {
    throw new TypeError('revokeServiceToken: a token id or value is required');
  }
  const now = nowIso();
  const result = await run(
    conn,
    'UPDATE converge_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND (token_hash = ? OR id = ?)',
    [now, digestOf(identifier), identifier],
  );
  return affectedRows(result) > 0;
}

// Split an Authorization header / options object down to the bearer value.
function bearerValue(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const raw = source.authorization !== undefined ? source.authorization : source.Authorization;
  if (raw === undefined || raw === null) return text(source.token) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : String(raw).trim();
}

// Service-token rows carry the same liveness questions as sessions.
function mapServiceToken(row) {
  if (!row) return null;
  const expiresAt = field(row, 'expires_at');
  const revokedAt = field(row, 'revoked_at');
  const expiry = parseTime(expiresAt);
  const expired = Boolean(expiresAt) && !(Number.isFinite(expiry) && expiry > Date.now());
  return {
    id: field(row, 'id'),
    userId: field(row, 'user_id'),
    name: field(row, 'name'),
    tokenHash: field(row, 'token_hash'),
    expiresAt: expiresAt || null,
    revokedAt: revokedAt || null,
    revoked: Boolean(revokedAt),
    expired,
    active: !revokedAt && !expired,
  };
}

// Find the service token a value (or digest) names. Only digests reach SQL.
export async function findServiceTokenByTokenHash(conn, tokenOrHash) {
  const identifier = text(tokenOrHash);
  if (!identifier) return null;
  const result = await run(
    conn,
    'SELECT id, user_id, name, token_hash, created_at, last_used_at, expires_at, revoked_at FROM converge_tokens WHERE token_hash = ? LIMIT 1',
    [digestOf(identifier)],
  );
  return mapServiceToken(firstRow(result));
}

// Who is asking? Accepts a request-shaped object ({ authorization: 'Bearer ...' }, { token }, or
// plain header names) and looks the bearer value up as a live session first, then as a live service
// token. Returns null when neither matches; otherwise the actor plus their memberships
// ({ id, email, name }, roles keyed by project, via: 'session' | 'token').
export async function resolveRequestActor(conn, request) {
  const source = request && typeof request === 'object' ? request : {};
  const value = bearerValue(source);
  if (!value) return null;

  const session = await findSessionByTokenHash(conn, value);
  let userId = session && session.active ? session.userId : null;
  let via = 'session';
  let tokenId = session ? session.id : null;

  if (!userId) {
    const token = await findServiceTokenByTokenHash(conn, value);
    userId = token && token.active ? token.userId : null;
    via = 'token';
    tokenId = token ? token.id : null;
  }
  if (!userId) return null;

  const user = await findUserById(conn, userId);
  if (!user) return null;

  const memberships = user.memberships || [];
  const roles = {};
  for (const membership of memberships) {
    if (membership && membership.project !== undefined && membership.project !== null) {
      roles[String(membership.project)] = membership.role;
    }
  }

  return {
    actor: { id: user.id, email: user.email, name: user.name },
    user,
    memberships,
    roles,
    via,
    tokenId,
  };
}

// The public shape of a user for the users API: no credential, memberships folded into roles.
function publicUser(user, memberships) {
  const roles = {};
  for (const membership of memberships || []) {
    if (membership && membership.project !== undefined && membership.project !== null) {
      roles[String(membership.project)] = membership.role;
    }
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    roles,
    memberships: memberships || [],
  };
}

// Every user with its roles, oldest-first by id for stable output. Never carries a credential.
export async function listUsers(conn) {
  const rows = allRows(await run(
    conn,
    'SELECT id, email, name, created_at, updated_at FROM converge_users ORDER BY email',
    [],
  ));
  const out = [];
  for (const row of rows) {
    const user = mapUser(row);
    if (!user) continue;
    out.push(publicUser(user, await listMemberships(conn, user.id)));
  }
  return out;
}

// Create a user and optionally grant one membership, in one operation: what POST
// /api/auth/users needs. Returns the public user shape (no credential).
export async function addUser(conn, input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const user = await createUser(conn, source);
  if (source.role !== undefined && source.role !== null && source.role !== '') {
    const project = source.project !== undefined && source.project !== null && source.project !== ''
      ? source.project
      : '*';
    await addMembership(conn, user.id, project, source.role);
  }
  return publicUser(user, await listMemberships(conn, user.id));
}

// Re-role one user's membership on `project`. The user may be named by id or email;
// the role must be one of ROLE_ACTIONS (addMembership refuses anything else).
export async function changeRole(conn, idOrEmail, project, role) {
  const user = (await findUserById(conn, idOrEmail)) || (await findUserByName(conn, idOrEmail));
  if (!user) return null;
  return addMembership(conn, user.id, project, role);
}

// First-install bootstrap: create the very first user as owner of '*' (the whole
// platform) and only while no user exists at all. Returns the new user, or null
// when anyone is already there -- so the endpoint is safe to call on every boot.
export async function bootstrapOwner(conn, input = {}) {
  const existing = firstRow(await run(conn, 'SELECT id FROM converge_users LIMIT 1', []));
  if (existing) return null;
  const user = await createUser(conn, input);
  await addMembership(conn, user.id, '*', 'owner');
  return user;
}

const ADMIN_ROLES = new Set(['owner', 'admin']);

// Remove a user (by id or email) and everything that signs in or acts as them: sessions, service tokens,
// credentials, memberships, and the invites sent to their email. The audit trail keeps naming them (it is
// history) and gains a row saying who removed them. Refuses to remove the last owner or admin of the whole
// platform: nobody would be left to administer it. Resolves to { id, email } of the removed user, or null
// when there is no such user.
export async function deleteUser(conn, idOrEmail, { actor = null } = {}) {
  const user = (await findUserById(conn, idOrEmail)) || (await findUserByName(conn, idOrEmail));
  if (!user) return null;
  const admins = (await listMemberships(conn)).filter((m) => m.project === '*' && ADMIN_ROLES.has(m.role));
  if (admins.some((m) => m.userId === user.id) && !admins.some((m) => m.userId !== user.id)) {
    throw Object.assign(new Error(`${user.email} is the last owner or admin of the platform: make someone else one first`), { code: 'LAST_ADMIN' });
  }
  // What signs in goes first, so a failure part-way never leaves a removed account able to act.
  for (const sql of [
    'DELETE FROM converge_sessions WHERE user_id = ?',
    'DELETE FROM converge_tokens WHERE user_id = ?',
    'DELETE FROM converge_credentials WHERE user_id = ?',
    'DELETE FROM converge_memberships WHERE user_id = ?',
  ]) await run(conn, sql, [user.id]);
  await run(conn, 'DELETE FROM converge_invites WHERE email = ?', [user.email]);
  await run(conn, 'DELETE FROM converge_users WHERE id = ?', [user.id]);
  await run(
    conn,
    'INSERT INTO converge_audit (at, actor, project, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [nowIso(), text(actor), '*', 'user.delete', user.email, JSON.stringify({ id: user.id })],
  );
  return { id: user.id, email: user.email };
}

export default {
  createUser,
  deleteUser,
  findUserByName,
  findUserById,
  createSession,
  findSessionByTokenHash,
  revokeSession,
  addMembership,
  listMemberships,
  createServiceToken,
};
