'use strict';
// Judge panel — independent, DETERMINISTIC judges for mission deliverables.
// Zero npm deps: every judge drives the same Unblink engine the validators
// use. A probe page iframes the target (file:// + --allow-file-access-from-
// files makes it same-origin), runs measurement JS against the live document,
// and smuggles a JSON verdict out through <title>, read back over CDP.
//
// Judges (all return { ok, issues:[...], metrics?:{} } or { skipped }):
//   a11y        — lang attr, page title, minimum font size, text contrast,
//                 keyboard focusability
//   performance — file bytes budget, DOM node budget, rAF frame rate
//   gameplay    — scripted probes: click X, expect numeric change in Y
//                 (actually plays the game)
//   regression  — every element id present in the baseline version must
//                 still exist (don't break what worked)
//
// The visual judge (model-scored aesthetics) lives in universal-agent.cjs —
// judgment is the one thing these can't do. Everything here is arithmetic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const validators = require('./validators.cjs');
const unblink = require('./shared/unblink.cjs');
const { killTree } = require('./shared/kill-tree.cjs');

// JSON embedded in an inline <script> must not let a value containing
// `</script>` (or a comment/`<!--`) break out of the script element. Escape
// the `<` so the browser parser never sees a closing tag inside the literal.
// The mission-authored probe selectors flow through here.
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
}

function resolveTarget(workdir, rel) {
  const named = String(rel || '').trim();
  if (named) {
    // A target was NAMED. If it exists (and is inside the workdir), use it;
    // if it does NOT, that is an error — do NOT silently fall back to the
    // largest HTML, which graded a DIFFERENT file than the one requested and
    // reported pass on a typo'd `dashbord.html`.
    const abs = path.resolve(workdir, named);
    if (abs.startsWith(path.resolve(workdir) + path.sep) && fs.existsSync(abs)) return abs;
    return null; // named-but-missing → caller must skip/fail, not grade a decoy
  }
  // No target named → auto-detect the largest HTML in the workdir.
  const roots = ['', 'public', 'dist', 'build'].map((dir) => path.join(workdir, dir)).filter((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  const htmls = roots.flatMap((dir) => fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f))
    .map((f) => {
      let size = 0;
      try { size = fs.statSync(path.join(dir, f)).size; } catch {}
      return { f: path.join(dir, f), size };
    }))
    .sort((a, b) => b.size - a.size);
  return htmls.length ? htmls[0].f : null;
}

