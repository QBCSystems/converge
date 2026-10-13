'use strict';
// mcp-remote.cjs — remote MCP support for the harness and GUI.
//
// Two things live here, shared by universal-agent.cjs (headless: read token,
// refresh, call tools) and gui/server.js (interactive: run the OAuth login):
//
//   1. OAuth 2.1 client for MCP remote servers — discovery (RFC 9728 protected-
//      resource + RFC 8414 authorization-server metadata), dynamic client
//      registration (RFC 7591), PKCE (S256), authorization-code + refresh_token
//      grants, and a per-endpoint token cache under ~/.converge/mcp-auth.
//   2. McpHttpClient — a Streamable-HTTP transport that mirrors the stdio
//      McpClient interface (ensure/listTools/call/callContent) so the harness
//      treats a `{ url }` server exactly like a spawned `{ command }` one.
//
// Auth model (chosen: GUI-driven login): the GUI does the one interactive
// browser consent and writes the token cache; every other surface (TUI, CLI,
// fleet, headless harness) reads that cache and refreshes non-interactively.
// When no usable token exists and no refresh is possible, calls fail LOUDLY with
// a "run the GUI login" message instead of hanging or silently returning empty.
//
// Zero dependencies (Node 18+ global fetch). No secrets are logged.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- token cache ----------
// ~/.converge/mcp-auth/<sanitized-endpoint>.json, 0600. One file per MCP endpoint
// URL so different gateway servers (…/gateway/mcp/trello vs …/eos) stay distinct.
function authDir() {
  const base = process.env.CONVERGE_AGENT_HOME || path.join(os.homedir(), '.converge');
  return path.join(base, 'mcp-auth');
}
function tokenFileFor(endpoint) {
  const safe = String(endpoint).replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
  return path.join(authDir(), `${safe}.json`);
}
function loadTokens(endpoint) {
  try { return JSON.parse(fs.readFileSync(tokenFileFor(endpoint), 'utf8')); } catch { return null; }
}
function saveTokens(endpoint, obj) {
  const dir = authDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = tokenFileFor(endpoint);
  const tmp = `${p}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ endpoint, ...obj }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on non-POSIX */ }
  fs.renameSync(tmp, p);
  return p;
}
function clearTokens(endpoint) { try { fs.unlinkSync(tokenFileFor(endpoint)); return true; } catch { return false; } }

// ---------- small fetch helpers ----------
async function getJson(url, headers) {
  const r = await fetch(url, { headers: { accept: 'application/json', ...(headers || {}) } });
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return r.json();
}
function originOf(u) { const x = new URL(u); return `${x.protocol}//${x.host}`; }

// ---------- OAuth discovery ----------
// Prefer the resource_metadata URL the server hands back in a 401 WWW-Authenticate
// (RFC 9728, the exact URL the resource wants used); otherwise derive the well-
// known path from the endpoint. Then resolve the authorization server's metadata.
function parseResourceMetadataUrl(wwwAuthenticate) {
  if (!wwwAuthenticate) return null;
  const m = /resource_metadata="?([^",\s]+)"?/i.exec(wwwAuthenticate);
  return m ? m[1] : null;
}
async function discover(endpoint, resourceMetadataUrl) {
  const origin = originOf(endpoint);
  const pth = new URL(endpoint).pathname.replace(/\/$/, '');
  // Protected-resource metadata: explicit URL from the 401 wins; else try the
  // path-scoped well-known, then the origin-level one.
  const prCandidates = [
    resourceMetadataUrl,
    `${origin}/.well-known/oauth-protected-resource${pth}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean);
  let pr = null;
  for (const u of prCandidates) { try { pr = await getJson(u); break; } catch { /* try next */ } }
  const resource = (pr && pr.resource) || origin;
  const asBase = (pr && Array.isArray(pr.authorization_servers) && pr.authorization_servers[0]) || origin;
  const scopes = (pr && pr.scopes_supported) || ['mcp'];
  // Authorization-server metadata (RFC 8414), with the OIDC path as a fallback.
  const asOrigin = originOf(asBase);
  const asPath = new URL(asBase).pathname.replace(/\/$/, '');
  const asCandidates = [
    `${asOrigin}/.well-known/oauth-authorization-server${asPath}`,
    `${asOrigin}/.well-known/oauth-authorization-server`,
    `${asOrigin}/.well-known/openid-configuration`,
  ];
  let as = null;
  for (const u of asCandidates) { try { as = await getJson(u); break; } catch { /* try next */ } }
  if (!as || !as.authorization_endpoint || !as.token_endpoint) {
    throw new Error(`could not discover OAuth metadata for ${endpoint}`);
  }
  return { resource, scopes, as };
}

// ---------- dynamic client registration (RFC 7591) ----------
async function registerClient(as, redirectUri, { clientName = 'converge', scope } = {}) {
  if (!as.registration_endpoint) throw new Error('server does not support dynamic client registration');
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client + PKCE
    ...(scope ? { scope } : {}),
  };
  const r = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`client registration failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (!j.client_id) throw new Error('registration response had no client_id');
  return { clientId: j.client_id, clientSecret: j.client_secret || null };
}

// ---------- PKCE ----------
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ---------- authorize URL + token grants ----------
function buildAuthorizeUrl(as, { clientId, redirectUri, scope, state, challenge, resource }) {
  const u = new URL(as.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (scope) u.searchParams.set('scope', scope);
  if (state) u.searchParams.set('state', state);
  if (resource) u.searchParams.set('resource', resource); // RFC 8707
  return u.toString();
}
async function tokenRequest(as, params) {
  const r = await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (!r.ok || !j || !j.access_token) throw new Error(`token endpoint HTTP ${r.status}: ${text.slice(0, 300)}`);
  return j;
}
function tokensFromResponse(j) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || null,
    token_type: j.token_type || 'Bearer',
    scope: j.scope || null,
    // 60s safety margin so we refresh before, not on, expiry.
    expires_at: j.expires_in ? Date.now() + (Number(j.expires_in) - 60) * 1000 : null,
  };
}
async function exchangeCode(as, { clientId, clientSecret, code, verifier, redirectUri, resource }) {
  return tokensFromResponse(await tokenRequest(as, {
    grant_type: 'authorization_code',
    code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(resource ? { resource } : {}),
  }));
}
async function refreshTokens(as, { clientId, clientSecret, refreshToken, resource, scope }) {
  return tokensFromResponse(await tokenRequest(as, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken, client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(resource ? { resource } : {}),
    ...(scope ? { scope } : {}),
  }));
}

