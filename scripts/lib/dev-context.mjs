// The local platform's shared state and helpers (scripts/dev-server.mjs and scripts/lib/*): one instance of each,
// imported by everything that needs it, never copied.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GIT_IDENT } from '../../agents/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.CONVERGE_PORT || 8787);
const HOST = process.env.CONVERGE_HOST || '127.0.0.1';
// Where the platform keeps its repositories and state: CONVERGE_DATA, else ~/.converge/local (the documented place).
// A data folder from before (.converge_dev_data in the checkout) is used where it is, never moved: main() prints one line.
const LEGACY_DATA = path.join(ROOT, '.converge_dev_data');
const DEFAULT_DATA = path.join(os.homedir(), '.converge', 'local');
const DATA_FROM = process.env.CONVERGE_DATA ? 'env' : (!fs.existsSync(DEFAULT_DATA) && fs.existsSync(LEGACY_DATA)) ? 'legacy' : 'default';
const DATA = path.resolve(process.env.CONVERGE_DATA || (DATA_FROM === 'legacy' ? LEGACY_DATA : DEFAULT_DATA));
// Optional, like the worker's secrets. Unset = open, which is only acceptable while the server is reachable from this
// machine alone: assertSafeBind refuses to listen anywhere else without a key.
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const VIEW_KEY = process.env.VIEW_KEY || '';
const ENGINE_KEY = crypto.randomBytes(16).toString('hex'); // per run, never leaves this machine
const HOOK_KEY = crypto.randomBytes(16).toString('hex');
const PROJECT_RE = /^[a-z0-9](?:[a-z0-9.]|-(?!-)){0,62}[a-z0-9]$|^[a-z0-9]$/i;
const MAX_AGENTS = 16;

const log = (tag, msg) => console.log(`\x1b[36m[${tag}]\x1b[0m ${msg}`);
const warn = (tag, msg) => console.log(`\x1b[33m[${tag}]\x1b[0m ${msg}`);
const randomHex = (n) => crypto.randomBytes(n).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GIT_ENV = GIT_IDENT;
// Async git for anything that pushes: a push runs our post-receive hook, which calls back into this
// process, so blocking the event loop on it would deadlock.
const execFileP = promisify(execFile);
const gitAsync = async (cwd, ...args) => (await execFileP('git', args, { cwd, env: { ...process.env, ...GIT_ENV } })).stdout.trim();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).trim();

const projects = new Map(); // name -> Project

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(payload);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw httpError(400, 'body must be JSON'); }
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || String(req.headers['x-mcp-key'] || '').trim();
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** The signed-in user a request carries (set by the server from an ASQL session before routing): { user, admin }. */
const principalOf = (req) => req.principal || null;
function requireAdmin(req) {
  if (!ADMIN_KEY) return;
  if (principalOf(req)?.admin) return;
  const k = String(req.headers['x-admin-key'] || '') || bearer(req);
  if (!safeEqual(k, ADMIN_KEY)) throw httpError(401, 'Unauthorized');
}
function requireView(req, url) {
  if (!VIEW_KEY) return;
  const who = principalOf(req);
  if (who?.admin) return;
  if (who) {
    // A member watches the project they belong to.
    const m = url.pathname.match(/^\/api\/projects\/([^/]+)/);
    let name = ''; try { name = m ? decodeURIComponent(m[1]) : ''; } catch { /* a malformed name matches no project */ }
    if (name && who.user.memberships.some((x) => x.project === name)) return;
  }
  const k = String(req.headers['x-view-key'] || '') || url.searchParams.get('key') || bearer(req);
  // Whoever may administer may also watch: the admin key opens every view the view key does.
  const admin = String(req.headers['x-admin-key'] || '');
  if (safeEqual(k, VIEW_KEY) || (ADMIN_KEY && (safeEqual(k, ADMIN_KEY) || safeEqual(admin, ADMIN_KEY)))) return;
  throw httpError(401, 'Unauthorized');
}
const decodeName = (s) => {
  try { return decodeURIComponent(s); } catch { throw httpError(400, 'malformed project name'); }
};

const isLoopback = (h) => /^(localhost|::1|\[::1\]|127(\.\d{1,3}){3})$/i.test(String(h || '').trim());
/** A server with no admin key accepts any caller as admin (it starts runs that spend the owner's provider keys and writes into
 *  the owner's folders): it may only listen on this machine's own loopback address. Throws otherwise. */
function assertSafeBind(host = HOST, adminKey = ADMIN_KEY) {
  if (adminKey || isLoopback(host)) return;
  throw new Error(`CONVERGE_HOST=${host} would serve the admin API to the network with no key: set ADMIN_KEY (and VIEW_KEY for read-only access), or bind to 127.0.0.1`);
}

const hostnameOf = (v) => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`).hostname; } catch { return ''; } };
/** With no admin key every caller is admin, and a loopback bind does not keep a web page out: the browser is on this machine
 *  and will send its requests (and, with CORS open, read the replies). So without a key a request must name a loopback Host
 *  (not a DNS-rebound name) and, if it carries an Origin, a loopback one. Throws 403 otherwise. A key makes this moot. */
function assertLocalRequest(req, adminKey = ADMIN_KEY) {
  if (adminKey) return;
  const host = req.headers.host;
  if (!isLoopback(hostnameOf(String(host || '')))) throw httpError(403, 'no ADMIN_KEY set: this server answers requests addressed to localhost only');
  const origin = req.headers.origin;
  if (origin !== undefined && !isLoopback(hostnameOf(String(origin)))) throw httpError(403, 'no ADMIN_KEY set: this server does not answer requests from other origins');
}

export {
  assertSafeBind, assertLocalRequest, isLoopback,
  ROOT, PORT, HOST, LEGACY_DATA, DEFAULT_DATA, DATA_FROM, DATA, ADMIN_KEY, VIEW_KEY, ENGINE_KEY, HOOK_KEY, PROJECT_RE, MAX_AGENTS,
  log, warn, randomHex, sha256, GIT_ENV, gitAsync, git, projects,
  httpError, send, readBody, readJson, bearer, safeEqual, requireAdmin, requireView, decodeName,
};
