// A client for agent-control (tools/aios-agent-control.cpp, src/channel/agent_control_serve.cpp):
// signed length-framed JSON requests, and a local service started once and shared by every agent
// on the machine.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const AIOS_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export class AiosControl {
  constructor({ port, secret, host = '127.0.0.1' }) { Object.assign(this, { port, secret, host }); }

  // One request, one answer. Signed (HMAC over the body with ts and nonce), so the service refuses
  // a request it has seen before.
  call(req) {
    return new Promise((resolve, reject) => {
      const signed = { ...req, ts: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(12).toString('hex') };
      const auth = crypto.createHmac('sha256', this.secret).update(JSON.stringify(signed)).digest('hex');
      const body = Buffer.from(JSON.stringify({ ...signed, auth }));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length);
      const sock = net.connect(this.port, this.host);
      let data = Buffer.alloc(0);
      sock.on('connect', () => sock.write(Buffer.concat([head, body])));
      sock.on('data', (c) => {
        data = Buffer.concat([data, c]);
        if (data.length >= 4 && data.length >= 4 + data.readUInt32BE(0)) {
          sock.end();
          resolve(JSON.parse(data.subarray(4, 4 + data.readUInt32BE(0)).toString('utf8')));
        }
      });
      sock.on('error', reject);
    });
  }

  async must(req) {
    const r = await this.call(req);
    if (!r.ok) throw new Error(`aios ${req.op}: ${r.error}`);
    return r;
  }
}

/**
 * The local agent-control service under dataDir/aios (its root, key and log), started if it is not
 * already answering on `port`. `minds` maps a name to the command line of an external mind
 * (agent.bind_mind kind "external" picks one by name); `api` (intelligence/minds/openai.cjs) and
 * `script` (intelligence/minds/script.cjs) are always registered. Model keys reach the minds from
 * the environment this process has when it starts the service.
 */
export async function ensureService({ dataDir, port = Number(process.env.AIOS_CONTROL_PORT) || 7319, bin, minds = {} }) {
  const dir = path.join(dataDir, 'aios');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, 'control.key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  const secret = fs.readFileSync(keyFile, 'utf8').trim();
  const ctl = new AiosControl({ port, secret });
  try { if ((await ctl.call({ op: 'svc.ping' })).ok) return ctl; } catch { /* not running yet */ }
  const exe = bin || process.env.AIOS_AGENT_CONTROL || path.join(AIOS_ROOT, 'build', 'aios-agent-control');
  if (!fs.existsSync(exe)) throw new Error(`aios-agent-control not found at ${exe} (cmake --build build --target aios-agent-control in aios, or set AIOS_AGENT_CONTROL)`);
  const all = {
    api: `${process.execPath} ${path.join(AIOS_ROOT, 'intelligence', 'minds', 'openai.cjs')}`,
    script: `${process.execPath} ${path.join(AIOS_ROOT, 'intelligence', 'minds', 'script.cjs')}`,
    ...minds,
  };
  const log = fs.openSync(path.join(dir, 'service.log'), 'a');
  const args = ['--root', path.join(dir, 'root'), '--port', String(port), '--auth-secret-file', keyFile];
  for (const [name, cmd] of Object.entries(all)) args.push('--external-mind', `${name}=${cmd}`);
  const child = spawn(exe, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { if ((await ctl.call({ op: 'svc.ping' })).ok) return ctl; } catch { /* starting */ }
  }
  throw new Error(`aios-agent-control did not come up on :${port} (see ${path.join(dir, 'service.log')})`);
}
