// GitHub, through a GitHub App: link an account, pick repositories on GitHub's own screen, bring one in as a
// project, and send what landed back as a pull request.
//
//   1. setup (once, admin): converge hands GitHub an app manifest; GitHub creates the app on the admin's account
//      and gives converge its keys (app id, private key). They are kept, encrypted, in the GitHubLink object.
//   2. connect: the app's install screen on GitHub, where the person picks the repositories converge may see.
//   3. import: a repository becomes a converge project (Artifacts imports it with a one-hour token for that
//      installation; nothing long-lived is stored).
//   4. bring home: main's commits are pushed to a new branch on GitHub and a pull request is opened. Never main.
//
// Tokens: an installation token lasts an hour and is minted per call from the app's key. No user token is kept.
import { DurableObject } from 'cloudflare:workers';

export interface GitHubEnv {
  GITHUB: DurableObjectNamespace<GitHubLink>;
  ADMIN_KEY?: string;
}

interface AppCreds { id: number; slug: string; pem: string; client_id: string; owner: string; html_url: string }

const UA = 'converge (https://github.com/apps)';
const enc = new TextEncoder();
const b64url = (b: Uint8Array | string) => btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * A state value for GitHub's redirects: proves converge (with the admin key) started the flow, expires, and names a
 * nonce the GitHubLink object lets through once (`useNonce`). No admin key, no state: an empty key would sign for anyone.
 */
