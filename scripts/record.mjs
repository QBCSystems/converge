#!/usr/bin/env node
// Record a project's live dashboard to a video: sign in, open the project, capture frames at a fixed
// rate, encode with ffmpeg. Stops at the time limit, or on SIGTERM/SIGINT (it then encodes what it has).
//
//   ADMIN_KEY=... node scripts/record.mjs <platform url> <project> <out.mp4> [max seconds] [width height]
//   FPS (default 2) frames per second; the video plays at 30 fps (a time-lapse).
//   RECORD_REQUEST="..." types that request into the dashboard's run box once recording has started and presses
//   Start (RECORD_AGENTS, RECORD_BUDGET set its sliders): the video then shows the whole run from the request on.
//
// Needs google-chrome (headless; on a Mac, Google Chrome.app) and ffmpeg on PATH. RECORD_DPR=2 for a sharper picture.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const [base, project, out, secs = '7200', w = '1400', h = '860'] = process.argv.slice(2);
if (!base || !project || !out) {
  console.error('usage: ADMIN_KEY=... node scripts/record.mjs <url> <project> <out.mp4> [max seconds] [width height]');
  process.exit(2);
}
const key = process.env.ADMIN_KEY || '';
const fps = Number(process.env.FPS) || 2;
const port = 9400 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(path.dirname(path.resolve(out)), '.chrome-'));
const frames = fs.mkdtempSync(path.join(path.dirname(path.resolve(out)), '.frames-'));
// google-chrome on Linux; on a Mac, Chrome's own binary (or CHROME=/path/to/chrome).
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME = process.env.CHROME || (spawnSync('which', ['google-chrome']).status !== 0 && fs.existsSync(MAC_CHROME) ? MAC_CHROME : 'google-chrome');
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--window-size=${w},${h}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; });

let target;
for (let i = 0; i < 100 && !target; i++) { await sleep(100); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* starting */ } }
if (!target) { chrome.kill(); console.error('record: chrome did not start'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
ws.on('message', (m) => { const msg = JSON.parse(m); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: Number(process.env.RECORD_DPR) || 1, mobile: Number(w) < 600 });
// Signed in by the key in the address (the dashboard moves it into the tab's storage and out of the address bar):
// the sign-in form now asks for an account first, with the key behind "Use a key".
await send('Page.navigate', { url: `${base.replace(/\/$/, '')}/?project=${encodeURIComponent(project)}&admin_key=${encodeURIComponent(key)}` });
await sleep(5000);

// The request typed in while the frames are taken, a few characters at a time, then Start.
async function typeRequest(text) {
  await sleep(2500);
  const js = (x) => send('Runtime.evaluate', { expression: x });
  const slider = (id, v) => `(() => { const e = document.querySelector('${id}'); if (!e) return; e.max = String(Math.max(Number(e.max), ${Number(v)})); e.value = '${Number(v)}'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`;
  if (process.env.RECORD_AGENTS) await js(slider('#run-agents', process.env.RECORD_AGENTS));
  if (process.env.RECORD_BUDGET) await js(slider('#run-budget', process.env.RECORD_BUDGET));
  await js(`document.querySelector('#run-req').focus()`);
  for (let i = 0; i < text.length && !stopping; i += 4) {
    await js(`(() => { const e = document.querySelector('#run-req'); e.value = ${JSON.stringify(text.slice(0, i + 4))}; e.scrollTop = e.scrollHeight; })()`);
    await sleep(45);
  }
  await sleep(900);
  await js(`document.querySelector('#run-go').click()`);
}
if (process.env.RECORD_REQUEST) typeRequest(process.env.RECORD_REQUEST).catch((e) => console.error('record: typing failed:', e.message));

const limit = Number(secs) * fps;
let n = 0;
for (; n < limit && !stopping; n++) {
  const t0 = Date.now();
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
  fs.writeFileSync(path.join(frames, `f${String(n).padStart(6, '0')}.jpg`), Buffer.from(r.result.data, 'base64'));
  await sleep(Math.max(0, 1000 / fps - (Date.now() - t0)));
}
ws.close();
chrome.kill();
const enc = n ? spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, 'f%06d.jpg'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', out]) : { status: 1, stderr: 'no frames' };
fs.rmSync(frames, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });
console.log(enc.status === 0 ? `wrote ${out} (${n} frames, ${(n / fps / 60).toFixed(1)} min of dashboard)` : `ffmpeg failed: ${enc.stderr}`);
process.exit(enc.status === 0 ? 0 : 1);
