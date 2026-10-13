// A real ASQL for tests: the aios binary serving MySQL wire on a free loopback port, in a temp root, with a random password.
// startAsql() resolves { client, stop } (an AsqlClient already pointed at it), or null when no aios binary is built here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsqlClient } from '../../scripts/lib/asql.mjs';
import { kernelBin } from '../../agents/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function aiosBin() {
  const cands = [process.env.AIOS_BIN, process.env.AIOS_DIR && path.join(process.env.AIOS_DIR, 'build', 'aios')];
  return cands.find((c) => c && fs.existsSync(c)) || '';
}
// Else the ASQL server from this machine's kernel bundle (kernel/<os>-<arch>/bin/aios-server, what npm run dev starts):
// on a unix socket only and trusting local clients, so the password is not checked - the tests here do not depend on it.
export const asqlServerBin = () => kernelBin('aios-server', ROOT);
export const asqlMissing = () => (aiosBin() || asqlServerBin() ? false : 'no aios binary (set AIOS_BIN) and no aios-server in kernel/<os>-<arch>/bin');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

// A unix socket's path has room for about 100 bytes (104 on macOS, 108 on Linux and Windows). The test's own temp folder
// first (a check jail's is short, and it may write nowhere else); where that is too deep (an agent's, under its run
// folder) the system's /tmp, which the agent's fence lets it write.
const SOCKET_ROOM = 100;
function socketHome() {
  const tried = [];
  for (const base of [os.tmpdir(), process.platform === 'win32' ? '' : '/tmp'].filter(Boolean)) {
    const probe = path.join(base, 'converge-asql-XXXXXX', 's');
    if (Buffer.byteLength(probe) >= SOCKET_ROOM) { tried.push(`${base} (too deep)`); continue; }
    try { return fs.mkdtempSync(path.join(base, 'converge-asql-')); } catch (e) { tried.push(`${base} (${e.code || e.message})`); }
  }
  throw new Error(`no folder short enough for ASQL's unix socket: ${tried.join(', ')}`);
}

export async function startAsql() {
  // The kernel bundle's aios-server first (it serves a unix socket); a full aios build only where there is none.
  const server = asqlServerBin();
  const bin = server ? '' : aiosBin();
  if (!bin && !server) return null;
  const dir = server ? socketHome() : fs.mkdtempSync(path.join(os.tmpdir(), 'converge-asql-'));
  const password = randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(dir, 'pass'), password, { mode: 0o600 });
  fs.mkdirSync(path.join(dir, 'root'));
  let child, client;
  if (server) {
    // A unix socket in the test's own temp folder, and no TCP port: a check sandbox allows sockets in its own
    // folders and no network at all, loopback included (converge-jail).
    const sock = path.join(dir, 's');
    child = spawn(server, ['--socket', sock, '--root', path.join(dir, 'root')], { stdio: 'ignore', windowsHide: true });
    client = new AsqlClient({ host: '127.0.0.1', port: 0, socketPath: sock, user: 'root', password, database: '' });
  } else {
    const [mysql, rpc] = [await freePort(), await freePort()];
    child = spawn(bin, ['--root', path.join(dir, 'root'), 'exec', `compute serve port=${rpc} lanes=2 sql=1 mysql_port=${mysql} mysql_bind=127.0.0.1 mysql_user=root mysql_pass_file=${path.join(dir, 'pass')}`], { stdio: 'ignore' });
    client = new AsqlClient({ host: '127.0.0.1', port: mysql, socketPath: '/nonexistent', user: 'root', password, database: '' });
  }
  for (let i = 0; i < 100; i++) {
    try { if (await client.connect()) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!client.connected) { child.kill(); throw new Error('ASQL did not come up'); }
  return {
    client,
    stop() { client.close(); child.kill(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {} },
  };
}
