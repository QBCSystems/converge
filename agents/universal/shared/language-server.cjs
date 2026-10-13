'use strict';

// Optional, lazy LSP client. the harness keeps its zero-dependency index/checker path;
// this module only starts a language server already present in the project or
// on PATH, and only after code_intelligence is called.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

const SPECS = [
  { id: 'typescript', extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'], commands: [['typescript-language-server', '--stdio']], local: 'typescript-language-server' },
  { id: 'python', extensions: ['.py'], commands: [['pyright-langserver', '--stdio'], ['pylsp']], local: 'pyright-langserver' },
  { id: 'go', extensions: ['.go'], commands: [['gopls']] },
  { id: 'rust', extensions: ['.rs'], commands: [['rust-analyzer']] },
  { id: 'clangd', extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'], commands: [['clangd']] },
];

function runnable(command) {
  const r = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 3000 });
  return !r.error && r.status === 0;
}

function detectServer(workdir, file, available = runnable) {
  const ext = path.extname(file).toLowerCase();
  const spec = SPECS.find((s) => s.extensions.includes(ext));
  if (!spec) return null;
  if (spec.local) {
    const local = path.join(workdir, 'node_modules', '.bin', process.platform === 'win32' ? `${spec.local}.cmd` : spec.local);
    if (fs.existsSync(local)) return { id: spec.id, command: local, args: spec.commands[0].slice(1) };
  }
  for (const [command, ...args] of spec.commands) if (available(command)) return { id: spec.id, command, args };
  return { id: spec.id, unavailable: true, tried: spec.commands.map((c) => c[0]) };
}

function languageId(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.js': 'javascript', '.jsx': 'javascriptreact', '.ts': 'typescript', '.tsx': 'typescriptreact', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hpp': 'cpp' })[ext] || ext.slice(1);
}

function positionFor(text, line, character, symbol) {
  if (line != null) return { line: Math.max(0, Number(line) - 1), character: Math.max(0, Number(character) || 0) };
  if (!symbol) throw new Error('give line (1-based) or symbol');
  const lines = text.split(/\r?\n/);
  const escaped = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].search(re);
    if (at >= 0) return { line: i, character: at };
  }
  throw new Error(`symbol ${symbol} was not found in the file`);
}

