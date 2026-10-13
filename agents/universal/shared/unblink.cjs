// Node.js driver for Unblink (custom-browser WebKit / JavaScriptCore — non-Chromium).
// Spawns custom_browser with --ipc-mode=stdio and speaks JSON-RPC on stdin/stdout.
// One shared session is reused by the agent tool, CLI, GUI, TUI, and console relay.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const helpers = require('./unblink-helpers.cjs');
const { killTree } = require('./kill-tree.cjs');

// Tunable via environment variables — operators on slow/fast machines can
// adjust without code changes. Defaults are conservative but not excessive.
const RPC_TIMEOUT_MS = 30000;
const BOOT_WAIT_MS = Number(process.env.UNBLINK_BOOT_WAIT_MS) || 250;
const NAV_SETTLE_MS = Number(process.env.UNBLINK_NAV_SETTLE_MS) || 600;

// The C++ JSON-RPC layer expects forward-slash paths. A Windows absolute path
// carries backslashes that would be interpreted as escape sequences and corrupt
// the target, so normalize before it ever leaves this process.
function toRpcPath(p) {
  if (process.platform !== 'win32' || typeof p !== 'string') return p;
  return p.replace(/\\/g, '/');
}

function findUnblinkBinary() {
  const env = process.env.UNBLINK_BIN || process.env.CONVERGE_UNBLINK_BIN;
  if (env && fs.existsSync(env)) return env;
  const isWin = process.platform === 'win32';
  const candidates = [
    path.join(__dirname, '../custom-browser/build/unblink'),
    path.join(__dirname, '../custom-browser/build/unblink.exe'),
    path.join(__dirname, '../custom-browser/build/custom_browser'),
    path.join(__dirname, '../custom-browser/build/custom_browser.exe'),
    path.join(__dirname, '../custom-browser/build-release/unblink.exe'),
    path.join(__dirname, '../custom-browser/build-release/custom_browser.exe'),
    path.join(__dirname, '../custom-browser/build/Release/unblink.exe'),
    path.join(__dirname, '../custom-browser/build/Release/custom_browser.exe'),
    // Nested layout: the agent checked out inside a larger repository that keeps
    // custom-browser beside it, so the binary lives one level above the agent's root.
    path.join(__dirname, '../../custom-browser/build/unblink'),
    path.join(__dirname, '../../custom-browser/build/custom_browser'),
    path.join(process.cwd(), 'custom-browser/build/unblink'),
    path.join(process.cwd(), 'custom-browser/build/custom_browser'),
    path.join(os.homedir(), '.converge', 'unblink', 'unblink'),
    path.join(os.homedir(), '.converge', 'unblink', 'unblink.exe'),
    path.join(os.homedir(), '.converge', 'custom-browser', 'custom_browser'),
    path.join(os.homedir(), '.converge', 'custom-browser', 'custom_browser.exe'),
    // Windows: per-user install under ~/.converge/bin
    path.join(os.homedir(), '.converge', 'bin', 'unblink.exe'),
    path.join(os.homedir(), '.converge', 'bin', 'custom_browser.exe'),
    // Windows: LOCALAPPDATA and Program Files installs
    ...(process.env.LOCALAPPDATA ? [
      path.join(process.env.LOCALAPPDATA, 'unblink', 'unblink.exe'),
      path.join(process.env.LOCALAPPDATA, 'custom-browser', 'custom_browser.exe'),
    ] : []),
    ...(process.env.ProgramFiles ? [
      path.join(process.env.ProgramFiles, 'unblink', 'unblink.exe'),
      path.join(process.env.ProgramFiles, 'custom-browser', 'custom_browser.exe'),
    ] : []),
    ...(process.env['ProgramFiles(x86)'] ? [
      path.join(process.env['ProgramFiles(x86)'], 'unblink', 'unblink.exe'),
      path.join(process.env['ProgramFiles(x86)'], 'custom-browser', 'custom_browser.exe'),
    ] : []),
    '/usr/local/bin/unblink',
    '/usr/local/bin/custom_browser',
    '/usr/bin/unblink',
    '/usr/bin/custom_browser',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  // Windows: fall back to a PATH lookup via where.exe so an install anywhere on
  // PATH is found without an explicit UNBLINK_BIN.
  if (isWin) {
    try {
      const { execFileSync } = require('child_process');
      for (const name of ['unblink.exe', 'custom_browser.exe', 'unblink', 'custom_browser']) {
        try {
          const hit = String(execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
            .split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
          if (hit) return hit;
        } catch { /* not on PATH */ }
      }
    } catch { /* where.exe unavailable */ }
  }
  return null;
}

function available() {
  return !!findUnblinkBinary();
}

function defaultProfileDir() {
  const dir = process.env.UNBLINK_PROFILE
    || process.env.UNBLINK_PROFILE_DIR
    || path.join(os.homedir(), '.converge', 'unblink-profile');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getProfileRoot() {
  return process.env.UNBLINK_PROFILE_DIR
    || process.env.UNBLINK_PROFILE
    || path.join(os.homedir(), '.converge');
}

// ---------- History Store ----------
function getHistoryFile() {
  return path.join(getProfileRoot(), 'unblink-history.json');
}

function loadHistory() {
  try {
    const file = getHistoryFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch {}
  return [];
}

function saveHistory(history) {
  try {
    const file = getHistoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(history.slice(0, 500), null, 2), 'utf8');
  } catch {}
}

function addHistoryEntry(url, title = '') {
  if (!url || typeof url !== 'string') return;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return;
  const history = loadHistory();
  const now = Date.now();
  const existingIdx = history.findIndex((h) => h.url === u);
  if (existingIdx >= 0) {
    const item = history[existingIdx];
    item.count = (item.count || 1) + 1;
    item.lastVisited = now;
    if (title && !item.title) item.title = title;
    history.splice(existingIdx, 1);
    history.unshift(item);
  } else {
    history.unshift({
      url: u,
      title: title || '',
      count: 1,
      lastVisited: now,
    });
  }
  saveHistory(history);
}

function searchHistory(query = '', limit = 8) {
  const history = loadHistory();
  const q = String(query || '').toLowerCase().trim();
  if (!q) return history.slice(0, limit);
  return history
    .filter((h) => (h.url && h.url.toLowerCase().includes(q)) || (h.title && h.title.toLowerCase().includes(q)))
    .sort((a, b) => {
      const aStarts = (a.url || '').toLowerCase().startsWith(q) ? 2 : 0;
      const bStarts = (b.url || '').toLowerCase().startsWith(q) ? 2 : 0;
      return (bStarts + (b.count || 1)) - (aStarts + (a.count || 1));
    })
    .slice(0, limit);
}

function clearHistory() {
  saveHistory([]);
  return true;
}

// ---------- Credential Vault ----------
function getCredentialsFile() {
  return path.join(getProfileRoot(), 'unblink-credentials.json');
}

function loadCredentials() {
  try {
    const file = getCredentialsFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof data === 'object' && data !== null) return data;
    }
  } catch {}
  return {};
}

function saveCredentials(credsOrSingle) {
  try {
    const file = getCredentialsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let toSave = {};
    if (credsOrSingle && typeof credsOrSingle === 'object') {
      if (credsOrSingle.username && (credsOrSingle.origin || credsOrSingle.domain || credsOrSingle.url)) {
        const d = extractDomain(credsOrSingle.domain || credsOrSingle.origin || credsOrSingle.url);
        toSave = loadCredentials();
        toSave[d] = {
          domain: d,
          username: String(credsOrSingle.username).trim(),
          password: String(credsOrSingle.password || ''),
          updatedAt: credsOrSingle.updatedAt || Date.now(),
        };
      } else {
        toSave = credsOrSingle;
      }
    }
    fs.writeFileSync(file, JSON.stringify(toSave, null, 2), 'utf8');
  } catch {}
}

function extractDomain(urlOrDomain) {
  if (!urlOrDomain) return '';
  const str = String(urlOrDomain).trim();
  try {
    if (/^https?:\/\//i.test(str)) {
      const u = new URL(str);
      return u.hostname.toLowerCase();
    }
  } catch {}
  return str.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
}

function domainMatches(a, b) {
  const da = extractDomain(a);
  const db = extractDomain(b);
  if (!da || !db) return false;
  return da === db || da.endsWith('.' + db) || db.endsWith('.' + da);
}

function saveDomainCredential(urlOrDomain, username, password) {
  const domain = extractDomain(urlOrDomain);
  if (!domain || !username) return { ok: false, error: 'Domain and username required' };
  const creds = loadCredentials();
  creds[domain] = {
    domain,
    username: String(username).trim(),
    password: String(password || ''),
    updatedAt: Date.now(),
  };
  saveCredentials(creds);
  return { ok: true, domain, username: creds[domain].username };
}

function getDomainCredential(urlOrDomain) {
  const domain = extractDomain(urlOrDomain);
  if (!domain) return null;
  const creds = loadCredentials();
  if (creds[domain]) return creds[domain];
  for (const [k, v] of Object.entries(creds)) {
    if (domain === k || domain.endsWith('.' + k) || k.endsWith('.' + domain)) return v;
  }
  return null;
}

function listDomainCredentials() {
  const creds = loadCredentials();
  return Object.values(creds).map((c) => ({
    domain: c.domain,
    username: c.username,
    hasPassword: !!c.password,
    updatedAt: c.updatedAt,
  }));
}

function deleteDomainCredential(urlOrDomain) {
  const domain = extractDomain(urlOrDomain);
  if (!domain) return false;
  const creds = loadCredentials();
  let found = false;
  if (creds[domain]) {
    delete creds[domain];
    found = true;
  }
  for (const k of Object.keys(creds)) {
    if (domainMatches(k, domain)) {
      delete creds[k];
      found = true;
    }
  }
  if (found) {
    saveCredentials(creds);
    return true;
  }
  return false;
}

function clearCredentials() {
  saveCredentials({});
  return true;
}

// ---------- Bookmark Store ----------
function getBookmarksFile() {
  return path.join(getProfileRoot(), 'unblink-bookmarks.json');
}

function loadBookmarks() {
  try {
    const file = getBookmarksFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch {}
  return [];
}

function saveBookmarks(bookmarks) {
  try {
    const file = getBookmarksFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(bookmarks.slice(0, 1000), null, 2), 'utf8');
  } catch {}
}

function addBookmark(urlOrObj, title = '', folder = 'Favorites') {
  let u = '';
  let t = title;
  let f = folder;
  if (urlOrObj && typeof urlOrObj === 'object') {
    u = urlOrObj.url;
    t = urlOrObj.title || title;
    f = urlOrObj.folder || folder;
  } else {
    u = urlOrObj;
  }
  if (!u || typeof u !== 'string') return { ok: false, error: 'URL required' };
  u = u.trim();
  if (!/^https?:\/\//i.test(u) && !/^about:/i.test(u) && !/^unblink:/i.test(u)) return { ok: false, error: 'Invalid URL' };
  const bookmarks = loadBookmarks();
  const existingIdx = bookmarks.findIndex((b) => b.url === u);
  const now = Date.now();
  const item = {
    id: existingIdx >= 0 ? bookmarks[existingIdx].id : now,
    url: u,
    title: t || (existingIdx >= 0 ? bookmarks[existingIdx].title : u),
    folder: f || 'Favorites',
    addedAt: existingIdx >= 0 ? bookmarks[existingIdx].addedAt : now,
    updatedAt: now,
  };
  if (existingIdx >= 0) {
    bookmarks[existingIdx] = item;
  } else {
    bookmarks.unshift(item);
  }
  saveBookmarks(bookmarks);
  return { ok: true, bookmark: item };
}

function getBookmarks(folder = '') {
  const bookmarks = loadBookmarks();
  if (!folder) return bookmarks;
  return bookmarks.filter((b) => b.folder && b.folder.toLowerCase() === folder.toLowerCase());
}

function removeBookmark(urlOrId) {
  if (urlOrId == null) return false;
  const bookmarks = loadBookmarks();
  const initialLen = bookmarks.length;
  const target = String(urlOrId).trim();
  const filtered = bookmarks.filter((b) => String(b.id) !== target && b.url !== target);
  if (filtered.length !== initialLen) {
    saveBookmarks(filtered);
    return true;
  }
  return false;
}

function clearBookmarks() {
  saveBookmarks([]);
  return true;
}

// ---------- Cookie Store ----------
function getCookiesFile() {
  return path.join(getProfileRoot(), 'unblink-cookies.json');
}

function loadCookies() {
  try {
    const file = getCookiesFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch {}
  return [];
}

function saveCookies(cookies) {
  try {
    const file = getCookiesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cookies.slice(0, 2000), null, 2), 'utf8');
  } catch {}
}

function matchesCookieDomain(cookieDomain, targetDomain) {
  if (!cookieDomain || !targetDomain) return false;
  const cd = cookieDomain.toLowerCase().replace(/^\./, '');
  const td = targetDomain.toLowerCase().replace(/^\./, '');
  return cd === td || td.endsWith('.' + cd);
}

function saveCookie(cookie) {
  if (!cookie || !cookie.name || !cookie.domain) return { ok: false, error: 'Domain and name required' };
  const cookies = loadCookies();
  const domain = extractDomain(cookie.domain);
  const cookiePath = cookie.path || '/';
  const name = String(cookie.name).trim();
  const existingIdx = cookies.findIndex((c) => c.domain === domain && (c.path || '/') === cookiePath && c.name === name);
  const rec = {
    domain,
    path: cookiePath,
    name,
    value: String(cookie.value || ''),
    expires: cookie.expires != null ? Number(cookie.expires) : 0,
    secure: !!(cookie.secure || cookie.is_secure),
    httpOnly: !!(cookie.httpOnly || cookie.is_http_only),
    sameSite: cookie.sameSite || cookie.same_site || 'Lax',
    updatedAt: Date.now(),
  };
  if (existingIdx >= 0) {
    cookies[existingIdx] = rec;
  } else {
    cookies.push(rec);
  }
  saveCookies(cookies);
  return { ok: true, cookie: rec };
}

function getCookiesForDomain(urlOrDomain) {
  const domain = extractDomain(urlOrDomain);
  if (!domain) return [];
  const cookies = loadCookies();
  const nowMs = Date.now();
  const nowSec = nowMs / 1000;
  const unexpired = [];
  let purged = false;
  for (const c of cookies) {
    const isExpired = c.expires > 0 && (c.expires > 1e11 ? c.expires < nowMs : c.expires < nowSec);
    if (isExpired) {
      purged = true;
    } else {
      unexpired.push(c);
    }
  }
  if (purged) saveCookies(unexpired);
  return unexpired.filter((c) => matchesCookieDomain(c.domain, domain));
}

function deleteCookie(urlOrDomain, name) {
  let domain = extractDomain(urlOrDomain);
  let cookieName = String(name || '').trim();
  if (cookieName.includes('.') && (!domain || !domain.includes('.'))) {
    const temp = domain;
    domain = extractDomain(cookieName);
    cookieName = temp;
  }
  if (!domain && !cookieName) return false;
  const cookies = loadCookies();
  const initialLen = cookies.length;
  const filtered = cookies.filter((c) => {
    if (domain && cookieName) return !(matchesCookieDomain(c.domain, domain) && c.name === cookieName);
    if (cookieName) return c.name !== cookieName;
    if (domain) return !matchesCookieDomain(c.domain, domain);
    return true;
  });
  if (filtered.length !== initialLen) {
    saveCookies(filtered);
    return true;
  }
  return false;
}

function clearCookies() {
  saveCookies([]);
  return true;
}

// ---------- Full Session State Export / Import ----------
function exportState() {
  const creds = loadCredentials();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    history: loadHistory(),
    credentials: Array.isArray(creds) ? creds : Object.values(creds),
    bookmarks: loadBookmarks(),
    cookies: loadCookies(),
  };
}

