#!/usr/bin/env node
// AI OS ↔ converge bridge. An out-of-kernel intelligence speaking the frame
// protocol on stdio, backed by the universal agent's model interface
// (providers.cjs callModel). The kernel has no idea this file exists: it is
// bound through `spawn_external_intelligence` like any other peer, and can be
// swapped for a native model without touching anything above this line.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAGIC = Buffer.from('AOSX');
const T = { Hello: 1, Perceive: 2, Think: 3, Act: 4, Error: 0x7f };

function findProviders() {
  const candidates = [
    process.env.CONVERGE_PROVIDERS,
    path.resolve(__dirname, 'providers.cjs'),                   // the one beside this file (agents/universal)
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// The machine's own settings file, the one `aos` writes: KEY=VALUE per line,
// '#' comments. This is where a person sets which model this machine thinks
// with, so it has to be read -- it was not, which is why a machine whose
// aos.conf said claude-cli/sonnet went on running whatever
// ~/.converge/config.json happened to name.
function loadMachineConf() {
  const out = {};
  const files = [process.env.AOS_CONF, path.join(os.homedir(), '.config', 'aos.conf')].filter(Boolean);
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      let v = line.slice(eq + 1).trim();
      if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))))
        v = v.slice(1, -1);
      out[line.slice(0, eq).trim()] = v;
    }
    break;
  }
  return out;
}

function loadConfig() {
  const cfg = {};
  if (process.env.CONVERGE_PROVIDERS_JSON) {
    // converge keeps the providers in ASQL and hands them over here: no file is read.
    try { Object.assign(cfg, JSON.parse(process.env.CONVERGE_PROVIDERS_JSON)); } catch (e) { process.stderr.write(`CONVERGE_PROVIDERS_JSON is not JSON: ${e.message}\n`); }
  } else {
    const files = [process.env.AIOS_AGENT_CONFIG, path.join(process.cwd(), 'universal-agent.config.json'), path.join(os.homedir(), '.converge', 'config.json')].filter(Boolean);
    for (const f of files) {
      try { Object.assign(cfg, JSON.parse(fs.readFileSync(f, 'utf8'))); break; } catch { /* next */ }
    }
  }
  // aos.conf is this machine's choice and outranks the harness-wide default it
  // inherited; an explicit AIOS_* in the environment still outranks both.
  const mc = loadMachineConf();
  if (mc.AOS_PROVIDER) cfg.provider = mc.AOS_PROVIDER;
  if (mc.AOS_MODEL) cfg.model = mc.AOS_MODEL;
  if (mc.AOS_MODEL_HOST) cfg.host = mc.AOS_MODEL_HOST;
  // A host carried over from the harness default belongs to that provider, not
  // to the one aos.conf just named.
  if (mc.AOS_PROVIDER && !mc.AOS_MODEL_HOST && cfg.provider !== 'ollama') delete cfg.host;
  // The CLIs this machine thinks with live in the user's own bin, which a
  // systemd unit's sanitised PATH does not include.
  if (mc.AOS_PATH && !String(process.env.PATH || '').includes(mc.AOS_PATH.split(':')[0]))
    process.env.PATH = mc.AOS_PATH + ':' + (process.env.PATH || '');
  if (process.env.AIOS_MODEL_PROVIDER) cfg.provider = process.env.AIOS_MODEL_PROVIDER;
  if (process.env.AIOS_MODEL) cfg.model = process.env.AIOS_MODEL;
  if (process.env.AIOS_MODEL_HOST) cfg.host = process.env.AIOS_MODEL_HOST;
  if (process.env.AIOS_MODEL_KEY) cfg.apiKey = process.env.AIOS_MODEL_KEY;
  // the harness keeps per-provider keys under apiKeys; the chosen provider's key applies.
  if (!cfg.apiKey && cfg.apiKeys && cfg.provider && cfg.apiKeys[cfg.provider]) cfg.apiKey = cfg.apiKeys[cfg.provider];
  if (process.env.AIOS_MODEL_PROVIDER && !process.env.AIOS_MODEL_HOST && cfg.providers && cfg.providers[cfg.provider] && cfg.providers[cfg.provider].host) cfg.host = cfg.providers[cfg.provider].host;
  else if (process.env.AIOS_MODEL_PROVIDER && !process.env.AIOS_MODEL_HOST && cfg.provider !== 'ollama') delete cfg.host;   // the ollama host does not apply to another provider
  return cfg;
}

