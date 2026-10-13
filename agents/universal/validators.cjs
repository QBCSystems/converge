'use strict';
// validators.cjs — typed validation checks for the gate. The default `shell`
// validator already expresses every case (git-clean is `git status --porcelain`,
// build is `npm run build`, api-health is `curl`, sql is `psql`); the named types
// are convenience + a consistent structured result, NOT a framework. This is a
// fixed dispatch map: no disk discovery, no dynamic require of model/user code,
// and the config comes from outside the model's reach — so the gate stays
// un-fakeable. Every validator returns { pass, exit, output } deterministically.
const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const cdp = require('./shared/cdp.cjs');
const unblink = require('./shared/unblink.cjs');
const { killTree } = require('./shared/kill-tree.cjs');

// Gate commands run with the SAME scrubbed env the engine gives run_command
// children — this is THE strip list; universal-agent.cjs's scrubbedEnv() is a
// one-line delegation to gateEnv(), not a second copy. Without this, gates
// inherited the harness's EDIT_*/AGENT_* vars while the model's own test runs
// didn't — a repo whose tests check config precedence passed for the model
// and failed in the gate, an unreproducible mismatch (watched live: the model
// correctly diagnosed the discrepancy and called blocked).
const SENSITIVE_KEY = /^(EDIT_|AGENT_)|(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
function gateEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_KEY.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, extra || {});
}

function normalizeCwd(cwd) {
  if (typeof cwd === 'object' && cwd !== null) {
    cwd = cwd.cwd || cwd.workdir || process.cwd();
  }
  if (!cwd || typeof cwd !== 'string') cwd = process.cwd();
  let resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved)) {
    const parent = path.dirname(resolved);
    if (fs.existsSync(parent) && path.basename(resolved) === path.basename(parent)) {
      resolved = parent;
    } else if (fs.existsSync(process.cwd())) {
      resolved = process.cwd();
    }
  }
  return resolved;
}

function runShell(command, cwd, timeout) {
  cwd = normalizeCwd(cwd);
  try {
    const out = execSync(command, { cwd, timeout: (timeout || 120) * 1000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: gateEnv() }).toString();
    return { exit: 0, output: out }; // raw (git-clean depends on empty == clean)
  } catch (e) {
    return { exit: e.status == null ? 1 : e.status, output: `${e.stdout || ''}${e.stderr || e.message || ''}` };
  }
}

// exit/contains semantics shared by shell + build.
function shellLike(c, cwd, defaultCmd, defaultTimeout) {
  const r = runShell(c.command || defaultCmd, cwd, c.timeout || defaultTimeout);
  const expectedExit = c.expectExit == null ? 0 : c.expectExit;
  let pass = r.exit === expectedExit;
  let failReason = '';
  if (r.exit !== expectedExit) {
    failReason = `exit status code ${r.exit} (expected ${expectedExit})`;
  }
  if (pass && c.expectContains) {
    pass = r.output.includes(c.expectContains);
    if (!pass) failReason = `output missing expected substring "${c.expectContains}"`;
  }
  const res = { pass, exit: r.exit, output: r.output };
  if (!pass) {
    res.expected = { exit: expectedExit, contains: c.expectContains || null };
    res.observed = { exit: r.exit, outputSnippet: r.output.slice(0, 500) };
    res.remediation = `Command \`${c.command || defaultCmd}\` failed validation: ${failReason}. Inspect output above and correct the source or environment.`;
  }
  return res;
}