function importState(bundle = {}, { overwrite = false } = {}) {
  if (!bundle || typeof bundle !== 'object') return { ok: false, error: 'Invalid state bundle' };
  let importedHistory = 0;
  let importedCreds = 0;
  let importedBookmarks = 0;
  let importedCookies = 0;

  if (Array.isArray(bundle.history)) {
    const cur = overwrite ? [] : loadHistory();
    for (const h of bundle.history) {
      if (h && h.url && !cur.some((x) => x.url === h.url)) {
        cur.push(h);
        importedHistory++;
      }
    }
    saveHistory(cur);
  }

  if (bundle.credentials) {
    const cur = overwrite ? {} : loadCredentials();
    const credList = Array.isArray(bundle.credentials)
      ? bundle.credentials
      : (typeof bundle.credentials === 'object' ? Object.values(bundle.credentials) : []);
    for (const v of credList) {
      const d = v && (v.domain || extractDomain(v.origin || v.url));
      if (v && d && v.username) {
        cur[d] = {
          domain: d,
          username: String(v.username).trim(),
          password: String(v.password || ''),
          updatedAt: v.updatedAt || Date.now(),
        };
        importedCreds++;
      }
    }
    saveCredentials(cur);
  }

  if (Array.isArray(bundle.bookmarks)) {
    const cur = overwrite ? [] : loadBookmarks();
    for (const b of bundle.bookmarks) {
      if (b && b.url && !cur.some((x) => x.url === b.url)) {
        cur.push(b);
        importedBookmarks++;
      }
    }
    saveBookmarks(cur);
  }

  if (Array.isArray(bundle.cookies)) {
    const cur = overwrite ? [] : loadCookies();
    for (const c of bundle.cookies) {
      if (c && c.name && c.domain && !cur.some((x) => x.domain === c.domain && x.name === c.name && x.path === c.path)) {
        cur.push(c);
        importedCookies++;
      }
    }
    saveCookies(cur);
  }

  return {
    ok: true,
    imported: {
      history: importedHistory,
      credentials: importedCreds,
      bookmarks: importedBookmarks,
      cookies: importedCookies,
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDisplay(env) {
  if (env.DISPLAY) return env;
  if (process.platform !== 'linux') return env;
  const xvfb = '/tmp/.X11-unix';
  try {
    if (fs.existsSync(xvfb)) {
      const socks = fs.readdirSync(xvfb).filter((n) => /^X\d+$/.test(n));
      if (socks.length) {
        const n = socks.sort().pop().slice(1);
        return { ...env, DISPLAY: `:${n}` };
      }
    }
  } catch {}
  try {
    const which = (cmd) => {
      for (const d of String(process.env.PATH || '').split(path.delimiter)) {
        if (!d) continue;
        const p = path.join(d, cmd);
        try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
      }
      return null;
    };
    const xvfbBin = which('Xvfb');
    if (xvfbBin) {
      for (let n = 90; n < 120; n++) {
        const lock = `/tmp/.X${n}-lock`;
        if (fs.existsSync(lock)) continue;
        const display = `:${n}`;
        const child = spawn(xvfbBin, [display, '-screen', '0', '1280x900x24', '-ac', '-nolisten', 'tcp'], {
          detached: true,
          stdio: 'ignore',
        });
        try { child.unref(); } catch {}
        return { ...env, DISPLAY: display };
      }
    }
  } catch {}
  return env;
}

const LOCATOR_HELPER_JS = `
function __unblink_find_elements(query) {
  if (!query || typeof query !== 'string') return [];
  const q = query.trim();
  let els = [];

  function queryDeep(selector, root = document.documentElement) {
    const results = [];
    function walk(node) {
      if (!node) return;
      try {
        if (node.matches && node.matches(selector)) results.push(node);
      } catch (_) {}
      const children = node.children ? Array.from(node.children) : [];
      for (const ch of children) walk(ch);
      if (node.shadowRoot) walk(node.shadowRoot);
    }
    walk(root);
    return results;
  }

  // 1. XPath detection
  if (q.startsWith('/') || q.startsWith('./') || q.startsWith('xpath=') || q.startsWith('(/')) {
    const xp = q.replace(/^xpath=/i, '');
    try {
      const snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < snap.snapshotLength; i++) {
        const n = snap.snapshotItem(i);
        if (n && n.nodeType === 1) els.push(n);
      }
      if (els.length) return els;
    } catch (e) {}
  }

  // 2. Playwright-style role / testid / label / placeholder syntax
  const roleM = q.match(/^(?:role=|getByRole\\(['"]?)([a-zA-Z0-9_-]+)(?:['"]?(?:,\\s*\\{?\\s*name:\\s*['"]?([^'"]+)['"]?\\s*\\}?)?)?\\)?$/i);
  if (roleM) {
    const rName = roleM[1].toLowerCase();
    const rText = roleM[2] ? roleM[2].trim().toLowerCase() : '';
    const cand = Array.from(document.querySelectorAll('[role="' + rName + '"], ' + rName));
    els = cand.filter(el => {
      if (!rText) return true;
      const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').trim().toLowerCase();
      return t === rText || t.includes(rText);
    });
    if (els.length) return els;
  }

  const testIdM = q.match(/^(?:data-testid=|getByTestId\\(['"]?)([^'"]+)\\)?$/i);
  if (testIdM) {
    const tid = testIdM[1];
    els = Array.from(document.querySelectorAll('[data-testid="' + tid + '"], [data-test="' + tid + '"], [data-qa="' + tid + '"], [id="' + tid + '"]'));
    if (els.length) return els;
  }

  const placeholderM = q.match(/^(?:placeholder=|getByPlaceholder\\(['"]?)([^'"]+)\\)?$/i);
  if (placeholderM) {
    const ph = placeholderM[1].toLowerCase();
    els = Array.from(document.querySelectorAll('input, textarea')).filter(el => (el.getAttribute('placeholder') || '').toLowerCase().includes(ph));
    if (els.length) return els;
  }

  // 3. Playwright-style text/has-text/contains syntax
  let tagScope = '*';
  let matchText = null;
  let exact = false;
  const hasTextM = q.match(/^([a-zA-Z0-9_-]*)?:(?:has-text|contains)\\(['"]?([^'"]+)['"]?\\)$/i);
  const textEqM = q.match(/^text=(["'])(.*?)\\1$/i) || q.match(/^text=(.+)$/i);
  const tagArrowM = q.match(/^([a-zA-Z0-9_-]+)\\s*>>\\s*text=(.+)$/i);

  if (hasTextM) {
    tagScope = hasTextM[1] || '*';
    matchText = hasTextM[2].trim().toLowerCase();
  } else if (textEqM) {
    matchText = textEqM[textEqM.length - 1].trim().toLowerCase();
    exact = q.startsWith('text="') || q.startsWith("text='");
  } else if (tagArrowM) {
    tagScope = tagArrowM[1];
    matchText = tagArrowM[2].replace(/^["']|["']$/g, '').trim().toLowerCase();
  }

  // 4. Direct querySelectorAll if valid CSS
  try {
    const list = Array.from(document.querySelectorAll(q));
    if (list.length) return list;
  } catch (e) {}

  // 5. Deep query with shadow roots
  try {
    const deepList = queryDeep(q);
    if (deepList.length) return deepList;
  } catch (e) {}

  // 6. Text / has-text match
  if (matchText) {
    const scope = tagScope === '*' ? 'button, a, input, [role="button"], [role="link"], [role="tab"], [role="menuitem"], label, summary, select, textarea, span, p, h1, h2, h3, h4, h5, h6, div, li, td, th' : tagScope;
    const candidates = Array.from(document.querySelectorAll(scope));
    els = candidates.filter(el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const val = (el.value ? String(el.value) : '').toLowerCase();
      const alt = (el.getAttribute('alt') || '').toLowerCase();
      const title = (el.title || '').toLowerCase();
      if (exact) {
        return t === matchText || aria === matchText || val === matchText || ph === matchText;
      }
      return t === matchText || aria === matchText || val === matchText || ph === matchText || alt === matchText || title === matchText ||
             (t.length < 300 && t.includes(matchText)) || aria.includes(matchText) || ph.includes(matchText);
    });
    if (els.length) return els;
  }

  // 7. Attribute & Label Association Fallback
  const clean = q.replace(/^[:'"]+|[:'"]+$/g, '').trim().toLowerCase();
  if (clean) {
    const labels = Array.from(document.querySelectorAll('label'));
    for (const lbl of labels) {
      const lt = (lbl.innerText || lbl.textContent || '').trim().toLowerCase();
      if (lt === clean || (lt.length < 100 && lt.includes(clean))) {
        if (lbl.control) return [lbl.control];
        const forId = lbl.getAttribute('for');
        if (forId) {
          const target = document.getElementById(forId);
          if (target) return [target];
        }
        const innerInput = lbl.querySelector('input, select, textarea');
        if (innerInput) return [innerInput];
      }
    }

    const all = [];
    function walk(root) {
      if (!root) return;
      const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
      for (const n of nodes) {
        all.push(n);
        if (n.shadowRoot) walk(n.shadowRoot);
      }
    }
    walk(document.body || document.documentElement);

    els = all.filter(el => {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const val = (el.value ? String(el.value) : '').toLowerCase();
      const alt = (el.getAttribute('alt') || '').toLowerCase();
      const title = (el.title || '').toLowerCase();
      const testid = (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.id || el.name || '').toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      return aria === clean || ph === clean || val === clean || alt === clean || title === clean || testid === clean || text === clean ||
             testid.includes(clean) || aria.includes(clean) || ph.includes(clean) || (text.length < 200 && text.includes(clean));
    });
  }

  return els;
}
`;

class UnblinkDriver {
  constructor(opts = {}) {
    this.instanceId = (typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
    this.binPath = opts.binPath || findUnblinkBinary();
    this.url = opts.url || 'about:blank';
    this.profileDir = opts.profileDir || defaultProfileDir();
    this.smokeQuitMs = opts.smokeQuitMs || 0;
    this.headless = opts.headless;
    this.width = opts.width || 1280;
    this.height = opts.height || 800;
    this.proc = null;
    this.pending = [];
    this.buffer = '';
    this.lastUrl = this.url;
    this.lastTitle = '';
    this.engine = '';
    this.logs = [];
    this.networkLogs = [];
    this.customHeaders = {};
    this.userAgent = opts.userAgent || null;
    this.presented = false;
    this._rpcChain = Promise.resolve();
  }

  get running() {
    return !!(this.proc && !this.proc.killed && this.proc.exitCode == null);
  }

  start() {
    if (this.running) return Promise.resolve({ pid: this.proc.pid, binary: this.binPath, reused: true });
    if (!this.binPath) {
      return Promise.reject(new Error(
        'Unblink binary not found — build custom-browser (cmake -B build && cmake --build build) or set UNBLINK_BIN'
      ));
    }
    return new Promise((resolve, reject) => {
      fs.mkdirSync(this.profileDir, { recursive: true });
      const args = [
        `--url=${this.url}`,
        `--profile=${this.profileDir}`,
        '--ipc-mode=stdio',
      ];
      if (this.headless !== false) args.push('--headless');
      if (this.smokeQuitMs > 0) args.push(`--smoke-quit-ms=${this.smokeQuitMs}`);
      if (this.userAgent) args.push(`--user-agent=${this.userAgent}`);

      const env = ensureDisplay({ ...process.env });
      // WebKitGTK's web process needs compositing off when there is no real GPU
      // context — under Xvfb on WebKitGTK 2.28 (the newest webkit2gtk-4.0 any
      // CentOS/RHEL 7 box can install) EVERY evalScript came back
      // `{"error":""}` until this was set; with it, JS runs. Harmless on the
      // 4.1/2.40+ boxes, and still overridable from the caller's environment.
      if (env.WEBKIT_DISABLE_COMPOSITING_MODE == null) { env.WEBKIT_DISABLE_COMPOSITING_MODE = '1'; }
      this.proc = spawn(this.binPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      try { this.proc.unref(); } catch { /* older runtimes */ }

      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      // Keep the tail of stderr: when the engine cannot even load, the loader's
      // one line ("error while loading shared libraries: libwebkit2gtk-4.1.so.0
      // …", "GLIBC_2.38 not found") is the whole diagnosis, and it used to be
      // thrown away — the operator saw only "Unblink failed to start" (a binary
      // built on a newer glibc copied to an older box).
      let stderrTail = '';
      this.proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600); });
      const why = () => {
        const line = stderrTail.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
        return line ? ` — ${line}` : '';
      };
      this.proc.on('error', (err) => {
        this._failAll(err);
        reject(err);
      });
      this.proc.on('exit', (code, signal) => {
        this._failAll(new Error(`Unblink exited (code=${code}, signal=${signal || 'none'})${why()}`));
        this.proc = null;
      });

      setTimeout(() => {
        if (!this.running) {
          const hint = /loading shared libraries|GLIBC|GLIBCXX/.test(stderrTail)
            ? ' (the binary does not match this machine — rebuild custom-browser here: cmake -B build && cmake --build build, with libwebkit2gtk-4.1 installed)'
            : '';
          reject(new Error(`Unblink failed to start${why()}${hint}`));
          return;
        }
        const want = this.viewport;
        const done = () => {
          this.injectNetworkHook().catch(() => {});
          resolve({ pid: this.proc.pid, binary: this.binPath, display: env.DISPLAY || null });
        };
        if (want && want.width && want.height) {
          this.setViewport(want.width, want.height, want.dpr || 1).then(done, done);
        } else {
          done();
        }
      }, BOOT_WAIT_MS);
    });
  }

  _onStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    // Split on CRLF or LF so a Windows driver that emits \r\n never leaves a
    // trailing carriage return that corrupts the JSON parse.
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      if (!msg || typeof msg !== 'object') continue;
      // An ANNOUNCEMENT, not an answer. Replies are paired positionally, so
      // letting one of these shift the queue would hand every later RPC the
      // wrong result. Consume it here and never touch `pending`.
      if (msg.event) {
        if (msg.event === 'url' && msg.url) this.lastUrl = msg.url;
        continue;
      }
      const cb = this.pending.shift();
      if (cb) cb(null, msg);
    }
  }

  _failAll(err) {
    while (this.pending.length) {
      const cb = this.pending.shift();
      try { cb(err); } catch {}
    }
  }

  // Serialize RPCs — the C++ side is FIFO and has no request ids.
  sendRPC(payload, timeoutMs = RPC_TIMEOUT_MS) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.running) return reject(new Error('Unblink process is not running'));
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        const idx = this.pending.indexOf(handler);
        if (idx >= 0) this.pending.splice(idx, 1);
        // CRITICAL: Prevent queue desync. If an RPC times out on a FIFO pipe, late responses
        // will misalign every future request. Terminate the child process and reset the session.
        if (this.running) {
          if (process.platform === 'win32') {
            // taskkill /T reaps the whole browser engine tree, not just the driver.
            try { killTree(this.proc.pid, 'SIGTERM'); } catch {}
          } else {
            try { this.proc.kill('SIGTERM'); } catch {}
            setTimeout(() => {
              try { if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL'); } catch {}
            }, 300);
          }
        }
        const err = new Error(`Unblink RPC timeout after ${timeoutMs}ms (${payload.method || 'unknown'})`);
        this._failAll(err);
        reject(err);
      }, timeoutMs);

      const handler = (err, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(result);
      };
      this.pending.push(handler);
      try {
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const idx = this.pending.indexOf(handler);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(e);
      }
    });
    const next = this._rpcChain.then(run, run);
    this._rpcChain = next.catch(() => {});
    return next;
  }

  async waitForReady(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await this.evalJson('document.readyState').catch(() => null);
      if (state === 'complete' || state === 'interactive') break;
      await sleep(100);
    }
  }

  async navigate(url, { timeoutMs = 30000, waitForSettle = true } = {}) {
    const u = String(url || '');
    if (!u) throw new Error('navigate needs a url');
    if (!this.engine) await this.getInfo().catch(() => {});
    const res = process.platform === 'win32' && /Gecko|Firefox/i.test(this.engine)
      ? await this.nativeControl('navigate', { url: u, timeoutMs })
      : await this.sendRPC({ method: 'navigate', url: u }, timeoutMs);
    this.lastUrl = u;
    if (waitForSettle) {
      await this.waitForReady(Math.min(timeoutMs, 4000)).catch(() => {});
      await sleep(NAV_SETTLE_MS);
    }
    try {
      const info = await this.getInfo();
      if (info && info.title != null) this.lastTitle = String(info.title).replace(/^"|"$/g, '');
    } catch {}
    if (this.lastUrl) addHistoryEntry(this.lastUrl, this.lastTitle);
    this.injectLoginCapture().catch(() => {});
    this.injectNetworkHook().catch(() => {});
    return res;
  }

  async navigationControl(action) {
    const op = String(action || '').toLowerCase();
    if (!['back', 'forward', 'reload', 'stop'].includes(op)) throw new Error(`unknown navigation control: ${op}`);
    const res = await this.sendRPC({ method: op });
    if (op !== 'stop') {
      await sleep(120);
      await this.snapshot(200).catch(() => {});
    }
    return res;
  }

  async evalScript(script) {
    const res = await this.sendRPC({ method: 'eval', script: String(script) });
    if (res && res.error) {
      const detail = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
      throw new Error(`Unblink eval error: ${detail}`);
    }
    return res;
  }

  async evalJson(script) {
    const res = await this.evalScript(script);
    let v = res && res.result;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }

  async takeScreenshot(outputPath, waitLoadMs = 200) {
    if (waitLoadMs > 0) await sleep(waitLoadMs);
    const out = path.resolve(String(outputPath));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
    const res = await this.sendRPC({ method: 'screenshot', path: toRpcPath(out) }, 60000);
    for (let i = 0; i < 15; i++) {
      try {
        if (fs.existsSync(out) && fs.statSync(out).size > 0) break;
      } catch {}
      await sleep(30);
    }
    return res;
  }

  async getInfo() {
    const res = await this.sendRPC({ method: 'get_info' });
    if (res && res.title != null) {
      const t = res.title;
      this.lastTitle = typeof t === 'string' ? t.replace(/^"|"$/g, '') : String(t);
    }
    if (res && res.engine) this.engine = String(res.engine);
    if (res && res.nativeInput != null) this.nativeInput = !!res.nativeInput;
    return res;
  }

  // Whether the BINARY delivers real OS-level input. Reported by get_info rather
  // than guessed from the engine name — guessing wrong means every keystroke is a
  // synthesized DOM event that the page may ignore, with nothing to show it did.
  async hasNativeInput() {
    if (this.nativeInput == null) await this.getInfo().catch(() => {});
    return !!this.nativeInput;
  }

  // Centre of the nth match, in CSS pixels, after scrolling it into view — plus
  // the checks that produce a useful error instead of a click into empty space.
  async elementBox(selector, nth = 0) {
    const sel = JSON.stringify(String(selector));
    const raw = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const el = els[${Number(nth) || 0}];
      if (!el) return JSON.stringify({ found: false, count: els.length });
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { try { el.scrollIntoView(true); } catch (_) {} }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const left = r.left !== undefined ? r.left : (r.x || 0);
      const top = r.top !== undefined ? r.top : (r.y || 0);
      const width = r.width || 0;
      const height = r.height || 0;
      const visible = (width > 0 || el.getClientRects().length > 0) && (height > 0 || el.getClientRects().length > 0) && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      return JSON.stringify({
        found: true, visible, disabled: !!el.disabled, count: els.length,
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        x: Math.round(left + width / 2), y: Math.round(top + height / 2),
        left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height)
      });
    })()`);
    const b = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!b || !b.found) throw new Error(`no element matches ${selector} (${(b && b.count) || 0} matches)`);
    if (!b.visible) throw new Error(`${selector} exists but is not visible`);
    if (b.disabled) throw new Error(`${selector} is disabled`);
    return b;
  }

  async nativeControl(operation, args = {}) {
    const res = await this.control(operation, args, Number(args.timeoutMs) || RPC_TIMEOUT_MS);
    if (!res || res.code !== 'ok') throw new Error((res && (res.message || res.code)) || `${operation} failed`);
    let value = res.result;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch {} }
    return value && typeof value === 'object' ? value : {};
  }

  async control(operation, args = {}, timeoutMs = RPC_TIMEOUT_MS) {
    return this.sendRPC({
      method: 'control',
      operation: String(operation || ''),
      requestId: String(args.requestId || ''),
      url: args.url,
      selector: args.selector,
      text: args.text,
      key: args.key,
      path: toRpcPath(args.path),
      x: args.x,
      y: args.y,
      deltaX: args.deltaX,
      deltaY: args.deltaY,
      generation: args.generation,
      elementGeneration: args.elementGeneration,
      append: !!args.append,
      timeoutMs,
    }, timeoutMs + 1000);
  }

  async snapshot(maxText = 4000) {
    let raw;
    try { raw = await this.evalJson(`(() => {
      try {
        return JSON.stringify({
          title: document.title || '',
          url: location.href || '',
          text: (document.body && document.body.innerText || '').slice(0, ${Number(maxText) || 4000})
        });
      } catch (e) {
        return JSON.stringify({ title: '', url: '', text: '', error: String(e && e.message || e) });
      }
    })()`); } catch (e) {
      // The Windows Gecko runtime exposes native control but no JS/DOM bridge.
      // Its state operation still gives AI callers the real URL/title and keeps
      // navigate/status usable instead of failing every action at snapshot().
      const state = await this.nativeControl('state').catch(() => null);
      if (!state) throw e;
      if (state.url) this.lastUrl = state.url;
      if (state.title) this.lastTitle = state.title;
      return { ...state, text: '', domAvailable: false };
    }
    const s = (typeof raw === 'string') ? (() => { try { return JSON.parse(raw); } catch { return { title: '', url: this.lastUrl, text: String(raw) }; } })() : (raw || {});
    if (s.url) this.lastUrl = s.url;
    if (s.title) this.lastTitle = s.title;
    return s;
  }

  async click(selector, nth = 0) {
    const n = Number(nth) || 0;
    // A real mouse press on the resolved centre when the engine can deliver one.
    // el.click() reaches handlers but leaves the element unfocused and untrusted,
    // which is why typing after a "successful" click went nowhere.
    if (await this.hasNativeInput()) {
      const b = await this.elementBox(selector, n).catch((e) => { throw new Error(`click: ${e.message}`); });
      await this.nativeControl('click', { x: b.x, y: b.y });
      await sleep(120);
      return { clicked: selector, nth: n, tag: b.tag, at: { x: b.x, y: b.y }, native: true };
    }
    const sel = JSON.stringify(String(selector));
    const box = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const el = els[${n}];
      if (!el) return JSON.stringify({ found: false, count: els.length });
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { try { el.scrollIntoView(true); } catch (_) {} }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const left = r.left !== undefined ? r.left : (r.x || 0);
      const top = r.top !== undefined ? r.top : (r.y || 0);
      const width = r.width || 0;
      const height = r.height || 0;
      const visible = (width > 0 || el.getClientRects().length > 0) && (height > 0 || el.getClientRects().length > 0) && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      if (!visible) return JSON.stringify({ found: true, visible: false, count: els.length, tag: el.tagName.toLowerCase() });
      if (el.disabled) return JSON.stringify({ found: true, visible: true, disabled: true, tag: el.tagName.toLowerCase() });
      
      const target = el.closest('button, a, input, select, textarea, [tabindex], [role="button"]') || el;
      try { target.focus({ preventScroll: true }); } catch (_) {}

      const clientX = Math.round(left + width / 2);
      const clientY = Math.round(top + height / 2);
      const mouseOpts = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 };
      
      try { target.dispatchEvent(new PointerEvent('pointerdown', mouseOpts)); } catch (_) {}
      target.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
      try { target.dispatchEvent(new PointerEvent('pointerup', mouseOpts)); } catch (_) {}
      target.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
      target.dispatchEvent(new MouseEvent('click', mouseOpts));
      if (typeof target.click === 'function') {
        try { target.click(); } catch (_) {}
      }

      return JSON.stringify({
        found: true, visible: true, disabled: false, count: els.length,
        tag: target.tagName.toLowerCase(),
        x: clientX, y: clientY
      });
    })()`);
    const b = typeof box === 'string' ? JSON.parse(box) : box;
    if (!b.found) throw new Error(`click: no element matches ${selector}${n ? ` at index ${n}` : ''} (${b.count || 0} matches)`);
    if (b.visible === false) throw new Error(`click: ${selector} exists but is not visible`);
    if (b.disabled) throw new Error(`click: ${selector} is disabled`);
    await sleep(150);
    return { clicked: selector, nth: n, tag: b.tag, at: { x: Math.round(b.x || 0), y: Math.round(b.y || 0) } };
  }

  async hover(selector, nth = 0) {
    const n = Number(nth) || 0;
    const b = await this.elementBox(selector, n).catch((e) => { throw new Error(`hover: ${e.message}`); });
    const sel = JSON.stringify(String(selector));
    await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const el = els[${n}];
      if (!el) return false;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: ${b.x}, clientY: ${b.y} };
      try { el.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent('mouseenter', opts)); } catch (_) {}
      try { el.dispatchEvent(new PointerEvent('pointermove', opts)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent('mousemove', opts)); } catch (_) {}
      return true;
    })()`);
    await sleep(80);
    return { hovered: selector, nth: n, at: { x: b.x, y: b.y }, tag: b.tag };
  }

  async focus(selector, nth = 0) {
    const sel = JSON.stringify(String(selector));
    const n = Number(nth) || 0;
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const el = els[${n}];
      if (!el) return JSON.stringify({ ok: false, error: 'not found' });
      el.focus();
      return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), active: document.activeElement === el });
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (!r || !r.ok) throw new Error(`focus: ${selector} not found`);
    return { focused: selector, nth: n, ...r };
  }

  async blur(selector, nth = 0) {
    const sel = selector ? JSON.stringify(String(selector)) : null;
    const n = Number(nth) || 0;
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const el = ${sel} ? __unblink_find_elements(${sel})[${n}] : document.activeElement;
      if (!el) return JSON.stringify({ ok: false, error: 'not found' });
      el.blur();
      return JSON.stringify({ ok: true, tag: el.tagName ? el.tagName.toLowerCase() : '' });
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    return { blurred: selector || 'activeElement', ...r };
  }

  async selectOption(selector, valueOrLabelOrIndex, { nth = 0 } = {}) {
    const sel = JSON.stringify(String(selector));
    const target = JSON.stringify(String(valueOrLabelOrIndex ?? ''));
    const n = Number(nth) || 0;
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const select = els[${n}];
      if (!select || select.tagName.toLowerCase() !== 'select') {
        return JSON.stringify({ ok: false, error: 'select element not found' });
      }
      const targetVal = ${target}.toLowerCase();
      const options = Array.from(select.options);
      let matchedIdx = -1;
      
      if (/^\\d+$/.test(targetVal) && Number(targetVal) < options.length) {
        matchedIdx = Number(targetVal);
      }
      if (matchedIdx < 0) {
        matchedIdx = options.findIndex(o => (o.value || '').toLowerCase() === targetVal || (o.text || '').trim().toLowerCase() === targetVal);
      }
      if (matchedIdx < 0) {
        matchedIdx = options.findIndex(o => (o.value || '').toLowerCase().includes(targetVal) || (o.text || '').trim().toLowerCase().includes(targetVal));
      }
      if (matchedIdx < 0) {
        return JSON.stringify({ ok: false, error: 'option matching ' + targetVal + ' not found in ' + options.length + ' options' });
      }

      select.selectedIndex = matchedIdx;
      options[matchedIdx].selected = true;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));

      return JSON.stringify({
        ok: true,
        selectedIndex: matchedIdx,
        value: select.value,
        text: options[matchedIdx].text
      });
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (!r || !r.ok) throw new Error(`selectOption: ${(r && r.error) || 'failed to select option'}`);
    return { selected: selector, ...r };
  }

  async setChecked(selector, checked = true, { nth = 0 } = {}) {
    const sel = JSON.stringify(String(selector));
    const shouldCheck = !!checked;
    const n = Number(nth) || 0;
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const input = els[${n}];
      if (!input || (input.type !== 'checkbox' && input.type !== 'radio')) {
        return JSON.stringify({ ok: false, error: 'checkbox or radio input not found' });
      }
      const prev = !!input.checked;
      if (prev !== ${shouldCheck}) {
        input.checked = ${shouldCheck};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return JSON.stringify({ ok: true, checked: !!input.checked, type: input.type });
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (!r || !r.ok) throw new Error(`setChecked: ${(r && r.error) || 'failed to toggle checkbox/radio'}`);
    return { checked: r.checked, selector, ...r };
  }

  async uploadFile(selector, filePaths, { nth = 0 } = {}) {
    const sel = JSON.stringify(String(selector));
    const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).map(p => path.resolve(String(p)));
    const n = Number(nth) || 0;
    const filesMeta = paths.map(p => ({
      name: path.basename(p),
      size: fs.existsSync(p) ? fs.statSync(p).size : 0,
      type: p.endsWith('.png') ? 'image/png' : p.endsWith('.jpg') || p.endsWith('.jpeg') ? 'image/jpeg' : p.endsWith('.json') ? 'application/json' : 'text/plain',
    }));
    const payload = JSON.stringify(filesMeta);
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const input = els[${n}];
      if (!input || input.type !== 'file') return JSON.stringify({ ok: false, error: 'file input not found' });
      const meta = ${payload};
      try {
        const dt = new DataTransfer();
        for (const m of meta) {
          const f = new File(['mock content for ' + m.name], m.name, { type: m.type, lastModified: Date.now() });
          dt.items.add(f);
        }
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ ok: true, count: dt.files.length, files: meta.map(m => m.name) });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e.message || e) });
      }
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (!r || !r.ok) throw new Error(`uploadFile: ${(r && r.error) || 'failed to set file input'}`);
    return { uploaded: filesMeta.map(m => m.name), selector, ...r };
  }

  async getAttribute(selector, attributeName, { nth = 0 } = {}) {
    const sel = JSON.stringify(String(selector));
    const attr = JSON.stringify(String(attributeName));
    const n = Number(nth) || 0;
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const el = els[${n}];
      if (!el) return JSON.stringify({ found: false });
      const a = ${attr};
      let val = null;
      if (a === 'value') val = el.value !== undefined ? String(el.value) : null;
      else if (a === 'text' || a === 'innerText') val = el.innerText || el.textContent;
      else val = el.getAttribute(a);
      return JSON.stringify({ found: true, attribute: a, value: val, tag: el.tagName.toLowerCase() });
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (!r || !r.found) throw new Error(`getAttribute: ${selector} not found`);
    return { selector, attribute: attributeName, value: r.value, tag: r.tag };
  }

  async getBoundingBox(selector, nth = 0) {
    return this.elementBox(selector, nth);
  }

  async scrollTo(target, opts = {}) {
    if (typeof target === 'string') {
      if (target === 'top') {
        await this.evalScript('window.scrollTo({ top: 0, left: 0, behavior: "instant" })');
      } else if (target === 'bottom') {
        await this.evalScript('window.scrollTo({ top: document.body.scrollHeight || document.documentElement.scrollHeight, left: 0, behavior: "instant" })');
      } else {
        const b = await this.elementBox(target, opts.nth || 0);
        return { scrolledTo: target, position: b };
      }
    } else if (target && typeof target === 'object' && (target.x !== undefined || target.y !== undefined)) {
      const x = Number(target.x) || 0;
      const y = Number(target.y) || 0;
      await this.evalScript(`window.scrollTo({ top: ${y}, left: ${x}, behavior: "instant" })`);
    }
    await sleep(80);
    return { scrolled: true, current: await this.scrollPos() };
  }

  async type(selector, text, { nth = 0, append = false } = {}) {
    if (!this.engine) await this.getInfo().catch(() => {});
    const chunk = String(text ?? '');
    const isFocusedTarget = !selector || selector === 'null' || selector === 'undefined';
    const doAppend = isFocusedTarget ? (append !== false && String(append) !== 'false') : (append === true || String(append) === 'true');
    if (process.platform === 'win32' && /Gecko|Firefox/i.test(this.engine)) {
      if (!isFocusedTarget) throw new Error('type: Windows Gecko has no DOM selector bridge; click_at the field first, then type with an empty selector');
      const r = await this.nativeControl('type', { text: chunk, append: doAppend });
      return { typed: chunk, into: 'focused element', native: true, ...r };
    }
    // Real keystrokes into the field, clicked first so the page sees focus land
    // the way it does for a person. Assigning .value fires input events but skips
    // every keydown a site listens for, so suggestion and submit code never runs.
    if (await this.hasNativeInput()) {
      let into = 'focused element';
      if (!isFocusedTarget) {
        const b = await this.elementBox(selector, nth).catch((e) => { throw new Error(`type: ${e.message}`); });
        await this.nativeControl('click', { x: b.x, y: b.y });
        into = selector;
      }
      if (!doAppend) {
        await this.evalScript('(()=>{const e=document.activeElement;if(e&&e.value!==undefined){const proto=e instanceof HTMLTextAreaElement?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;const desc=Object.getOwnPropertyDescriptor(proto,"value");if(desc&&desc.set)desc.set.call(e,"");else e.value="";e.dispatchEvent(new Event("input",{bubbles:true}));}else if(e&&e.isContentEditable)e.textContent="";return true})()');
      }
      if (chunk) await this.nativeControl('type', { text: chunk, append: doAppend });
      const value = await this.evalJson('(()=>{const e=document.activeElement;if(!e)return "";return e.value!==undefined?String(e.value):String(e.innerText||"")})()')
        .catch(() => '');
      return { typed: chunk, into, value: typeof value === 'string' ? value : String(value ?? ''), native: true };
    }
    const sel = isFocusedTarget ? 'null' : JSON.stringify(String(selector));
    const n = Number(nth) || 0;
    const value = JSON.stringify(chunk);
    const appendFlag = doAppend ? 'true' : 'false';
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const sel = ${sel};
      const els = sel ? __unblink_find_elements(sel) : [];
      let el = els[${n}] || document.activeElement;
      if (!el || el === document.body) {
        const active = document.activeElement;
        if (active && active !== document.body) {
          el = active;
        } else {
          el = document.querySelector('textarea, input[name="q"], input:not([type="hidden"]), [contenteditable="true"], [role="searchbox"]') || document.activeElement;
        }
      }
      if (!el) return JSON.stringify({ ok: false, error: 'not found' });
      try { el.focus({ preventScroll: true }); } catch (_) {}
      const append = ${appendFlag};
      const chunk = ${value};
      if (el.value !== undefined) {
        const cur = String(el.value || '');
        let nextVal = '';
        let newPos = -1;
        if (append) {
          if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number' && el.selectionStart >= 0) {
            const sStart = el.selectionStart;
            const sEnd = el.selectionEnd;
            nextVal = cur.slice(0, sStart) + chunk + cur.slice(sEnd);
            newPos = sStart + chunk.length;
          } else {
            nextVal = cur + chunk;
            newPos = nextVal.length;
          }
        } else {
          nextVal = chunk;
          newPos = chunk.length;
        }
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) {
          desc.set.call(el, nextVal);
        } else {
          el.value = nextVal;
        }
        if (newPos >= 0) {
          try { el.setSelectionRange(newPos, newPos); } catch (_) {}
        }
        for (let i = 0; i < chunk.length; i++) {
          const ch = chunk[i];
          const code = ch.charCodeAt(0);
          try {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, char: ch, keyCode: code, which: code, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, char: ch, keyCode: code, which: code, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, char: ch, keyCode: code, which: code, bubbles: true }));
          } catch (_) {}
        }
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: chunk })); } catch (_) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        if (!append) el.textContent = '';
        el.textContent = String(el.textContent || '') + chunk;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        return JSON.stringify({ ok: false, error: 'not editable' });
      }
      return JSON.stringify({
        ok: true,
        value: el.value !== undefined ? String(el.value) : String(el.innerText || el.textContent || ''),
        tag: el.tagName.toLowerCase()
      });
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (!r || !r.ok) throw new Error(`type: ${selector || 'focused element'} — ${(r && r.error) || 'failed'}`);
    return { typed: String(text ?? ''), into: selector || 'focused element', value: r.value };
  }

  async press(key, { times = 1, selector = null, nth = 0 } = {}) {
    const name = String(key || '');
    const map = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Space: { key: ' ', code: 'Space', keyCode: 32 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      Home: { key: 'Home', code: 'Home', keyCode: 36 },
      End: { key: 'End', code: 'End', keyCode: 35 },
      PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    };
    const k = map[name] || map[name === ' ' ? 'Space' : name];
    if (!k) throw new Error(`unsupported key "${name}" — supported: ${Object.keys(map).join(', ')}`);
    if (!this.engine) await this.getInfo().catch(() => {});
    if (selector) await this.click(selector, nth);
    const n = Math.max(1, Number(times) || 1);
    // Windows Gecko intentionally has no DOM/script bridge. Its control adapter
    // does expose real native keyboard input, so use that rather than making the
    // AI browser mysteriously lose keys on Windows.
    if (process.platform === 'win32' && /Gecko|Firefox/i.test(this.engine)) {
      for (let i = 0; i < n; i++) await this.nativeControl('key', { key: name });
      return { pressed: name, times: n, native: true };
    }
    const isWebKitGTK = /WebKitGTK/i.test(this.engine || '');
    if (await this.hasNativeInput() && !isWebKitGTK) {
      const before = name === 'Enter' ? await this.currentHref() : '';
      for (let i = 0; i < n; i++) await this.nativeControl('key', { key: name });
      await sleep(200);
      if (name !== 'Enter') return { pressed: name, times: n, native: true };
      const submitted = await this.completeSubmit(before);
      return { pressed: name, times: n, native: true, ...submitted };
    }
    const payload = JSON.stringify(k);
    for (let i = 0; i < n; i++) {
      await this.evalScript(`(() => {
        const k = ${payload};
        let t = document.activeElement;
        if (!t || t === document.body) {
          t = document.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"], [role="searchbox"]') || document.body;
        }
        for (const type of ['keydown', 'keypress', 'keyup']) {
          t.dispatchEvent(new KeyboardEvent(type, {
            key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
            bubbles: true, cancelable: true
          }));
        }
        if (k.key === 'Backspace' && t && t.value !== undefined) {
          const cur = String(t.value || '');
          let sStart = typeof t.selectionStart === 'number' ? t.selectionStart : cur.length;
          let sEnd = typeof t.selectionEnd === 'number' ? t.selectionEnd : cur.length;
          let nextVal = cur;
          let newPos = sStart;
          if (sStart !== sEnd) {
            nextVal = cur.slice(0, sStart) + cur.slice(sEnd);
            newPos = sStart;
          } else if (sStart > 0) {
            nextVal = cur.slice(0, sStart - 1) + cur.slice(sStart);
            newPos = sStart - 1;
          }
          if (nextVal !== cur) {
            const proto = t instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(t, nextVal); else t.value = nextVal;
            try { t.setSelectionRange(newPos, newPos); } catch (_) {}
            try { t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); } catch (_) {
              t.dispatchEvent(new Event('input', { bubbles: true }));
            }
            t.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        if (k.key === 'Delete' && t && t.value !== undefined) {
          const cur = String(t.value || '');
          let sStart = typeof t.selectionStart === 'number' ? t.selectionStart : cur.length;
          let sEnd = typeof t.selectionEnd === 'number' ? t.selectionEnd : cur.length;
          let nextVal = cur;
          if (sStart !== sEnd) {
            nextVal = cur.slice(0, sStart) + cur.slice(sEnd);
          } else if (sStart < cur.length) {
            nextVal = cur.slice(0, sStart) + cur.slice(sStart + 1);
          }
          if (nextVal !== cur) {
            const proto = t instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(t, nextVal); else t.value = nextVal;
            try { t.setSelectionRange(sStart, sStart); } catch (_) {}
            try { t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentForward' })); } catch (_) {
              t.dispatchEvent(new Event('input', { bubbles: true }));
            }
            t.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        if (k.key === 'Enter' && t) {
          if (t.form && typeof t.form.requestSubmit === 'function') {
            try { t.form.requestSubmit(); } catch { try { t.form.submit(); } catch {} }
          } else if (t.form && typeof t.form.submit === 'function') {
            try { t.form.submit(); } catch {}
          } else {
            const container = (t.closest ? t.closest('form, div, section, [role="search"], [role="combobox"]') : null);
            const btn = container ? container.querySelector('button[type="submit"], input[type="submit"], [aria-label*="Search" i], button[aria-label*="search" i]') : null;
            if (btn && typeof btn.click === 'function') try { btn.click(); } catch {}
          }
        }
        return true;
      })()`);
    }
    await sleep(120);
    return { pressed: name, times: n };
  }

  // Lay the page out at the size the viewer actually is. Without this every page
  // rendered at the window's creation size and got squashed into whatever shape
  // the pane was, and click coordinates were scaled off a size nobody had.
  // deltaY POSITIVE scrolls DOWN, matching the DOM wheel event, so a caller can
  // hand its wheel delta straight through without flipping a sign. Returns where
  // the page actually ended up: "scrolled" with nothing moving is the sort of
  // quiet success that hides a broken pane.
  // `light` skips the before/after position reads and the settle. The agent wants
  // proof the page moved; a viewer dragging its wheel wants the scroll to happen
  // now, and paying two extra round trips plus 80ms per notch to compute a `moved`
  // flag nobody reads is most of the lag between the wheel and the picture.
  async scroll(deltaX = 0, deltaY = 0, { light = false } = {}) {
    const dx = Math.round(Number(deltaX) || 0);
    const dy = Math.round(Number(deltaY) || 0);
    if (light) {
      if (await this.hasNativeInput()) await this.nativeControl('scroll', { deltaX: dx, deltaY: dy });
      else await this.evalScript(`(() => { window.scrollBy(${dx}, ${dy}); return true; })()`);
      return { deltaX: dx, deltaY: dy, light: true };
    }
    const before = await this.scrollPos();
    if (await this.hasNativeInput()) {
      await this.nativeControl('scroll', { deltaX: dx, deltaY: dy });
    } else {
      await this.evalScript(`(() => { window.scrollBy(${dx}, ${dy}); return true; })()`);
    }
    await sleep(80);
    const after = await this.scrollPos();
    return { deltaX: dx, deltaY: dy, from: before, to: after, moved: before.y !== after.y || before.x !== after.x };
  }

  async drag(from, to, opts = {}) {
    const steps = Math.max(2, Math.min(60, Number(opts.steps) || 12));
    const delayMs = Math.max(5, Math.min(200, Number(opts.delayMs) || 16));

    let fromX = 0, fromY = 0, fromSel = null;
    if (typeof from === 'object' && from !== null && from.x !== undefined && from.y !== undefined) {
      fromX = Number(from.x);
      fromY = Number(from.y);
    } else if (typeof from === 'string') {
      fromSel = from;
      const b = await this.elementBox(from, Number(opts.fromNth) || 0).catch((e) => { throw new Error(`drag (from): ${e.message}`); });
      fromX = b.x;
      fromY = b.y;
    } else {
      throw new Error('drag: "from" must be a selector string or { x, y } coordinate object');
    }

    let toX = 0, toY = 0, toSel = null;
    if (typeof to === 'object' && to !== null && to.x !== undefined && to.y !== undefined) {
      toX = Number(to.x);
      toY = Number(to.y);
    } else if (typeof to === 'string') {
      toSel = to;
      const b = await this.elementBox(to, Number(opts.toNth) || 0).catch((e) => { throw new Error(`drag (to): ${e.message}`); });
      toX = b.x;
      toY = b.y;
    } else {
      throw new Error('drag: "to" must be a selector string or { x, y } coordinate object');
    }

    const payload = JSON.stringify({
      fromX: Math.round(fromX),
      fromY: Math.round(fromY),
      toX: Math.round(toX),
      toY: Math.round(toY),
      fromSel,
      toSel,
      steps,
      delayMs,
    });

    const js = `(() => {
      const { fromX, fromY, toX, toY, fromSel, toSel, steps } = ${payload};
      
      const startEl = fromSel ? document.querySelector(fromSel) : document.elementFromPoint(fromX, fromY);
      if (!startEl) return JSON.stringify({ ok: false, error: 'Start element not found at ' + fromX + ',' + fromY });
      
      const endEl = toSel ? document.querySelector(toSel) : document.elementFromPoint(toX, toY);

      let dataTransfer = null;
      try {
        dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', (startEl && (startEl.id || startEl.innerText || 'dragged-item')) || 'drag');
        dataTransfer.effectAllowed = 'all';
        dataTransfer.dropEffect = 'move';
      } catch (e) {}

      const dispatchMouse = (el, type, x, y, buttons) => {
        if (!el) return;
        const opts = {
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y,
          button: 0, buttons: buttons, which: 1, pointerId: 1, isPrimary: true
        };
        try { el.dispatchEvent(new PointerEvent('pointer' + type.replace('mouse', ''), opts)); } catch {}
        try { el.dispatchEvent(new MouseEvent(type, opts)); } catch {}
      };

      const dispatchDrag = (el, type, x, y) => {
        if (!el) return;
        const opts = {
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y, screenX: x, screenY: y,
          dataTransfer: dataTransfer
        };
        try { el.dispatchEvent(new DragEvent(type, opts)); } catch {}
      };

      startEl.focus?.({ preventScroll: true });
      dispatchMouse(startEl, 'mousedown', fromX, fromY, 1);
      dispatchDrag(startEl, 'dragstart', fromX, fromY);

      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const ease = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
        const curX = Math.round(fromX + (toX - fromX) * ease);
        const curY = Math.round(fromY + (toY - fromY) * ease);

        const underPoint = document.elementFromPoint(curX, curY) || startEl;
        dispatchMouse(underPoint, 'mousemove', curX, curY, 1);
        dispatchDrag(underPoint, 'drag', curX, curY);
        dispatchDrag(underPoint, 'dragover', curX, curY);
        if (i === 1 && underPoint !== startEl) {
          dispatchDrag(underPoint, 'dragenter', curX, curY);
        }
      }

      const dropTarget = toSel ? document.querySelector(toSel) : (document.elementFromPoint(toX, toY) || endEl || startEl);
      if (dropTarget) {
        dispatchDrag(dropTarget, 'dragover', toX, toY);
        dispatchDrag(dropTarget, 'drop', toX, toY);
        dispatchMouse(dropTarget, 'mouseup', toX, toY, 0);
        dispatchMouse(dropTarget, 'click', toX, toY, 0);
      }
      dispatchDrag(startEl, 'dragend', toX, toY);
      dispatchMouse(startEl, 'mouseup', toX, toY, 0);

      return JSON.stringify({
        ok: true,
        from: { x: fromX, y: fromY, tag: startEl.tagName.toLowerCase() },
        to: { x: toX, y: toY, tag: dropTarget ? dropTarget.tagName.toLowerCase() : 'unknown' }
      });
    })()`;

    const res = await this.evalJson(js);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (!r || !r.ok) throw new Error(`drag: ${(r && r.error) || 'failed to complete drag and drop'}`);
    await sleep(200);
    return { dragged: true, from: r.from, to: r.to, steps, delayMs };
  }

  // Change ONLY the capture density, reusing the remembered viewport size. The
  // stream drops to 1x while the page moves — a 2x frame is 4x the pixels to render
  // AND ~4x the time to decode in the viewer, which is what made motion crawl — and
  // upgrades to the pane's real dpr once the page settles, so a still page is crisp.
  async setStreamScale(dpr) {
    const v = this.viewport;
    if (!v || !v.width) return null;
    const d = Number(dpr) || 1;
    if (v.dpr === d) return v;
    const keep = this.desiredDpr;
    const out = await this.setViewport(v.width, v.height, d);
    this.desiredDpr = keep;  // a stream-driven density change is not a new viewer intent
    return out;
  }

  // A frame as raw BYTES, for a streaming viewer. runAction('frame') base64s it for
  // JSON, which is a third more bytes plus a decode on both ends — pointless when
  // the transport can carry binary.
  async frameBuffer() {
    const file = path.join(os.tmpdir(), `unblink-stream-${this.instanceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
    try {
      const shot = await this.takeScreenshot(file, 0);
      if (!shot || shot.status !== 'ok') return null;
      const buf = fs.readFileSync(file);
      if (!buf.length) return null;
      return { buf, pixels: pngSize(buf), url: this.lastUrl, title: this.lastTitle, viewport: this.viewport || null };
    } catch {
      return null;
    } finally {
      try { fs.unlinkSync(file); } catch { /* ignore cleanup failure */ }
    }
  }

  // What the PAGE logged, from the engine's document-start hook. Returns an empty
  async injectConsoleHook() {
    return this.evalScript(`(() => {
      if (window.__convergeLogs) return true;
      var logs = [];
      window.__convergeLogs = logs;
      var push = function (type, text) {
        if (logs.length > 400) logs.shift();
        logs.push({ type: type, text: String(text).slice(0, 2000), t: Date.now() });
      };
      var fmt = function (args) {
        return Array.prototype.map.call(args, function (a) {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
      };
      ['log', 'info', 'warn', 'error', 'debug'].forEach(function (name) {
        var orig = console[name];
        console[name] = function () {
          push(name, fmt(arguments));
          if (orig) try { orig.apply(console, arguments); } catch (e) {}
        };
      });
      window.addEventListener('error', function (e) {
        push('pageerror', (e && e.message) || 'script error');
      });
      window.addEventListener('unhandledrejection', function (e) {
        push('pageerror', 'unhandled rejection: ' + ((e && e.reason && (e.reason.message || e.reason)) || '?'));
      });
      return true;
    })()`).catch(() => false);
  }

  // Read the page console. If the custom-browser binary was built without the
  // document-start hook, attempt lazy in-page hook injection so calls do not
  // hard crash.
  async consoleLogs({ errorsOnly = false, max = 200, clear = false, strict = false } = {}) {
    let raw = await this.evalJson('(()=>{if(!window.__convergeLogs)return JSON.stringify({hook:false,logs:[]});return JSON.stringify({hook:true,logs:window.__convergeLogs})})()')
      .catch(() => null);
    let p = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
    if (!p || !p.hook) {
      await this.injectConsoleHook();
      raw = await this.evalJson('(()=>{if(!window.__convergeLogs)return JSON.stringify({hook:false,logs:[]});return JSON.stringify({hook:true,logs:window.__convergeLogs})})()')
        .catch(() => null);
      p = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
      if (!p || !p.hook) {
        if (strict) throw new Error('console capture is not installed in this Unblink build — rebuild custom-browser');
        return [];
      }
    }
    let logs = Array.isArray(p.logs) ? p.logs : [];
    if (errorsOnly) logs = logs.filter((l) => l.type === 'error' || l.type === 'warn' || l.type === 'pageerror');
    logs = logs.slice(-Math.max(1, Number(max) || 200));
    // Same buffer the Chrome-CDP path's own `clear` empties (browser-mcp's
    // BROWSER.logs.length = 0) — without this the Unblink path silently
    // ignored the flag, so a second read-and-clear still returned the first
    // read's entries, hiding a real new error among stale ones.
    if (clear) await this.evalScript('(()=>{if(window.__convergeLogs)window.__convergeLogs.length=0;return true})()').catch(() => {});
    return logs;
  }

  async injectNetworkHook() {
    return this.evalScript(`(() => {
      if (window.__unblink_network_hooked) return;
      window.__unblink_network_hooked = true;
      window.__unblink_requests = [];

      // --- fetch ---
      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = async function(...args) {
          const start = Date.now();
          const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
          let requestHeaders = {};
          const initHeaders = (args[1] && args[1].headers) || (args[0] && args[0].headers);
          if (initHeaders) {
            try {
              if (typeof initHeaders.entries === 'function') {
                for (const [k, v] of initHeaders.entries()) requestHeaders[k] = v;
              } else {
                Object.assign(requestHeaders, initHeaders);
              }
            } catch {}
          }
          const requestBody = (args[1] && args[1].body != null) ? String(args[1].body) : null;
          const rec = { type: 'fetch', url, method, start, status: 0, duration: 0,
                        requestHeaders, requestBody, responseHeaders: {}, responseBody: null };
          window.__unblink_requests.push(rec);
          if (window.__unblink_requests.length > 500) window.__unblink_requests.shift();
          try {
            const res = await origFetch.apply(this, args);
            rec.status = res.status;
            rec.duration = Date.now() - start;
            try { res.headers.forEach((v, k) => { rec.responseHeaders[k] = v; }); } catch {}
            try { res.clone().text().then(t => { rec.responseBody = t; }).catch(() => {}); } catch {}
            return res;
          } catch (e) {
            rec.error = e.message;
            rec.duration = Date.now() - start;
            throw e;
          }
        };
      }

      // --- XHR ---
      const origXhrOpen      = XMLHttpRequest.prototype.open;
      const origXhrSend      = XMLHttpRequest.prototype.send;
      const origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

      XMLHttpRequest.prototype.open = function(method, url) {
        this.__unblink_rec = {
          type: 'xhr', method, url, start: Date.now(),
          status: 0, duration: 0,
          requestHeaders: {}, requestBody: null,
          responseHeaders: {}, responseBody: null,
        };
        return origXhrOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (this.__unblink_rec) this.__unblink_rec.requestHeaders[name] = value;
        return origXhrSetHeader.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        if (this.__unblink_rec) {
          const rec = this.__unblink_rec;
          if (body != null) rec.requestBody = String(body);
          window.__unblink_requests.push(rec);
          if (window.__unblink_requests.length > 500) window.__unblink_requests.shift();
          this.addEventListener('loadend', () => {
            rec.status   = this.status;
            rec.duration = Date.now() - rec.start;
            try {
              (this.getAllResponseHeaders() || '').trim().split(/\r?\n/).forEach(line => {
                const idx = line.indexOf(':');
                if (idx > 0) rec.responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
              });
            } catch {}
            rec.responseBody = this.responseText;
          });
        }
        return origXhrSend.apply(this, arguments);
      };

      return true;
    })()`).catch(() => {});
  }

  async networkRequests({ clear = false, filter = '' } = {}) {
    const raw = await this.evalJson('(() => JSON.stringify(window.__unblink_requests || []))()').catch(() => '[]');
    let list = Array.isArray(raw) ? raw : (() => { try { return JSON.parse(raw); } catch { return []; } })();
    if (filter) {
      const q = String(filter).toLowerCase();
      list = list.filter(r => (r.url || '').toLowerCase().includes(q) || (r.method || '').toLowerCase().includes(q));
    }
    if (clear) await this.evalScript('window.__unblink_requests = []; true').catch(() => {});
    return list;
  }

  async setExtraHttpHeaders(headers = {}) {
    this.customHeaders = { ...this.customHeaders, ...headers };
    const hJson = JSON.stringify(this.customHeaders);
    return this.evalScript(`(() => {
      window.__unblink_custom_headers = ${hJson};
      const curHeaders = ${hJson};
      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function(input, init = {}) {
          init.headers = Object.assign({}, curHeaders, init.headers || {});
          return origFetch(input, init);
        };
      }
    })()`).catch(() => {});
  }

  async setUserAgent(ua) {
    this.userAgent = String(ua || '');
    return this.evalScript(`(() => {
      try {
        Object.defineProperty(navigator, 'userAgent', { get: () => ${JSON.stringify(this.userAgent)}, configurable: true });
      } catch (_) {}
    })()`).catch(() => {});
  }

  async emulateDevice(device) {
    const presets = {
      'iPhone 15': { width: 393, height: 852, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
      'iPhone 15 Pro Max': { width: 430, height: 932, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
      'Pixel 8': { width: 412, height: 915, dpr: 2.625, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Mobile Safari/537.36' },
      'iPad Pro': { width: 1024, height: 1366, dpr: 2, ua: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
      'Desktop 1080p': { width: 1920, height: 1080, dpr: 1, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36' },
      'Desktop 4K': { width: 3840, height: 2160, dpr: 2, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36' },
    };
    const spec = typeof device === 'string' ? (presets[device] || { width: 1280, height: 800, dpr: 1 }) : device;
    this.viewport = { width: spec.width, height: spec.height, dpr: spec.dpr || 1 };
    if (spec.ua) this.userAgent = spec.ua;
    if (this.running) {
      if (spec.width && spec.height) await this.setViewport(spec.width, spec.height, spec.dpr || 1);
      if (spec.ua) await this.setUserAgent(spec.ua);
    }
    return { ok: true, device: typeof device === 'string' ? device : 'custom', viewport: this.viewport, userAgent: this.userAgent, ...spec };
  }

  async extractTable(selector = 'table', nth = 0) {
    const sel = JSON.stringify(String(selector));
    const n = Number(nth) || 0;
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const table = els[${n}];
      if (!table) return JSON.stringify({ ok: false, error: 'table not found' });
      const headers = [];
      const ths = table.querySelectorAll('th');
      if (ths.length) {
        for (const th of ths) headers.push((th.innerText || th.textContent || '').trim());
      }
      const rows = [];
      const trs = table.querySelectorAll('tbody tr, tr');
      for (const tr of trs) {
        if (tr.querySelector('th') && !tr.querySelector('td')) continue;
        const cells = Array.from(tr.querySelectorAll('td, th')).map(c => (c.innerText || c.textContent || '').trim());
        if (cells.length) {
          if (headers.length === cells.length) {
            const obj = {};
            headers.forEach((h, i) => { obj[h || ('col_' + i)] = cells[i]; });
            rows.push(obj);
          } else {
            rows.push(cells);
          }
        }
      }
      return JSON.stringify({ ok: true, headers, rowCount: rows.length, rows });
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (!r || !r.ok) throw new Error(`extractTable: ${(r && r.error) || 'failed to extract table'}`);
    return r;
  }

  async extractForms(selector = null) {
    const sel = selector ? JSON.stringify(String(selector)) : 'null';
    const res = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const forms = ${sel} ? __unblink_find_elements(${sel}) : Array.from(document.querySelectorAll('form'));
      const out = [];
      for (const f of forms) {
        const formObj = {
          id: f.id || null,
          name: f.name || null,
          action: f.action || '',
          method: (f.method || 'GET').toUpperCase(),
          fields: []
        };
        const elements = Array.from(f.elements || f.querySelectorAll('input, select, textarea, button'));
        for (const el of elements) {
          if (!el.name && !el.id) continue;
          formObj.fields.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || el.id,
            value: el.type === 'password' ? '********' : (el.value || ''),
            checked: el.checked !== undefined ? el.checked : null,
            required: !!el.required,
            placeholder: el.placeholder || null,
            disabled: !!el.disabled
          });
        }
        out.push(formObj);
      }
      return JSON.stringify({ ok: true, count: out.length, forms: out });
    })()`);
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    return r || { ok: false, forms: [] };
  }

  async scrollPos() {
    const raw = await this.evalJson('(()=>{const e=document.scrollingElement||document.documentElement;return JSON.stringify({x:Math.round(e.scrollLeft||0),y:Math.round(e.scrollTop||0),max:Math.round(e.scrollHeight||0)})})()')
      .catch(() => null);
    const p = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
    return p && typeof p === 'object' ? p : { x: 0, y: 0, max: 0 };
  }

  // The 240x180 floor is about a viewport a PERSON has to use, so it does not
  // apply to an offscreen capture: the engine resizes and snapshots correctly
  // well below it (measured 192x192 and 180x180, exact). Applying it to renders
  // silently produced icons at the window's default 1280x800 instead, because
  // the throw was caught and discarded — wrong pixels at whatever size the
  // caller happened to check for.
  async setViewport(width, height, dpr = 0, { allowBelowPaneMinimum = false } = {}) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    if (w < 1 || h < 1) throw new Error(`resize: ${w}x${h} is not a size`);
    if (!allowBelowPaneMinimum && (w < 240 || h < 180)) throw new Error(`resize: ${w}x${h} is too small`);
    const scale = Number(dpr) > 0 ? Number(dpr) : undefined;
    const res = await this.sendRPC({ method: 'resize', width: w, height: h, dpr: scale });
    let vp = res && res.viewport;
    if (typeof vp === 'string') { try { vp = JSON.parse(vp); } catch { vp = null; } }
    const out = Array.isArray(vp)
      ? { width: vp[0], height: vp[1], dpr: vp[2] }
      : { width: w, height: h, dpr: null };
    this.viewport = out;
    // The density the VIEWER actually wants, remembered apart from the active
    // capture density so the stream can drop to 1x for motion and still know what
    // to restore to for a crisp still.
    if (Number(dpr) > 0) this.desiredDpr = Number(dpr);
    return out;
  }

  // Desktop viewers only: hand the browser the pane's rect on screen and it puts
  // its own window there, so the operator is on the engine instead of on a picture
  // of it — no capture, no encode, no decode, no latency floor, and the display's
  // real density. Rect is screen DIP with a top-left origin, which is what
  // Electron's getContentBounds already reports. Callers must treat a false return
  // as "keep streaming"; every non-macOS backend returns exactly that.
  async present(x, y, width, height, parentPid = 0) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    if (w < 240 || h < 180) throw new Error(`present: ${w}x${h} is too small`);
    const res = await this.sendRPC({
      method: 'present',
      on: true,
      x: Math.round(Number(x) || 0),
      y: Math.round(Number(y) || 0),
      width: w,
      height: h,
      parentPid: Math.round(Number(parentPid) || 0),
    });
    // A bare false tells a viewer nothing about whether the platform declined or
    // the rect was rejected, and it has to explain itself to the operator.
    if (!res || res.status !== 'ok') throw new Error(`present rejected by the engine: ${JSON.stringify(res)}`);
    this.presented = !!res.presented;
    // Acknowledged but not taken is not a "no": it means the request and the reply
    // disagree, and reporting it as a plain false hides that from the viewer.
    if (!this.presented) throw new Error(`present acknowledged without a surface: ${JSON.stringify(res)}`);
    return this.presented;
  }

  async unpresent() {
    const res = await this.sendRPC({ method: 'present', on: false });
    this.presented = !!(res && res.presented);
    return !this.presented;
  }

  // Poll, never a fixed sleep. A Google SERP took ~3s to land here, and a hard
  // wait shorter than that reported "did not navigate" on a navigation that was
  // simply still in flight — then fired a redundant second one on top of it.
  async waitForHrefChange(before, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(250);
      const now = await this.currentHref();
      if (now && now !== before) return now;
    }
    return null;
  }

  async currentHref() {
    const v = await this.evalJson('location.href').catch(() => '');
    return typeof v === 'string' ? v : String(v ?? '');
  }

  // A real Enter is not always enough. Google's home page, for one, swallows Enter
  // in a capture-phase handler AND no-ops requestSubmit(), so a genuine keypress
  // leaves the query sitting in the box. This finishes what Enter asked for by
  // navigating to the URL the form itself describes — the browser's own default
  // action, which the page suppressed. It reports HOW it got there so nobody
  // reads "pressed Enter" as proof the site's own handler ran.
  async completeSubmit(hrefBefore) {
    if (!hrefBefore) return {};
    if (await this.waitForHrefChange(hrefBefore, 1500)) return { navigated: true, via: 'keypress' };
    const raw = await this.evalJson(`(() => {
      const el = document.activeElement;
      const form = el && el.form;
      if (!form) return JSON.stringify({ can: false, why: 'focused element is not in a form' });
      const method = String(form.method || 'get').toLowerCase();
      if (method !== 'get') return JSON.stringify({ can: false, why: 'form is ' + method + ', not get' });
      const build = (visibleOnly) => {
        const params = new URLSearchParams();
        for (const f of Array.from(form.elements)) {
          if (!f.name || f.disabled) continue;
          if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) continue;
          if (f.type === 'submit' || f.type === 'button' || f.type === 'file') continue;
          if (visibleOnly && f.type === 'hidden') continue;
          params.append(f.name, f.value == null ? '' : String(f.value));
        }
        const url = new URL(form.action || location.href, location.href);
        url.search = params.toString();
        return url.href;
      };
      return JSON.stringify({ can: true, url: build(false), plain: build(true) });
    })()`).catch(() => null);
    const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!plan || !plan.can) return { navigated: false, submitBlocked: (plan && plan.why) || 'unknown' };
    await this.navigate(plan.url);
    const landed = await this.waitForHrefChange(hrefBefore, 8000);
    if (landed) return { navigated: true, via: 'form-action', url: landed };
    // Still where we started means the site rejected its own payload — its hidden
    // fields carry single-use tokens its JS had already spent. Retry with only what
    // the person actually filled in.
    if (plan.plain && plan.plain !== plan.url) {
      await this.navigate(plan.plain);
      const plain = await this.waitForHrefChange(hrefBefore, 8000);
      if (plain) return { navigated: true, via: 'form-action-plain', url: plain };
    }
    return { navigated: false, submitBlocked: 'form action did not navigate' };
  }

  async hotkey(action) {
    return this.sendRPC({ method: 'hotkey', action: String(action || '') });
  }

  async waitFor({ selector, text, gone = false, urlContains, timeoutMs = 10000, nth = 0 } = {}) {
    const start = Date.now();
    const limit = Math.max(200, Number(timeoutMs) || 10000);
    let last = null;
    while (Date.now() - start < limit) {
      last = await this._checkCondition({ selector, text, gone, urlContains, nth });
      if (last.ok) return { ms: Date.now() - start, ...last };
      await sleep(150);
    }
    throw new Error(`wait_for timed out after ${limit}ms — ${last && last.reason ? last.reason : 'condition not met'}`);
  }

  async assertPage(opts = {}) {
    const r = await this._checkCondition(opts);
    if (!r.ok) throw new Error(`assert failed — ${r.reason}`);
    return r;
  }

  async _checkCondition({ selector, text, gone = false, urlContains, titleContains, count, minCount, noConsoleErrors = false, nth = 0 } = {}) {
    const state = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const out = {
        url: location.href || '',
        title: document.title || '',
        bodyText: (document.body ? document.body.innerText || '' : '')
      };
      ${selector ? `const els = __unblink_find_elements(${JSON.stringify(String(selector))});
      out.matchCount = els.length;
      const el = els[${Number(nth) || 0}];
      out.hasMatch = !!el;
      if (el) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
        out.elText = (el.innerText || el.textContent || '').slice(0, 2000);
      }` : 'out.matchCount = 0; out.hasMatch = false;'}
      return JSON.stringify(out);
    })()`);
    const s = typeof state === 'string' ? JSON.parse(state) : (state || {});
    if (s.url) this.lastUrl = s.url;
    if (s.title) this.lastTitle = s.title;

    const reasons = [];
    if (urlContains && !(s.url || '').includes(String(urlContains))) reasons.push(`url does not contain ${urlContains}`);
    if (titleContains && !(s.title || '').includes(String(titleContains))) reasons.push(`title does not contain ${titleContains}`);
    if (selector) {
      if (gone) {
        if (s.hasMatch && s.visible) reasons.push(`selector ${selector} is still visible`);
      } else if (!s.hasMatch) {
        reasons.push(`selector ${selector} not found`);
      } else if (s.visible === false) {
        reasons.push(`selector ${selector} not visible`);
      }
    }
    if (text != null && text !== '') {
      const hay = selector ? (s.elText || '') : (s.bodyText || '');
      const has = hay.includes(String(text));
      if (gone ? has : !has) reasons.push(gone ? `text still present: ${text}` : `text missing: ${text}`);
    }
    if (count != null && Number(s.matchCount) !== Number(count)) reasons.push(`count ${s.matchCount} != ${count}`);
    if (minCount != null && Number(s.matchCount) < Number(minCount)) reasons.push(`count ${s.matchCount} < ${minCount}`);
    // Advertised by assert, so it has to actually look. A build with no capture
    // throws from consoleLogs rather than passing this on an empty list — an
    // assertion that cannot fail is worse than no assertion.
    if (noConsoleErrors) {
      const errs = await this.consoleLogs({ errorsOnly: true, max: 50 });
      const hard = errs.filter((l) => l.type === 'error' || l.type === 'pageerror');
      if (hard.length) reasons.push(`${hard.length} console error(s): ${hard.slice(0, 3).map((l) => l.text.slice(0, 90)).join(' | ')}`);
    }

    return {
      ok: reasons.length === 0,
      reason: reasons.join('; ') || 'held',
      url: s.url,
      title: s.title,
      matches: s.matchCount,
    };
  }

  async readText({ selector = null, nth = 0, max = 4000 } = {}) {
    const m = Number(max) || 4000;
    if (!selector) {
      const s = await this.snapshot(m);
      return { text: s.text || '' };
    }
    const sel = JSON.stringify(String(selector));
    const n = Number(nth) || 0;
    const text = await this.evalJson(`(() => {
      ${LOCATOR_HELPER_JS}
      const els = __unblink_find_elements(${sel});
      const el = els[${n}];
      if (!el) return '';
      return String(el.innerText || el.textContent || '').slice(0, ${m});
    })()`);
    return { text: String(text || '') };
  }

  async clickAt(x, y) {
    if (!this.engine) await this.getInfo().catch(() => {});
    // This is the OPERATOR clicking in the pane. A synthesized MouseEvent moves no
    // caret and gives the page no trusted click, so clicking a field and typing did
    // nothing — the same defect the agent path had.
    if (await this.hasNativeInput()) {
      await this.nativeControl('click', { x: Number(x) || 0, y: Number(y) || 0 });
      return { x: Number(x) || 0, y: Number(y) || 0, native: true };
    }
    if (process.platform === 'win32' && /Gecko|Firefox/i.test(this.engine)) {
      await this.nativeControl('click', { x: Number(x) || 0, y: Number(y) || 0 });
      return { x: Number(x) || 0, y: Number(y) || 0, native: true };
    }
    await this.evalScript(`(() => {
      let target = document.elementFromPoint(${Number(x) || 0}, ${Number(y) || 0}) || document.body;
      if (!target) return false;
      const interactive = target.closest('button, a, input, select, textarea, [tabindex], [role="button"], [role="combobox"], [role="searchbox"]');
      let el = interactive || target;
      if (el && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) {
        const childInput = el.querySelector('textarea, input[name="q"], input:not([type="hidden"]), [contenteditable="true"], [role="searchbox"]');
        if (childInput) {
          el = childInput;
        } else {
          const container = el.closest('form, [role="combobox"], [role="search"], div');
          if (container) {
            const formInput = container.querySelector('textarea, input[name="q"], input:not([type="hidden"]), [contenteditable="true"]');
            if (formInput) el = formInput;
          }
        }
      }
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ${Number(x) || 0}, clientY: ${Number(y) || 0} }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ${Number(x) || 0}, clientY: ${Number(y) || 0} }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: ${Number(x) || 0}, clientY: ${Number(y) || 0} }));
      try { el.focus({ preventScroll: true }); } catch {}
      return true;
    })()`);
    return { x: Number(x) || 0, y: Number(y) || 0 };
  }

  async autofill(urlOrDomain = null) {
    const targetUrl = urlOrDomain || this.lastUrl || '';
    const cred = getDomainCredential(targetUrl);
    if (!cred || !cred.username) {
      return { ok: false, filled: false, error: 'No saved credentials for this domain' };
    }
    const user = JSON.stringify(cred.username);
    const pass = JSON.stringify(cred.password || '');
    const res = await this.evalJson(`(() => {
      const uVal = ${user};
      const pVal = ${pass};
      let uField = document.querySelector('input[type="email"], input[type="text"][name*="user" i], input[type="text"][name*="email" i], input[type="text"][name*="login" i], input[type="text"][id*="user" i], input[type="text"][id*="email" i], input[type="text"][id*="login" i], input[autocomplete*="username"], input[autocomplete*="email"]');
      let pField = document.querySelector('input[type="password"]');
      if (!uField && pField) {
        const allInputs = Array.from(document.querySelectorAll('input'));
        const pIdx = allInputs.indexOf(pField);
        if (pIdx > 0) uField = allInputs[pIdx - 1];
      }
      let filled = false;
      function setVal(el, val) {
        if (!el) return;
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        filled = true;
      }
      if (uField && uVal) setVal(uField, uVal);
      if (pField && pVal) setVal(pField, pVal);
      return { ok: true, filled, username: uVal, hasPassword: !!pVal };
    })()`).catch(() => null);
    return { ok: true, filled: !!(res && res.filled), username: cred.username, domain: cred.domain };
  }

  async injectLoginCapture() {
    return this.evalScript(`(() => {
      if (window.__unblink_login_hooked) return;
      window.__unblink_login_hooked = true;
      function grabCredentials() {
        try {
          const passInputs = Array.from(document.querySelectorAll('input[type="password"]'));
          for (const passInput of passInputs) {
            const pass = passInput.value;
            if (!pass || pass.length < 1) continue;
            let user = '';
            const form = passInput.closest('form');
            if (form) {
              const uInput = form.querySelector('input[type="text"], input[type="email"], input[type="tel"], input[autocomplete*="user"], input[autocomplete*="email"]');
              if (uInput && uInput.value) user = uInput.value;
            }
            if (!user) {
              const allInputs = Array.from(document.querySelectorAll('input'));
              const idx = allInputs.indexOf(passInput);
              if (idx > 0 && allInputs[idx - 1].value) user = allInputs[idx - 1].value;
            }
            if (user && pass) {
              window.__unblink_captured_login = {
                domain: window.location.hostname,
                username: user,
                password: pass,
                ts: Date.now(),
              };
              sessionStorage.setItem('__unblink_captured_login', JSON.stringify(window.__unblink_captured_login));
            }
          }
        } catch {}
      }
      document.addEventListener('submit', grabCredentials, true);
      document.addEventListener('click', (e) => {
        if (e.target && e.target.closest('button, input[type="submit"], [role="button"], a[href*="login"], a[href*="sign"]')) {
          grabCredentials();
        }
      }, true);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') grabCredentials();
      }, true);
    })()`).catch(() => {});
  }

  async checkLoginCapture() {
    const res = await this.evalJson(`(() => {
      try {
        let cred = window.__unblink_captured_login;
        if (!cred) {
          const raw = sessionStorage.getItem('__unblink_captured_login');
          if (raw) cred = JSON.parse(raw);
        }
        if (cred && cred.username && cred.password && !cred.reported) {
          cred.reported = true;
          window.__unblink_captured_login = cred;
          sessionStorage.setItem('__unblink_captured_login', JSON.stringify(cred));
          return cred;
        }
      } catch {}
      return null;
    })()`).catch(() => null);
    if (res && res.username && res.password) {
      const existing = getDomainCredential(res.domain);
      if (!existing || existing.password !== res.password || existing.username !== res.username) {
        return res;
      }
    }
    return null;
  }

  close() {
    if (!this.proc) return;
    try { this.proc.stdin.write(JSON.stringify({ method: 'quit' }) + '\n'); } catch {}
    const proc = this.proc;
    setTimeout(() => {
      if (!proc || proc.killed) return;
      if (process.platform === 'win32') {
        try { killTree(proc.pid, 'SIGKILL'); } catch {}
      } else {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, 250);
    this.proc = null;
  }

  stop() {
    return this.close();
  }
}

// ---------- shared session (agent + GUI + CLI + console) ----------
let SHARED = null;
let SHARED_BOOT = null;

async function getShared(opts = {}) {
  if (SHARED && SHARED.running) return SHARED;
  if (SHARED_BOOT) return SHARED_BOOT;
  SHARED_BOOT = (async () => {
    if (SHARED) { try { SHARED.close(); } catch {} SHARED = null; }
    const driver = new UnblinkDriver({
      url: opts.url || 'about:blank',
      profileDir: opts.profileDir || defaultProfileDir(),
      smokeQuitMs: 0,
      binPath: opts.binPath,
    });
    await driver.start();
    SHARED = driver;
    return driver;
  })().finally(() => { SHARED_BOOT = null; });
  return SHARED_BOOT;
}

function closeShared() {
  if (SHARED) {
    try { SHARED.close(); } catch {}
    SHARED = null;
  }
}

process.on('exit', () => { try { closeShared(); } catch {} });

// One page, rendered and reported, on a session of its OWN. Same shape cdp.cjs's
// renderOnce returns, so a caller swaps engines without changing its logic.
// Deliberately NOT the shared session: a gate or a judge that borrowed it would
// navigate the pane the operator is watching out from under them mid-check.
async function renderOnce(url, { timeoutMs = 60000, screenshot = false, width = 1000, height = 800, dpr = 1, settleMs = 400 } = {}) {
  const bin = findUnblinkBinary();
  if (!bin) return { ok: false, html: '', screenshot: null, error: 'unblink binary not found', logs: [] };
  const driver = new UnblinkDriver({
    profileDir: path.join(os.tmpdir(), `unblink-render-${process.pid}-${Date.now().toString(36)}`),
  });
  let shotFile = null;
  try {
    await driver.start();
    await driver.setViewport(width, height, dpr, { allowBelowPaneMinimum: true });
    await driver.navigate(url);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let ready = null;
      try { ready = await driver.evalJson('document.readyState'); } catch { ready = null; }
      if (ready === 'complete' || Date.now() > deadline) break;
      await sleep(150);
    }
    await sleep(settleMs);
    // A failed load does NOT throw here — WebKit reports it to the delegate and
    // leaves an empty document behind. Reporting ok on that let a gate with no
    // expectations "render" an unreachable host and pass. Confirm a real document
    // arrived before calling this a render.
    const landed = await driver.evalJson('JSON.stringify({href:location.href,body:(document.body&&document.body.innerHTML||"").length})')
      .catch(() => null);
    const at = typeof landed === 'string' ? (() => { try { return JSON.parse(landed); } catch { return null; } })() : landed;
    if (!at || !at.href || at.href === 'about:blank' || (!at.body && !/^about:/.test(url))) {
      return { ok: false, html: '', screenshot: null, logs: [], error: `page did not load (${url} — landed on ${(at && at.href) || 'nothing'})` };
    }
    const html = (await driver.evalJson('document.documentElement.outerHTML').catch(() => '')) || '';
    let shot = null;
    if (screenshot) {
      shotFile = path.join(os.tmpdir(), `unblink-shot-${process.pid}-${Date.now().toString(36)}.png`);
      const s = await driver.takeScreenshot(shotFile, 0).catch(() => null);
      // The FILE decides, as everywhere else: a capture that claimed ok and wrote
      // nothing is how a gate once reported evidence it did not have.
      if (s && s.status === 'ok') {
        try { if (fs.statSync(shotFile).size > 0) shot = fs.readFileSync(shotFile); } catch { shot = null; }
      }
    }
    const logs = await driver.consoleLogs({ max: 200 }).catch(() => []);
    return { ok: true, html: String(html || ''), screenshot: shot, error: null, logs };
  } catch (e) {
    return { ok: false, html: '', screenshot: null, error: e.message, logs: [] };
  } finally {
    try { driver.close(); } catch { /* already gone */ }
    if (shotFile) { try { fs.unlinkSync(shotFile); } catch { /* nothing to clear */ } }
  }
}

// Real dimensions from the FILE or BUFFER, for PNG IHDR or JPEG SOF.
function pngSize(fileOrBuf) {
  try {
    const buf = Buffer.isBuffer(fileOrBuf) ? fileOrBuf : fs.readFileSync(fileOrBuf);
    if (buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        while (i < buf.length && buf[i] === 0xFF) i++;
        if (i >= buf.length) break;
        const marker = buf[i];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          if (i + 8 < buf.length) {
            return { height: buf.readUInt16BE(i + 4), width: buf.readUInt16BE(i + 6), type: 'jpeg' };
          }
        }
        if (marker === 0xD9 || marker === 0xDA) break;
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i++; continue; }
        if (i + 2 >= buf.length) break;
        const segLen = buf.readUInt16BE(i + 1);
        if (segLen < 2) break;
        i += 1 + segLen;
      }
    }
    return null;
  } catch { return null; }
}

