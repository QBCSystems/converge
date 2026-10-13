// Helpers for the local dev stack (scripts/dev-server.mjs): grabbing a free TCP port for the
// embedded servers, polling until something is ready, and callbacks that write or edit files
// inside a scratch work tree.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().on('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Edit-callback replacing lines [from, to] (1-based) of `file` with "<tag> <n>". */
export const editLines = (file, from, to, tag) => (wt) => {
  const f = path.join(wt, file);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = from; i <= to; i++) lines[i - 1] = `${tag} ${i}`;
  fs.writeFileSync(f, lines.join('\n'));
};

export const writeFile = (file, content) => (wt) => {
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), content);
};

export const numberedLines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