const VALIDATORS = {
  shell(c, cwd) { return shellLike(c, cwd); },
  build(c, cwd) { return shellLike(c, cwd, 'npm run build', 600); },
  'git-clean'(c, cwd) {
    const r = runShell('git status --porcelain', cwd, c.timeout);
    const dirty = r.output.trim();
    const pass = r.exit === 0 && dirty === '';
    const res = { pass, exit: r.exit, output: dirty ? `uncommitted changes:\n${dirty}` : 'working tree clean' };
    if (!pass) {
      res.expected = { exit: 0, dirty: false };
      res.observed = { exit: r.exit, dirtyFiles: dirty.split('\n').filter(Boolean) };
      res.remediation = 'Working tree has uncommitted modifications. Either commit or revert unneeded changes before proceeding.';
    }
    return res;
  },
  async http(c) {
    const ms = (c.timeout || 30) * 1000;
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(c.url, { method: c.method || 'GET', headers: c.headers || {}, body: c.body, signal: ctrl.signal });
      const body = await res.text();
      const expectedStatus = c.expectStatus || 200;
      let pass = res.status === expectedStatus;
      let failReason = '';
      if (res.status !== expectedStatus) {
        failReason = `HTTP status ${res.status} (expected ${expectedStatus})`;
      }
      if (pass && c.expectContains) {
        pass = body.includes(c.expectContains);
        if (!pass) failReason = `HTTP response body missing expected substring "${c.expectContains}"`;
      }
      const outObj = { pass, exit: pass ? 0 : 1, output: `HTTP ${res.status}\n${body.slice(0, 500)}` };
      if (!pass) {
        outObj.expected = { status: expectedStatus, contains: c.expectContains || null };
        outObj.observed = { status: res.status, bodySnippet: body.slice(0, 300) };
        outObj.remediation = `HTTP check to ${c.url} failed: ${failReason}. Ensure server endpoint is running and returning expected payload.`;
      }
      return outObj;
    } catch (e) {
      return {
        pass: false,
        exit: 1,
        output: `request failed: ${e.message}`,
        expected: { status: c.expectStatus || 200 },
        observed: { error: e.message },
        remediation: `Failed to reach endpoint ${c.url}: ${e.message}. Verify that the target server is listening.`
      };
    } finally { clearTimeout(id); }
  },
};
VALIDATORS['api-health'] = VALIDATORS.http;

