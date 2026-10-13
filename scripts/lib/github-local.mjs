// GitHub on the local platform, the same way the Worker does it (worker/github.ts): a GitHub App of the owner's own,
// made in one click through GitHub's manifest flow, then installed on the repositories they pick on GitHub's own
// screen. No URL to paste and no token to copy: converge asks GitHub for a one-hour installation token each time it
// clones, pushes or opens a pull request. The app is private (only its owner's account can install it) and may read
// and write code and pull requests, nothing else.
//
// Kept in DATA/github.json (0600): the app's id, slug and private key; DATA/github-links.json: project -> repo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpError } from '../../agents/common.mjs';
import { writePrivate } from './private-file.mjs';

const UA = 'converge-local';
const err = httpError;

export function githubLocal(dataDir) {
  const appFile = path.join(dataDir, 'github.json');
  const linkFile = path.join(dataDir, 'github-links.json');
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const write = (f, v) => writePrivate(f, JSON.stringify(v));
  const states = new Map(); // one-time states for GitHub's redirects
  const app = () => read(appFile);

  function jwt(a) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: a.id })}`;
    return `${head}.${crypto.createSign('RSA-SHA256').update(head).sign(a.pem, 'base64url')}`;
  }
  async function gh(p, token, init = {}) {
    const r = await fetch(`https://api.github.com${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    const j = await r.json().catch(() => ({}));
    // GitHub's 422 says only "Validation Failed": its reason is in errors[] ("No commits between main and ...").
    const why = (j.errors || []).map((e) => e.message || e.code).filter(Boolean).join('; ');
    if (!r.ok) throw err(502, `GitHub ${r.status}: ${j.message || 'request failed'}${why ? ` (${why})` : ''}`);
    return j;
  }
  const need = () => { const a = app(); if (!a) throw err(409, 'GitHub is not set up yet'); return a; };

  return {
    status() {
      const a = app();
      return { setup: Boolean(a), app: a ? { slug: a.slug, owner: a.owner, html_url: a.html_url } : null, install_url: a ? `https://github.com/apps/${a.slug}/installations/new` : '' };
    },
    /** Step 1 (once): the page posts this manifest to GitHub, which creates the app on the owner's account. */
    setup(origin) {
      const state = crypto.randomBytes(16).toString('hex');
      states.set(state, Date.now() + 3600_000);
      return {
        action: `https://github.com/settings/apps/new?state=${state}`,
        manifest: {
          name: `converge-local-${crypto.randomBytes(3).toString('hex')}`,
          url: origin,
          description: 'converge on this computer: agents change your repositories in parallel, every change is checked before it lands, and the result goes back as a pull request.',
          public: false,
          redirect_url: `${origin}/api/github/created`,
          setup_url: `${origin}/api/github/installed`,
          setup_on_update: true,
          default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          default_events: [],
        },
      };
    },
    /** GitHub came back with the new app's code: exchange it for the app's keys. */
    async created(state, code) {
      const ok = states.get(state) > Date.now();
      states.delete(state);
      if (!ok) throw err(400, 'expired');
      const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA } });
      const j = await r.json();
      if (!r.ok) throw err(502, `GitHub ${r.status}: ${j.message || 'could not create the app'}`);
      write(appFile, { id: j.id, slug: j.slug, pem: j.pem, client_id: j.client_id, owner: j.owner?.login || '', html_url: j.html_url });
    },
    /** The repositories the app is installed on (GitHub's own screen picks them). */
    async repos() {
      const a = need();
      const t = jwt(a);
      const inst = await gh('/app/installations?per_page=100', t);
      const repos = [];
      for (const i of inst) {
        const tok = (await gh(`/app/installations/${i.id}/access_tokens`, t, { method: 'POST' })).token;
        for (let page = 1; page <= 5; page++) {
          const r = await gh(`/installation/repositories?per_page=100&page=${page}`, tok);
          for (const x of r.repositories || []) repos.push({ installation_id: i.id, full_name: x.full_name, private: x.private, default_branch: x.default_branch, updated_at: x.pushed_at || x.updated_at });
          if ((r.repositories || []).length < 100) break;
        }
      }
      repos.sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
      return { installations: inst.map((i) => ({ id: i.id, account: i.account?.login || '' })), repos };
    },
    /** A one-hour token for one installation, narrowed to one repository. */
    async tokenFor(installationId, repo) {
      const a = need();
      const body = repo ? JSON.stringify({ repositories: [repo.split('/')[1]] }) : undefined;
      return (await gh(`/app/installations/${installationId}/access_tokens`, jwt(a), { method: 'POST', ...(body ? { body } : {}) })).token;
    },
    link(project) { return (read(linkFile) || {})[project] || null; },
    /** The project a repository already came in as, or '' (so bringing it in again opens it instead of copying it). */
    projectFor(repo) {
      const all = read(linkFile) || {};
      return Object.keys(all).find((p) => String(all[p]?.repo || '').toLowerCase() === String(repo).toLowerCase()) || '';
    },
    setLink(project, l) { const all = read(linkFile) || {}; if (l) all[project] = l; else delete all[project]; write(linkFile, all); },
    /** The commit a branch of the repository is at on GitHub. */
    async branchHead(installationId, repo, branch) {
      const tok = await this.tokenFor(installationId, repo);
      return (await gh(`/repos/${repo}/branches/${encodeURIComponent(branch)}`, tok)).commit?.sha || '';
    },
    async openPr(installationId, repo, head, base, title, body) {
      const tok = await this.tokenFor(installationId, repo);
      const pr = await gh(`/repos/${repo}/pulls`, tok, { method: 'POST', body: JSON.stringify({ title, head, base, body, maintainer_can_modify: true }) });
      return { url: pr.html_url, number: pr.number };
    },
  };
}
