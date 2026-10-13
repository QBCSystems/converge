'use strict';
// The one CDP driver. Raw DevTools protocol over a WebSocket upgrade, no deps.
//
// This code used to live inside universal-agent.cjs, where only the browser tool
// could reach it. The browser validator therefore drove Chrome the other way —
// one-shot `--dump-dom` / `--screenshot=` flags — and that path is unreliable:
// on macOS it currently dies with "Trying to load the allocator multiple times",
// and because Chrome's helper processes inherit stdout, a spawnSync waiting on
// EOF never sees its own timeout fire. The same binary driven over CDP boots in
// well under a second. So both consumers now share this module: the tool keeps
// its persistent session, the validator gets renderOnce(), and neither can drift
// from the other or lose the stealth patches below.
//
// Server frames can exceed 64KB (screenshots) and arrive fragmented, so the
// reader handles 8-byte lengths and continuation frames.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { killTree: killProcessTree } = require('./kill-tree.cjs');

// Plain --headless=new Chrome fingerprints as automated (navigator.webdriver,
// missing chrome.runtime, the headless permissions-query quirk) — exactly what
// Akamai/PerimeterX-class bot detection on Amazon/Walmart/Target gates on.
// These are the standard, well-known evasions (same set puppeteer-extra-plugin-
// stealth ships); real fix is patching the fingerprint, not the Chrome binary.
const STEALTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const STEALTH_SCRIPT = [
  "Object.defineProperty(navigator, 'webdriver', { get: () => false });",
  "Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });",
  "Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });",
  "window.chrome = window.chrome || { runtime: {} };",
  "if (window.navigator.permissions) { const q = navigator.permissions.query.bind(navigator.permissions); navigator.permissions.query = (p) => (p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q(p)); }",
  "const gp = WebGLRenderingContext.prototype.getParameter; WebGLRenderingContext.prototype.getParameter = function (p) { if (p === 37445) return 'Intel Inc.'; if (p === 37446) return 'Intel Iris OpenGL Engine'; return gp.call(this, p); };",
].join('\n');

function maskFrame(payloadStr) {
  const data = Buffer.from(payloadStr);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  let head;
  if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length < 65536) head = Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 255]);
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([head, mask, masked]);
}

function drain(B) {
  for (;;) {
    if (B.buf.length < 2) return;
    const b0 = B.buf[0], b1 = B.buf[1];
    const fin = !!(b0 & 0x80), opcode = b0 & 0x0f;
    let len = b1 & 0x7f, pos = 2;
    if (len === 126) { if (B.buf.length < 4) return; len = B.buf.readUInt16BE(2); pos = 4; }
    else if (len === 127) { if (B.buf.length < 10) return; len = Number(B.buf.readBigUInt64BE(2)); pos = 10; }
    if (B.buf.length < pos + len) return;
    const payload = B.buf.slice(pos, pos + len);
    B.buf = B.buf.slice(pos + len);
    if (opcode === 0x8) { try { B.sock.destroy(); } catch {} return; }
    if (opcode === 0x9) { // ping -> masked pong echoing the payload (client frames must mask)
      try { const mask = crypto.randomBytes(4); const echoed = Buffer.from(payload); for (let i = 0; i < echoed.length; i++) echoed[i] ^= mask[i % 4]; B.sock.write(Buffer.concat([Buffer.from([0x8A, 0x80 | echoed.length]), mask, echoed])); } catch {}
      continue;
    }
    if (opcode === 0x0) { B.frag = Buffer.concat([B.frag || Buffer.alloc(0), payload]); if (!fin) continue; onMessage(B, B.frag.toString('utf8')); B.frag = null; continue; }
    if (opcode !== 0x1 && opcode !== 0x2) continue;
    if (!fin) { B.frag = payload; continue; }
    onMessage(B, payload.toString('utf8'));
  }
}

const argText = (a) => {
  if (!a) return '';
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return a.description || a.unserializableValue || a.type || '';
};

