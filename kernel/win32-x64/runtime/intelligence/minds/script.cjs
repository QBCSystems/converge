#!/usr/bin/env node
// A scripted aios mind: speaks the same AOSX frame protocol as the bridge mind, but instead of a
// model it answers each cycle with the next line of a script (one line per cycle). It is how
// containment is tested without a model: the script plays an adversarial agent through the real
// path (agent-control, capabilities, the runtime, the sandbox), and every attempt has to be refused
// and recorded. The script path arrives as AIOS_MODEL (agent.bind_mind {"model": "<path>"}).
'use strict';
const fs = require('fs');

const MAGIC = Buffer.from('AOSX');
const T = { Hello: 1, Perceive: 2, Think: 3, Act: 4, Error: 0x7f };
const lines = (() => {
  try { return fs.readFileSync(process.env.AIOS_MODEL || '', 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')); }
  catch { return []; }
})();
// Position survives a respawn (an aios rewind rebinds a fresh mind process): <script>.pos.
const posFile = (process.env.AIOS_MODEL || '') + '.pos';
let next = (() => { try { return Number(fs.readFileSync(posFile, 'utf8')) || 0; } catch { return 0; } })();
const advance = () => { next++; try { fs.writeFileSync(posFile, String(next)); } catch { /* read-only: restart from 0 */ } };
let thought = Buffer.alloc(0);

function writeFrame(type, payload) {
  const hdr = Buffer.alloc(9);
  MAGIC.copy(hdr, 0);
  hdr[4] = type;
  hdr.writeUInt32LE(payload.length, 5);
  process.stdout.write(Buffer.concat([hdr, payload]));
}

function handle(type, payload) {
  switch (type) {
    case T.Hello: return writeFrame(T.Hello, Buffer.from(`replay:${lines.length} steps`));
    case T.Perceive: return writeFrame(T.Perceive, payload);
    case T.Think:
      thought = Buffer.from(next < lines.length ? lines[next] : '{"action":"done","summary":"script finished"}');
      if (next < lines.length) advance();
      return writeFrame(T.Think, thought);
    case T.Act: return writeFrame(T.Act, thought);
    default: return writeFrame(T.Error, Buffer.from('unknown frame ' + type));
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const at = buf.indexOf(MAGIC);
    if (at < 0) { buf = buf.subarray(Math.max(0, buf.length - 3)); return; }
    if (at > 0) buf = buf.subarray(at);
    if (buf.length < 9) return;
    const len = buf.readUInt32LE(5);
    if (buf.length < 9 + len) return;
    const type = buf[4];
    const payload = buf.subarray(9, 9 + len);
    buf = buf.subarray(9 + len);
    handle(type, Buffer.from(payload));
  }
});