export async function makeState(adminKey: string, purpose: string): Promise<string> {
  if (!adminKey) throw new Error('ADMIN_KEY is not configured');
  const exp = Math.floor(Date.now() / 1000) + 900;
  const nonce = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${exp}.${nonce}.${(await hmacHex(adminKey, `gh|${purpose}|${exp}|${nonce}`)).slice(0, 32)}`;
}
/** The nonce of a genuine, unexpired state (null otherwise); the caller spends it with GitHubLink.useNonce. */
export async function checkState(adminKey: string, purpose: string, state: string | null): Promise<string | null> {
  if (!adminKey) return null;
  const m = /^(\d{9,12})\.([0-9a-f]{24})\.([0-9a-f]{32})$/.exec(state || '');
  if (!m || Number(m[1]) < Date.now() / 1000) return null;
  const want = (await hmacHex(adminKey, `gh|${purpose}|${m[1]}|${m[2]}`)).slice(0, 32);
  let d = 0;
  for (let i = 0; i < 32; i++) d |= want.charCodeAt(i) ^ m[3].charCodeAt(i);
  return d === 0 ? m[2] : null;
}

// ---- the app's key: GitHub hands out PKCS#1; WebCrypto signs with PKCS#8 -------------------------------------

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}
function pemBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}
function pkcs1to8(pkcs1: Uint8Array): Uint8Array {
  // PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length), ...pkcs1];
  const inner = [0x02, 0x01, 0x00, ...alg, ...octet];
  return Uint8Array.from([0x30, ...derLen(inner.length), ...inner]);
}
async function appJwt(app: AppCreds): Promise<string> {
  const raw = pemBytes(app.pem);
  const der = app.pem.includes('BEGIN RSA PRIVATE KEY') ? pkcs1to8(raw) : raw;
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(app.id) }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function gh(path: string, token: string, init: RequestInit = {}, scheme = 'Bearer'): Promise<any> {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA, Authorization: `${scheme} ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}: ${data.message || text.slice(0, 200)}`), { status: r.status });
  return data;
}

// ---- the stored link ----------------------------------------------------------------------------------------

/** One per converge: the app's keys (encrypted with a key derived from the admin key), and which project came from which repo. */
export class GitHubLink extends DurableObject<GitHubEnv> {
  private async aes(): Promise<CryptoKey> {
    const material = await crypto.subtle.digest('SHA-256', enc.encode(`converge github|${this.env.ADMIN_KEY || ''}`));
    return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async saveApp(app: AppCreds): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.aes(), enc.encode(JSON.stringify(app))));
    await this.ctx.storage.put('app', { iv: [...iv], ct: [...ct] });
  }
  async app(): Promise<AppCreds | null> {
    const s = await this.ctx.storage.get<{ iv: number[]; ct: number[] }>('app');
    if (!s) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(s.iv) }, await this.aes(), Uint8Array.from(s.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  /** Spend a state's nonce: true the first time, false after (a replayed redirect). Old nonces go when they expire. */
  async useNonce(nonce: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const seen = (await this.ctx.storage.get<Record<string, number>>('nonces')) || {};
    for (const [k, exp] of Object.entries(seen)) if (exp < now) delete seen[k];
    if (seen[nonce]) return false;
    seen[nonce] = now + 900;
    await this.ctx.storage.put('nonces', seen);
    return true;
  }
  async appPublic(): Promise<{ slug: string; owner: string; html_url: string } | null> {
    const a = await this.app();
    return a ? { slug: a.slug, owner: a.owner, html_url: a.html_url } : null;
  }
  async linkProject(project: string, link: { installation_id: number; repo: string; branch: string; base: string }): Promise<void> {
    await this.ctx.storage.put(`p:${project}`, link);
  }
  async projectLink(project: string): Promise<{ installation_id: number; repo: string; branch: string; base: string } | null> {
    return (await this.ctx.storage.get(`p:${project}`)) || null;
  }
  /** Every linked project and its repository ("owner/name"). */
  async linkedRepos(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of await this.ctx.storage.list<{ repo: string }>({ prefix: 'p:' })) out[k.slice(2)] = v.repo;
    return out;
  }
  async unlinkProject(project: string): Promise<void> {
    await this.ctx.storage.delete(`p:${project}`);
  }

  /** The app's installations and every repository each can see. */
  async repos(): Promise<{ installations: { id: number; account: string }[]; repos: { installation_id: number; full_name: string; private: boolean; default_branch: string; updated_at: string }[] }> {
    const app = await this.app();
    if (!app) throw new Error('GitHub is not set up yet');
    const jwt = await appJwt(app);
    const inst: any[] = await gh('/app/installations?per_page=100', jwt);
    const repos: any[] = [];
    for (const i of inst) {
      const tok = await this.tokenFor(i.id, app, jwt);
      for (let page = 1; page <= 5; page++) {
        const r = await gh(`/installation/repositories?per_page=100&page=${page}`, tok);
        for (const x of r.repositories || []) repos.push({ installation_id: i.id, full_name: x.full_name, private: x.private, default_branch: x.default_branch, updated_at: x.pushed_at || x.updated_at });
        if ((r.repositories || []).length < 100) break;
      }
    }
    repos.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return { installations: inst.map((i) => ({ id: i.id, account: i.account?.login || '' })), repos };
  }

  /** A one-hour token for one installation (optionally narrowed to one repository). */
  async tokenFor(installationId: number, app?: AppCreds, jwt?: string, repo?: string): Promise<string> {
    const a = app || (await this.app());
    if (!a) throw new Error('GitHub is not set up yet');
    const body = repo ? JSON.stringify({ repositories: [repo.split('/')[1]] }) : undefined;
    const r = await gh(`/app/installations/${installationId}/access_tokens`, jwt || (await appJwt(a)), { method: 'POST', ...(body ? { body } : {}) });
    return r.token;
  }

  /** Open a pull request from `branch` (already pushed) onto the repository's base branch. */
  async openPr(installationId: number, repo: string, head: string, base: string, title: string, body: string): Promise<{ url: string; number: number }> {
    const tok = await this.tokenFor(installationId, undefined, undefined, repo);
    const pr = await gh(`/repos/${repo}/pulls`, tok, { method: 'POST', body: JSON.stringify({ title, head, base, body, maintainer_can_modify: true }) });
    return { url: pr.html_url, number: pr.number };
  }
}

// ---- the manifest: what the app may do -------------------------------------------------------------------------

export function manifest(origin: string): Record<string, unknown> {
  return {
    name: `converge-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`,
    url: origin,
    description: 'Agents change your repository in parallel; converge checks every change before it lands, and sends the result back as a pull request.',
    public: true,
    redirect_url: `${origin}/api/github/created`,
    setup_url: `${origin}/api/github/installed`,
    setup_on_update: true,
    // No webhook (no hook_attributes): converge asks GitHub when it needs to know (installations, repositories).
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: [],
  };
}

/** Exchange the code GitHub returns after creating the app for the app's keys. */
export async function convertManifest(code: string): Promise<AppCreds> {
  const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST', headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${j.message || 'could not create the app'}`);
  return { id: j.id, slug: j.slug, pem: j.pem, client_id: j.client_id, owner: j.owner?.login || '', html_url: j.html_url };
}
