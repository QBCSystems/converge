// Drives intelligence/minds/openai.cjs over the AOSX frame protocol: Hello must answer Hello; Think against an
// unreachable model host must answer an Error frame, not crash.
//
//   node intelligence/minds/check.mjs
import { spawn } from 'node:child_process';
const frame = (t, p = Buffer.alloc(0)) => { const h = Buffer.alloc(9); Buffer.from('AOSX').copy(h); h[4] = t; h.writeUInt32LE(p.length, 5); return Buffer.concat([h, p]); };
const child = spawn(process.execPath, [new URL('./openai.cjs', import.meta.url).pathname], { env: { ...process.env, AIOS_MODEL_PROVIDER: 'deepseek', AIOS_MODEL: 'deepseek-v4-flash', AIOS_MODEL_HOST: 'http://127.0.0.1:9', DEEPSEEK_API_KEY: 'test-key' }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0); const got = [];
child.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= 9 && buf.length >= 9 + buf.readUInt32LE(5)) { const n = buf.readUInt32LE(5); got.push([buf[4], buf.subarray(9, 9 + n).toString()]); buf = buf.subarray(9 + n); } });
const wait = (n, ms) => new Promise((ok, no) => { const t0 = Date.now(); const i = setInterval(() => { if (got.length >= n) { clearInterval(i); ok(); } else if (Date.now() - t0 > ms) { clearInterval(i); no(new Error(`no frame ${n} after ${ms}ms`)); } }, 50); });
try {
  child.stdin.write(frame(1)); await wait(1, 5000);
  if (got[0][0] !== 1 || !got[0][1]) throw new Error('Hello did not answer Hello with a name');
  child.stdin.write(frame(3, Buffer.from('context'))); await wait(2, 20000);
  if (got[1][0] !== 0x7f) throw new Error(`Think against an unreachable host answered type ${got[1][0]}, not an Error frame`);
  if (child.exitCode !== null) throw new Error('mind exited');
  console.log('mind protocol ok:', got[0][1], '|', got[1][1].slice(0, 80)); child.kill(); process.exit(0);
} catch (e) { console.log('FAIL', e.message); child.kill(); process.exit(1); }
