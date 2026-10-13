// The project's app as it is on main, served as a web page: what the dashboard shows next to the work, reloaded
// each time a change lands. Files come straight from main's repository (git cat-file), index.html at the root.
//
// The app is code agents wrote, so it never runs as the dashboard: every response carries a CSP sandbox (an
// opaque origin: no cookies, no storage, no access to the dashboard's keys), and it is reached through a
// token the dashboard gets with its own key, scoped to one project and short-lived, so no key is in a URL.
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TTL_MS = 12 * 3600_000;
const tokens = new Map(); // token -> { project, exp }
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals';

/** A token for one project's preview; the caller has checked the view key. */
export function previewToken(project) {
  const now = Date.now();
  for (const [t, v] of tokens) if (v.exp < now) tokens.delete(t);
  const token = crypto.randomBytes(18).toString('base64url');
  tokens.set(token, { project, exp: now + TTL_MS });
  return token;
}

/** GET /preview/<token>/<path>: the file at <path> on the project's main. */
export async function servePreview(res, token, rel, { repoPath, branchOf }) {
  const t = tokens.get(token);
  const head = { 'Content-Security-Policy': SANDBOX, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const page = (status, text) => { res.writeHead(status, { ...head, 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>body{font:16px/1.6 system-ui,sans-serif;color:#5b5b66;background:#f7f7f8;display:grid;place-items:center;height:100vh;margin:0;text-align:center}.soon{display:grid;gap:10px;text-align:left;min-width:min(420px,90vw)}.soon b{font-size:20px;color:inherit}.soon ul{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:6px}.soon li{display:flex;gap:10px;align-items:baseline;padding:10px 14px;border:1px solid #e4e4e8;border-radius:10px;background:#fff;animation:in .5s ease}.soon a{color:#4f46e5;font-weight:600;text-decoration:none}.soon i{font-style:normal;font-size:12px;opacity:.6}@keyframes in{from{opacity:0;transform:translateY(6px)}}@media(prefers-color-scheme:dark){body{color:#a0a0ab;background:#0e0e11}.soon li{background:#151518;border-color:#2a2a30}.soon a{color:#a5b4fc}}</style><body><div>${text}</div></body>`); };
  if (!t || t.exp < Date.now()) return page(401, 'This preview link has expired. Reload the dashboard.');
  let file = decodeURIComponent(rel || '').replace(/^\/+/, '');
  if (file === '' || file.endsWith('/')) file += 'index.html';
  if (file.split('/').some((s) => s === '..')) return page(400, 'Bad path');
  const git = ['--git-dir', repoPath(t.project)];
  const branch = branchOf(t.project) || 'main';
  try {
    const { stdout } = await run('git', [...git, 'cat-file', 'blob', `refs/heads/${branch}:${file}`], { encoding: 'buffer', maxBuffer: 64 << 20 });
    res.writeHead(200, { ...head, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    return res.end(stdout);
  } catch {
    if (file === 'index.html') {
      const empty = await run('git', [...git, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`]).then(() => false, () => true);
      if (empty) return page(404, 'Nothing on main yet.<br>Your app appears here as soon as the first change lands.');
      // No home page yet: the pages that have landed so far, so the app is there to try while the rest is built.
      const { stdout: tree } = await run('git', [...git, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`]).catch(() => ({ stdout: '' }));
      const pages = String(tree).split('\n').filter((f) => /\.html?$/i.test(f)).sort();
      const esc = (t) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      const name = (f) => esc(f.split('/').pop().replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));
      return page(200, pages.length
        ? `<div class="soon"><b>No home page yet</b><span>${pages.length === 1 ? 'One page has' : `${pages.length} pages have`} landed so far:</span><ul>${pages.map((f) => `<li><a href="${esc(f.split('/').map(encodeURIComponent).join('/'))}">${name(f)}</a> <i>${esc(f)}</i></li>`).join('')}</ul></div>`
        : 'There is no web page on main yet.<br>A web app shows here once it has one.');
    }
    return page(404, `${file.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}: not on main`);
  }
}
