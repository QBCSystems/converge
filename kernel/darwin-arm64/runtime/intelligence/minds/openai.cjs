#!/usr/bin/env node
// An aios mind for any OpenAI-compatible chat API: speaks the AOSX frame protocol on stdio (the
// same one the bridge mind speaks) and answers each Think frame with one chat
// completion. Node built-ins only. Register it with agent-control:
//   aios-agent-control --external-mind api="node intelligence/minds/openai.cjs"
// and bind it with agent.bind_mind {"kind":"external","mind":"api","provider":"deepseek","model":"..."}.
// Configuration comes from the environment (agent.bind_mind sets the first, third and fourth):
//   AIOS_MODEL_PROVIDER  deepseek | openai | openrouter | ollama   (selects the default host/key)
//   AIOS_MODEL_HOST      overrides the provider's base URL
//   AIOS_MODEL           the model name
//   AIOS_MIND_EFFORT     'off' disables deepseek thinking ({type: 'disabled'})
// The key is the provider's variable (DEEPSEEK_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY) in the
// environment agent-control was started with; it never passes through a request.
'use strict';
const http = require('node:http');
const https = require('node:https');

const MAGIC = Buffer.from('AOSX');
const T = { Hello: 1, Perceive: 2, Think: 3, Act: 4, Error: 0x7f };

const PROVIDERS = {
  deepseek: { host: 'https://api.deepseek.com', key: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  openai: { host: 'https://api.openai.com', key: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  openrouter: { host: 'https://openrouter.ai/api', key: 'OPENROUTER_API_KEY', model: 'openai/gpt-4o-mini' },
  ollama: { host: 'http://127.0.0.1:11434', key: null, model: 'llama3' },
};

const provider = process.env.AIOS_MODEL_PROVIDER || 'deepseek';
const preset = PROVIDERS[provider] || PROVIDERS.deepseek;
const baseUrl = (process.env.AIOS_MODEL_HOST || preset.host).replace(/\/+$/, '');
const model = process.env.AIOS_MODEL || preset.model;
const apiKey = preset.key ? process.env[preset.key] : undefined;
const effortOff = process.env.AIOS_MIND_EFFORT === 'off';

let thought = Buffer.alloc(0);

function writeFrame(type, payload) {
  const hdr = Buffer.alloc(9);
  MAGIC.copy(hdr, 0);
  hdr[4] = type;
  hdr.writeUInt32LE(payload.length, 5);
  process.stdout.write(Buffer.concat([hdr, payload]));
}

function fail(err) {
  writeFrame(T.Error, Buffer.from(String((err && err.message) || err)));
}

function callModel(userMessage) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(baseUrl + '/v1/chat/completions'); } catch (e) { return reject(e); }
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: userMessage }],
      stream: false,
      ...(provider === 'deepseek' && effortOff ? { thinking: { type: 'disabled' } } : {}),
    });
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      { protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('model HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
          let parsed;
          try { parsed = JSON.parse(data); } catch (e) { return reject(new Error('model returned invalid JSON')); }
          const choice = parsed && parsed.choices && parsed.choices[0];
          const content = choice && choice.message && choice.message.content;
          if (typeof content !== 'string') return reject(new Error('model returned no content'));
          resolve(content);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('model request timed out')));
    req.end(body);
  });
}

function handle(type, payload) {
  switch (type) {
    case T.Hello: return writeFrame(T.Hello, Buffer.from(`api-mind:${provider}/${model}`));
    case T.Perceive: return writeFrame(T.Perceive, payload);
    case T.Think:
      callModel(payload.toString('utf8')).then(
        (answer) => { thought = Buffer.from(answer); writeFrame(T.Think, thought); },
        (err) => fail(err),
      );
      return;
    case T.Act: return writeFrame(T.Act, thought);
    default: return fail(new Error('unknown frame ' + type));
  }
}

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
    try { handle(type, Buffer.from(payload)); } catch (e) { fail(e); }
  }
});

let buf = Buffer.alloc(0);
