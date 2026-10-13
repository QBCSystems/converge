/**
 * Authentication, key minting, and SHA-256 token hashing for Converge.
 * Conventions:
 * - Agent id: a-<8 hex>
 * - Task id: t-<8 hex>
 * - Change id: c-<8 hex>
 * - MCP keys: Bearer tokens hashed with SHA-256 in DO SQLite
 */

export async function hashToken(token: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateId(prefix: 'a' | 't' | 'c'): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}-${hex}`;
}

export function generateKey(prefix = 'mcp_'): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}${hex}`;
}

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization') || request.headers.get('authorization');
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  const mcpKey = request.headers.get('X-MCP-Key');
  if (mcpKey) return mcpKey.trim();

  const adminKey = request.headers.get('X-Admin-Key');
  if (adminKey) return adminKey.trim();

  const viewKey = request.headers.get('X-View-Key');
  if (viewKey) return viewKey.trim();

  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (key) return key.trim();
  } catch {
    // Ignore invalid URLs
  }

  return null;
}

export function extractAdminKey(request: Request): string | null {
  const adminKey = request.headers.get('X-Admin-Key');
  if (adminKey) return adminKey.trim();

  const auth = request.headers.get('Authorization') || request.headers.get('authorization');
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * A browser cannot set headers on a WebSocket, so it offers the key as a subprotocol instead of in the URL
 * (where it lands in logs and history): `Sec-WebSocket-Protocol: converge, converge.key.<base64url(key)>`.
 * The server answers with `converge` (see WS_PROTOCOL).
 */
export const WS_PROTOCOL = 'converge';
export function wsProtocolKey(request: Request): string | null {
  const offered = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((x) => x.trim());
  const p = offered.find((x) => x.startsWith(`${WS_PROTOCOL}.key.`));
  if (!p) return null;
  try {
    const b64 = p.slice(`${WS_PROTOCOL}.key.`.length).replace(/-/g, '+').replace(/_/g, '/');
    const key = new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))).trim();
    return key || null;
  } catch {
    return null;
  }
}
const isWebSocket = (request: Request) => request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

export function extractViewKey(request: Request): string | null {
  const viewKey = request.headers.get('X-View-Key');
  if (viewKey) return viewKey.trim();

  // The query string only on a WebSocket upgrade (older dashboards); everything else sends a header.
  if (isWebSocket(request)) {
    const fromProtocol = wsProtocolKey(request);
    if (fromProtocol) return fromProtocol;
    try {
      const url = new URL(request.url);
      const key = url.searchParams.get('key');
      if (key) return key.trim();
    } catch { /* an unparsable URL carries no key */ }
  }

  const auth = request.headers.get('Authorization') || request.headers.get('authorization');
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

export function extractMcpKey(request: Request): string | null {
  const auth = request.headers.get('Authorization') || request.headers.get('authorization');
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  const mcpKey = request.headers.get('X-MCP-Key');
  if (mcpKey) return mcpKey.trim();

  return null;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

/**
 * Both verifiers fail CLOSED: an unset key rejects every request, so a deployment that forgot
 * `wrangler secret put` is locked rather than open. Local development opts in explicitly with
 * ALLOW_INSECURE=true (see `allowOpen`).
 */
export function verifyAdminKey(request: Request, expectedKey?: string, allowOpen = false): boolean {
  if (!expectedKey) return allowOpen;
  const token = extractAdminKey(request);
  if (!token) return false;
  return timingSafeEqual(token, expectedKey);
}

export function verifyViewKey(request: Request, expectedKey?: string, allowOpen = false): boolean {
  if (!expectedKey) return allowOpen;
  const token = extractViewKey(request);
  if (!token) return false;
  return timingSafeEqual(token, expectedKey);
}

/**
 * Project names become repo names (`<project>` and `<project>--<agent>`), URL segments and Durable
 * Object names. `--` is the fork separator, so it must never appear inside a project name.
 */
export function isValidProjectName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z0-9](?:[a-z0-9.]|-(?!-)){0,62}[a-z0-9]$|^[a-z0-9]$/i.test(name) && !name.includes('--');
}