function onMessage(B, text) {
  let msg; try { msg = JSON.parse(text); } catch { return; }
  if (msg.id != null) {
    const w = B.pending.get(msg.id);
    if (w) { B.pending.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message || 'CDP error')) : w.resolve(msg.result); }
    return;
  }
  if (!msg.method) return;
  // Console + uncaught errors accumulate on the session. B.stderr only catches
  // what Chrome prints before a listener could attach; this is the in-page
  // record, and "did the page load clean?" is the cheapest real assertion there
  // is. One-shot waitEvent listeners would drop anything logged before a caller
  // happened to ask.
  if (msg.method === 'Runtime.consoleAPICalled') {
    B.logs.push({ type: msg.params.type || 'log', text: (msg.params.args || []).map(argText).join(' ').slice(0, 2000) });
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    const t = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'uncaught error';
    B.logs.push({ type: 'pageerror', text: String(t).slice(0, 2000) });
  } else if (msg.method === 'Network.requestWillBeSent') {
    // Failed subresources are the silent third failure mode beside exceptions
    // and console errors: a module script that 404s throws NOTHING — the page
    // just quietly never runs it (caught live: a done() claiming two files
    // when only index.html existed still rendered "clean").
    if (B.reqs.size > 500) B.reqs.clear();
    B.reqs.set(msg.params.requestId, (msg.params.request && msg.params.request.url) || '');
  } else if (msg.method === 'Network.loadingFailed') {
    B.logs.push({ type: 'requestfailed', text: `${B.reqs.get(msg.params.requestId) || '(unknown url)'} — ${msg.params.errorText || 'failed'}`.slice(0, 2000) });
  } else if (msg.method === 'Network.responseReceived') {
    const st = msg.params.response ? msg.params.response.status : 0;
    if (st >= 400) B.logs.push({ type: 'requestfailed', text: `${(msg.params.response && msg.params.response.url) || ''} — HTTP ${st}`.slice(0, 2000) });
  }
  if (B.logs.length > 300) B.logs.shift();
  const ws = B.events.get(msg.method);
  if (ws && ws.length) { B.events.set(msg.method, []); for (const fn of ws) fn(msg.params); }
  // Durable subscriptions, alongside the one-shot waiters above: a screencast
  // delivers frames for as long as the pane is open, so a listener that is
  // consumed on first delivery is useless to it.
  const subs = B.subs && B.subs.get(msg.method);
  if (subs && subs.length) for (const fn of subs.slice()) { try { fn(msg.params); } catch { /* a bad subscriber must not kill the socket */ } }
}