// A distinct error type so callers can tell "you must run the GUI login" apart
// from a transport/server error and surface the right guidance to the model/user.
class NeedsLoginError extends Error {
  constructor(endpoint, detail) {
    super(`MCP server "${endpoint}" is not authorized${detail ? ` (${detail})` : ''}. Connect it once interactively (the server's OAuth flow), which completes the one-time browser sign-in; the token is then shared with the CLI/TUI/harness.`);
    this.name = 'NeedsLoginError';
    this.endpoint = endpoint;
    this.needsLogin = true;
  }
}

// Return a valid bearer for `endpoint`, refreshing non-interactively if needed.
// Throws NeedsLoginError when only the interactive GUI login can recover.
async function getAccessToken(endpoint) {
  const cache = loadTokens(endpoint);
  if (!cache || !cache.access_token) throw new NeedsLoginError(endpoint, 'no cached token');
  if (!cache.expires_at || cache.expires_at > Date.now()) return cache.access_token;
  // Expired: try refresh.
  if (!cache.refresh_token || !cache.as) throw new NeedsLoginError(endpoint, 'token expired, no refresh grant');
  try {
    const t = await refreshTokens(cache.as, {
      clientId: cache.client_id, clientSecret: cache.client_secret,
      refreshToken: cache.refresh_token, resource: cache.resource, scope: cache.scope,
    });
    // A refresh may or may not rotate the refresh_token; keep the old one if absent.
    saveTokens(endpoint, { ...cache, ...t, refresh_token: t.refresh_token || cache.refresh_token });
    return t.access_token;
  } catch (e) {
    throw new NeedsLoginError(endpoint, `refresh failed: ${e.message}`);
  }
}