class LspProcess {
  constructor(server, workdir, options = {}) {
    this.server = server; this.workdir = workdir; this.seq = 0; this.pending = new Map(); this.buffer = Buffer.alloc(0);
    this.timeoutMs = options.timeoutMs || 15000;
    this.child = (options.spawn || spawn)(server.command, server.args, { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.stderr = '';
    this.child.stdout.on('data', (b) => this.onData(b));
    this.child.stderr.on('data', (b) => { this.stderr = (this.stderr + b).slice(-2000); });
    this.child.on('error', (e) => this.failAll(e));
    this.child.on('exit', (code) => this.failAll(new Error(`${server.id} language server exited ${code}${this.stderr ? `: ${this.stderr.trim()}` : ''}`)));
  }
  send(message) {
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${this.timeoutMs}ms`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString();
      const match = /Content-Length:\s*(\d+)/i.exec(head);
      if (!match) { this.buffer = this.buffer.subarray(end + 4); continue; }
      const length = Number(match[1]);
      if (this.buffer.length < end + 4 + length) return;
      const raw = this.buffer.subarray(end + 4, end + 4 + length).toString();
      this.buffer = this.buffer.subarray(end + 4 + length);
      let msg; try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error))); else p.resolve(msg.result);
      } else if (msg.id != null && msg.method) {
        // Servers may request workspace/configuration during initialization.
        this.send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'workspace/configuration' ? [] : null });
      }
    }
  }
  failAll(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  async initialize() {
    const rootUri = pathToFileURL(this.workdir).href;
    const result = await this.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: path.basename(this.workdir) }], capabilities: { textDocument: { definition: {}, references: {}, documentSymbol: {}, callHierarchy: {} }, workspace: { symbol: {} } } });
    this.notify('initialized', {});
    this.capabilities = (result && result.capabilities) || {};
  }
  close() { try { this.notify('exit'); } catch {} try { this.child.kill(); } catch {} }
}

class LanguageServerManager {
  constructor(workdir, options = {}) { this.workdir = path.resolve(workdir); this.options = options; this.clients = new Map(); }
  async clientFor(file) {
    const server = (this.options.detectServer || detectServer)(this.workdir, file);
    if (!server) throw new Error(`no language-server mapping for ${path.extname(file) || 'this file type'}`);
    if (server.unavailable) throw new Error(`${server.id} language server is not installed (tried: ${server.tried.join(', ')}); use search_code/search_index and check_diagnostics fallback`);
    if (!this.clients.has(server.id)) {
      const client = new LspProcess(server, this.workdir, this.options);
      this.clients.set(server.id, client);
      try { await client.initialize(); } catch (e) { this.clients.delete(server.id); client.close(); throw e; }
    }
    return this.clients.get(server.id);
  }
  async query({ action, file, line, character, symbol, query, includeDeclaration = true }) {
    const abs = path.resolve(this.workdir, String(file || ''));
    if (abs !== this.workdir && !abs.startsWith(this.workdir + path.sep)) throw new Error('file is outside the workdir');
    if (!fs.statSync(abs).isFile()) throw new Error(`no such file: ${file}`);
    const client = await this.clientFor(abs);
    if (action === 'workspace_symbols') return { server: client.server.id, result: await client.request('workspace/symbol', { query: String(query || symbol || '') }) };
    const text = fs.readFileSync(abs, 'utf8');
    const uri = pathToFileURL(abs).href;
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageId(abs), version: 1, text } });
    let result;
    if (action === 'document_symbols') result = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    else {
      const position = positionFor(text, line, character, symbol);
      const at = { textDocument: { uri }, position };
      if (action === 'definition') result = await client.request('textDocument/definition', at);
      else if (action === 'references') result = await client.request('textDocument/references', { ...at, context: { includeDeclaration: includeDeclaration !== false } });
      else if (action === 'incoming_calls' || action === 'outgoing_calls') {
        const items = await client.request('textDocument/prepareCallHierarchy', at) || [];
        result = [];
        for (const item of items.slice(0, 10)) result.push(...((await client.request(`callHierarchy/${action === 'incoming_calls' ? 'incomingCalls' : 'outgoingCalls'}`, { item })) || []));
      } else throw new Error(`unknown action: ${action}`);
    }
    return { server: client.server.id, result };
  }
  close() { for (const c of this.clients.values()) c.close(); this.clients.clear(); }
}

function displayLocation(workdir, location) {
  const loc = location && (location.location || location.from || location.to || location);
  const uri = loc && (loc.uri || (loc.targetUri));
  const range = loc && (loc.range || loc.targetSelectionRange || loc.targetRange);
  let file = uri || '';
  try { if (uri && uri.startsWith('file:')) file = path.relative(workdir, fileURLToPath(uri)).split(path.sep).join('/'); } catch {}
  const pos = range && range.start;
  return `${file || location.name || '(unknown)'}${pos ? `:${pos.line + 1}:${pos.character + 1}` : ''}${location.name ? ` — ${location.name}` : ''}`;
}

function formatResult(workdir, response) {
  const list = response.result == null ? [] : Array.isArray(response.result) ? response.result : [response.result];
  if (!list.length) return `${response.server}: no results`;
  return `${response.server}: ${list.length} result(s)\n${list.slice(0, 200).map((x) => displayLocation(workdir, x)).join('\n')}${list.length > 200 ? '\n(capped at 200)' : ''}`;
}

module.exports = { SPECS, detectServer, positionFor, LspProcess, LanguageServerManager, formatResult, displayLocation };