// Chrome is detached so the whole helper tree lands in its own process group and
// can be reaped with one signal — a plain child.kill leaves the GPU/renderer
// helpers behind, and those are what hold pipes open and stall the caller.
function killTree(child) {
  if (!child || !child.pid) return;
  try { killProcessTree(child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

// Boot headless Chrome and attach to its first page target. Returns a session:
//   call(method, params, timeoutMs) -> result      waitEvent(method, timeoutMs)
//   run(expression) -> value                       close()
// `stealth` applies the UA + fingerprint patches; callers that only render a
// local file can leave it on, it costs one extra CDP round trip.
// The DevTools websocket for a running Chrome's first page target.
async function pageWsUrl(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = targets.filter((t) => t.type === 'page');
  if (!pages.length) throw new Error('chrome exposed no page target');
  // The FOCUSED tab, not merely the first one. /json/list is most-recently-used
  // first, so a guest joining the operator's Chrome lands on the tab they are
  // actually looking at instead of whatever page happened to open earliest.
  return pages[0].webSocketDebuggerUrl;
}
// A page ws url carries its port; a guest has no child process to read it from.
function portFromWsUrl(u) {
  try { return Number(new URL(String(u)).port) || 0; } catch { return 0; }
}
function openSocket(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (_res, socket) => { socket.setNoDelay(true); socket.on('error', () => {}); resolve(socket); });
    req.on('response', (r) => reject(new Error(`CDP upgrade refused: HTTP ${r.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}
// `attachTo` (a page's webSocketDebuggerUrl) joins a Chrome someone else owns
// instead of spawning one — the whole point being that the operator's pane and
// the agent can drive ONE browser, with one cookie jar and one logged-in
// session, rather than two that merely visit the same URL. An attached client
// never kills the process or wipes the profile on close; it is a guest.
// `headful` drops --headless=new. Headless is a bot signal no UA string or
// stealth patch covers: measured on dsw.com, headless got "Access is temporarily
// restricted" while the same binary, same profile, headful, got the store.
//
// Keeping that headful window OFF the operator's desktop:
//   Preferred (Linux): a private Xvfb display. Real headed Chrome, zero WM
//   fight, Page.screencast keeps flowing (document.visibilityState stays
//   "visible"). Falls back when Xvfb is missing or CONVERGE_BROWSER_NO_XVFB=1.
//   Fallback: seed Preferences, CDP offscreen bounds, then cloak (opacity 0 +
//   unused desktop). Minimized is NOT used — it stops screencast.
const OFFSCREEN_X = -32000;
const OFFSCREEN_Y = -32000;
const OFFSCREEN = [`--window-position=${OFFSCREEN_X},${OFFSCREEN_Y}`, '--no-default-browser-check'];
const HIDDEN_DESKTOP = 99; // beyond any normal workspace count; keeps paint alive

function whichBin(name) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, name);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function profileDirFromArgs(args, fallback) {
  for (const a of args) {
    const s = String(a);
    if (s.startsWith('--user-data-dir=')) return s.slice('--user-data-dir='.length);
  }
  return fallback || null;
}

// Best-effort: stop Chrome restoring an on-screen rect before the first map.
function seedOffscreenPlacement(dir, width, height) {
  if (!dir) return;
  const prefPath = path.join(dir, 'Default', 'Preferences');
  let prefs = {};
  try {
    if (fs.existsSync(prefPath)) prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
  } catch { prefs = {}; }
  if (!prefs || typeof prefs !== 'object') prefs = {};
  prefs.browser = prefs.browser && typeof prefs.browser === 'object' ? prefs.browser : {};
  prefs.browser.window_placement = {
    left: OFFSCREEN_X,
    top: OFFSCREEN_Y,
    right: OFFSCREEN_X + width,
    bottom: OFFSCREEN_Y + height,
    maximized: false,
    work_area_left: OFFSCREEN_X,
    work_area_top: OFFSCREEN_Y,
    work_area_right: OFFSCREEN_X + width,
    work_area_bottom: OFFSCREEN_Y + height,
  };
  try {
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(prefPath, JSON.stringify(prefs));
  } catch {}
}

async function startPrivateXvfb(width, height) {
  if (process.platform !== 'linux') return null;
  if (process.env.CONVERGE_BROWSER_NO_XVFB === '1') return null;
  const bin = whichBin('Xvfb');
  if (!bin) return null;
  const w = Math.max(800, Number(width) || 1280);
  const h = Math.max(600, Number(height) || 900);
  for (let n = 70; n < 120; n++) {
    const lock = `/tmp/.X${n}-lock`;
    if (fs.existsSync(lock)) continue;
    const display = `:${n}`;
    const child = spawn(bin, [display, '-screen', '0', `${w}x${h}x24`, '-ac', '-nolisten', 'tcp', '-dpi', '96'], {
      detached: true,
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode != null || child.signalCode != null) break;
      if (fs.existsSync(lock)) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      continue;
    }
    return { display, child };
  }
  return null;
}

function x11ClientIds(env) {
  try {
    const out = execSync('xprop -root _NET_CLIENT_LIST', { encoding: 'utf8', timeout: 2000, env });
    return (out.split(':')[1] || '').match(/0x[0-9a-fA-F]+/g) || [];
  } catch { return []; }
}

function x11WindowsForPid(pid, env) {
  if (!pid || process.platform !== 'linux' || !env.DISPLAY) return [];
  const hits = [];
  for (const id of x11ClientIds(env)) {
    try {
      const p = execSync(`xprop -id ${id} _NET_WM_PID`, { encoding: 'utf8', timeout: 1000, env });
      const m = p.match(/=\s*(\d+)/);
      if (m && Number(m[1]) === pid) hits.push(id);
    } catch {}
  }
  return hits;
}

function cloakX11Window(id, env) {
  const opts = { encoding: 'utf8', timeout: 1000, env, stdio: ['ignore', 'ignore', 'ignore'] };
  // Keep the window Normal (painted) so CDP screencast still emits frames.
  try { execSync(`xprop -id ${id} -f _NET_WM_DESKTOP 32c -set _NET_WM_DESKTOP ${HIDDEN_DESKTOP}`, opts); } catch {}
  try { execSync(`xprop -id ${id} -f _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY 0`, opts); } catch {}
  try { execSync(`xprop -id ${id} -f _NET_WM_STATE 32a -set _NET_WM_STATE '_NET_WM_STATE_SKIP_TASKBAR,_NET_WM_STATE_SKIP_PAGER'`, opts); } catch {}
}

function cloakDarwinWindow() {
  // macOS usually honors negative bounds; AppleScript is a second belt.
  try {
    execSync(`osascript -e 'tell application "System Events" to tell process "Google Chrome" to repeat with w in windows
      try
        set position of w to {${OFFSCREEN_X}, ${OFFSCREEN_Y}}
      end try
    end repeat'`, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {}
}

async function parkHeadfulWindow(B, width, height) {
  // CDP first: restore if something minimized it, push size + offscreen origin.
  try {
    const win = await B.call('Browser.getWindowForTarget', {}, 5000);
    if (win && win.windowId != null) {
      if (win.bounds && win.bounds.windowState && win.bounds.windowState !== 'normal') {
        await B.call('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } }, 5000);
      }
      await B.call('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { left: OFFSCREEN_X, top: OFFSCREEN_Y, width, height },
      }, 5000);
    }
  } catch {}

  if (!B.child || !B.child.pid) return;

  if (process.platform === 'darwin') {
    cloakDarwinWindow();
    return;
  }
  const env = B.chromeEnv || process.env;
  if (process.platform !== 'linux' || !env.DISPLAY) return;

  // Window may land in _NET_CLIENT_LIST a beat after DevTools is up.
  for (let i = 0; i < 20; i++) {
    const ids = x11WindowsForPid(B.child.pid, env);
    if (ids.length) {
      for (const id of ids) cloakX11Window(id, env);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function launch(chromeBin, { width = 1200, height = 900, bootTimeoutMs = 15000, stealth = true, args = [], sandbox = false, attachTo = '', headful = false } = {}) {
  if (!chromeBin && !attachTo) throw new Error('no Chrome/Chromium found — install Google Chrome (or set CHROMIUM_BIN)');
  const tmpDir = attachTo ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'converge-browser-'));
  // A caller that pins its own profile (the link-preview renderer isolates each
  // render) wins: two --user-data-dir flags is not a merge, Chrome takes one.
  const ownsProfile = args.some((a) => String(a).startsWith('--user-data-dir='));

  let privateDisplay = null;
  let chromeEnv = null;
  let usePrivateDisplay = false;
  if (headful && !attachTo) {
    privateDisplay = await startPrivateXvfb(width, height);
    usePrivateDisplay = !!privateDisplay;
    if (usePrivateDisplay) {
      chromeEnv = { ...process.env, DISPLAY: privateDisplay.display };
      delete chromeEnv.WAYLAND_DISPLAY;
    } else {
      seedOffscreenPlacement(profileDirFromArgs(args, ownsProfile ? null : tmpDir), width, height);
    }
  }

  const headfulArgs = usePrivateDisplay
    ? ['--window-position=0,0', '--no-default-browser-check']
    : OFFSCREEN;

  const child = attachTo ? null : spawn(chromeBin, [
    // Headless still needs a GL backend for WebGL canvases (Three.js). --disable-gpu
    // black-screens every WebGL page on macOS; SwiftShader keeps CI/Linux working too.
    // Chrome 119+ requires --enable-unsafe-swiftshader for the software GL path.
    ...(headful ? headfulArgs : [
      '--headless=new',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ]),
    ...(sandbox ? [] : ['--no-sandbox']), '--no-first-run', '--no-proxy-server',
    '--disable-blink-features=AutomationControlled',
    '--remote-debugging-port=0', ...(ownsProfile ? [] : [`--user-data-dir=${tmpDir}`]), `--window-size=${width},${height}`,
    ...args, 'about:blank',
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: chromeEnv || process.env });

  const scrub = () => {
    if (!child) return; // guest: the owner tears the browser down, not us
    killTree(child);
    if (privateDisplay && privateDisplay.child) {
      try { process.kill(-privateDisplay.child.pid, 'SIGKILL'); } catch { try { privateDisplay.child.kill('SIGKILL'); } catch {} }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };
  let port, sock, wsUrl;
  try {
    if (attachTo) {
      wsUrl = attachTo;
    } else {
      port = await new Promise((resolve, reject) => {
        let err = '';
        const to = setTimeout(() => reject(new Error(`chrome did not expose DevTools in ${Math.round(bootTimeoutMs / 1000)}s: ${err.slice(-200)}`)), bootTimeoutMs);
        child.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//); if (m) { clearTimeout(to); resolve(Number(m[1])); } });
        child.on('exit', () => { clearTimeout(to); reject(new Error(`chrome exited during boot: ${err.slice(-200)}`)); });
      });
      wsUrl = await pageWsUrl(port);
      if (!wsUrl) throw new Error('chrome exposed no page target');
    }
    sock = await openSocket(wsUrl);
  } catch (e) { scrub(); throw e; }

  const B = {
    child, sock, tmpDir, port, wsUrl, buf: Buffer.alloc(0), frag: null, nextId: 0,
    pending: new Map(), events: new Map(), subs: new Map(), closed: false, stderr: '', logs: [], reqs: new Map(),
    privateDisplay, chromeEnv: chromeEnv || process.env,
  };
  // Persistent listener; returns its own unsubscribe.
  B.on = (method, fn) => {
    const list = B.subs.get(method) || [];
    list.push(fn);
    B.subs.set(method, list);
    return () => B.subs.set(method, (B.subs.get(method) || []).filter((f) => f !== fn));
  };
  // Chrome logs uncaught page errors to stderr under --enable-logging=stderr,
  // and boot-time exceptions fire before any CDP listener could attach — so the
  // judges read them from here rather than from Runtime.exceptionThrown.
  if (child) child.stderr.on('data', (d) => { B.stderr = (B.stderr + d).slice(-64 * 1024); });
  // A dead socket means the TAB went away, not that Chrome did — recover once by
  // re-resolving the frontmost page. B.gone marks a deliberate close, which must
  // never resurrect itself.
  B.call = async (method, params = {}, timeoutMs = 20000) => {
    if (B.closed && !B.gone && B.reattach) {
      B.reattaching = B.reattaching || (async () => {
        try { await B.reattach(); }
        catch { B.gone = true; }
        finally { B.reattaching = null; }
      })();
      await B.reattaching;
    }
    return B.rawCall(method, params, timeoutMs);
  };
  B.rawCall = (method, params = {}, timeoutMs = 20000) => {
    if (B.closed) return Promise.reject(new Error('browser not running'));
    const id = ++B.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { B.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      B.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { B.sock.write(maskFrame(JSON.stringify({ id, method, params }))); } catch (e) { clearTimeout(timer); B.pending.delete(id); reject(e); }
    });
  };
  B.waitEvent = (method, timeoutMs) => new Promise((resolve) => {
    // A page can already be loaded when we start waiting — timing out is normal.
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const list = B.events.get(method) || [];
    list.push((params) => { clearTimeout(timer); resolve(params); });
    B.events.set(method, list);
  });
  B.run = async (expression, timeoutMs = 20000) => {
    const r = await B.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'page threw');
    return r.result && r.result.value;
  };
  B.close = () => {
    if (B.gone) return;
    B.gone = true; // deliberate: never re-resolve after this
    B.closed = true;
    try { B.sock.destroy(); } catch {}
    scrub();
  };

  B.bindSocket = (s) => {
    B.sock = s;
    B.buf = Buffer.alloc(0);
    B.frag = null;
    s.setNoDelay(true);
    s.on('data', (chunk) => { B.buf = Buffer.concat([B.buf, chunk]); drain(B); });
    s.on('error', () => {});
    s.on('close', () => { B.closed = true; });
  };
  B.bindSocket(sock);
  // FOLLOW THE TAB, don't pin one. A page ws url dies with its target, so an
  // operator opening a new tab (or a page that replaces itself) left a guest
  // holding a socket onto a page that no longer exists — driving a stale DOM
  // while the operator looked at something else. Re-resolve to whatever page is
  // frontmost now and re-arm the domains on it.
  B.reattach = async () => {
    const p = B.port || portFromWsUrl(B.wsUrl);
    if (!p) throw new Error('cannot re-resolve a page target without a DevTools port');
    const next = await pageWsUrl(p);
    const s = await openSocket(next);
    try { B.sock.destroy(); } catch {}
    B.wsUrl = next;
    B.pending.clear();
    B.closed = false;
    B.bindSocket(s);
    await B.arm();
    return B;
  };
  B.arm = async () => {
    await B.call('Page.enable');
    await B.call('Runtime.enable');
    await B.call('Network.enable');
    if (stealth) {
      await B.call('Network.setUserAgentOverride', { userAgent: STEALTH_UA });
      await B.call('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SCRIPT });
    }
  };
  await B.arm();
  // Private Xvfb needs no cloak — the window never touches the operator display.
  // Fallback path only: cloak windows we spawned (never an attachTo guest).
  if (headful && child && !usePrivateDisplay) await parkHeadfulWindow(B, width, height);
  return B;
}

// Load a URL in a throwaway browser, hand back the rendered DOM (and optionally
// a screenshot), then tear the whole tree down. This is what the browser
// validator runs; it never throws, so a gate reports a failure instead of
// killing the run. Returns { ok, html, screenshot: Buffer|null, error }.
async function renderOnce(chromeBin, url, { timeoutMs = 60000, screenshot = false, width = 1000, height = 800, settleMs = 400, args = [], sandbox = false } = {}) {
  let B = null;
  try {
    B = await launch(chromeBin, { width, height, args, sandbox, bootTimeoutMs: Math.min(timeoutMs, 20000) });
    const loaded = B.waitEvent('Page.loadEventFired', timeoutMs);
    await B.call('Page.navigate', { url }, timeoutMs);
    await loaded;
    // loadEventFired can be missed if the page was already up — confirm by state.
    const deadline = Date.now() + timeoutMs;
    // EVERY evaluate here used to run on B.run's 20s DEFAULT, ignoring the
    // timeoutMs the caller asked for — and a Runtime.evaluate queues behind
    // whatever the page's main thread is doing. So a heavy WebGL page that
    // takes 25s to build its first scene blew a 20s evaluate, threw out of this
    // loop, and renderOnce reported `chromium failed rendering <url>` on a page
    // that was merely slow. That is what halted the Dragon mobile-HUD mission:
    // a 45s check, capped at 20s internally, three times over, on work that was
    // correct and shipped. The caller's budget is the only budget.
    const left = () => Math.max(1000, deadline - Date.now());
    for (;;) {
      // A busy main thread makes this evaluate time out; that means "not ready
      // yet", not "broken". Keep polling until the real deadline.
      let ready = null;
      try { ready = await B.run('document.readyState', left()); } catch { ready = null; }
      if (ready === 'complete' || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, settleMs)); // let the first frame paint
    const html = (await B.run('document.documentElement.outerHTML', left())) || '';
    let shot = null;
    if (screenshot) {
      const s = await B.call('Page.captureScreenshot', { format: 'png' }, left());
      if (s && s.data) shot = Buffer.from(s.data, 'base64');
    }
    // `logs` (console output + uncaught page errors) is collected on the
    // session above precisely so a caller can ask "did the page load clean?",
    // but it used to stop here — renderOnce dropped it, so the browser
    // validator, the only consumer, could assert on the DOM and nothing else.
    // A page whose React tree threw on mount still passed any gate whose
    // expected substring came from static index.html. Hand the record back.
    return { ok: true, html, screenshot: shot, error: null, logs: B.logs.slice() };
  } catch (e) {
    return { ok: false, html: '', screenshot: null, error: e.message, logs: B ? B.logs.slice() : [] };
  } finally {
    if (B) B.close();
  }
}

// Join a Chrome another process owns. Same client, same stealth patches — the
// module header's rule that the two consumers must not drift applies here too.
const attach = (wsUrl, opts = {}) => launch('', { ...opts, attachTo: wsUrl });
module.exports = { launch, attach, pageWsUrl, portFromWsUrl, renderOnce, STEALTH_UA, STEALTH_SCRIPT };