// A VERIFIED-FREE port for the app under test. The old pid-modulo pick never
// checked the port: if anything already listened there (another mission's
// judge, an unrelated service), the up-poll succeeded against the INCUMBENT
// and the vision judge screenshotted and scored the wrong application — a
// gate verdict on a page the stage never built. Bind :0, take the kernel's
// free port, release it for the child (tiny race, vastly better than none).
// Shared: universal-agent.cjs's judgeVisualServer needs the identical guarantee
// and used to carry a verbatim second copy of this.
async function freeLocalPort(preferred) {
  const net = require('net');
  const tryPort = (p) => new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(null));
    srv.listen(p, '127.0.0.1', () => { const got = srv.address().port; srv.close(() => res(got)); });
  });
  return (await tryPort(preferred)) || (await tryPort(0)) || preferred;
}
// Probing a LIVE server app: the wrapper must be same-origin with the target
// or contentDocument is sealed. A throwaway local server serves the wrapper
// AND proxies the app under /app/ — one origin, full access, zero deps.
function withApp(workdir, startCmd, fn) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const http = require('http');
    (async () => {
    // A VERIFIED-free port (bind :0, take the kernel's) — the old fixed
    // 21000+pid%900 was never probed, so a stale server from a prior run on
    // that port made the judge grade the WRONG app and report it green.
    const port = await freeLocalPort(21000 + (process.pid % 900));
    // gateEnv, NOT the full process.env: the app under judgement runs a
    // model-authored `start` command, which must not inherit ANTHROPIC_API_KEY
    // / EDIT_API_KEY / *_TOKEN (validators.cjs uses gateEnv for exactly this).
    const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', String(startCmd)] : ['-c', String(startCmd)];
    const child = spawn(shell, shellArgs, { cwd: workdir, env: validators.gateEnv({ PORT: String(port) }), stdio: 'ignore', detached: true, windowsHide: true });
    const target = `http://127.0.0.1:${port}`;
    const kill = () => {
      try { killTree(child.pid, 'SIGKILL'); } catch {}
    };
    let tries = 0;
    const poll = () => {
      const r = http.get(target + '/', (res) => { res.resume(); ready(); });
      r.on('error', () => (++tries > 40 ? fail() : setTimeout(poll, 250)));
      r.setTimeout(800, () => { r.destroy(); });
    };
    const fail = () => { kill(); resolve({ error: `app did not come up via \`${startCmd}\`` }); };
    const ready = async () => {
      try { resolve({ result: await fn(target) }); } catch (e) { resolve({ error: String(e.message || e) }); }
      finally { kill(); }
    };
    poll();
    child.on('exit', () => { if (tries <= 40) tries = 41; });
    child.on('error', () => { if (tries <= 40) tries = 41; });
    })().catch((e) => resolve({ error: String(e && e.message || e) }));
  });
}
function probeUrl(targetUrl, appPath, probeScript, opts = {}) {
  const http = require('http');
  return new Promise((resolve) => {
    // A one-shot DOM dump captures at the wrapper's load event, and virtual time
    // deadlocks pages that fetch() at boot — so the wrapper HOLDS its own
    // load open with a pending image the proxy only answers once the probe
    // script reports done. Real time, deterministic completion.
    let held = null;
    const proxy = http.createServer((req, res) => {
      if (req.url === '/__probe') {
        const html = wrapperHtml('/app' + (appPath || '/'), probeScript, { ...opts, hold: true });
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(html);
      }
      if (req.url === '/__hold') { held = res; res.writeHead(200, { 'content-type': 'image/gif' }); return; }
      if (req.url === '/__release') { if (held) { try { held.end(); } catch {} held = null; } res.writeHead(200); return res.end('ok'); }
      const upstream = targetUrl + req.url.replace(/^\/app/, '');
      const r = http.request(upstream, { method: req.method, headers: { ...req.headers, host: new URL(targetUrl).host } }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      r.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(r);
    });
    proxy.listen(0, '127.0.0.1', async () => {
      const purl = `http://127.0.0.1:${proxy.address().port}/__probe`;
      // The proxy lives in THIS process, so the probe must never block the
      // event loop — the browser could not be answered and every probe came back
      // empty with exit 0. readProbe is fully async for the same reason.
      try { resolve(await readProbe(purl, { ...opts, timeout: opts.timeout || 45000 })); }
      finally { try { proxy.close(); } catch { /* already closed */ } }
    });
  });
}
function wrapperHtml(src, probeScript, opts = {}) {
  const hold = opts.hold ? '<img src="/__hold" alt="" width="1" height="1">' : '';
  return `<!doctype html><html><head><title>PENDING</title></head><body style="margin:0">
${hold}<iframe id="t" src="${src}" style="width:${opts.width || 1000}px;height:${opts.height || 760}px;border:0"></iframe>
<script>
const IFR = document.getElementById('t');
function done(o){ document.title = 'CONVERGEJUDGE:' + btoa(unescape(encodeURIComponent(JSON.stringify(o)))); ${opts.hold ? "fetch('/__release').catch(()=>{});" : ''} }
IFR.addEventListener('load', () => {
  (async () => {
    const doc = IFR.contentDocument, win = IFR.contentWindow;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    ${probeScript}
  })().catch((e) => done({ error: String(e && e.message || e) }));
});
setTimeout(() => { if (document.title === 'PENDING') done({ error: 'probe timed out inside the page' }); }, ${Math.max(1000, (opts.budget || 9000) - 1500)});
</script></body></html>`;
}

// The probe smuggles its verdict out through document.title. Over CDP we poll
// the LIVE title instead of scraping a --dump-dom snapshot: one-shot dump mode
// captures at the load event (hence the /__hold trick), and on some machines it
// does not run at all — every judge then returned "no result (page crashed?)"
// for pages that were fine. Same driver as the browser tool and the gate.
async function readProbe(url, opts = {}) {
  const deadline = Date.now() + (opts.timeout || 40000);
  // Unblink runs the probe, same engine as the pane and the browser tool. Its own
  // session, so a judge never steals the page the operator is watching, and console
  // errors come from the engine's own capture rather than scraped from stderr.
  if (!unblink.available()) {
    return { error: 'no browser available — build custom-browser (cmake -B build && cmake --build build) or set UNBLINK_BIN' };
  }
  {
    const profDir = path.join(os.tmpdir(), `unblink-judge-${process.pid}-${Date.now().toString(36)}`);
    const driver = new unblink.UnblinkDriver({
      profileDir: profDir,
    });
    try {
      await driver.start();
      await driver.setViewport(opts.width || 1000, opts.height || 760, 1).catch(() => {});
      await driver.navigate(url);
      let title = '';
      for (;;) {
        title = String((await driver.evalJson('document.title').catch(() => '')) || '');
        if (title.startsWith('CONVERGEJUDGE:') || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const errs = await driver.consoleLogs({ errorsOnly: true, max: 50 }).catch(() => []);
      const errText = errs.filter((l) => l.type === 'error' || l.type === 'pageerror').map((l) => l.text);
      const m = title.match(/CONVERGEJUDGE:([A-Za-z0-9+/=]+)/);
      if (!m) return { error: 'probe produced no result (page crashed?)', __consoleErrors: errText };
      const out = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      out.__consoleErrors = errText;
      return out;
    } catch (e) {
      return { error: `probe failed: ${e.message}` };
    } finally {
      try { driver.close(); } catch { /* already gone */ }
      try { fs.rmSync(profDir, { recursive: true, force: true }); } catch { /* tmp dir cleanup */ }
    }
  }
}

// The wrapper iframes the target and reads its DOM across two file:// paths. Our
// engine is configured to permit that (see engine_wkwebview.mm) exactly as Chrome once
// does with --allow-file-access-from-files, so the probe keeps working off disk with
// no server to stand up.
async function probePage(targetAbs, probeScript, opts = {}) {
  const { budget = 8000 } = opts;
  const wrapper = path.join(os.tmpdir(), `converge-probe-${process.pid}-${Date.now().toString(36)}.html`);
  fs.writeFileSync(wrapper, wrapperHtml('file://' + targetAbs, probeScript, { ...opts, budget }));
  try { return await readProbe('file://' + wrapper, opts); }
  finally { try { fs.unlinkSync(wrapper); } catch { /* already gone */ } }
}

// Route a probe at a file (default) or a LIVE app (opts.start + opts.path).
async function runProbe(workdir, opts, script, probeOpts) {
  if (opts.start) {
    const r = await withApp(workdir, opts.start, (url) => probeUrl(url, opts.path || '/', script, probeOpts));
    return r.error ? { error: r.error } : r.result;
  }
  const target = resolveTarget(workdir, opts.target);
  if (!target) return { error: 'no HTML deliverable to judge' };
  return probePage(target, script, probeOpts);
}

// ---------- accessibility ----------
async function judgeA11y(workdir, opts = {}) {
  const minFont = Number(opts.minFontPx) || 12;
  const minContrast = Number(opts.minContrast) || 4.5;
  const res = await runProbe(workdir, opts, `
    const issues = [];
    if (!doc.documentElement.getAttribute('lang')) issues.push('html has no lang attribute');
    if (!(doc.title || '').trim()) issues.push('page has no <title>');
    const lum = (c) => { const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/); if (!m) return null;
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]); };
    const bgOf = (el) => { let e = el; while (e && e !== doc.documentElement) {
      const bg = win.getComputedStyle(e).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg; e = e.parentElement; }
      return 'rgb(255, 255, 255)'; };
    let tinyFonts = 0, checked = 0;
    const tinyList = [], contrastList = [];
    for (const el of [...doc.querySelectorAll('body *')].slice(0, 400)) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText || !el.offsetHeight) continue;
      checked++;
      const cs = win.getComputedStyle(el);
      const label = '<' + el.tagName.toLowerCase() + '> "' + String(el.textContent).trim().slice(0, 30) + '"';
      if (parseFloat(cs.fontSize) < ${minFont}) { tinyFonts++; if (tinyList.length < 3) tinyList.push(label + ' at ' + cs.fontSize); }
      const lt = lum(cs.color), lb = lum(bgOf(el));
      if (lt != null && lb != null) {
        const ratio = (Math.max(lt, lb) + 0.05) / (Math.min(lt, lb) + 0.05);
        if (ratio < ${minContrast}) { if (contrastList.length < 3) contrastList.push(label + ' at ' + ratio.toFixed(2) + ':1 (' + cs.color + ' on ' + bgOf(el) + ')'); }
      }
    }
    if (tinyList.length) issues.push('text below ${minFont}px: ' + tinyList.join('; '));
    if (contrastList.length) issues.push('contrast under ${minContrast}:1: ' + contrastList.join('; '));
    const lowContrast = contrastList.length;
    const focusable = doc.querySelectorAll('a[href],button,input,select,textarea,[tabindex]').length;
    if (!focusable) issues.push('no keyboard-focusable element on the page');
    done({ issues, metrics: { checked, tinyFonts, lowContrast, focusable } });
  `, { budget: Number(opts.budget) || 6000 });
  if (res.error) return { skipped: `a11y probe failed: ${res.error}` };
  return { ok: !res.issues.length, issues: res.issues, metrics: res.metrics };
}

// ---------- performance ----------
async function judgePerformance(workdir, opts = {}) {
  const issues = [];
  const fileTarget = opts.start ? null : resolveTarget(workdir, opts.target);
  const maxBytes = Number(opts.maxBytes) || 256 * 1024;
  // Redraw rate is measured from the CANVAS PIXELS, not requestAnimationFrame
  // (rAF doesn't tick under headless virtual time, and pixel deltas measure
  // the game actually drawing — which is what the user sees anyway): sample
  // the canvas 12 times over ~1.2s of page time and count distinct frames.
  const res = await runProbe(workdir, opts, `
    await wait(500); // let the page boot
    const cv = doc.querySelector('canvas');
    let distinct = 0;
    if (cv) {
      const probeCv = doc.createElement('canvas'); probeCv.width = 64; probeCv.height = 48;
      const ctx = probeCv.getContext('2d', { willReadFrequently: true });
      let prev = '';
      for (let i = 0; i < 12; i++) {
        ctx.drawImage(cv, 0, 0, 64, 48);
        const sig = ctx.getImageData(0, 0, 64, 48).data.join('').length + ':' + [...ctx.getImageData(0, 0, 64, 48).data.slice(0, 512)].join(',');
        if (sig !== prev) { distinct++; prev = sig; }
        await wait(100);
      }
    }
    const nodes = doc.querySelectorAll('*').length;
    done({ metrics: { redrawsPerSec: cv ? Math.max(0, distinct - 1) / 1.1 : null, nodes, servedBytes: doc.documentElement.outerHTML.length } });
  `, { budget: Number(opts.budget) || 9000 });
  if (res.error) return { skipped: `performance probe failed: ${res.error}` };
  const bytes = fileTarget ? fs.statSync(fileTarget).size : res.metrics.servedBytes;
  if (bytes > maxBytes) issues.push(`page is ${bytes} bytes (budget ${maxBytes})`);
  const maxNodes = Number(opts.maxNodes) || 3000;
  if (res.metrics.nodes > maxNodes) issues.push(`${res.metrics.nodes} DOM nodes (budget ${maxNodes})`);
  if (opts.minFps != null) {
    if (res.metrics.redrawsPerSec == null) issues.push('minFps set but the page has no canvas to measure');
    else if (res.metrics.redrawsPerSec < Number(opts.minFps)) issues.push(`canvas redraws ${res.metrics.redrawsPerSec.toFixed(1)}/sec sampled (needs ${opts.minFps}) — the render loop is not actually drawing`);
  }
  return { ok: !issues.length, issues, metrics: { bytes, ...res.metrics } };
}

// ---------- gameplay: actually play it ----------
// probes:
//   click: [{ click: 'canvas'|selector, expect: '#ammo', change: 'decrease'|'increase'|'change', at?: [fx, fy] }]
//   drag:  [{ drag: '.task-card', to: '#col-done' }]  — verifies the source
//          element ends up inside the target after a real pointer drag; tests
//          TOUCH and MOUSE, so HTML5 draggable (mouse-only, dead on phones) is
//          caught. Optional { expect:'#count-done', change:'increase' } instead
//          of the default "moved into target" check.
async function judgeGameplay(workdir, opts = {}) {
  const probes = Array.isArray(opts.probes) && opts.probes.length ? opts.probes : [{ click: 'canvas', expect: '#ammo', change: 'decrease' }];
  const res = await runProbe(workdir, opts, `
    await wait(700); // let the game boot and spawn
    const issues = [], results = [];
    const num = (sel) => { const el = doc.querySelector(sel); if (!el) return null;
      const m = String(el.textContent || '').match(/-?\\d+(?:\\.\\d+)?/); return m ? parseFloat(m[0]) : null; };
    // A full pointer-drag: press on source center, glide to target center in
    // steps (dispatching to whatever is under the pointer), release over target.
    // pointerType selects touch vs mouse. Returns whether the source ended up
    // inside the target (or the numeric expectation changed).
    async function dragOnce(p, kind) {
      const src = doc.querySelector(p.drag), tgt = doc.querySelector(p.to);
      if (!src || !tgt) return { ran: false };
      const before = p.expect ? num(p.expect) : null;
      // Bring the target into view before computing the drop point — on a tall
      // or column-stacked board the target can sit below the fold, so a fixed
      // viewport would drop onto nothing (elementFromPoint → null). Real users
      // scroll to it; so does the probe. Re-read rects after the scroll settles.
      try { tgt.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { tgt.scrollIntoView(); }
      await wait(150);
      const sr = src.getBoundingClientRect(), tr = tgt.getBoundingClientRect();
      const a = { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 };
      const b = { x: tr.left + tr.width / 2, y: tr.top + Math.min(tr.height / 2, 70) };
      const opt = (x, y, ex) => ({ clientX: x, clientY: y, pointerId: kind === 'touch' ? 2 : 1, pointerType: kind, isPrimary: true, bubbles: true, cancelable: true, ...ex });
      // Dispatch pointermove/up on the SOURCE, not on elementFromPoint: the
      // recommended drag pattern calls setPointerCapture, which routes all later
      // pointer events to the source in a real browser (synthetic dispatch does
      // not honor capture, so targeting the source is what matches reality).
      // Handlers locate the drop column from the event COORDINATES via
      // elementFromPoint, so carrying the right clientX/clientY is what matters.
      // This also bubbles to any document-level listener (the non-capture style).
      if (win.PointerEvent) src.dispatchEvent(new win.PointerEvent('pointerdown', opt(a.x, a.y, { button: 0, buttons: 1 })));
      for (let i = 1; i <= 6; i++) {
        const x = a.x + (b.x - a.x) * i / 6, y = a.y + (b.y - a.y) * i / 6;
        if (win.PointerEvent) src.dispatchEvent(new win.PointerEvent('pointermove', opt(x, y, { buttons: 1 })));
        await wait(30);
      }
      const endEl = doc.elementFromPoint(b.x, b.y) || tgt;
      if (win.PointerEvent) src.dispatchEvent(new win.PointerEvent('pointerup', opt(b.x, b.y, { button: 0, buttons: 0 })));
      await wait(450);
      // Check the SPECIFIC element we dragged (src), not a fresh querySelector:
      // after the move, the dragged card is no longer the first '.task-card' in
      // document order (it's now deeper in the target column), so re-querying
      // would test the wrong card and report a false negative on a WORKING drag.
      const check = () => p.expect
        ? (p.change === 'increase' ? (num(p.expect) > before) : p.change === 'decrease' ? (num(p.expect) < before) : (num(p.expect) !== before))
        : !!(tgt && src && tgt.contains(src));
      let moved = check();
      // A real MOUSE also emits native HTML5 drag events (touch never does). So
      // the mouse attempt additionally fires dragstart/dragover/drop — that is
      // how an HTML5-draggable board (dead on phones) still registers mouseOk,
      // letting the probe name "works with a mouse but NOT touch" precisely.
      if (kind === 'mouse' && !moved && win.DragEvent) {
        try {
          const dt = new win.DataTransfer();
          const de = (t, el, x, y) => el.dispatchEvent(new win.DragEvent(t, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
          de('dragstart', src, a.x, a.y); de('dragenter', endEl, b.x, b.y); de('dragover', endEl, b.x, b.y); de('drop', endEl, b.x, b.y); de('dragend', src, b.x, b.y);
          await wait(350); moved = check();
        } catch (e) { /* DragEvent/DataTransfer unavailable — pointer result stands */ }
      }
      return { ran: true, moved };
    }
    // Cards/targets may render asynchronously (fetch, animation frame). A fixed
    // wait races that and makes the verdict FLAKY (watched live: the same board
    // scored true/false/true across repair rounds, thrashing the repair loop).
    // Poll until the selector exists (or a budget elapses) so the probe is
    // deterministic — a real absence still fails after the budget.
    const pollFor = async (sel, ms) => { const end = Date.now() + (ms || 2500); while (Date.now() < end) { if (doc.querySelector(sel)) return true; await wait(120); } return !!doc.querySelector(sel); };
    for (const p of ${jsonForScript(probes)}) {
      if (p.drag) {
        if (!(await pollFor(p.drag))) { issues.push('drag probe: nothing matches ' + p.drag + ' (no draggable cards rendered)'); continue; }
        if (!(await pollFor(p.to))) { issues.push('drag probe: nothing matches target ' + p.to); continue; }
        // Touch first. A failed touch drag leaves the card in place, so mouse
        // can be tried fresh to tell "mouse-only DnD" apart from "drag is dead".
        const t = await dragOnce(p, 'touch');
        const touchOk = t.ran && t.moved;
        const mouseOk = touchOk ? true : (await dragOnce(p, 'mouse')).moved;
        results.push({ probe: p.drag + ' -> ' + p.to, touchOk, mouseOk, ok: touchOk });
        if (!touchOk && mouseOk) issues.push(p.drag + ' can be dragged with a MOUSE but NOT by touch — phones cannot move cards. Implement pointer-based drag (pointerdown/pointermove/pointerup), not HTML5 draggable/ondragstart (native drag-and-drop does not fire on touch).');
        else if (!touchOk) issues.push('dragging ' + p.drag + ' onto ' + p.to + ' did not move it — drag-and-drop is not functional.');
        continue;
      }
      const targetEl = doc.querySelector(p.click);
      if (!targetEl) { issues.push('gameplay probe: nothing matches ' + p.click); continue; }
      const before = num(p.expect);
      if (before == null) { issues.push('gameplay probe: no numeric value at ' + p.expect); continue; }
      const r = targetEl.getBoundingClientRect();
      const fx = (p.at && p.at[0]) || 0.5, fy = (p.at && p.at[1]) || 0.5;
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      const changed = (a, b) => p.change === 'decrease' ? b < a : p.change === 'increase' ? b > a : b !== a;
      // TWO probes per target, because phones are not mice (found live: a
      // mousedown-only game probed as playable while real phones could not
      // shoot at all).
      // 1) TOUCH tap: pointer events with pointerType 'touch' + the compat
      //    click. Rapid game taps do NOT reliably synthesize mouse events —
      //    interactive surfaces must listen on pointer/touch/click.
      if (win.PointerEvent) for (const type of ['pointerdown', 'pointerup'])
        targetEl.dispatchEvent(new win.PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 2, pointerType: 'touch', isPrimary: true }));
      targetEl.dispatchEvent(new win.MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
      await wait(400);
      const afterTouch = num(p.expect);
      const touchOk = changed(before, afterTouch);
      // 2) MOUSE click: full desktop sequence.
      if (win.PointerEvent) for (const type of ['pointerdown', 'pointerup'])
        targetEl.dispatchEvent(new win.PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      for (const type of ['mousedown', 'mouseup', 'click'])
        targetEl.dispatchEvent(new win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
      await wait(400);
      const after = num(p.expect);
      const mouseOk = changed(afterTouch, after);
      const verdictOk = touchOk && mouseOk;
      results.push({ probe: p.click + ' -> ' + p.expect, before, afterTouch, after, touchOk, mouseOk, ok: verdictOk });
      if (!touchOk && mouseOk) issues.push(p.click + ' responds to a mouse but NOT to touch — phones cannot play it. Listen on pointerdown (or click), not mousedown.');
      else if (!verdictOk) issues.push('clicking ' + p.click + ' did not ' + (p.change || 'change') + ' ' + p.expect + ' (' + before + ' -> ' + after + ')');
    }
    done({ issues, metrics: { results } });
  `, { budget: Number(opts.budget) || 10000 });
  if (res.error) return { skipped: `gameplay probe failed: ${res.error}` };
  return { ok: !res.issues.length, issues: res.issues, metrics: res.metrics };
}

// ---------- frontend reality: does the UI actually FUNCTION? ----------
// Runs before the visual judge earns an opinion. Deterministic checks born
// from a live failure (Tailwind classnames with no Tailwind = garbage UI that
// still passed a shallow "has a <form>" gate):
//   - zero unhandled client-side exceptions during boot + scripted steps
//   - the page ships REAL CSS (a rule count, not vibes)
//   - framework-style utility classes must be DEFINED by some stylesheet
//   - no horizontal overflow at the probe viewport
//   - optional steps: fill/click/assertVisible/assertHidden flows
// opts: { target?|start+path?, steps?: [{fill,value}|{click}|{assertVisible}|
//         {assertHidden}], viewports?: ['1200,900','390,844'], minCssRules? }
async function judgeFrontend(workdir, opts = {}) {
  const steps = Array.isArray(opts.steps) ? opts.steps : [];
  const minRules = Number(opts.minCssRules) || 5;
  const viewports = Array.isArray(opts.viewports) && opts.viewports.length ? opts.viewports : ['1200,900', '390,844'];
  const allIssues = [];
  let metrics = null;
  for (const vp of viewports) {
    const [w, h] = String(vp).split(',').map(Number);
    const res = await runProbe(workdir, opts, `
      const issues = [];
      const errors = [];
      win.addEventListener('error', (e) => errors.push(String(e.message || e).slice(0, 120)));
      win.addEventListener('unhandledrejection', (e) => errors.push('unhandled rejection: ' + String(e.reason).slice(0, 100)));
      await wait(900); // boot
      // real CSS shipped?
      let rules = 0, selectors = [];
      for (const sheet of doc.styleSheets) {
        try { for (const r of sheet.cssRules) { rules++; if (r.selectorText) selectors.push(r.selectorText); } } catch {}
      }
      if (rules < ${minRules}) issues.push('the page ships almost no CSS (' + rules + ' rules) — browser-default styling is not a UI');
      // framework classes that nothing defines (the Tailwind-without-Tailwind failure)
      const classTokens = new Set();
      for (const el of doc.querySelectorAll('[class]')) for (const c of el.classList) classTokens.add(c);
      const frameworky = [...classTokens].filter((c) => /^(bg|text|border|rounded|shadow|flex|grid|items|justify|gap|p[xytrbl]?-|m[xytrbl]?-|w-|h-|font-|hover:|md:|lg:|sm:)/.test(c));
      if (frameworky.length >= 8) {
        const selStr = selectors.join(' ');
        const defined = frameworky.filter((c) => selStr.includes('.' + c.replace(/([:.\\/])/g, '\\\\$1')) || selStr.includes('.' + c));
        if (defined.length < frameworky.length * 0.3) issues.push('framework-style classes with no CSS defining them (' + frameworky.slice(0, 6).join(', ') + ' … ' + frameworky.length + ' total) — the framework is not actually loaded and no replacement CSS exists');
      }
      // horizontal overflow
      const over = doc.documentElement.scrollWidth - win.innerWidth;
      if (over > 4) issues.push('horizontal overflow at ${w}x${h}: content is ' + over + 'px wider than the viewport');
      // scripted flow
      const visible = (el) => !!el && el.offsetParent !== null && el.offsetHeight > 0;
      for (const s of ${jsonForScript(steps)}) {
        if (s.fill) { const el = doc.querySelector(s.fill); if (!el) { issues.push('flow: nothing matches ' + s.fill); continue; } el.value = s.value || ''; el.dispatchEvent(new win.Event('input', { bubbles: true })); }
        else if (s.click) {
          const el = doc.querySelector(s.click);
          if (!el) { issues.push('flow: nothing matches ' + s.click); continue; }
          if (win.PointerEvent) for (const t of ['pointerdown', 'pointerup']) el.dispatchEvent(new win.PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new win.MouseEvent(t, { bubbles: true }));
          await wait(500);
        }
        else if (s.assertVisible) { const el = doc.querySelector(s.assertVisible); if (!visible(el)) issues.push('flow: ' + s.assertVisible + ' should be visible but is ' + (el ? 'hidden' : 'missing')); }
        else if (s.assertHidden) { const el = doc.querySelector(s.assertHidden); if (el && visible(el)) issues.push('flow: ' + s.assertHidden + ' should be hidden but is visible'); }
      }
      if (errors.length) issues.push('client-side exceptions: ' + [...new Set(errors)].slice(0, 4).join(' | '));
      done({ issues, metrics: { cssRules: rules, classTokens: classTokens.size, exceptions: errors.length, overflowPx: Math.max(0, over) } });
    `, { budget: Number(opts.budget) || 10000, width: w, height: h });
    if (res.error) return { skipped: `frontend probe failed: ${res.error}` };
    for (const i of res.issues) if (!allIssues.includes(i)) allIssues.push(i);
    if (res.__consoleErrors && res.__consoleErrors.length) {
      const ce = 'client-side exceptions: ' + res.__consoleErrors.join(' | ');
      if (!allIssues.some((i) => i.startsWith('client-side exceptions'))) allIssues.push(ce);
    }
    metrics = metrics || res.metrics;
  }
  return { ok: !allIssues.length, issues: allIssues, metrics };
}

// ---------- regression vs the baseline ----------
function snapshotBaseline(workdir, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const roots = ['', 'public', 'dist', 'build'];
  for (const r of roots) {
    const srcDir = r ? path.join(workdir, r) : workdir;
    if (!fs.existsSync(srcDir)) continue;
    try {
      if (!fs.statSync(srcDir).isDirectory()) continue;
      for (const f of fs.readdirSync(srcDir)) {
        if (/\.html?$/i.test(f)) {
          const destSub = r ? path.join(dir, r) : dir;
          fs.mkdirSync(destSub, { recursive: true });
          fs.copyFileSync(path.join(srcDir, f), path.join(destSub, f));
        }
      }
    } catch {}
  }
}
async function judgeRegression(workdir, opts = {}) {
  const baseDir = opts.baselineDir;
  if (!baseDir || !fs.existsSync(baseDir)) return { skipped: 'no baseline snapshot' };
  const issues = [];
  const roots = ['', 'public', 'dist', 'build'];
  const baseFiles = [];
  for (const r of roots) {
    const d = r ? path.join(baseDir, r) : baseDir;
    if (!fs.existsSync(d)) continue;
    try {
      for (const f of fs.readdirSync(d)) {
        if (/\.html?$/i.test(f)) baseFiles.push(r ? path.join(r, f) : f);
      }
    } catch {}
  }
  if (!baseFiles.length) return { skipped: 'baseline snapshot has no HTML to compare' };
  let comparedAny = false;
  for (const rel of baseFiles) {
    const cur = path.join(workdir, rel);
    const baseFile = path.join(baseDir, rel);
    if (!fs.existsSync(cur)) { issues.push(`${rel} existed in the baseline but is gone`); comparedAny = true; continue; }
    let baseContent = '';
    try { baseContent = fs.readFileSync(baseFile, 'utf8'); } catch {}
    const baseIds = [...baseContent.matchAll(/id=["']([\w-]+)["']/g)].map((m) => m[1]);
    if (!baseIds.length) continue;
    comparedAny = true;
    const res = await probePage(cur, `
      await wait(500);
      done({ ids: [...doc.querySelectorAll('[id]')].map((e) => e.id) });
    `, { budget: 5000 });
    if (res.error) { issues.push(`${rel}: regression probe failed: ${res.error}`); continue; }
    const now = new Set(res.ids);
    for (const id of new Set(baseIds)) if (!now.has(id)) issues.push(`${rel}: element #${id} from the previous version is gone`);
  }
  if (!comparedAny) return { skipped: 'no id-anchored elements in the baseline to check for regressions' };
  return { ok: !issues.length, issues };
}

const JUDGES = { a11y: judgeA11y, performance: judgePerformance, gameplay: judgeGameplay, frontend: judgeFrontend, regression: judgeRegression };

// Run a panel of judge specs; every judge must pass. Returns per-judge
// verdicts plus the aggregate.
async function runPanel(workdir, specs) {
  const verdicts = [];
  for (const spec of specs || []) {
    const type = spec && spec.type;
    if (!JUDGES[type]) { verdicts.push({ type: String(type), skipped: 'unknown judge type' }); continue; }
    try { verdicts.push({ type, ...(await JUDGES[type](workdir, spec)) }); }
    catch (e) { verdicts.push({ type, skipped: `judge crashed: ${String(e.message || e).slice(0, 160)}` }); }
  }
  // A skipped judge is NOT a passing judge — a panel that silently skips
  // everything must never confer a green result (watched live: 'panel 3/3'
  // with three skips). ok demands every judge RAN and passed.
  const ok = verdicts.length > 0 && verdicts.every((v) => v.ok === true);
  return { ok, verdicts };
}

module.exports = { runPanel, JUDGES, snapshotBaseline, resolveTarget, freeLocalPort };
