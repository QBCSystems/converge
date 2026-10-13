// Auth core: the pure, dependency-free half of converge auth.
//
// Everything here is a plain function over strings and object literals: no
// network, no database handle, no imports beyond node:crypto. Persistence
// (the converge_credentials / converge_sessions / converge_tokens /
// converge_memberships tables described in ./schema.mjs) is somebody else's
// job; this module only turns secrets into storable strings and answers
// "may this user do this?".
//
// Secrets are stored as hashes, never as values:
//   - hashPassword() returns a self-describing `scrypt$N$r$p$salt$hash` string,
//     so verifyPassword() can re-derive it with the same parameters later
//     (params are read from the stored string, not from this file).
//   - hashToken() returns a sha256 hex digest for the token_hash columns
//     (sessions, API tokens, invitations).
//   - can() reads the user's memberships -- the in-memory shape of
//     converge_memberships -- and maps role -> permitted actions.

import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

// scrypt cost parameters. N is deliberately modest (16 MiB-ish of memory,
// well under node's default maxmem) so hashing stays cheap enough to run on
// every sign-in; raise them here and old hashes keep verifying because the
// parameters are carried in the stored string.
export const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

const SCHEME = 'scrypt';
const SALT_BYTES = 16;
const BASE64URL = 'base64url';

export const TOKEN_HASH_ALGO = 'sha256';

function derive(password, salt, params) {
  return scrypt(String(password), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * 2,
  });
}

// Hash a password for storage. Returns `scrypt$N$r$p$<salt-b64url>$<hash-b64url>`.
export async function hashPassword(password, params = SCRYPT_PARAMS) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return [
    SCHEME,
    params.N,
    params.r,
    params.p,
    salt.toString(BASE64URL),
    key.toString(BASE64URL),
  ].join('$');
}

function parseStored(stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || r < 1 || p < 1) return null;
  return {
    params: { N, r, p, keylen: SCRYPT_PARAMS.keylen },
    salt: Buffer.from(parts[4], BASE64URL),
    hash: Buffer.from(parts[5], BASE64URL),
  };
}

// True only when `password` re-derives the stored hash. A malformed or
// unknown stored value is a mismatch, never a throw.
export async function verifyPassword(password, stored) {
  let parsed = null;
  try {
    parsed = parseStored(stored);
  } catch {
    return false;
  }
  if (!parsed || parsed.salt.length === 0 || parsed.hash.length === 0) return false;
  try {
    const key = await derive(password, parsed.salt, parsed.params);
    if (key.length !== parsed.hash.length) return false;
    return timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

// A fresh opaque session token. The value is returned exactly once (to the
// client); only hashToken(token) is meant to reach storage.
export function mintSession() {
  return randomBytes(32).toString(BASE64URL);
}

// Stable, one-way digest for session / API token / invitation values.
export function hashToken(token) {
  if (token === undefined || token === null || token === '') {
    throw new TypeError('hashToken(token): a token value is required');
  }
  return createHash(TOKEN_HASH_ALGO).update(String(token)).digest('hex');
}

// Roles, from weakest to strongest. `owner` is a wildcard: an owner may do
// anything in the project, including actions this table does not list yet.
export const ROLE_ACTIONS = Object.freeze({
  viewer: Object.freeze(['read']),
  member: Object.freeze(['read', 'write', 'comment', 'push']),
  maintainer: Object.freeze(['read', 'write', 'comment', 'push', 'merge', 'deploy']),
  admin: Object.freeze([
    'read',
    'write',
    'comment',
    'push',
    'merge',
    'deploy',
    'admin',
    'manage',
    'invite',
    'tokens',
    'delete',
  ]),
  owner: Object.freeze('*'),
});

function membershipFor(user, project) {
  const memberships = user && Array.isArray(user.memberships) ? user.memberships : [];
  const wanted = String(project);
  for (const entry of memberships) {
    if (!entry) continue;
    const name = entry.project !== undefined ? entry.project : entry.id;
    if (name !== undefined && String(name) === wanted) return entry;
  }
  return null;
}

// Decide whether `user` may perform `action` on `project`. Reads only
// user.memberships (shape: [{project, role}, ...]); a missing user, a missing
// membership or an unknown role denies.
export function can(user, action, project) {
  if (!user || action === undefined || action === null || project === undefined || project === null) {
    return false;
  }
  const membership = membershipFor(user, project);
  if (!membership) return false;
  const role = String(membership.role || 'member').trim().toLowerCase();
  const allowed = ROLE_ACTIONS[role];
  if (!allowed) return false;
  if (allowed === '*') return true;
  const wanted = String(action).trim().toLowerCase();
  return allowed.includes(wanted);
}

export default { hashPassword, verifyPassword, mintSession, hashToken, can };