// ---------- browser: verify a running web UI, zero npm deps ----------
// The one capability the repo lacked. We drive the preinstalled Chromium binary
// directly (no playwright module): render the page, assert on the real DOM, and
// save a screenshot as evidence. Behavioral correctness (what a click DOES) is
// covered by companion `http` checks against the same endpoints; this validator
// proves the UI actually renders the required structure. Config:
//   { type:'browser', start?, port?, url?, path?, expectContains?:[..]|str,
//     screenshot?, timeout? }
// If `start` is given we spawn it, wait for readiness, drive, then kill it.
function findChromium() {
  if (process.env.CHROMIUM_BIN && fs.existsSync(process.env.CHROMIUM_BIN)) return process.env.CHROMIUM_BIN;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  // macOS app bundles — without these every browser-driven feature (visual
  // judge, browser tool) silently returned null on a Mac and never ran.
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ]) if (fs.existsSync(p)) return p;
  // Windows — same failure as the Mac one above: a win32 fleet node returned
  // null here, so every browser-driven feature was dead on it and the agent
  // went looking for some other browser to drive instead.
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ];
    for (const root of roots) {
      for (const parts of rel) {
        const p = path.join(root, ...parts);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

async function waitForHttp(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (res.status) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Correct types matter under a real browser: a module script typed text/plain
// is refused, which is one of the exact "loads but silently never runs" traps
// this validator exists to catch.
const STATIC_MIME = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

async function runBrowser(c, cwd) {
  cwd = normalizeCwd(cwd);
  // Unblink first, so no Chrome on the machine is no longer a dead gate.
  const chrome = unblink.available() ? null : findChromium();
  if (!unblink.available() && !chrome) {
    return { pass: false, exit: 1, output: 'browser validator: no browser available — build custom-browser (cmake -B build && cmake --build build), or set CHROMIUM_BIN' };
  }
  const port = c.port || 3000;
  let url = c.url || `http://127.0.0.1:${port}${c.path || '/'}`;
  const timeoutMs = (c.timeout || 60) * 1000;
  let child = null;
  let server = null;
  const notes = [];
  try {
    // serveDir: serve a directory statically from THIS process on an ephemeral
    // port — no `start` command, no python dependency, no port races. Exists so
    // multi-file pages are validated over HTTP: file:// blocks module scripts
    // (CORS), which black-screens exactly the builds this check must catch.
    if (c.serveDir) {
      const root = path.resolve(cwd, c.serveDir === true ? '.' : String(c.serveDir));
      server = http.createServer((rq, rs) => {
        try {
          const rel = decodeURIComponent(new URL(rq.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
          const abs = path.resolve(root, rel);
          if (abs !== root && !abs.startsWith(root + path.sep)) { rs.writeHead(403); return rs.end(); }
          const body = fs.readFileSync(abs);
          rs.writeHead(200, { 'content-type': STATIC_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
          rs.end(body);
        } catch { rs.writeHead(404); rs.end(); }
      });
      await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
      url = `http://127.0.0.1:${server.address().port}/${String(c.path || 'index.html').replace(/^\/+/, '')}`;
    }
    if (c.start) {
      // detached so we can kill the WHOLE process group — killing the `sh -c`
      // shell alone leaves the node grandchild bound to the port, and a later
      // run would then connect to that stale server (a real bug this caught).
      child = spawn('sh', ['-c', c.start], { cwd, env: gateEnv({ PORT: String(port) }), stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      child.on('error', () => {});
      const up = await waitForHttp(`http://127.0.0.1:${port}${c.readyPath || '/'}`, Math.min(timeoutMs, 20000));
      if (!up) return { pass: false, exit: 1, output: `browser validator: app did not come up on PORT ${port} via \`${c.start}\`` };
    }
    // Assert the capture is from THIS run, not just fs.existsSync — a stale
    // screenshot at the same path from a prior run would otherwise make a
    // FAILED capture report success. Remove any prior file first.
    const shot = c.screenshot ? (path.isAbsolute(c.screenshot) ? c.screenshot : path.join(cwd, c.screenshot)) : null;
    if (shot) { try { fs.unlinkSync(shot); } catch { /* absent is fine */ } }
    // UNBLINK renders this — the same engine the agent's browser tool and the
    // operator's pane use, on a private session so a gate never navigates the pane
    // out from under them. Chrome stays as the fallback for machines where
    // custom-browser was never built. screenshotInline returns the frame as a data
    // URL beside the file, so evidence can ride the tool-event rail to the UIs.
    const wantShot = !!shot || !!c.screenshotInline;
    const r = unblink.available()
      ? await unblink.renderOnce(url, { timeoutMs, screenshot: wantShot })
      : await cdp.renderOnce(chrome, url, { timeoutMs, screenshot: wantShot });
    if (!r.ok) {
      // THE CHECK DID NOT COMPLETE — that is not a verdict on the page.
      //
      // renderOnce only reports !ok when IT could not finish: the browser would
      // not boot, navigate never returned, an evaluate outran the deadline. None
      // of those is evidence the page is broken, and treating them as a failure
      // is how a merely SLOW page (a heavy WebGL scene on a GPU-less box) got a
      // correct mission halted: the render "failed", the syntax gate failed with
      // it, and repair rounds were sent to fix syntax errors that did not exist.
      //
      // A check the caller attached automatically (bestEffort) therefore returns
      // NO verdict and lets the deterministic tiers decide. A check an operator
      // wrote by hand still fails — they asked for this page to be proven, and
      // "could not prove it" must not read as proven.
      const why = `browser validator: could not complete the render of ${url}: ${String(r.error).slice(0, 300)}`;
      if (!c.bestEffort) return { pass: false, exit: 1, output: why };
      return { pass: true, incomplete: true, exit: 0, output: `${why}\nno verdict on this page — the render tier was skipped, other tiers still apply` };
    }
    const dom = r.html;
    // POLICY: an uncaught exception FAILS the gate. A page that throws on mount
    // is not verified no matter what strings its DOM happens to contain — the
    // dragon-game mission passed "7/7 stages" on syntax checks while the page
    // black-screened on a live TypeError. Opt out per check with
    // `allowPageErrors: true` (e.g. a page that intentionally throws).
    // console.error MESSAGES stay diagnostic-only: apps log errors routinely,
    // and failing on prints would make the gate cry wolf.
    const pageErrors = (r.logs || []).filter((l) => l && l.type === 'pageerror');
    const consoleErrors = (r.logs || []).filter((l) => l && l.type === 'error');
    // A SAME-ORIGIN subresource that fails to load also fails the gate: a
    // module script that 404s throws no exception at all — the page renders
    // its static HTML and the code silently never runs (caught live: a done()
    // claimed game.js existed; only index.html did, and the render passed).
    // Cross-origin failures stay diagnostic — pages reference dead CDNs and
    // trackers routinely, and that is not this build's defect.
    const pageOrigin = (() => { try { return url.startsWith('file:') ? 'file:' : new URL(url).origin; } catch { return ''; } })();
    const reqFails = (r.logs || []).filter((l) => l && l.type === 'requestfailed');
    // /favicon.ico is the BROWSER's automatic probe, not something the page
    // asked for — nearly no project ships one, and failing every faviconless
    // build would make the gate cry wolf on its first day.
    const localFails = reqFails.filter((l) => pageOrigin && String(l.text).startsWith(pageOrigin) && !/\/(favicon\.ico|api\/)/.test(String(l.text)));
    const remoteFails = reqFails.length - localFails.length;
    if (pageErrors.length) {
      notes.push(`uncaught page errors (${pageErrors.length}): ${pageErrors.slice(0, 3).map((l) => String(l.text).slice(0, 200)).join(' | ')}`);
    }
    if (localFails.length) {
      notes.push(`failed to load (${localFails.length}): ${localFails.slice(0, 3).map((l) => String(l.text).slice(0, 200)).join(' | ')}`);
    }
    if (remoteFails) notes.push(`cross-origin request failures (${remoteFails}, diagnostic)`);
    if (consoleErrors.length) {
      notes.push(`console errors (${consoleErrors.length}, diagnostic): ${consoleErrors.slice(0, 2).map((l) => String(l.text).slice(0, 150)).join(' | ')}`);
    }
    if (shot) {
      let ok = false;
      try {
        let buf = null;
        if (Buffer.isBuffer(r.screenshot)) {
          buf = r.screenshot;
        } else if (typeof r.screenshot === 'string') {
          const raw = r.screenshot.startsWith('data:') ? r.screenshot.split(',')[1] : r.screenshot;
          buf = Buffer.from(raw, 'base64');
        }
        if (buf) { fs.writeFileSync(shot, buf); ok = fs.statSync(shot).size > 0; }
      } catch { ok = false; }
      notes.push(ok ? `screenshot: ${c.screenshot}` : `screenshot FAILED (${c.screenshot} not captured this run)`);
    }
    const wants = c.expectContains == null ? [] : (Array.isArray(c.expectContains) ? c.expectContains : [c.expectContains]);
    const missing = wants.filter((w) => !dom.includes(w));
    const inlineShots = c.screenshotInline && r.screenshot ? [`data:image/png;base64,${Buffer.isBuffer(r.screenshot) ? r.screenshot.toString('base64') : String(r.screenshot).replace(/^data:image\/png;base64,/, '')}`] : [];
    const errFail = (pageErrors.length > 0 || localFails.length > 0) && !c.allowPageErrors;
    const pass = missing.length === 0 && !errFail;
    const detail = pass
      ? `rendered ${url}; all ${wants.length} DOM expectation(s) present${pageErrors.length || localFails.length ? ' (page errors allowed by this check)' : ''}`
      : [
          missing.length ? `missing in rendered DOM: ${JSON.stringify(missing)}` : '',
          errFail && pageErrors.length ? `page threw ${pageErrors.length} uncaught error(s) — not verified (set allowPageErrors:true to permit)` : '',
          errFail && localFails.length ? `${localFails.length} of the page's own file(s) failed to load — not verified` : '',
        ].filter(Boolean).join('; ');
    const resObj = { pass, exit: pass ? 0 : 1, output: [detail, ...notes].join('\n'), ...(inlineShots.length ? { images: inlineShots } : {}) };
    if (!pass) {
      resObj.expected = { domStrings: wants, allowPageErrors: !!c.allowPageErrors };
      resObj.observed = { missingDOM: missing, pageErrors: pageErrors.map((l) => String(l.text)), localFails: localFails.map((l) => String(l.text)) };
      resObj.remediation = `Browser validation failed on ${url}: ${detail}. Fix client-side script errors or missing DOM elements.`;
    }
    return resObj;
  } finally {
    if (server) { try { server.close(); } catch { /* already closed */ } }
    if (child && child.pid) { try { killTree(child.pid, 'SIGKILL'); } catch {} }
  }
}
VALIDATORS.browser = runBrowser;

// sql-query prefers a configured MCP server (db-mcp) via the injected caller;
// falls back to a shell command (psql) so it works with no MCP wired.
async function runSql(c, cwd, mcpCall) {
  if (mcpCall && c.server) {
    try {
      const out = String(await mcpCall(c.server, c.tool || 'query', c.args || { sql: c.sql }));
      const pass = c.expectContains ? out.includes(c.expectContains) : true;
      return { pass, exit: pass ? 0 : 1, output: out.slice(0, 1000) };
    } catch (e) { return { pass: false, exit: 1, output: `sql failed: ${e.message}` }; }
  }
  return shellLike(c, cwd);
}

// c: the check config. cwd: working dir. mcpCall(server,tool,args)->Promise<string>
// (optional, for sql-query). Returns { pass, exit, output }.
async function runValidator(c, cwd, mcpCall) {
  cwd = normalizeCwd(cwd);
  const type = c.type || 'shell';
  if (type === 'sql-query') return runSql(c, cwd, mcpCall);
  const fn = VALIDATORS[type];
  if (!fn) return { pass: false, exit: 1, output: `unknown validator type "${type}" (known: ${Object.keys(VALIDATORS).concat('sql-query').join(', ')})` };
  return await fn(c, cwd);
}

module.exports = { runValidator, VALIDATORS, findChromium, gateEnv };