// ---------- Streamable-HTTP MCP client ----------
// Same shape the stdio McpClient exposes: ensure(), listTools(), call(), and
// callContent() (image-aware). One POST per JSON-RPC request; the response is
// either a single application/json body or a one-shot text/event-stream frame.
class McpHttpClient {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.endpoint = spec.url;
    this.sessionId = null;
    this.ready = null;
    this.nextId = 1;
  }
  _disabled() { return new Set(Array.isArray(this.spec.disabledTools) ? this.spec.disabledTools : []); }

  _staticAuth() {
    // A spec carrying its own credential (x-api-key / Authorization header, or a
    // bare apiKey) authenticates statically — skip the interactive OAuth flow.
    const h = this.spec.headers || {};
    return !!(this.spec.apiKey || h['x-api-key'] || h['X-Api-Key'] || h.authorization || h.Authorization);
  }

  async _post(method, params, isNotification) {
    const staticAuthed = this._staticAuth();
    const token = staticAuthed ? null : await getAccessToken(this.endpoint);
    const doPost = async (bearer) => fetch(this.endpoint, {
      method: 'POST',
      // Never FOLLOW a redirect: Node/undici strips `authorization` on a
      // cross-origin redirect but NOT custom headers (x-api-key, spec.headers),
      // so a hostile/compromised endpoint returning a 3xx to attacker.tld would
      // harvest the static key. A JSON-RPC POST never needs to follow one.
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(this.spec.apiKey ? { 'x-api-key': this.spec.apiKey } : {}),
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(this.spec.headers || {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(isNotification ? {} : { id: this.nextId++ }), params: params || {} }),
    });
    let r = await doPost(token);
    // A 401 mid-session means an OAuth token died between calls; refresh once and
    // retry. Static-key auth has no token to refresh, so a 401 there is terminal.
    if (r.status === 401 && !staticAuthed) {
      clearExpiry(this.endpoint);
      const fresh = await getAccessToken(this.endpoint);
      r = await doPost(fresh);
      if (r.status === 401) throw new NeedsLoginError(this.endpoint, 'server rejected the token');
    }
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (isNotification) { if (!r.ok && r.status !== 202) { /* notifications need no reply */ } return null; }
    if (!r.ok) throw new Error(`${this.name} ${method} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const msg = await readRpcMessage(r);
    if (msg && msg.error) throw new Error(`${this.name}.${method}: ${JSON.stringify(msg.error).slice(0, 300)}`);
    return msg ? msg.result : null;
  }

  ensure() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await this._post('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'universal-agent', version: '1.0' },
      });
      await this._post('notifications/initialized', {}, true);
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }
  async listTools() {
    await this.ensure();
    const r = await this._post('tools/list', {});
    const off = this._disabled();
    return ((r && r.tools) || []).filter((t) => !off.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || null }));
  }
  async call(tool, args) { return (await this.callContent(tool, args)).text; }
  async callContent(tool, args) {
    if (this._disabled().has(tool)) return { text: `ERROR: tool "${tool}" on server "${this.name}" is disabled in this configuration.`, images: [], isError: true };
    await this.ensure();
    const r = await this._post('tools/call', { name: tool, arguments: args || {} });
    const isError = !!(r && r.isError);
    if (!r || !Array.isArray(r.content)) return { text: JSON.stringify(r), images: [], isError };
    const images = r.content.filter((c) => c && c.type === 'image' && c.data && c.mimeType).map((c) => ({ mimeType: c.mimeType, data: c.data }));
    const text = r.content.map((c) => (c.type === 'image' && c.data ? `[image: ${c.mimeType || 'image'}]` : c.text || JSON.stringify(c))).join('\n');
    return { text, images, isError };
  }
}

// Force the next getAccessToken() to refresh (used after a mid-session 401).
function clearExpiry(endpoint) {
  const c = loadTokens(endpoint);
  if (c) saveTokens(endpoint, { ...c, expires_at: 1 });
}

// Read a JSON-RPC response from a Streamable-HTTP reply: a plain JSON body, or a
// text/event-stream where each `data:` line is a JSON-RPC message — return the
// first one carrying a result/error (the answer to our request).
async function readRpcMessage(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  if (ct.includes('application/json')) { try { return JSON.parse(text); } catch { return null; } }
  if (ct.includes('text/event-stream') || /^data:/m.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m) continue;
      try { const obj = JSON.parse(m[1]); if (obj && (obj.result !== undefined || obj.error !== undefined)) return obj; } catch { /* keep scanning */ }
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// True when a server spec should use the remote HTTP transport.
function isRemote(spec) {
  return !!(spec && (spec.url || spec.type === 'http' || spec.type === 'sse' || spec.transport === 'http' || spec.transport === 'sse'));
}

module.exports = {
  // transport
  McpHttpClient, isRemote,
  // token cache
  authDir, tokenFileFor, loadTokens, saveTokens, clearTokens, getAccessToken, NeedsLoginError,
  // oauth flow (used by the GUI login endpoints)
  discover, parseResourceMetadataUrl, registerClient, pkce, buildAuthorizeUrl, exchangeCode, refreshTokens, tokensFromResponse,
};
