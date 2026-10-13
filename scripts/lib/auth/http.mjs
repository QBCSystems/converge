// The HTTP side of sign-in for the local platform: who a request is (a session in ASQL), and the /api/auth routes.
// A session token is minted by core.mjs mintSession() and only its hash is stored (store.mjs).
import { bearer, httpError, send, readJson, randomHex, warn } from '../dev-context.mjs';
import { getAsql } from '../asql.mjs';
import { findUserByName, findUserById, createSession, findSessionByTokenHash, revokeSession, deleteUser, listUsers, addUser } from './store.mjs';
import { createFirstAccount } from './first-user.mjs';
import { setupStatus } from './setup.mjs';
import { verifyPassword, hashPassword, hashToken } from './core.mjs';

const SESSION_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url: an agent key or an admin key never looks like this
const PLATFORM_SCOPE = '*';                  // a membership on this project name is a role on the whole platform
const PRINCIPAL_TTL_MS = 5000;               // a revoked session stops working within this long

/** May this user administer the platform? An owner or admin of the platform scope. */
const isPlatformAdmin = (user) => user.memberships.some((m) => m.project === PLATFORM_SCOPE && (m.role === 'owner' || m.role === 'admin'));
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, memberships: user.memberships || [] });

// ---- who is asking ----
const principals = new Map(); // token digest -> { at, value }

/** The signed-in user a request carries, as { user, admin }, or null. Looks at the Authorization bearer, X-View-Key, and
 *  the `key` and `session` query parameters (a browser cannot set headers on a WebSocket). */
export async function principalFor(req, url) {
  const candidates = [bearer(req), String(req.headers['x-view-key'] || ''), url.searchParams.get('key') || '', url.searchParams.get('session') || ''];
  const token = candidates.find((c) => SESSION_SHAPE.test(c));
  if (!token) return null;
  const digest = hashToken(token);
  const hit = principals.get(digest);
  if (hit && Date.now() - hit.at < PRINCIPAL_TTL_MS) return hit.value;
  let value = null;
  try {
    const asql = getAsql();
    const session = await findSessionByTokenHash(asql, digest);
    const user = session?.active ? await findUserById(asql, session.userId) : null;
    if (user) value = { user, admin: isPlatformAdmin(user) };
  } catch (e) { warn('auth', `session lookup failed: ${e.message}`); }
  principals.set(digest, { at: Date.now(), value });
  if (principals.size > 500) for (const [k, v] of principals) if (Date.now() - v.at >= PRINCIPAL_TTL_MS) principals.delete(k);
  return value;
}

// ---- sign-in hygiene ----
let decoyHash = '';
hashPassword(randomHex(16)).then((h) => { decoyHash = h; });
const failures = new Map(); // remote address -> { n, until }

/** A growing pause after repeated failures from one address: the response is slowed, nobody is locked out. */
async function loginDelay(req) {
  const ip = req.socket.remoteAddress || '?';
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n += 1; f.until = Date.now() + 60_000;
  failures.set(ip, f);
  if (failures.size > 1000) for (const [k, v] of failures) if (v.until < Date.now()) failures.delete(k);
  await new Promise((r) => setTimeout(r, Math.min(2000, 100 * 2 ** Math.min(f.n - 1, 5))));
}

/** Remove a user and forget every principal already worked out, so none of its sessions outlives it. */
async function removeUser(target, actor) {
  let removed;
  try { removed = await deleteUser(getAsql(), target, { actor }); } catch (e) { throw e.code === 'LAST_ADMIN' ? httpError(409, e.message) : e; }
  principals.clear();
  return removed;
}

// ---- routes: POST /api/auth/login, GET /api/auth/session, POST /api/auth/logout,
//      DELETE /api/auth/account (yourself, with your password), DELETE /api/auth/users/<email or id> (an admin) ----
/** Answers an /api/auth request and returns true, or returns false when the request is not one. */
export async function authRoutes(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/setup' && method === 'GET') {
    send(res, 200, await setupStatus({ countUsers: async () => (await listUsers(getAsql())).length }));
    return true;
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const identifier = String(body.username || body.email || body.identifier || '').trim();
    const password = String(body.password || '');
    if (!identifier || !password) throw httpError(400, 'username and password are required');
    const asql = getAsql();
    const user = await findUserByName(asql, identifier);
    // An unknown name is verified against a throwaway hash, so it costs the same time as a wrong password.
    const valid = await verifyPassword(password, user?.credential?.hash || decoyHash);
    if (!user || !user.credential?.hash || !valid) {
      await loginDelay(req);
      throw httpError(401, 'invalid username or password');
    }
    const session = await createSession(asql, user.id);
    send(res, 200, { token: session.token, admin: isPlatformAdmin(user), user: publicUser(user) });
    return true;
  }

  if (pathname === '/api/setup' && method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    if (!email || !password) throw httpError(400, 'email and password are required');
    const asql = getAsql();
    const made = await createFirstAccount(
      { countUsers: async () => (await listUsers(asql)).length, createUser: (input) => addUser(asql, input) },
      { name, email, password },
    );
    if (!made.ok) throw httpError(made.status, 'setup is already done');
    const user = await findUserById(asql, made.user.id);
    const session = await createSession(asql, user.id);
    send(res, 200, { token: session.token, admin: isPlatformAdmin(user), user: publicUser(user) });
    return true;
  }

  if (pathname === '/api/auth/session' && method === 'GET') {
    const token = bearer(req) || url.searchParams.get('token') || '';
    if (!token) throw httpError(401, 'no session token provided');
    const asql = getAsql();
    const session = await findSessionByTokenHash(asql, hashToken(token));
    if (!session || !session.active) throw httpError(401, 'session expired or invalid');
    const user = await findUserById(asql, session.userId);
    if (!user) throw httpError(401, 'user not found');
    send(res, 200, { admin: isPlatformAdmin(user), user: publicUser(user) });
    return true;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = bearer(req) || (await readJson(req)).token || '';
    if (token) {
      await revokeSession(getAsql(), token);
      principals.delete(hashToken(token));
    }
    send(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/auth/account' && method === 'DELETE') {
    const who = await principalFor(req, url);
    if (!who) throw httpError(401, 'sign in to delete your account');
    // The password again: a session alone (a borrowed laptop, a leaked token) cannot delete the account.
    const { password } = await readJson(req);
    const full = await findUserByName(getAsql(), who.user.email);
    if (!password || !full?.credential?.hash || !(await verifyPassword(String(password), full.credential.hash))) {
      await loginDelay(req);
      throw httpError(401, 'enter your password to delete your account');
    }
    const removed = await removeUser(who.user.id, who.user.email);
    send(res, 200, { deleted: removed });
    return true;
  }

  const target = pathname.match(/^\/api\/auth\/users\/([^/]+)$/);
  if (target && method === 'DELETE') {
    const who = await principalFor(req, url);
    if (!who?.admin) throw httpError(who ? 403 : 401, 'only a platform owner or admin may delete users');
    let name = '';
    try { name = decodeURIComponent(target[1]); } catch { throw httpError(400, 'malformed user'); }
    const removed = await removeUser(name, who.user.email);
    if (!removed) throw httpError(404, `no user ${name}`);
    send(res, 200, { deleted: removed });
    return true;
  }

  return false;
}
