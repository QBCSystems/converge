// ASQL for the local platform, started here when nothing is serving it: `npm run dev` needs nothing else running.
// Sign-in, stored provider keys and the Cloudflare config live in ASQL (lib/asql.mjs connects to it). The kernel
// bundle carries the server (kernel/<os>-<arch>/bin/aios-server); when the configured host is this machine and
// nothing answers on the port, it is started on 127.0.0.1 with its data in ~/.converge-local/asql
// (CONVERGE_ASQL_ROOT moves it) and its output in ~/.converge-local/asql.log. One that is already running (a
// previous dev server's, or one of your own) is used as it is. Remote hosts and sockets are never started here.
// It requires a password: checks and agents run fenced but with network, and a loopback ASQL that let any local
// client in would be theirs to read. The password is AIOS_MYSQL_PASS_FILE, else ~/.converge-local/asql.pass (made
// here, random, owner-only; lib/asql.mjs reads the same file), which neither fence lets a check or an agent read.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { makePrivate, writePrivate } from './private-file.mjs';
import { kernelBin, kernelHint } from '../../agents/common.mjs';
import { asqlPort } from './asql-port.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function answers(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * Make sure ASQL answers. Returns the child process when this call started it (the caller stops it on exit), or null
 * when one was already there, it is not this machine's to start, or it could not be started (`warn` says why).
 */
export async function ensureAsql({ log, warn }) {
  if (process.env.AIOS_MYSQL_SOCKET || process.env.CONVERGE_ASQL === 'off') return null;
  const host = process.env.AIOS_MYSQL_HOST || '127.0.0.1';
  const port = asqlPort(process.env);
  if (!LOOPBACK.has(host)) return null;
  if (await answers(host, port)) return null;

  const bin = kernelBin('aios-server');
  if (!bin) { warn('asql', `nothing on ${host}:${port} and no aios-server in this machine's kernel folder (${kernelHint()})`); return null; }
  const state = path.resolve(process.env.CONVERGE_LOCAL_STATE || path.join(os.homedir(), '.converge-local'));   // local.sh's state dir, as for everything else
  const root = path.resolve(process.env.CONVERGE_ASQL_ROOT || path.join(state, 'asql'));
  fs.mkdirSync(root, { recursive: true });
  const user = process.env.AIOS_MYSQL_USER || 'root';
  const passFile = path.resolve(process.env.AIOS_MYSQL_PASS_FILE || path.join(state, 'asql.pass'));
  if (!fs.existsSync(passFile) || !fs.readFileSync(passFile, 'utf8').trim()) {
    fs.mkdirSync(path.dirname(passFile), { recursive: true });
    writePrivate(passFile, `${randomBytes(24).toString('hex')}\n`);
  } else makePrivate(passFile);   // one made before this restricted it (Windows ignored its 0600)
  const out = fs.openSync(path.join(state, 'asql.log'), 'a');
  const child = spawn(bin, ['--port', String(port), '--bind', '127.0.0.1', '--root', root, '--user', user, '--pass-file', passFile], {
    stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, AIOS_NO_ACCEL: process.env.AIOS_NO_ACCEL || '1' },
  });
  fs.closeSync(out);
  let exited = null;
  child.once('exit', (code, sig) => { exited = sig || code; });
  child.once('error', (e) => { exited = e.message; });
  for (const until = Date.now() + 20_000; Date.now() < until;) {
    if (exited !== null) break;
    if (await answers(host, port)) {
      log('asql', `started ASQL on ${host}:${port} (${path.basename(bin)}, data in ${root})`);
      return child;
    }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  if (exited === null) { try { child.kill(); } catch { /* gone */ } }
  warn('asql', `${bin} did not come up on ${host}:${port}${exited !== null ? ` (exited: ${exited})` : ''}: see ${path.join(state, 'asql.log')}`);
  return null;
}