/**
 * A sandbox session's token: it administers ONE project (`sandbox-<id>`) until it expires, and nothing else.
 * `<expiry seconds>.<HMAC-SHA256(admin key, "sandbox|project|expiry")>`: stateless, so there is nothing to
 * store or clean up, and it dies with the admin key.
 */
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function sandboxSessionToken(adminKey: string, project: string, expiresAtSeconds: number): Promise<string> {
  return `${expiresAtSeconds}.${await hmacHex(adminKey, `sandbox|${project}|${expiresAtSeconds}`)}`;
}
/** A run started from the dashboard: a token that administers that one project until it expires (the run's container holds it, never the admin key). */
export async function runToken(adminKey: string, project: string, expiresAtSeconds: number): Promise<string> {
  return `${expiresAtSeconds}.${await hmacHex(adminKey, `run|${project}|${expiresAtSeconds}`)}`;
}
/** A sandbox session's own token for its `sandbox-` project (never a run token: those are held by containers). */
export async function verifySessionToken(request: Request, adminKey: string | undefined, project: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!adminKey || !project.startsWith('sandbox-')) return false;
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(extractAdminKey(request) || '');
  if (!m || Number(m[1]) < nowSeconds) return false;
  return timingSafeEqual(m[2], await hmacHex(adminKey, `sandbox|${project}|${m[1]}`));
}
export async function verifySandboxToken(request: Request, adminKey: string | undefined, project: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!adminKey) return false;
  const token = extractAdminKey(request) || extractViewKey(request) || '';
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m || Number(m[1]) < nowSeconds) return false;
  // A sandbox session's token opens its own sandbox- project; a run token opens the one project it was made for.
  if (project.startsWith('sandbox-') && timingSafeEqual(m[2], await hmacHex(adminKey, `sandbox|${project}|${m[1]}`))) return true;
  return timingSafeEqual(m[2], await hmacHex(adminKey, `run|${project}|${m[1]}`));
}

/**
 * Credentials that may turn up in text the platform shows to others (an agent's observation printing its env, an
 * error carrying a URL): session/run tokens, Artifacts tokens, MCP keys, Authorization headers, user:pass@ in URLs,
 * and any of the deployment's own secrets given in `literal`. Safe on JSON text: no replacement touches a quote.
 */
export function redactSecrets(text: string, literal: Array<string | undefined> = []): string {
  let out = text
    .replace(/(\/\/)[^\/@\s"'<>]+@/g, '$1')
    .replace(/(Authorization:\s*(?:Basic|Bearer|token)\s+)[A-Za-z0-9+/=._~-]+/gi, '$1<redacted>')
    .replace(/art_v\d+_[A-Za-z0-9_?=.-]+/g, '<token>')
    .replace(/\bmcp_[0-9a-f]{32}\b/g, '<mcp key>')
    .replace(/\b\d{9,12}\.[0-9a-f]{64}\b/g, '<token>')
    .replace(/\b(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<token>');
  for (const s of literal) if (s && s.length >= 8) out = out.split(s).join('<redacted>');
  return out;
}

/** First-run setup (mirrors scripts/lib/auth/first-user.mjs): the first account is an admin; once any user exists, 409. */
export async function createFirstAccount<U>(
  store: { countUsers(): Promise<number>; createUser(u: { name: string; email: string; password: string; role: 'admin' }): Promise<U> },
  input: { name: string; email: string; password: string },
): Promise<{ ok: true; user: U } | { ok: false; status: 409 }> {
  if ((await store.countUsers()) !== 0) return { ok: false, status: 409 };
  const user = await store.createUser({ ...input, role: 'admin' });
  return { ok: true, user };
}

/** GET /api/setup body, as scripts/lib/auth/setup.mjs setupStatus: needsSetup only while no user exists. The deployed
 *  Worker has no account store (it signs in with keys), so it passes a count of 0 only if it ever gains one. */
export async function setupStatus(countUsers: () => Promise<number>): Promise<{ needsSetup: boolean }> {
  return { needsSetup: (await countUsers()) === 0 };
}