function writeFrame(type, payload) {
  const hdr = Buffer.alloc(9);
  MAGIC.copy(hdr, 0);
  hdr[4] = type;
  hdr.writeUInt32LE(payload.length, 5);
  process.stdout.write(Buffer.concat([hdr, payload]));
}
const fail = (msg) => writeFrame(T.Error, Buffer.from(String(msg)));

// The intelligence's own working notion of its situation. It is NOT kernel
// state: the kernel holds the entity's state objects; this is the bridge's
// running interpretation, rebuilt from the context it is handed every cycle.
// An agent's surface can be one long reply — a whole document, written in one
// go — and the provider layer's default patience is two minutes of silence,
// tuned for a chat turn. The mind timed out mid-sentence on long runs.
// Nine minutes — inside the kernel's own ten-minute wait for a peer — unless the operator said otherwise.
if (!process.env.AGENT_CALL_TIMEOUT) process.env.AGENT_CALL_TIMEOUT = '540000';

let providers = null;
let cfg = null;
let thought = Buffer.alloc(0);

const SYSTEM = [
  'You are the intelligence occupying an entity in an operating system built for intelligence.',
  'You receive the entity\'s current context state as bytes rendered as text. Your reply becomes the entity\'s next state.',
  'If the context defines how the entity may act (a protocol such as "run:" / "answer:" lines), follow it exactly and reply in that form only.',
  'Otherwise reply with a concise continuation of the entity\'s situation — what it now holds to be true, what it has decided, what it is doing next.',
].join(' ');

async function think(contextBytes) {
  if (!providers) throw new Error('providers.cjs not found beside the bridge (set CONVERGE_PROVIDERS)');
  if (!cfg || !cfg.provider || !cfg.model) throw new Error('no model configured: add a key in the dashboard, or set AIOS_MODEL_PROVIDER/AIOS_MODEL/AIOS_MODEL_HOST/AIOS_MODEL_KEY');
  const text = contextBytes.toString('utf8');
  const res = await providers.callModel({
    provider: cfg.provider, model: cfg.model, host: cfg.host, apiKey: cfg.apiKey,
    system: SYSTEM,
    messages: [{ role: 'user', content: text.length ? text : '(empty context: the entity has just come into existence)' }],
    maxTokens: Number(process.env.AIOS_MIND_MAX_TOKENS) || 16384,   // a whole surface has to fit in one reply
    // AIOS_MIND_EFFORT=off turns a reasoning model's thinking off (providers.cjs applyEffort).
    ...(process.env.AIOS_MIND_EFFORT ? { effort: process.env.AIOS_MIND_EFFORT } : {}),
  });
  return Buffer.from(String(res && res.text || '').trim());
}

async function handle(type, payload) {
  switch (type) {
    case T.Hello: {
      const p = findProviders();
      if (p) { try { providers = require(p); } catch (e) { return fail('providers.cjs failed to load: ' + e.message); } }
      cfg = loadConfig();
      const name = `bridge:${cfg.provider || 'unconfigured'}/${cfg.model || '?'}`;
      return writeFrame(T.Hello, Buffer.from(name));
    }
    case T.Perceive: return writeFrame(T.Perceive, payload);
    case T.Think: {
      try { thought = await think(payload); } catch (e) { return fail(e.message); }
      return writeFrame(T.Think, thought);
    }
    case T.Act: {
      // payload = bytes(perceived) bytes(thought) in the kernel's native encoding
      let off = 0;
      const n1 = Number(payload.readBigUInt64LE(off)); off += 8; off += n1;
      const n2 = Number(payload.readBigUInt64LE(off)); off += 8;
      const th = payload.subarray(off, off + n2);
      return writeFrame(T.Act, th.length ? th : thought);
    }
    default: return fail('unknown frame type ' + type);
  }
}

let buf = Buffer.alloc(0);
let busy = Promise.resolve();
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    // A wire can carry noise before the first frame (firmware and loader chatter
    // on a shared serial line): resynchronise on the magic instead of dying.
    const at = buf.indexOf(MAGIC);
    if (at < 0) { buf = buf.subarray(Math.max(0, buf.length - 3)); return; }
    if (at > 0) buf = buf.subarray(at);
    if (buf.length < 9) return;
    const type = buf[4];
    const len = buf.readUInt32LE(5);
    if (buf.length < 9 + len) return;
    const payload = buf.subarray(9, 9 + len);
    buf = buf.subarray(9 + len);
    busy = busy.then(() => handle(type, Buffer.from(payload)));
  }
});
process.stdin.on('end', () => busy.then(() => process.exit(0)));