async function runAction(action, args = {}, opts = {}) {
  const act = String(action || '').toLowerCase();
  const helperRoot = opts.helperRoot || process.env.CONVERGE_AGENT_HOME || path.join(os.homedir(), '.converge');
  if (act === 'helper_list' || act === 'helpers') return { ok: true, action: 'helper_list', helpers: helpers.list(helperRoot, args.url || (SHARED && SHARED.lastUrl) || '') };
  if (act === 'helper_candidate') { const c = helpers.createCandidate(helperRoot, args); return { ok: true, action: act, name: c.name, domain: c.domain, replays: c.replays.length }; }
  if (act === 'helper_promote') { const p = helpers.promote(helperRoot, args.name); return { ok: true, action: act, name: p.name, version: p.version, domain: p.helper.domain }; }
  if (act === 'available' || act === 'status') {
    const bin = findUnblinkBinary();
    return {
      ok: !!bin,
      available: !!bin,
      binary: bin,
      running: !!(SHARED && SHARED.running),
      url: SHARED ? SHARED.lastUrl : null,
      title: SHARED ? SHARED.lastTitle : null,
      engine: (SHARED && SHARED.engine) || null,
      nativeInput: SHARED ? !!SHARED.nativeInput : null,
      viewport: (SHARED && SHARED.viewport) || null,
      chromium: false,
    };
  }
  if (act === 'close') {
    const last = SHARED ? SHARED.lastUrl : '';
    closeShared();
    return { ok: true, action: 'close', url: last };
  }
  if (act === 'state_export' || act === 'export_state') {
    return { ok: true, action: 'export_state', state: exportState() };
  }
  if (act === 'state_import' || act === 'import_state') {
    const res = importState(args.state || args.bundle || args, { overwrite: !!args.overwrite });
    return { ...res, action: 'import_state' };
  }

  async function execute(drv) {
    if (act === 'helper_replay') return helpers.replayCandidate(helperRoot, args.name, args.inputs || {}, (a, v) => runAction(a, v, { ...opts, driver: drv }), drv.lastUrl);
    if (act === 'helper_run') return helpers.run(helperRoot, args.name, args.inputs || {}, (a, v) => runAction(a, v, { ...opts, driver: drv }), drv.lastUrl);
    if (act === 'navigate') {
      await drv.navigate(args.url);
      const snap = await drv.snapshot();
      return { ok: true, action: 'navigate', ...snap };
    }
    if (act === 'eval') {
      const res = await drv.evalScript(args.script || args.expression || 'document.title');
      return { ok: true, action: 'eval', result: res && res.result, raw: res };
    }
    if (act === 'screenshot') {
      const out = args.path || path.join(os.tmpdir(), `unblink-${Date.now()}.png`);
      const shot = await drv.takeScreenshot(out, args.waitMs != null ? args.waitMs : 400);
      let snap = { url: drv.lastUrl, title: drv.lastTitle };
      try { snap = await drv.snapshot(200); } catch {}
      let bytes = 0;
      try { bytes = fs.statSync(out).size; } catch { bytes = 0; }
      return {
        ok: !!(shot && shot.status === 'ok' && bytes > 0),
        action: 'screenshot', path: out, bytes, ...shot,
        url: snap.url, title: snap.title,
        viewport: drv.viewport || null,
        pixels: pngSize(out),
      };
    }
    if (act === 'resize') {
      const vp = await drv.setViewport(args.width != null ? args.width : args.w,
                                         args.height != null ? args.height : args.h,
                                         args.dpr);
      return { ok: true, action: 'resize', viewport: vp };
    }
    if (act === 'get_info' || act === 'info') {
      const info = await drv.getInfo();
      const snap = await drv.snapshot(500).catch(() => ({ url: drv.lastUrl, title: drv.lastTitle }));
      return { ok: true, action: 'info', info, ...snap, engine: (info && info.engine) || 'unknown', renders: !!(info && info.renders), chromium: false };
    }
    if (act === 'snapshot' || act === 'read_page') {
      const snap = await drv.snapshot(args.max || 4000);
      return { ok: true, action: 'snapshot', ...snap };
    }
    if (act === 'click') {
      const r = await drv.click(args.selector, args.nth);
      const snap = await drv.snapshot(2000);
      return { ok: true, action: 'click', ...r, ...snap };
    }
    if (act === 'hover') {
      const r = await drv.hover(args.selector, args.nth);
      return { ok: true, action: 'hover', ...r, url: drv.lastUrl };
    }
    if (act === 'focus') {
      const r = await drv.focus(args.selector, args.nth);
      return { ok: true, action: 'focus', ...r, url: drv.lastUrl };
    }
    if (act === 'blur') {
      const r = await drv.blur(args.selector, args.nth);
      return { ok: true, action: 'blur', ...r, url: drv.lastUrl };
    }
    if (act === 'select_option' || act === 'selectoption' || act === 'select') {
      const val = args.value !== undefined ? args.value : (args.label !== undefined ? args.label : args.option);
      const r = await drv.selectOption(args.selector, val, args);
      return { ok: true, action: 'select_option', ...r, url: drv.lastUrl };
    }
    if (act === 'check' || act === 'uncheck' || act === 'set_checked') {
      const chk = act === 'uncheck' ? false : (args.checked !== undefined ? !!args.checked : true);
      const r = await drv.setChecked(args.selector, chk, args);
      return { ok: true, action: 'set_checked', ...r, url: drv.lastUrl };
    }
    if (act === 'upload_file' || act === 'set_input_files' || act === 'upload') {
      const files = args.files || args.paths || args.path || args.file;
      const r = await drv.uploadFile(args.selector, files, args);
      return { ok: true, action: 'upload_file', ...r, url: drv.lastUrl };
    }
    if (act === 'get_attribute' || act === 'attribute') {
      const r = await drv.getAttribute(args.selector, args.attribute || args.name || args.attr, args);
      return { ok: true, action: 'get_attribute', ...r, url: drv.lastUrl };
    }
    if (act === 'bounding_box' || act === 'get_bounding_box' || act === 'box') {
      const r = await drv.getBoundingBox(args.selector, args.nth);
      return { ok: true, action: 'bounding_box', box: r, url: drv.lastUrl };
    }
    if (act === 'scroll_to' || act === 'scrollto') {
      const r = await drv.scrollTo(args.target || (args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : args.selector), args);
      return { ok: true, action: 'scroll_to', ...r, url: drv.lastUrl };
    }
    if (act === 'type') {
      const r = await drv.type(args.selector, args.text, { nth: args.nth, append: !!args.append });
      return { ok: true, action: 'type', ...r, url: drv.lastUrl };
    }
    if (act === 'press') {
      const r = await drv.press(args.key, { times: args.times, selector: args.selector, nth: args.nth });
      const snap = await drv.snapshot(2000);
      return { ok: true, action: 'press', ...r, ...snap };
    }
    if (act === 'wait_for') {
      const r = await drv.waitFor(args);
      const snap = await drv.snapshot(2000);
      return { ok: true, action: 'wait_for', ...r, ...snap };
    }
    if (act === 'assert') {
      const r = await drv.assertPage(args);
      return { ok: true, action: 'assert', ...r };
    }
    if (act === 'read_text') {
      const r = await drv.readText(args);
      return { ok: true, action: 'read_text', ...r, url: drv.lastUrl };
    }
    if (act === 'click_at' || act === 'mouse') {
      const r = await drv.clickAt(args.x, args.y);
      return { ok: true, action: 'click_at', ...r, url: drv.lastUrl };
    }
    if (act === 'drag' || act === 'drag_and_drop' || act === 'drag_drop') {
      const from = args.from || (args.fromX != null && args.fromY != null ? { x: args.fromX, y: args.fromY } : args.source || args.selector);
      const to = args.to || (args.toX != null && args.toY != null ? { x: args.toX, y: args.toY } : args.target || args.destination);
      const r = await drv.drag(from, to, args);
      const snap = await drv.snapshot(2000).catch(() => ({}));
      return { ok: true, action: 'drag', ...r, ...snap };
    }
    if (act === 'hotkey' || act === 'exec_command' || /^(copy|paste|cut|select_all|undo|redo|zoom_in|zoom_out|zoom_reset)$/i.test(act)) {
      const shortcut = args.action || args.shortcut || (/^(copy|paste|cut|select_all|undo|redo|zoom_in|zoom_out|zoom_reset)$/i.test(act) ? act.toLowerCase() : 'copy');
      const res = await drv.hotkey(shortcut);
      return { ok: true, action: 'hotkey', shortcut, result: res };
    }
    if (act === 'frame') {
      const file = path.join(os.tmpdir(), `unblink-frame-${drv.instanceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
      let data = null;
      let bytes = 0;
      let buf = null;
      let shot = null;
      try {
        shot = await drv.takeScreenshot(file, 0);
        if (shot && shot.status === 'ok') {
          buf = fs.readFileSync(file);
          bytes = buf.length;
          if (bytes > 0) data = buf.toString('base64');
        }
      } catch { data = null; }
      finally {
        try { fs.unlinkSync(file); } catch { /* ignore cleanup failure */ }
      }
      return {
        ok: !!(shot && shot.status === 'ok' && data),
        action: 'frame', mime: 'image/jpeg', data, bytes,
        viewport: drv.viewport || null,
        pixels: buf ? pngSize(buf) : null,
        url: drv.lastUrl, title: drv.lastTitle,
      };
    }
    if (act === 'console_logs' || act === 'console') {
      const logs = await drv.consoleLogs({ errorsOnly: !!args.errorsOnly, max: args.max, clear: !!args.clear });
      return { ok: true, action: 'console_logs', logs, count: logs.length, url: drv.lastUrl };
    }
    if (act === 'network_requests' || act === 'network_history' || act === 'network') {
      const requests = await drv.networkRequests({ clear: !!args.clear, filter: args.filter || args.query || '' });
      return { ok: true, action: 'network_requests', count: requests.length, requests, url: drv.lastUrl };
    }
    if (act === 'set_extra_http_headers' || act === 'headers') {
      await drv.setExtraHttpHeaders(args.headers || args);
      return { ok: true, action: 'set_extra_http_headers', headers: drv.customHeaders };
    }
    if (act === 'set_user_agent' || act === 'user_agent') {
      await drv.setUserAgent(args.userAgent || args.ua || args.value);
      return { ok: true, action: 'set_user_agent', userAgent: drv.userAgent };
    }
    if (act === 'emulate_device' || act === 'device') {
      const dev = await drv.emulateDevice(args.device || args);
      return { ok: true, action: 'emulate_device', ...dev };
    }
    if (act === 'extract_table' || act === 'table') {
      const table = await drv.extractTable(args.selector || 'table', args.nth || 0);
      return { ok: true, action: 'extract_table', ...table, url: drv.lastUrl };
    }
    if (act === 'extract_forms' || act === 'forms') {
      const forms = await drv.extractForms(args.selector || null);
      return { ok: true, action: 'extract_forms', ...forms, url: drv.lastUrl };
    }
    if (act === 'scroll') {
      const r = await drv.scroll(args.deltaX != null ? args.deltaX : args.dx,
                                   args.deltaY != null ? args.deltaY : args.dy,
                                   { light: !!args.light });
      return { ok: true, action: 'scroll', ...r, url: drv.lastUrl };
    }
    if (act === 'back' || act === 'forward' || act === 'reload') {
      await drv.evalScript(`(() => { history.${act === 'reload' ? 'go(0)' : act + '()'}; return location.href; })()`);
      await sleep(NAV_SETTLE_MS);
      const snap = await drv.snapshot();
      return { ok: true, action: act, ...snap };
    }
    if (act === 'history_search' || act === 'search_history') {
      const items = searchHistory(args.query || args.q || '', Number(args.limit) || 8);
      return { ok: true, action: 'history_search', items };
    }
    if (act === 'history_list' || act === 'list_history') {
      const items = loadHistory().slice(0, Number(args.limit) || 50);
      return { ok: true, action: 'history_list', items };
    }
    if (act === 'history_clear') {
      saveHistory([]);
      return { ok: true, action: 'history_clear' };
    }
    if (act === 'credentials_save' || act === 'save_credential') {
      const res = saveDomainCredential(args.domain || args.url || drv.lastUrl, args.username || args.user, args.password || args.pass);
      return { ok: res.ok, action: 'credentials_save', ...res };
    }
    if (act === 'credentials_get' || act === 'get_credential') {
      const cred = getDomainCredential(args.domain || args.url || drv.lastUrl);
      if (!cred) return { ok: false, action: 'credentials_get', error: 'Not found' };
      return { ok: true, action: 'credentials_get', domain: cred.domain, username: cred.username, hasPassword: !!cred.password, password: cred.password };
    }
    if (act === 'credentials_list' || act === 'list_credentials') {
      const items = listDomainCredentials();
      return { ok: true, action: 'credentials_list', items };
    }
    if (act === 'credentials_delete' || act === 'delete_credential') {
      const ok = deleteDomainCredential(args.domain || args.url);
      return { ok, action: 'credentials_delete' };
    }
    if (act === 'credentials_clear' || act === 'clear_credentials') {
      const ok = clearCredentials();
      return { ok, action: 'credentials_clear' };
    }
    if (act === 'autofill') {
      const res = await drv.autofill(args.domain || args.url);
      return { ...res, action: 'autofill' };
    }
    if (act === 'bookmark_add' || act === 'add_bookmark') {
      const res = addBookmark(args.url || (SHARED && SHARED.lastUrl) || '', args.title || (SHARED && SHARED.lastTitle) || '', args.folder);
      return { ok: res.ok, action: 'bookmark_add', ...res };
    }
    if (act === 'bookmark_list' || act === 'list_bookmarks' || act === 'bookmarks') {
      const items = getBookmarks(args.folder);
      return { ok: true, action: 'bookmark_list', items };
    }
    if (act === 'bookmark_delete' || act === 'delete_bookmark' || act === 'remove_bookmark') {
      const ok = removeBookmark(args.id || args.url);
      return { ok, action: 'bookmark_delete' };
    }
    if (act === 'bookmark_clear' || act === 'clear_bookmarks') {
      const ok = clearBookmarks();
      return { ok, action: 'bookmark_clear' };
    }
    if (act === 'cookie_save' || act === 'save_cookie') {
      const res = saveCookie({ domain: args.domain || (SHARED && SHARED.lastUrl) || '', name: args.name, value: args.value, path: args.path, expires: args.expires, secure: args.secure, httpOnly: args.httpOnly, sameSite: args.sameSite });
      return { ok: res.ok, action: 'cookie_save', ...res };
    }
    if (act === 'cookie_get' || act === 'get_cookies' || act === 'cookies') {
      const items = getCookiesForDomain(args.domain || args.url || (SHARED && SHARED.lastUrl) || '');
      return { ok: true, action: 'cookie_get', items };
    }
    if (act === 'cookie_delete' || act === 'delete_cookie') {
      const ok = deleteCookie(args.domain || args.url || (SHARED && SHARED.lastUrl) || '', args.name);
      return { ok, action: 'cookie_delete' };
    }
    if (act === 'cookie_clear' || act === 'clear_cookies') {
      const ok = clearCookies();
      return { ok, action: 'cookie_clear' };
    }

    throw new Error(`unknown Unblink action "${action}" — use navigate|click|type|press|hover|focus|blur|select_option|check|uncheck|upload_file|get_attribute|bounding_box|scroll_to|network_requests|emulate_device|extract_table|extract_forms|export_state|import_state|hotkey|wait_for|assert|read_text|snapshot|screenshot|eval|info|close|autofill|history_search|credentials_save|bookmark_add|bookmark_list|cookie_save|cookie_get`);
  }

  const driver = opts.driver || await getShared(opts);
  try {
    return await execute(driver);
  } catch (err) {
    const isCrash = err && (
      /Unblink process is not running/i.test(err.message) ||
      /Unblink exited/i.test(err.message) ||
      /EPIPE/i.test(err.message) ||
      /ERR_STREAM_DESTROYED/i.test(err.message)
    );
    if (isCrash && !opts.driver) {
      closeShared();
      const freshDriver = await getShared(opts);
      return await execute(freshDriver);
    }
    throw err;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  let action = 'info';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--url=')) args.url = a.slice(6);
    else if (a.startsWith('--selector=')) args.selector = a.slice(11);
    else if (a.startsWith('--text=')) args.text = a.slice(7);
    else if (a.startsWith('--path=')) args.path = a.slice(7);
    else if (a.startsWith('--script=')) args.script = a.slice(9);
    else if (a.startsWith('--key=')) args.key = a.slice(6);
    else if (a.startsWith('--times=')) args.times = Number(a.slice(8));
    else if (a.startsWith('--dx=')) args.dx = Number(a.slice(5));
    else if (a.startsWith('--dy=')) args.dy = Number(a.slice(5));
    else if (a.startsWith('--width=')) args.width = Number(a.slice(8));
    else if (a.startsWith('--height=')) args.height = Number(a.slice(9));
    else if (a.startsWith('--dpr=')) args.dpr = Number(a.slice(6));
    else if (a.startsWith('--value=')) args.value = a.slice(8);
    else if (a.startsWith('--name=')) args.name = a.slice(7);
    else if (a.startsWith('--domain=')) args.domain = a.slice(9);
    else if (a.startsWith('--username=')) args.username = a.slice(11);
    else if (a.startsWith('--password=')) args.password = a.slice(11);
    else if (a.startsWith('--folder=')) args.folder = a.slice(9);
    else if (a.startsWith('--device=')) args.device = a.slice(9);
    else if (a.startsWith('--attribute=')) args.attribute = a.slice(12);
    else if (a.startsWith('--filter=')) args.filter = a.slice(9);
    else if (a.startsWith('--query=')) args.query = a.slice(8);
    else if (a.startsWith('--checked=')) args.checked = a.slice(10) === 'true';
    else if (!a.startsWith('--') && (action === 'info' || i === 0)) {
      if (/^(navigate|click|hover|focus|blur|type|press|wait_for|assert|read_text|snapshot|screenshot|eval|info|status|available|close|autofill|select_option|check|uncheck|upload_file|get_attribute|bounding_box|scroll_to|network_requests|emulate_device|extract_table|extract_forms|export_state|import_state|history_search|history_list|history_clear|credentials_save|credentials_get|credentials_list|credentials_delete|credentials_clear|bookmark_add|bookmark_list|bookmark_delete|bookmark_clear|cookie_save|cookie_get|cookie_delete|cookie_clear|back|forward|reload|scroll|drag|hotkey|frame|console_logs)$/i.test(a)) {
        action = a.toLowerCase();
      } else if (/^https?:\/\//i.test(a)) {
        action = 'navigate';
        args.url = a;
      }
    } else if (!a.startsWith('--') && !args.url && /^https?:\/\//i.test(a)) {
      args.url = a;
    }
  }
  if (action === 'navigate' && !args.url) {
    const u = argv.find((x) => /^https?:\/\//i.test(x));
    if (u) args.url = u;
  }

  if (action === 'available' || action === 'status') {
    console.log(JSON.stringify(await runAction('status'), null, 2));
    return;
  }
  if (action === 'close') {
    console.log(JSON.stringify(await runAction('close'), null, 2));
    return;
  }

  const result = await runAction(action, args);
  console.log(JSON.stringify(result, null, 2));
  if (action !== 'close' && !(SHARED && SHARED.running && process.env.UNBLINK_KEEP === '1')) {
    if (!process.env.UNBLINK_KEEP) closeShared();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[Unblink Driver Error]:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  UnblinkDriver,
  findUnblinkBinary,
  available,
  getShared,
  closeShared,
  runAction,
  renderOnce,
  defaultProfileDir,
  addHistoryEntry,
  searchHistory,
  loadHistory,
  saveHistory,
  clearHistory,
  getHistoryFile,
  saveDomainCredential,
  getDomainCredential,
  listDomainCredentials,
  deleteDomainCredential,
  clearCredentials,
  loadCredentials,
  saveCredentials,
  getCredentialsFile,
  extractDomain,
  domainMatches,
  addBookmark,
  getBookmarks,
  loadBookmarks,
  saveBookmarks,
  removeBookmark,
  clearBookmarks,
  saveCookie,
  loadCookies,
  saveCookies,
  getCookiesForDomain,
  deleteCookie,
  clearCookies,
  exportState,
  importState,
  pngSize,
};
