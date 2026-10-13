'use strict';
// AIOS Storage Bridge & Dual Gateway
//
// Bridges the converge harness, MCPs, GUI, and console tools to AIOS storage.
// Provides a unified database interface compatible with better-sqlite3 while
// unlocking AIOS microsecond RAM tables, Write-Behind WAL, and Tiered Residency.
//
// Operational Modes:
//  - 'duel'           : Side-by-side execution. Mutations hit AIOS (Write-Behind)
//                       and SQLite simultaneously. Measures latency delta, asserts
//                       read/write parity, and records telemetry.
//  - 'aios_primary'   : Fast path to AIOS. Microsecond local commit + instant ACK.
//                       Seamlessly falls back to SQLite on connection drop or error.
//  - 'sqlite_primary' : Traditional SQLite execution with optional async replication to AIOS.

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Universal SQLite Engine Resolver:
// 1. Attempts native Node.js 22+ built-in node:sqlite (DatabaseSync)
// 2. Attempts better-sqlite3
// 3. Fallback in-memory map
let SqliteEngine = null;
let sqliteEngineType = 'none';

try {
  const nodeSqlite = require('node:sqlite');
  if (nodeSqlite && nodeSqlite.DatabaseSync) {
    SqliteEngine = nodeSqlite.DatabaseSync;
    sqliteEngineType = 'node:sqlite';
  }
} catch {}

if (!SqliteEngine) {
  try {
    const betterSqlite = require('better-sqlite3');
    if (betterSqlite) {
      SqliteEngine = betterSqlite;
      sqliteEngineType = 'better-sqlite3';
    }
  } catch {}
}

// -----------------------------------------------------------------------------
// Pure-JS Minimal MySQL Wire Protocol Client (Zero external dependencies)
// -----------------------------------------------------------------------------

// The engine's tokenizer treats a backslash as an escape character inside
// ANY quoted string (single or double) -- `\X` always becomes just `X`,
// regardless of what X is. Escaping only quotes (doubling `'` to `''`) and
// leaving backslashes alone means every backslash already in the payload
// (`\"`, `\\`, `\n` -- all completely ordinary in real JSON text: escaped
// quotes, literal backslashes, Windows paths, newlines) gets silently eaten
// on the way in, corrupting the payload. Backslashes must be doubled FIRST,
// before quotes, so the tokenizer's own unescaping restores exactly one
// backslash for each one that was actually in the original string.
// Must match src/storage/object_store.cpp's StoredObject::is_tombstone(),
// which recognizes a payload only if it IS this exact string -- not JSON
// containing it. Shared here so the write side (delete()) and the read
// side (getPrimary()) can't drift apart from each other or from the engine.
const AIOS_TOMBSTONE_SENTINEL = '__aios_tombstone__';

// Write-behind retry budget. Deliberately small: this re-sends the LATEST
// version of at most this many distinct keys, so it covers an engine blip or a
// pool-saturation window (the failure actually seen in production) without
// turning into an unbounded in-RAM log of a busy console's whole history.
const AIOS_RETRY_MAX_KEYS = parseInt(process.env.AIOS_RETRY_MAX_KEYS || '512', 10);
const AIOS_RETRY_MAX_ATTEMPTS = parseInt(process.env.AIOS_RETRY_MAX_ATTEMPTS || '6', 10);
const AIOS_RETRY_BASE_MS = parseInt(process.env.AIOS_RETRY_BASE_MS || '500', 10);
const AIOS_RETRY_MAX_MS = parseInt(process.env.AIOS_RETRY_MAX_MS || '30000', 10);

// ---- write-behind coalescing -------------------------------------------
// Every set() used to fire its own INSERT immediately: JSON.stringify + a hex
// encode of the WHOLE value on the event loop, then one pooled query per call.
// For the console's conversation store that value is the entire ui trail, so a
// streaming turn paid a multi-megabyte encode and a pool acquire per tool
// event -- which is exactly how a 16-connection pool reached a 236-deep
// acquire queue and lost 118 writes to `pool acquire timeout` on chi.
//
// ASQL is append-only and readers take the newest version of a key, so every
// version but the last is dead weight. Coalesce by key over a short window and
// send one batched multi-row INSERT: one encode and one query for a burst
// instead of N of each. RAM is still updated synchronously, so readers never
// see a delay -- only the durable mirror is deferred, which is what
// "write-behind" already promised.
const AIOS_WB_COALESCE_MS = parseInt(process.env.AIOS_WB_COALESCE_MS || '120', 10);
// Cap a single INSERT's size: one 50-row batch of whole conversations is a
// multi-megabyte statement, and the wire client buffers it whole.
const AIOS_WB_MAX_SQL_BYTES = parseInt(process.env.AIOS_WB_MAX_SQL_BYTES || String(2 * 1024 * 1024), 10);

function sqlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function payloadString(val) {
  return typeof val === 'string' ? val : JSON.stringify(val);
}

function hexFromPayloadString(str) {
  if (!str || str.length === 0) return "''";
  return '0x' + Buffer.from(str, 'utf8').toString('hex');
}

function scramblePassword(password, scramble) {
  if (!password || !scramble || scramble.length < 20) return Buffer.alloc(0);
  const stage1 = crypto.createHash('sha1').update(password).digest();
  const stage2 = crypto.createHash('sha1').update(stage1).digest();
  const stage3 = crypto.createHash('sha1').update(scramble.subarray(0, 20)).update(stage2).digest();
  const reply = Buffer.alloc(stage1.length);
  for (let i = 0; i < stage1.length; i++) {
    reply[i] = stage1[i] ^ stage3[i];
  }
  return reply;
}

// Kept so callers that only want the hex literal are unchanged. The write
// paths below serialize ONCE and reuse the string for both the byte count
// and the hex, rather than stringifying the same payload twice.
function toHexPayload(val) {
  return hexFromPayloadString(payloadString(val));
}

// -----------------------------------------------------------------------------
// Where the AIOS engine actually is
// -----------------------------------------------------------------------------
const AIOS_ENGINE_PORT_CANDIDATES = [
  4406,  // AIOS's own reserved port, for a deployed aios-server
  13307  // what `aios exec compute serve mysql_port=...` is run on locally
];

function resolveAiosEndpoint(options = {}) {
  const explicitPort = options.port || process.env.AIOS_MYSQL_PORT;
  return {
    host: options.host || process.env.AIOS_MYSQL_HOST || '127.0.0.1',
    portCandidates: explicitPort
      ? [parseInt(explicitPort, 10)]
      : AIOS_ENGINE_PORT_CANDIDATES.slice(),
    portExplicit: !!explicitPort,
    user: options.user || process.env.AIOS_MYSQL_USER || 'root',
    password: options.password || process.env.AIOS_MYSQL_PASSWORD || '',
    database: options.database || process.env.AIOS_MYSQL_DATABASE || 'aios_db',
    requireAiosBanner: options.requireAiosBanner !== undefined
      ? options.requireAiosBanner
      : process.env.AIOS_MYSQL_ALLOW_ANY_SERVER !== '1'
  };
}

class MysqlWireClient {
  constructor(options = {}) {
    const endpoint = resolveAiosEndpoint(options);
    this.host = endpoint.host;
    this.portCandidates = endpoint.portCandidates;
    this.portExplicit = endpoint.portExplicit;
    this.requireAiosBanner = endpoint.requireAiosBanner && !endpoint.portExplicit;
    this.port = this.portCandidates[0];
    this.user = endpoint.user;
    this.password = endpoint.password;
    this.database = endpoint.database;
    this.serverVersion = null;
    this.lastConnectAttempts = [];
    this.lastConnectError = null;
    this.timeoutMs = options.idleTimeoutMs || options.timeoutMs || parseInt(process.env.AIOS_MYSQL_IDLE_TIMEOUT_MS || process.env.AIOS_MYSQL_TIMEOUT_MS || '30000', 10);
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this._connectPromise = null;
    this.seq = 0;
    this.buffer = Buffer.alloc(0);
    this.requestQueue = [];
    this.inFlight = null;
  }

  async connect() {
    if (this.connected && this.socket && !this.socket.destroyed) {
      return true;
    }
    if (this._connectPromise) {
      return this._connectPromise;
    }

    this.connecting = true;
    const done = (ok) => {
      this.connecting = false;
      this._connectPromise = null;
      return ok;
    };
    this._connectPromise = this._connectAnyCandidate().then(done, () => done(false));
    return this._connectPromise;
  }

  // Walk the candidate ports and keep the first that is reachable AND proves
  // it is AIOS. Every rejection is recorded so diagnostics can say WHY there
  // is no connection instead of just reporting aios_connected: false.
  async _connectAnyCandidate() {
    const attempts = [];
    for (const port of this.portCandidates) {
      this.lastConnectError = null;
      const ok = await this._connectToPort(port);
      if (!ok) {
        attempts.push({ port, accepted: false, reason: this.lastConnectError || 'unreachable' });
        continue;
      }
      this.port = port;
      attempts.push({ port, accepted: true, server_version: this.serverVersion });
      this.lastConnectAttempts = attempts;
      return true;
    }
    this.lastConnectAttempts = attempts;
    return false;
  }

  _connectToPort(port) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      const sock = net.createConnection({ host: this.host, port }, () => {
        this.socket = sock;
        this.buffer = Buffer.alloc(0);
      });

      sock.setTimeout(this.timeoutMs);

      let handshakeState = 'init'; // 'init' -> 'auth_sent' -> 'ready'

      const onError = (err) => {
        this.connected = false;
        // "unreachable" was reported for every failure, including a server
        // that answered and refused our credentials. Keep what actually
        // happened so the candidate walk can say so.
        this.lastConnectError = err && err.message ? err.message : 'connect failed';
        this._drainQueue(err);
        try { sock.destroy(); } catch {}
        finish(false);
      };

      sock.on('error', onError);
      sock.on('timeout', () => {
        onError(new Error('AIOS socket timeout'));
      });

      sock.on('close', () => {
        this.connected = false;
        this._drainQueue(new Error('AIOS socket closed'));
        finish(false);
      });

      sock.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        
        if (handshakeState === 'init') {
          const pkt = this._readPacket();
          if (pkt) {
            try {
              const version = this._readServerVersion(pkt);
              if (this.requireAiosBanner && !/aios/i.test(version || '')) {
                this.lastConnectError =
                  `not an AIOS engine (server reported "${version || 'no version'}")`;
                try { sock.destroy(); } catch {}
                finish(false);
                return;
              }
              this._handleInitialHandshake(pkt);
              handshakeState = 'auth_sent';
            } catch (err) {
              onError(err);
              return;
            }
          }
        }
        
        if (handshakeState === 'auth_sent') {
          const pkt = this._readPacket();
          if (pkt) {
            if (pkt.payload[0] === 0xFF) {
              onError(new Error('Authentication failed'));
              return;
            } else if (pkt.payload[0] === 0x00 || pkt.payload[0] === 0xFE) {
              // Auth OK!
              handshakeState = 'ready';
              this.connected = true;
              finish(true);
              this._sendNext();
            }
          }
        } else if (handshakeState === 'ready') {
          this._processIncomingPackets();
        }
      });
    });
  }

  _readPacket() {
    if (this.buffer.length < 4) return null;
    const len = this.buffer[0] | (this.buffer[1] << 8) | (this.buffer[2] << 16);
    const totalLen = len + 4;
    if (this.buffer.length < totalLen) return null;

    const seq = this.buffer[3];
    const payload = this.buffer.slice(4, totalLen);
    this.buffer = this.buffer.slice(totalLen);
    this.seq = (seq + 1) & 0xFF;
    return { seq, payload };
  }

  _writePacket(payload, seq) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Socket not connected');
    }
    const len = payload.length;
    const header = Buffer.alloc(4);
    header[0] = len & 0xFF;
    header[1] = (len >> 8) & 0xFF;
    header[2] = (len >> 16) & 0xFF;
    header[3] = (seq !== undefined ? seq : this.seq) & 0xFF;
    this.socket.write(Buffer.concat([header, payload]));
    this.seq = ((header[3] + 1) & 0xFF);
  }

  // Greeting packet: protocol version byte, then a NUL-terminated server
  // version string. Nothing used to read it. It is the only thing on the wire
  // that says whether this is AIOS or some other MySQL-speaking server that
  // happened to be on the port, and it arrives BEFORE we send credentials --
  // so the candidate walk can reject a stranger without ever authenticating
  // to it.
  _readServerVersion(pkt) {
    try {
      const end = pkt.payload.indexOf(0x00, 1);
      this.serverVersion = end > 1 ? pkt.payload.slice(1, end).toString('latin1') : null;
    } catch {
      this.serverVersion = null;
    }
    return this.serverVersion;
  }

  _handleInitialHandshake(pkt) {
    let scramble = Buffer.alloc(0);
    if (this.password) {
      try {
        const nullIdx = pkt.payload.indexOf(0, 1);
        let pos = nullIdx + 1;
        pos += 4; // threadId
        const salt1 = pkt.payload.slice(pos, pos + 8); pos += 8;
        pos += 1; // filter byte
        pos += 2; // serverCaps
        pos += 1; // charset
        pos += 2; // status
        pos += 2; // serverCaps high
        const authPluginDataLen = pkt.payload[pos]; pos += 1;
        pos += 10; // reserved
        const salt2Len = Math.max(12, authPluginDataLen - 8);
        const salt2 = pkt.payload.slice(pos, pos + 12);
        scramble = Buffer.concat([salt1, salt2]);
      } catch {}
    }

    const clientFlags = 0x00000200 | 0x00008000 | 0x00000008; // CLIENT_PROTOCOL_41 | CLIENT_PLUGIN_AUTH | CLIENT_CONNECT_WITH_DB
    const maxPacketSize = 0x01000000;
    const charset = 33; // utf8_general_ci

    const authResp = scramble.length >= 20 ? scramblePassword(this.password, scramble) : Buffer.alloc(0);

    const resp = Buffer.alloc(512);
    let offset = 0;

    resp.writeUInt32LE(clientFlags, offset); offset += 4;
    resp.writeUInt32LE(maxPacketSize, offset); offset += 4;
    resp.writeUInt8(charset, offset); offset += 1;
    resp.fill(0, offset, offset + 23); offset += 23; // reserved 23 bytes

    const userBuf = Buffer.from(this.user, 'utf8');
    userBuf.copy(resp, offset);
    offset += userBuf.length;
    resp[offset++] = 0; // null terminator

    if (authResp.length > 0) {
      resp.writeUInt8(authResp.length, offset); offset += 1;
      authResp.copy(resp, offset); offset += authResp.length;
    } else {
      resp[offset++] = 0; // auth response len 0
    }

    if (this.database) {
      const dbBuf = Buffer.from(this.database, 'utf8');
      dbBuf.copy(resp, offset);
      offset += dbBuf.length;
      resp[offset++] = 0;
    }

    const pluginBuf = Buffer.from("mysql_native_password\0", "utf8");
    pluginBuf.copy(resp, offset);
    offset += pluginBuf.length;

    this._writePacket(resp.slice(0, offset), 1);
  }

  _sendNext() {
    if (this.inFlight || this.requestQueue.length === 0) return;
    if (!this.connected || !this.socket || this.socket.destroyed) {
      return;
    }

    const item = this.requestQueue.shift();
    this.inFlight = item;
    item.columnsExpected = null;
    item.colEofReceived = false;
    item.columns = [];
    item.rows = [];

    const sqlBuf = Buffer.from(item.sql, 'utf8');
    const payload = Buffer.alloc(1 + sqlBuf.length);
    payload[0] = 0x03; // COM_QUERY
    sqlBuf.copy(payload, 1);

    try {
      this._writePacket(payload, 0);
    } catch (err) {
      this.inFlight = null;
      item.reject(err);
      this._sendNext();
    }
  }

  _processIncomingPackets() {
    if (!this.inFlight) return;
    const current = this.inFlight;

    while (this.buffer.length >= 4) {
      const pkt = this._readPacket();
      if (!pkt) break;

      const marker = pkt.payload[0];
      if (marker === 0xFF) {
        // ERR Packet
        const errCode = pkt.payload.length >= 3 ? pkt.payload.readUInt16LE(1) : 0;
        let errMsg = '';
        if (pkt.payload.length >= 9 && pkt.payload[3] === 0x23) { // '#' SQLSTATE
          errMsg = pkt.payload.slice(9).toString('utf8');
        } else if (pkt.payload.length > 3) {
          errMsg = pkt.payload.slice(3).toString('utf8');
        }
        const err = new Error(`MySQL Error (${errCode}): ${errMsg}`);
        this.inFlight = null;
        current.reject(err);
        this._sendNext();
        return;
      }

      if (current.columnsExpected === null) {
        if (marker === 0x00) {
          // OK Packet
          let affectedRows = 0;
          let insertId = 0;
          let pos = 1;
          const [aff, affLen] = this._readLenEncInt(pkt.payload, pos);
          affectedRows = aff; pos += affLen;
          const [ins, insLen] = this._readLenEncInt(pkt.payload, pos);
          insertId = ins; pos += insLen;

          this.inFlight = null;
          current.resolve({ affectedRows, insertId, rows: [] });
          this._sendNext();
          return;
        } else {
          // Resultset header: number of columns
          const [numCols, _] = this._readLenEncInt(pkt.payload, 0);
          current.columnsExpected = numCols;
          continue;
        }
      }

      // We are reading columns or EOF or rows
      if (current.columns.length < current.columnsExpected) {
        // Column definition packet
        const colDef = this._parseColumnDef(pkt.payload);
        current.columns.push(colDef);
        continue;
      }

      if (!current.colEofReceived && marker === 0xFE && pkt.payload.length < 9) {
        // Column EOF
        current.colEofReceived = true;
        continue;
      }

      if (marker === 0xFE && pkt.payload.length < 9) {
        // Row EOF
        this.inFlight = null;
        current.resolve({ affectedRows: current.rows.length, insertId: 0, rows: current.rows, columns: current.columns });
        this._sendNext();
        return;
      }

      // Row data packet
      const row = this._parseRowData(pkt.payload, current.columns);
      current.rows.push(row);
    }
  }

  _parseColumnDef(buf) {
    let pos = 0;
    const [catalog, cLen] = this._readLenEncString(buf, pos); pos += cLen;
    const [schema, sLen] = this._readLenEncString(buf, pos); pos += sLen;
    const [table, tLen] = this._readLenEncString(buf, pos); pos += tLen;
    const [orgTable, otLen] = this._readLenEncString(buf, pos); pos += otLen;
    const [name, nLen] = this._readLenEncString(buf, pos); pos += nLen;
    const [orgName, onLen] = this._readLenEncString(buf, pos); pos += onLen;
    return { name, table, schema };
  }

  _parseRowData(buf, columns) {
    const row = {};
    let pos = 0;
    for (let i = 0; i < columns.length; i++) {
      if (pos >= buf.length) break;
      if (buf[pos] === 0xFB) {
        row[columns[i].name] = null;
        pos += 1;
      } else {
        const [val, vLen] = this._readLenEncString(buf, pos);
        row[columns[i].name] = val;
        pos += vLen;
      }
    }
    return row;
  }

  _readLenEncInt(buf, offset) {
    if (offset >= buf.length) return [0, 0];
    const b0 = buf[offset];
    if (b0 < 0xFB) return [b0, 1];
    if (b0 === 0xFC) return [buf.readUInt16LE(offset + 1), 3];
    if (b0 === 0xFD) return [buf.readUIntLE(offset + 1, 3), 4];
    if (b0 === 0xFE) return [Number(buf.readBigUInt64LE(offset + 1)), 9];
    return [0, 1];
  }

  _readLenEncString(buf, offset) {
    const [len, intBytes] = this._readLenEncInt(buf, offset);
    if (len === 0) return ['', intBytes];
    const str = buf.slice(offset + intBytes, offset + intBytes + len).toString('utf8');
    return [str, intBytes + len];
  }

  _drainQueue(err) {
    if (this.inFlight) {
      const cur = this.inFlight;
      this.inFlight = null;
      cur.reject(err);
    }
    while (this.requestQueue.length > 0) {
      const item = this.requestQueue.shift();
      item.reject(err);
    }
  }

  async query(sql) {
    const isConn = await this.connect();
    if (!isConn) {
      throw new Error(`Cannot connect to AIOS MySQL wire server at ${this.host}:${this.port}`);
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({ sql, resolve, reject });
      this._sendNext();
    });
  }

  async vacuum() {
    return this.query('VACUUM OBJECTS');
  }

  async drain(timeoutMs = 5000) {
    const t0 = Date.now();
    while ((this.inFlight || this.requestQueue.length > 0) && (Date.now() - t0 < timeoutMs)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    this.close();
  }

  close() {
    this.connected = false;
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
  }
}

// -----------------------------------------------------------------------------
// MysqlWirePool: Multi-Connection Pool for Concurrent Write-Behinds & Queries
// -----------------------------------------------------------------------------

class MysqlWirePool {
  constructor(options = {}) {
    this.options = { ...options };
    const endpoint = resolveAiosEndpoint(options);
    this.host = endpoint.host;
    this.portCandidates = endpoint.portCandidates;
    this.portExplicit = endpoint.portExplicit;
    this.requireAiosBanner = endpoint.requireAiosBanner;
    this.port = this.portCandidates[0];
    this.portResolved = endpoint.portExplicit;
    this.serverVersion = null;
    this.lastConnectAttempts = [];
    this.user = endpoint.user;
    this.password = endpoint.password;
    this.database = endpoint.database;
    this.idleTimeoutMs = options.idleTimeoutMs || options.timeoutMs || parseInt(process.env.AIOS_MYSQL_IDLE_TIMEOUT_MS || process.env.AIOS_MYSQL_TIMEOUT_MS || '30000', 10);
    this.timeoutMs = this.idleTimeoutMs;
    this.minConnections = typeof options.minConnections === 'number' ? options.minConnections : 1;
    this.maxConnections = typeof options.maxConnections === 'number'
      ? options.maxConnections
      : parseInt(process.env.AIOS_MYSQL_POOL_MAX || '16', 10);
    this.acquireTimeoutMs = options.acquireTimeoutMs || 10000;

    this.allClients = new Set();
    this.idleClients = [];
    this.activeClients = new Set();
    this.waitQueue = [];
    this._closed = false;
    this.metrics = {
      totalCreated: 0,
      totalQueries: 0,
      totalFailedQueries: 0,
      peakConcurrent: 0,
      queuedRequests: 0,
      peakQueueDepth: 0
    };
  }

  get connected() {
    if (this._closed) return false;
    for (const client of this.allClients) {
      if (client.connected && client.socket && !client.socket.destroyed) {
        return true;
      }
    }
    return false;
  }

  _createClient() {
    const client = new MysqlWireClient({
      host: this.host,
      // Only pass a port once one is pinned; passing the provisional first
      // candidate would look "explicit" to the client and skip the walk.
      ...(this.portResolved ? { port: this.port } : {}),
      requireAiosBanner: this.requireAiosBanner,
      user: this.user,
      password: this.password,
      database: this.database,
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: this.idleTimeoutMs
    });
    if (!this.portResolved) client.portCandidates = this.portCandidates.slice();
    this.allClients.add(client);
    this.metrics.totalCreated++;
    return client;
  }

  // "Cannot connect" naming one port was misleading once several are tried,
  // and it never said why a reachable port was refused.
  _noEndpointError() {
    const tried = (this.lastConnectAttempts || [])
      .map((a) => `${a.port} (${a.reason || 'rejected'})`)
      .join(', ') || this.portCandidates.join(', ');
    return `Cannot connect to an AIOS MySQL wire server on ${this.host} — tried ${tried}`;
  }

  // Record where a client actually landed, so the pool reports the live
  // endpoint rather than the first thing it was going to try.
  _pinEndpoint(client) {
    if (!client || !client.connected) return;
    this.port = client.port;
    this.portResolved = true;
    this.serverVersion = client.serverVersion;
    if (client.lastConnectAttempts && client.lastConnectAttempts.length) {
      this.lastConnectAttempts = client.lastConnectAttempts;
    }
  }

  async connect() {
    if (this._closed) return false;
    for (const client of this.idleClients) {
      if (client.connected && client.socket && !client.socket.destroyed) {
        return true;
      }
    }
    const client = this._createClient();
    try {
      const ok = await client.connect();
      if (ok) {
        this._pinEndpoint(client);
        this.idleClients.push(client);
        return true;
      } else {
        this.allClients.delete(client);
        client.close();
        return false;
      }
    } catch {
      this.allClients.delete(client);
      client.close();
      return false;
    }
  }

  async acquire() {
    if (this._closed) {
      throw new Error('Connection pool is closed');
    }

    // 1. Try to find a healthy idle client
    while (this.idleClients.length > 0) {
      const client = this.idleClients.pop();
      if (client.connected && client.socket && !client.socket.destroyed) {
        this.activeClients.add(client);
        this._updatePeak();
        return client;
      } else {
        this.allClients.delete(client);
        client.close();
      }
    }

    // 2. If below maxConnections, create and connect a new client
    if (this.allClients.size < this.maxConnections) {
      const client = this._createClient();
      this.activeClients.add(client);
      this._updatePeak();
      try {
        const ok = await client.connect();
        if (!ok) {
          this.activeClients.delete(client);
          this.allClients.delete(client);
          client.close();
          throw new Error(this._noEndpointError());
        }
        this._pinEndpoint(client);
        return client;
      } catch (err) {
        this.activeClients.delete(client);
        this.allClients.delete(client);
        client.close();
        throw err;
      }
    }

    // 3. Pool saturated, wait in queue
    return new Promise((resolve, reject) => {
      let timer = null;
      const waitItem = {
        resolve: (client) => {
          if (timer) clearTimeout(timer);
          this.activeClients.add(client);
          this._updatePeak();
          resolve(client);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        }
      };

      if (this.acquireTimeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.waitQueue.indexOf(waitItem);
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
            this.metrics.queuedRequests = this.waitQueue.length;
            waitItem.reject(new Error(`AIOS connection pool acquire timeout (${this.acquireTimeoutMs}ms)`));
          }
        }, this.acquireTimeoutMs);
      }

      this.waitQueue.push(waitItem);
      this.metrics.queuedRequests = this.waitQueue.length;
      if (this.waitQueue.length > this.metrics.peakQueueDepth) {
        this.metrics.peakQueueDepth = this.waitQueue.length;
      }
    });
  }

  release(client) {
    this.activeClients.delete(client);

    if (this._closed || !client.connected || !client.socket || client.socket.destroyed) {
      this.allClients.delete(client);
      client.close();
      this._drainNextWaiter();
      return;
    }

    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      this.metrics.queuedRequests = this.waitQueue.length;
      next.resolve(client);
    } else {
      this.idleClients.push(client);
    }
  }

  async _drainNextWaiter() {
    if (this._closed || this.waitQueue.length === 0) return;
    if (this.allClients.size < this.maxConnections) {
      const next = this.waitQueue.shift();
      this.metrics.queuedRequests = this.waitQueue.length;
      try {
        const client = this._createClient();
        const ok = await client.connect();
        if (ok) {
          this._pinEndpoint(client);
          next.resolve(client);
        } else {
          this.allClients.delete(client);
          client.close();
          next.reject(new Error(this._noEndpointError()));
        }
      } catch (err) {
        next.reject(err);
      }
    }
  }

  _updatePeak() {
    const current = this.activeClients.size;
    if (current > this.metrics.peakConcurrent) {
      this.metrics.peakConcurrent = current;
    }
  }

  async query(sql, retryCount = 1) {
    this.metrics.totalQueries++;
    let client;
    try {
      client = await this.acquire();
    } catch (err) {
      this.metrics.totalFailedQueries++;
      throw err;
    }

    try {
      const res = await client.query(sql);
      this.release(client);
      return res;
    } catch (err) {
      this.release(client);
      if (retryCount > 0 && (!client.connected || (err && err.message && (err.message.includes('closed') || err.message.includes('Socket not connected') || err.message.includes('timeout'))))) {
        return this.query(sql, retryCount - 1);
      }
      this.metrics.totalFailedQueries++;
      throw err;
    }
  }

  getPoolStats() {
    return {
      total_connections: this.allClients.size,
      active_connections: this.activeClients.size,
      idle_connections: this.idleClients.length,
      queued_requests: this.waitQueue.length,
      max_connections: this.maxConnections,
      min_connections: this.minConnections,
      idle_timeout_ms: this.idleTimeoutMs,
      peak_concurrent_connections: this.metrics.peakConcurrent,
      peak_queue_depth: this.metrics.peakQueueDepth,
      total_queries: this.metrics.totalQueries,
      total_failed_queries: this.metrics.totalFailedQueries,
      total_created: this.metrics.totalCreated
    };
  }

  stats() {
    return this.getPoolStats();
  }

  async vacuum() {
    return this.query('VACUUM OBJECTS');
  }

  async drain(timeoutMs = 5000) {
    const t0 = Date.now();
    while ((this.activeClients.size > 0 || this.waitQueue.length > 0) && (Date.now() - t0 < timeoutMs)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    this.close();
  }

  close() {
    this._closed = true;
    for (const waitItem of this.waitQueue) {
      waitItem.reject(new Error('AIOS connection pool closed'));
    }
    this.waitQueue = [];
    this.metrics.queuedRequests = 0;

    for (const client of this.allClients) {
      try { client.close(); } catch {}
    }
    this.allClients.clear();
    this.idleClients = [];
    this.activeClients.clear();
  }
}

// -----------------------------------------------------------------------------
// DualDatabase: SQLite + AIOS Gateway Adapter
// -----------------------------------------------------------------------------

class DualDatabase {
  constructor(options = {}) {
    this.filePath = options.filePath || options.dbPath || ':memory:';
    this.mode = options.mode || process.env.AIOS_STORAGE_MODE || 'duel'; // 'duel' | 'aios_primary' | 'sqlite_primary'
    // 3306 is MariaDB's port, not AIOS's. Defaulting here meant a DualDatabase
    // built with no explicit port silently paired off against whatever MariaDB
    // was on the box. Now: pass a port ONLY if one was actually configured --
    // an omitted port has to stay omitted so MysqlWireClient runs its
    // banner-verified candidate walk instead of being pinned to a guess.
    const configuredPort = options.aiosPort || options.port;
    const aiosConfig = options.aios || {
      host: options.aiosHost || options.host,
      ...(configuredPort ? { port: configuredPort } : {}),
      user: options.aiosUser || options.user,
      database: options.aiosDatabase || options.database
    };
    if (options.aiosClient) {
      this.aiosClient = options.aiosClient;
    } else if (options.pool === false || options.singleConnection) {
      this.aiosClient = new MysqlWireClient(aiosConfig);
    } else {
      this.aiosClient = new MysqlWirePool(aiosConfig);
    }
    this.onFallback = options.onFallback || null;
    this.sqliteDb = null;
    this.metrics = {
      aios_writes: 0,
      aios_reads: 0,
      aios_total_latency_us: 0,
      sqlite_writes: 0,
      sqlite_reads: 0,
      sqlite_total_latency_us: 0,
      failovers_to_sqlite: 0,
      total_operations: 0,
      last_error: null
    };

    this._initSqlite();
  }

  _initSqlite() {
    if (SqliteEngine) {
      try {
        if (this.filePath !== ':memory:' && typeof this.filePath === 'string') {
          fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        }
        this.sqliteDb = new SqliteEngine(this.filePath);
      } catch (err) {
        this.metrics.last_error = err.message;
      }
    }
  }

  _isMutation(sql) {
    const trimmed = String(sql || '').trim().toUpperCase();
    return /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)/i.test(trimmed);
  }

  _formatSql(sql, params) {
    if (!params) return sql;
    if (Array.isArray(params)) {
      let i = 0;
      return sql.replace(/\?/g, () => {
        if (i >= params.length) return 'NULL';
        const val = params[i++];
        return this._escapeSqlVal(val);
      });
    } else if (typeof params === 'object') {
      let formatted = sql;
      for (const [key, val] of Object.entries(params)) {
        const regex = new RegExp(`[@:$]${key}\\b`, 'g');
        formatted = formatted.replace(regex, this._escapeSqlVal(val));
      }
      return formatted;
    }
    return sql;
  }

  _escapeSqlVal(val) {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? '1' : '0';
    if (typeof val === 'object') return `'${sqlEscape(JSON.stringify(val))}'`;
    return `'${sqlEscape(String(val))}'`;
  }

  pragma(pragmaStr) {
    if (this.sqliteDb) {
      if (this.sqliteDb.pragma) {
        try { return this.sqliteDb.pragma(pragmaStr); } catch {}
      } else if (this.sqliteDb.exec) {
        try { return this.sqliteDb.exec(`PRAGMA ${pragmaStr};`); } catch {}
      }
    }
    return null;
  }

  async execAsync(sql) {
    const isMut = this._isMutation(sql);
    this.metrics.total_operations++;

    let aiosResult = null;
    let sqliteResult = null;
    let aiosLatency = 0;
    let sqliteLatency = 0;

    // AIOS Execution
    if (this.mode === 'duel' || this.mode === 'aios_primary') {
      const t0 = process.hrtime.bigint();
      try {
        aiosResult = await this.aiosClient.query(sql);
        aiosLatency = Number(process.hrtime.bigint() - t0) / 1000;
        this.metrics.aios_total_latency_us += aiosLatency;
        if (isMut) this.metrics.aios_writes++; else this.metrics.aios_reads++;
      } catch (err) {
        this.metrics.failovers_to_sqlite++;
        this.metrics.last_error = err.message;
        if (this.onFallback) this.onFallback(err, sql);
      }
    }

    // SQLite Execution
    if (this.mode === 'duel' || this.mode === 'sqlite_primary' || (!aiosResult && this.mode === 'aios_primary')) {
      if (this.sqliteDb) {
        const t0 = process.hrtime.bigint();
        try {
          sqliteResult = this.sqliteDb.exec(sql);
          sqliteLatency = Number(process.hrtime.bigint() - t0) / 1000;
          this.metrics.sqlite_total_latency_us += sqliteLatency;
          if (isMut) this.metrics.sqlite_writes++; else this.metrics.sqlite_reads++;
        } catch (err) {
          if (!aiosResult) throw err;
        }
      }
    }

    return aiosResult || sqliteResult;
  }

  prepare(sql) {
    const self = this;
    const isMut = this._isMutation(sql);

    return {
      run(...params) {
        self.metrics.total_operations++;
        const flatParams = params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0]) ? params[0] : params;
        const formattedSql = self._formatSql(sql, flatParams);

        let sqliteRes = null;

        // Execute SQLite
        if (self.sqliteDb && (self.mode === 'duel' || self.mode === 'sqlite_primary')) {
          const t0 = process.hrtime.bigint();
          try {
            const stmt = self.sqliteDb.prepare(sql);
            if (stmt.run) {
              sqliteRes = stmt.run(...params);
            } else if (stmt.exec) {
              sqliteRes = stmt.exec(...params);
            }
            const lat = Number(process.hrtime.bigint() - t0) / 1000;
            self.metrics.sqlite_total_latency_us += lat;
            self.metrics.sqlite_writes++;
          } catch (err) {
            self.metrics.last_error = err.message;
          }
        }

        // Fire-and-forget / async write-behind to AIOS
        if (self.mode === 'duel' || self.mode === 'aios_primary') {
          const t0 = process.hrtime.bigint();
          self.aiosClient.query(formattedSql).then(() => {
            const lat = Number(process.hrtime.bigint() - t0) / 1000;
            self.metrics.aios_total_latency_us += lat;
            self.metrics.aios_writes++;
          }).catch((err) => {
            self.metrics.failovers_to_sqlite++;
            self.metrics.last_error = err.message;
            if (self.onFallback) self.onFallback(err, formattedSql);
            if (self.mode === 'aios_primary' && self.sqliteDb) {
              try {
                const stmt = self.sqliteDb.prepare(sql);
                if (stmt.run) stmt.run(...params);
                else if (stmt.exec) stmt.exec(...params);
              } catch {}
            }
          });
        }

        return sqliteRes || { changes: 1, lastInsertRowid: 1 };
      },

      get(...params) {
        self.metrics.total_operations++;
        self.metrics.sqlite_reads++;
        if (self.sqliteDb) {
          const stmt = self.sqliteDb.prepare(sql);
          if (stmt.get) return stmt.get(...params);
          if (stmt.all) {
            const res = stmt.all(...params);
            return res && res.length ? res[0] : null;
          }
        }
        return null;
      },

      all(...params) {
        self.metrics.total_operations++;
        self.metrics.sqlite_reads++;
        if (self.sqliteDb) {
          const stmt = self.sqliteDb.prepare(sql);
          if (stmt.all) return stmt.all(...params);
        }
        return [];
      }
    };
  }

  exec(sql) {
    if (this.sqliteDb) {
      try { this.sqliteDb.exec(sql); } catch {}
    }
    const formatted = sql.trim();
    if (formatted) {
      this.aiosClient.query(formatted).catch(() => {});
    }
  }

  transaction(fn) {
    if (this.sqliteDb && this.sqliteDb.transaction) {
      return this.sqliteDb.transaction(fn);
    }
    return fn;
  }

  getMetrics() {
    const aiosOps = this.metrics.aios_writes + this.metrics.aios_reads;
    const sqliteOps = this.metrics.sqlite_writes + this.metrics.sqlite_reads;

    return {
      ...this.metrics,
      aios_avg_latency_us: aiosOps > 0 ? (this.metrics.aios_total_latency_us / aiosOps).toFixed(2) : '0.00',
      sqlite_avg_latency_us: sqliteOps > 0 ? (this.metrics.sqlite_total_latency_us / sqliteOps).toFixed(2) : '0.00',
      speedup_factor: (aiosOps > 0 && sqliteOps > 0 && this.metrics.aios_total_latency_us > 0)
        ? ((this.metrics.sqlite_total_latency_us / sqliteOps) / (this.metrics.aios_total_latency_us / aiosOps)).toFixed(2) + 'x'
        : 'N/A'
    };
  }

  close() {
    if (this.aiosClient) {
      this.aiosClient.close();
    }
    if (this.sqliteDb) {
      try { this.sqliteDb.close(); } catch {}
      this.sqliteDb = null;
    }
  }
}

// -----------------------------------------------------------------------------
// AiosMemoryStore: Microsecond Tiered Object / Document Cache for JSON/State
// -----------------------------------------------------------------------------

class AiosMemoryStore {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.maxHotEntries = options.maxHotEntries || 2000;
    // An entry COUNT cannot bound memory. 5000 conversations is a few MB of
    // index records or many GB of full transcripts, and a count cap treats
    // those two identically -- so the cache stayed "within limits" while RAM
    // ran away. The engine hit exactly this wall with its probe-index cache
    // and settled on a byte budget (SqlDatabase::kProbeIndexBudgetBytes);
    // this is that same rule on the JS side. BOTH bounds apply, whichever
    // binds first.
    this.maxHotBytes = options.maxHotBytes ||
      parseInt(process.env.AIOS_STORE_BUDGET_BYTES || '268435456', 10); // 256 MiB
    this.hotBytes = 0;
    this.hotCache = new Map(); // key -> { val, meta, bytes, accessedAt, modifiedAt }
    if (options.aiosClient) {
      this.aiosClient = options.aiosClient;
    } else if (options.pool === false || options.singleConnection) {
      this.aiosClient = new MysqlWireClient(options.aios || {});
    } else {
      this.aiosClient = new MysqlWirePool(options.aios || {});
    }
    this.objKind = `${this.name}_kv`;
    this.metrics = {
      hits: 0,
      misses: 0,
      writes: 0,
      evictions: 0,
      evictedBytes: 0,
      totalReadLatencyUs: 0,
      totalWriteLatencyUs: 0,
      writeBehindOk: 0,
      writeBehindFailed: 0,
      lastWriteBehindError: null,
      lastWriteBehindOkAt: 0,
      primaryReadFromRam: 0,
      primaryReadFromAios: 0,
      primaryReadAiosMiss: 0,
      primaryReadAiosFailed: 0,
      lastPrimaryReadError: null,
      writeBehindCoalesced: 0,
      writeBehindBatches: 0,
      writeBehindQueries: 0
    };
    // key -> { op: 'set' | 'del', val }  (last write wins, see the comment on
    // AIOS_WB_COALESCE_MS)
    this._wbPending = new Map();
    this._wbTimer = null;
    this._wbInFlight = null;
  }

  // Shared LRU bookkeeping for every RAM write path.
  _touchRam(key, val, meta) {
    if (this.hotCache.has(key)) {
      this.hotCache.delete(key);
    } else if (this.hotCache.size >= this.maxHotEntries) {
      const oldestKey = this.hotCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.hotCache.delete(oldestKey);
        this.metrics.evictions++;
      }
    }
    const now = Date.now();
    this.hotCache.set(key, { val, meta, accessedAt: now, modifiedAt: now });
  }

  get(key) {
    const t0 = process.hrtime.bigint();
    const entry = this.hotCache.get(key);
    if (entry) {
      entry.accessedAt = Date.now();
      this.hotCache.delete(key);
      this.hotCache.set(key, entry);
      this.metrics.hits++;
      const lat = Number(process.hrtime.bigint() - t0) / 1000;
      this.metrics.totalReadLatencyUs += lat;
      return entry.val;
    }
    this.metrics.misses++;
    return null;
  }

  // The read path the caller should actually use: RAM (fastest, populated by
  // a prior write or a prior AIOS read in this process) -> AIOS itself (the
  // real durable copy, a genuine AQL query) -> undefined, which tells the
  // caller "AIOS has no answer or isn't working, go read your file fallback."
  // Returns:
  //   { hit: true,  value }   found in RAM or AIOS — this IS the answer
  //   { hit: false }          AIOS was reachable and genuinely has nothing —
  //                           still worth trying disk (this key may predate
  //                           AIOS write-behind ever running)
  //   { hit: false, down: true, error } — AIOS didn't answer; disk fallback
  //                           is standing in for a store that isn't working
  async getPrimary(key, { timeoutMs = 800 } = {}) {
    const ram = this.get(key);
    if (ram !== null) {
      this.metrics.primaryReadFromRam++;
      return { hit: true, value: ram };
    }
    // Marks "when this fetch started" so the eventual AIOS answer can be
    // compared against whatever lands in RAM while it's in flight — AIOS's
    // write-behind is deliberately async and can be behind a write that just
    // happened synchronously elsewhere (e.g. straight to disk). Without this,
    // a slow AIOS read finishing after a fresher write clobbers it with a
    // stale value — the real bug behind "conversation was lost on refresh".
    const fetchStartedAt = Date.now();

    const keyEsc = sqlEscape(key);
    const sql = `SELECT * FROM OBJECTS WHERE meta.kind = "${this.objKind}" AND meta.key = "${keyEsc}" ORDER BY timestamp DESC LIMIT 1`;

    let res;
    try {
      res = await Promise.race([
        this.aiosClient.query(sql),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AIOS read timed out')), timeoutMs))
      ]);
    } catch (err) {
      this.metrics.primaryReadAiosFailed++;
      this.metrics.lastPrimaryReadError = err.message;
      return { hit: false, down: true, error: err.message };
    }
    const row = res && res.rows && res.rows[0];
    if (!row) {
      this.metrics.primaryReadAiosMiss++;
      return { hit: false };
    }

    if (row.payload === AIOS_TOMBSTONE_SENTINEL) {
      this.metrics.primaryReadAiosMiss++;
      return { hit: false };
    }

    let value;
    try {
      // The engine returns the literal string "<empty>" for a genuinely
      // empty payload column (see sql_database.cpp) rather than an empty
      // string, so that has to be treated as "no payload" too.
      value = (row.payload && row.payload !== '<empty>') ? JSON.parse(row.payload) : null;
    } catch (err) {
      this.metrics.primaryReadAiosFailed++;
      this.metrics.lastPrimaryReadError = `unparseable payload: ${err.message}`;
      return { hit: false, down: true, error: this.metrics.lastPrimaryReadError };
    }

    this.metrics.primaryReadFromAios++;
    // A synchronous writer (a real `.set()`, or another read's disk fallback)
    // may have landed in RAM while this AIOS round trip was in flight — that
    // value is guaranteed at least as fresh as what AIOS just returned, since
    // AIOS only ever catches up to a write, never ahead of it. Don't stomp it.
    const already = this.hotCache.get(key);
    if (already && already.modifiedAt >= fetchStartedAt) {
      return { hit: true, value: already.val };
    }
    const now = Date.now();
    this._storeHot(key, value, {}, this._entryBytes(key, payloadString(value)), now);
    return { hit: true, value };
  }

  // Approximate resident size of one cached entry. The serialized length is
  // what the write-behind actually ships and tracks the real payload closely;
  // the key and a fixed slot cost cover the Map entry itself.
  _entryBytes(key, str) {
    const payloadBytes = str ? Buffer.byteLength(str, 'utf8') : 0;
    return payloadBytes + (key ? key.length * 2 : 0) + 64;
  }

  // Drop an existing entry's byte accounting before it is replaced or removed.
  _forgetBytes(key) {
    const prev = this.hotCache.get(key);
    if (prev) this.hotBytes -= (prev.bytes || 0);
    return !!prev;
  }

  // LRU-evict until BOTH bounds hold with `incoming` bytes added. protectKey
  // is the entry being written right now and is never chosen as the victim --
  // otherwise a single payload larger than the whole budget would evict
  // itself in a loop and the write would be lost.
  _evictToFit(incoming, protectKey) {
    while (this.hotCache.size > 0 &&
           (this.hotCache.size >= this.maxHotEntries ||
            this.hotBytes + incoming > this.maxHotBytes)) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, e] of this.hotCache.entries()) {
        if (k === protectKey) continue;
        if (e.accessedAt < oldestTime) {
          oldestTime = e.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      const victim = this.hotCache.get(oldestKey);
      this.hotBytes -= (victim.bytes || 0);
      this.metrics.evictedBytes += (victim.bytes || 0);
      this.hotCache.delete(oldestKey);
      this.metrics.evictions++;
    }
    if (this.hotBytes < 0) this.hotBytes = 0;
  }

  // Single funnel for every RAM insert, so byte accounting cannot drift
  // between the set / setMany / AIOS-read-fill paths.
  _storeHot(key, val, meta, bytes, now) {
    this._forgetBytes(key);
    this._evictToFit(bytes, key);
    this.hotCache.set(key, { val, meta, bytes, accessedAt: now, modifiedAt: now });
    this.hotBytes += bytes;
  }

  set(key, val, meta = {}) {
    const t0 = process.hrtime.bigint();
    const payloadStr = payloadString(val);
    const now = Date.now();
    this._storeHot(key, val, meta, this._entryBytes(key, payloadStr), now);
    this.metrics.writes++;

    // Write-Behind to AIOS: queued and coalesced by key (see AIOS_WB_COALESCE_MS)
    this._enqueueWriteBehind(key, { op: 'set', val });

    const lat = Number(process.hrtime.bigint() - t0) / 1000;
    this.metrics.totalWriteLatencyUs += lat;
    return val;
  }

  // ---- coalesced write-behind queue --------------------------------------

  _enqueueWriteBehind(key, op) {
    if (this._wbPending.has(key)) this.metrics.writeBehindCoalesced++;
    this._wbPending.set(key, op);
    this._scheduleWriteBehind();
  }

  _scheduleWriteBehind() {
    if (this._wbTimer || this._wbInFlight || !this._wbPending.size) return;
    this._wbTimer = setTimeout(() => {
      this._wbTimer = null;
      this._flushWriteBehind().catch(() => {});
    }, AIOS_WB_COALESCE_MS);
    // Never hold the process open for a best-effort mirror write.
    if (typeof this._wbTimer.unref === 'function') this._wbTimer.unref();
  }

  _wbTuple(key, op) {
    const kEsc = sqlEscape(key);
    // A delete is a tombstone VERSION, not a row removal -- OBJECTS is
    // append-only. It must be the bare sentinel: the engine's own
    // is_tombstone() (src/storage/object_store.cpp) only recognizes a payload
    // that IS this exact string, and a JSON-wrapped one survives VACUUM.
    const payload = op.op === 'del' ? `'${AIOS_TOMBSTONE_SENTINEL}'` : toHexPayload(op.val);
    return `('${this.objKind}', '${kEsc}', ${payload})`;
  }

  async _flushWriteBehind() {
    if (this._wbInFlight) return this._wbInFlight;
    if (!this._wbPending.size) return;
    if (this._wbTimer) { clearTimeout(this._wbTimer); this._wbTimer = null; }

    this._wbInFlight = (async () => {
      // Drain until empty: writes that arrive mid-flight get their own round
      // rather than waiting out another full coalesce window.
      while (this._wbPending.size) {
        const batch = [...this._wbPending];
        this._wbPending.clear();

        // Pack by BYTES, not by row count -- one conversation trail is
        // megabytes once hex-encoded, and the wire client buffers a statement
        // whole.
        const chunks = [];
        let chunk = [];
        let bytes = 0;
        for (const [key, op] of batch) {
          const tuple = this._wbTuple(key, op);
          if (chunk.length && bytes + tuple.length > AIOS_WB_MAX_SQL_BYTES) {
            chunks.push(chunk);
            chunk = [];
            bytes = 0;
          }
          chunk.push({ key, tuple });
          bytes += tuple.length + 2;
        }
        if (chunk.length) chunks.push(chunk);

        // Sequentially, on purpose: N parallel multi-megabyte INSERTs is what
        // filled the pool's acquire queue in the first place. One statement in
        // flight keeps pool depth at 1 and the engine's latency honest.
        for (const c of chunks) {
          const sql = `INSERT INTO OBJECTS (kind, key, payload) VALUES ${c.map((e) => e.tuple).join(', ')}`;
          this.metrics.writeBehindBatches++;
          this.metrics.writeBehindQueries++;
          try {
            await this.aiosClient.query(sql);
            this.metrics.writeBehindOk += c.length;
            this.metrics.lastWriteBehindOkAt = Date.now();
          } catch (err) {
            this.metrics.writeBehindFailed += c.length;
            this.metrics.lastWriteBehindError = err.message;
            // Re-queue, never drop (the bug fixed in e5469d7e) -- but only the
            // keys with no NEWER pending version. Re-sending a stale payload
            // after its successor landed would resurrect old data, since
            // readers just take the newest version of a key.
            const stale = c.filter((e) => !this._wbPending.has(e.key));
            if (stale.length) {
              const retrySql = `INSERT INTO OBJECTS (kind, key, payload) VALUES ${stale.map((e) => e.tuple).join(', ')}`;
              this._retryLater(`batch:${stale[0].key}`, retrySql);
            }
          }
        }
      }
    })().finally(() => {
      this._wbInFlight = null;
      this._scheduleWriteBehind();
    });

    return this._wbInFlight;
  }

  // Push every coalesced write now and wait for it. A caller that needs the
  // durable copy to exist (shutdown, read-your-write from another process)
  // needs this -- the whole point of the queue is that set() does not wait.
  async flushWriteBehind() {
    await this._flushWriteBehind();
    return this._wbPending.size;
  }

  // Versions queued but not yet mirrored to ASQL.
  pendingWriteBehind() {
    return this._wbPending.size;
  }

  // ---- write-behind retry -------------------------------------------------
  // The ONE reason this exists: a failed write-behind used to be dropped, so a
  // few seconds of engine unavailability silently cost ASQL every conversation
  // version written in that window. Bounded on purpose — this is a retry queue,
  // not a second write-ahead log, and the disk JSONL remains the primary
  // durable copy either way.
  //
  // Keyed by store key, last-write-wins: OBJECTS is append-only and readers
  // take the newest version of a key, so re-sending a superseded payload buys
  // nothing and re-sending the LATEST one is the whole point. That also bounds
  // a hot conversation to one pending entry however fast it is being written.
  _retryLater(key, sql) {
    if (!this._retryQueue) this._retryQueue = new Map();
    // Drop the OLDEST distinct key when full rather than refusing the newest:
    // the newest write is the one whose loss the operator would actually see.
    if (!this._retryQueue.has(key) && this._retryQueue.size >= AIOS_RETRY_MAX_KEYS) {
      const oldest = this._retryQueue.keys().next().value;
      if (oldest !== undefined) {
        this._retryQueue.delete(oldest);
        this.metrics.retriesDropped = (this.metrics.retriesDropped || 0) + 1;
      }
    }
    this._retryQueue.set(key, { sql, attempts: 0 });
    this.metrics.retriesQueued = this._retryQueue.size;
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._retryTimer || !this._retryQueue || !this._retryQueue.size) return;
    const delay = Math.min(
      AIOS_RETRY_BASE_MS * Math.pow(2, this._retryBackoff || 0),
      AIOS_RETRY_MAX_MS
    );
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._flushRetries().catch(() => {});
    }, delay);
    // Never hold the process open for a best-effort mirror write.
    if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
  }

  async _flushRetries() {
    if (!this._retryQueue || !this._retryQueue.size) return;
    let failed = false;
    for (const [key, item] of [...this._retryQueue]) {
      try {
        await this.aiosClient.query(item.sql);
        this._retryQueue.delete(key);
        this.metrics.writeBehindOk++;
        this.metrics.retriesOk = (this.metrics.retriesOk || 0) + 1;
        this.metrics.lastWriteBehindOkAt = Date.now();
      } catch (err) {
        failed = true;
        item.attempts++;
        this.metrics.lastWriteBehindError = err.message;
        if (item.attempts >= AIOS_RETRY_MAX_ATTEMPTS) {
          this._retryQueue.delete(key);
          this.metrics.retriesDropped = (this.metrics.retriesDropped || 0) + 1;
        }
        // Engine still down — stop hammering it with the rest of the queue
        // this round; the backoff timer brings them all back together.
        break;
      }
    }
    this.metrics.retriesQueued = this._retryQueue.size;
    this._retryBackoff = failed ? Math.min((this._retryBackoff || 0) + 1, 6) : 0;
    this._scheduleRetry();
  }

  // Push every queued retry now and report what is still unwritten, so a
  // shutdown path can actually wait for the mirror instead of assuming it.
  async flushRetries() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._retryBackoff = 0;
    await this._flushRetries();
    return this._retryQueue ? this._retryQueue.size : 0;
  }

  setMany(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const t0 = process.hrtime.bigint();
    const now = Date.now();
    const validEntries = [];

    for (const item of entries) {
      if (!item || item.key == null) continue;
      const { key, val, meta = {} } = item;
      const payloadStr = payloadString(val);
      this._storeHot(key, val, meta, this._entryBytes(key, payloadStr), now);
      this.metrics.writes++;
      validEntries.push({ key, val, payloadStr });
    }

    if (validEntries.length === 0) return [];

    for (const item of validEntries) {
      this._enqueueWriteBehind(item.key, { op: 'set', val: item.val });
    }

    const lat = Number(process.hrtime.bigint() - t0) / 1000;
    this.metrics.totalWriteLatencyUs += lat;
    return validEntries.map((e) => e.val);
  }

  // RAM-ONLY WRITE. Same cache semantics as set(), but no write-behind INSERT.
  //
  // Every set() appends a whole new version of the value into the append-only
  // OBJECTS table, hex-encoded. That is right for a real state change and
  // ruinous for a hot path that re-sets the SAME large value hundreds of times
  // in a burst: the console's conversation store used to set() the entire `ui`
  // trail and the entire store index on EVERY streamed tool event, so replaying
  // one re-attached turn shipped the conversation to ASQL once per event (and
  // hex-encoded it on the event loop once per event) when only the final
  // version is worth keeping.
  //
  // Use setLocal() for cache maintenance — populating RAM after a disk read, or
  // keeping RAM in step with a write whose durable copy is a file — and set()
  // when this really is a new version ASQL should hold. A caller that does the
  // hot updates with setLocal() must still call set() when the value settles,
  // or ASQL keeps serving the last version it was actually told about.
  setLocal(key, val, meta = {}) {
    const t0 = process.hrtime.bigint();
    this._touchRam(key, val, meta);
    this.metrics.writes++;
    this.metrics.localWrites = (this.metrics.localWrites || 0) + 1;
    this.metrics.totalWriteLatencyUs += Number(process.hrtime.bigint() - t0) / 1000;
    return val;
  }

  has(key) {
    return this.hotCache.has(key);
  }

  // Drop the RAM copy without touching AIOS at all — for a caller that just
  // mutated the record some OTHER way (a direct disk write, an in-place index
  // update) and knows the cached copy is now stale, but isn't performing an
  // actual delete of the underlying data. delete() writes an AIOS tombstone;
  // this does not, because nothing was actually deleted.
  invalidate(key) {
    this._forgetBytes(key);
    this.hotCache.delete(key);
  }

  delete(key) {
    this._forgetBytes(key);
    const res = this.hotCache.delete(key);
    // The object store is append-only -- there is no in-place row delete, so
    // the honest equivalent is a tombstone VERSION: the latest version for the
    // key becomes a recognizable sentinel payload, which a reader checks after
    // taking ORDER BY timestamp DESC LIMIT 1. Goes through the same coalescing
    // queue as set(), which is also what makes delete-after-set correct: the
    // tombstone REPLACES any payload still queued for this key, so a pending
    // write can never land after the delete and resurrect it.
    this._enqueueWriteBehind(key, { op: 'del' });
    return res;
  }

  archive(key, archiveFilePath) {
    const entry = this.hotCache.get(key);
    if (entry && archiveFilePath) {
      try {
        fs.mkdirSync(path.dirname(archiveFilePath), { recursive: true });
        fs.appendFileSync(archiveFilePath, JSON.stringify({ key, val: entry.val, archivedAt: new Date().toISOString() }) + '\n');
      } catch (e) {
        return false;
      }
    }
    this.delete(key);
    return true;
  }

  clear() {
    this.hotCache.clear();
    this.hotBytes = 0;
  }

  size() {
    return this.hotCache.size;
  }

  stats() {
    const reads = this.metrics.hits + this.metrics.misses;
    const hitRate = reads > 0 ? ((this.metrics.hits / reads) * 100).toFixed(1) + '%' : '100%';
    const avgReadUs = reads > 0 ? (this.metrics.totalReadLatencyUs / reads).toFixed(3) : '0.000';
    const avgWriteUs = this.metrics.writes > 0 ? (this.metrics.totalWriteLatencyUs / this.metrics.writes).toFixed(3) : '0.000';

    return {
      name: this.name,
      entries_in_ram: this.hotCache.size,
      hit_rate: hitRate,
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      writes: this.metrics.writes,
      local_writes: this.metrics.localWrites || 0,
      evictions: this.metrics.evictions,
      // The count was the only bound that used to exist and the only one ever
      // reported; bytes are what actually ran the box out of memory.
      bytes_in_ram: this.hotBytes,
      max_bytes: this.maxHotBytes,
      max_entries: this.maxHotEntries,
      evicted_bytes: this.metrics.evictedBytes,
      avg_read_latency_us: avgReadUs,
      avg_write_latency_us: avgWriteUs,
      // These are about the RAM cache above, not AIOS — the durable copy is
      // async and unmeasured here by design (that is what "write-behind"
      // means). write_behind_failed / last_write_behind_error is what tells
      // you whether that background copy is actually landing.
      write_behind_ok: this.metrics.writeBehindOk,
      write_behind_failed: this.metrics.writeBehindFailed,
      // Coalescing: versions superseded inside the window and never sent (the
      // savings), batched statements actually issued, and what is queued but
      // not yet mirrored right now.
      write_behind_coalesced: this.metrics.writeBehindCoalesced,
      write_behind_batches: this.metrics.writeBehindBatches,
      write_behind_pending: this._wbPending ? this._wbPending.size : 0,
      last_write_behind_error: this.metrics.lastWriteBehindError,
      last_write_behind_ok_at: this.metrics.lastWriteBehindOkAt || null,
      last_write_behind_ok_ms_ago: this.metrics.lastWriteBehindOkAt ? (Date.now() - this.metrics.lastWriteBehindOkAt) : null,
      // Retries are the difference between "write-behind failed" and "that
      // write is gone". retries_dropped is the only counter here that means
      // real loss from the ASQL mirror; retries_queued > 0 means in flight.
      retries_queued: this._retryQueue ? this._retryQueue.size : 0,
      retries_ok: this.metrics.retriesOk || 0,
      retries_dropped: this.metrics.retriesDropped || 0,
      primary_read_from_ram: this.metrics.primaryReadFromRam,
      primary_read_from_aios: this.metrics.primaryReadFromAios,
      primary_read_aios_miss: this.metrics.primaryReadAiosMiss,
      primary_read_aios_failed: this.metrics.primaryReadAiosFailed,
      last_primary_read_error: this.metrics.lastPrimaryReadError,
      pool: (this.aiosClient && typeof this.aiosClient.getPoolStats === 'function') ? this.aiosClient.getPoolStats() : null
    };
  }

  async vacuum() {
    const res = await this.aiosClient.query('VACUUM OBJECTS');
    const stats = {};
    if (res && res.rows) {
      for (const row of res.rows) {
        if (row.metric) {
          const num = Number(row.value);
          stats[row.metric] = Number.isFinite(num) ? num : row.value;
        }
      }
    }
    return stats;
  }
}

// -----------------------------------------------------------------------------
// Fast Migration & Diagnostic Helpers
// -----------------------------------------------------------------------------

async function migrateJsonDirectory(dir, store, options = {}) {
  const t0 = process.hrtime.bigint();
  const summary = {
    directory: dir,
    files_scanned: 0,
    files_migrated: 0,
    bytes_loaded: 0,
    elapsed_ms: 0,
    errors: []
  };

  if (!fs.existsSync(dir)) {
    return summary;
  }

  const pendingBatch = [];
  const flushBatch = () => {
    if (pendingBatch.length === 0) return;
    if (store && typeof store.setMany === 'function') {
      store.setMany(pendingBatch);
    } else if (store && typeof store.set === 'function') {
      for (const item of pendingBatch) {
        store.set(item.key, item.val, item.meta);
      }
    }
    pendingBatch.length = 0;
  };

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const name = ent.name;
      const fullPath = path.join(dir, name);

      if (ent.isDirectory()) {
        // Subdirectory store: e.g. CONV_DIR/<cid>/
        if (options.prefix === 'conv' || options.conversations || options.recursive || options.prefix === 'tasks' || options.tasks) {
          try {
            const id = name;
            const subIndexFile = path.join(fullPath, 'index.json');
            if (fs.existsSync(subIndexFile)) {
              summary.files_scanned++;
              const st = fs.statSync(subIndexFile);
              const data = JSON.parse(fs.readFileSync(subIndexFile, 'utf8'));
              pendingBatch.push({ key: `index:${id}`, val: data, meta: { file: subIndexFile, size: st.size, mtime: st.mtimeMs } });
              summary.files_migrated++;
              summary.bytes_loaded += st.size;
              if (pendingBatch.length >= 50) flushBatch();
            }
            const subStateFile = path.join(fullPath, 'state.json');
            if (fs.existsSync(subStateFile)) {
              summary.files_scanned++;
              const st = fs.statSync(subStateFile);
              const data = JSON.parse(fs.readFileSync(subStateFile, 'utf8'));
              pendingBatch.push({ key: `state:${id}`, val: data, meta: { file: subStateFile, size: st.size, mtime: st.mtimeMs } });
              summary.files_migrated++;
              summary.bytes_loaded += st.size;
              if (pendingBatch.length >= 50) flushBatch();
            }
            const subUiJsonl = path.join(fullPath, 'ui.jsonl');
            if (fs.existsSync(subUiJsonl)) {
              summary.files_scanned++;
              const st = fs.statSync(subUiJsonl);
              const rawLines = fs.readFileSync(subUiJsonl, 'utf8').split('\n').filter(Boolean);
              const turns = [];
              for (const line of rawLines) {
                try { turns.push(JSON.parse(line)); } catch {}
              }
              if (turns.length > 0) {
                pendingBatch.push({ key: `ui:${id}`, val: turns, meta: { file: subUiJsonl, size: st.size, mtime: st.mtimeMs } });
                summary.files_migrated++;
                summary.bytes_loaded += st.size;
                if (pendingBatch.length >= 50) flushBatch();
              }
            }
            const subMsgJsonl = path.join(fullPath, 'messages.jsonl');
            if (fs.existsSync(subMsgJsonl)) {
              summary.files_scanned++;
              const st = fs.statSync(subMsgJsonl);
              const rawLines = fs.readFileSync(subMsgJsonl, 'utf8').split('\n').filter(Boolean);
              const msgs = [];
              for (const line of rawLines) {
                try { msgs.push(JSON.parse(line)); } catch {}
              }
              if (msgs.length > 0) {
                pendingBatch.push({ key: `conv:${id}`, val: msgs, meta: { file: subMsgJsonl, size: st.size, mtime: st.mtimeMs } });
                pendingBatch.push({ key: `messages:${id}`, val: msgs, meta: { file: subMsgJsonl, size: st.size, mtime: st.mtimeMs } });
                summary.files_migrated++;
                summary.bytes_loaded += st.size;
                if (pendingBatch.length >= 50) flushBatch();
              }
            }
            const subEventsJsonl = path.join(fullPath, 'events.jsonl');
            if (fs.existsSync(subEventsJsonl)) {
              summary.files_scanned++;
              const st = fs.statSync(subEventsJsonl);
              const rawLines = fs.readFileSync(subEventsJsonl, 'utf8').split('\n').filter(Boolean);
              const events = [];
              for (const line of rawLines) {
                try { events.push(JSON.parse(line)); } catch {}
              }
              if (events.length > 0) {
                pendingBatch.push({ key: `events:${id}`, val: events, meta: { file: subEventsJsonl, size: st.size, mtime: st.mtimeMs } });
                summary.files_migrated++;
                summary.bytes_loaded += st.size;
                if (pendingBatch.length >= 50) flushBatch();
              }
            }
          } catch (err) {
            summary.errors.push({ directory: name, error: err.message });
          }
        }
        continue;
      }

      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      summary.files_scanned++;
      try {
        const stat = fs.statSync(fullPath);
        const raw = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(raw);

        let key;
        if (typeof options.keyMapper === 'function') {
          key = options.keyMapper(name, parsed, fullPath);
        } else if (options.prefix === 'conv' || options.conversations) {
          // Harmonized keys matching runtime index: and ui:
          if (name === 'index.json') {
            key = 'index:global';
          } else if (name.endsWith('.ui.json')) {
            const id = name.slice(0, -8);
            key = `ui:${id}`;
          } else if (name.endsWith('.meta.json')) {
            const id = name.slice(0, -10);
            key = `meta:${id}`;
          } else {
            const id = name.slice(0, -5);
            if (Array.isArray(parsed)) {
              key = `conv:${id}`;
              pendingBatch.push({ key: `messages:${id}`, val: parsed, meta: { file: fullPath, size: stat.size, mtime: stat.mtimeMs } });
            } else {
              key = `index:${id}`;
            }
          }
        } else if (options.prefix === 'fleet' || options.fleet) {
          key = `mission:${name.slice(0, -5)}`;
        } else if (options.prefix === 'tasks' || options.tasks) {
          if (name === 'index.json') {
            key = 'index:tasks';
          } else {
            key = `task:${name.slice(0, -5)}`;
          }
        } else {
          key = options.prefix ? `${options.prefix}:${name.slice(0, -5)}` : name.slice(0, -5);
        }

        if (key) {
          pendingBatch.push({ key, val: parsed, meta: { file: fullPath, size: stat.size, mtime: stat.mtimeMs } });
          summary.files_migrated++;
          summary.bytes_loaded += stat.size;
          if (pendingBatch.length >= 50) flushBatch();
        }
      } catch (err) {
        summary.errors.push({ file: name, error: err.message });
      }
    }
    flushBatch();
  } catch (err) {
    summary.errors.push({ error: err.message });
  }

  summary.elapsed_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return summary;
}

async function runDuelBenchmark(options = {}) {
  const count = options.count || 100;
  const dbPath = options.dbPath || ':memory:';
  const dualDb = new DualDatabase({
    filePath: dbPath,
    mode: 'duel',
    aios: options.aios || {}
  });

  const runId = `duel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const avg = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null);
  const opsPerSec = (us) => (us && us > 0 ? Number((1e6 / us).toFixed(0)) : null);

  // The comparison has to be against something that EXISTS on this host.
  // node:sqlite only landed in Node 22 and the console runs Node 20, so on
  // the box that actually serves this panel `sqliteEngineType` is 'none' --
  // which used to leave every number null and the speedup reading
  // 'n/a (aios not connected)' while aios_connected was true. The baseline
  // there is the thing ASQL is actually replacing in the console: a JSON file
  // on disk, read and written the way the disk fallback does it.
  const haveSqlite = !!dualDb.sqliteDb;
  const baselineEngine = haveSqlite ? sqliteEngineType : 'disk-json';
  const baselineDir = path.join(os.tmpdir(), `aios-duel-${runId}`);

  const report = {
    iterations: count,
    aios_connected: false,
    aios_endpoint: `${dualDb.aiosClient.host}:${dualDb.aiosClient.port}`,
    sqlite_engine: sqliteEngineType,
    baseline_engine: baselineEngine,
    // Flat fields kept for existing callers (tools/, MachineSheet's raw view).
    writes: { aios_avg_us: null, sqlite_avg_us: null, baseline_avg_us: null, speedup: 'not measured' },
    reads: { aios_avg_us: null, sqlite_avg_us: null, baseline_avg_us: null, speedup: 'not measured' },
    // Per-engine blocks, the shape the console's duel panel renders.
    aios: { engine: 'aios-asql (OBJECTS)', connected: false, avg_write_us: null, avg_read_us: null, ops_per_sec: null },
    baseline: { engine: baselineEngine, avg_write_us: null, avg_read_us: null, ops_per_sec: null },
    sqlite: null,
    verdict: {},
    // false unless every read actually round-tripped a matching row back
    // from a real AQL query -- never defaults to true.
    parity_verified: false,
    parity_checked: 0,
    parity_mismatches: 0,
    samples: []
  };

  try {
    // 1. Connect & Verify Handshake
    report.aios_connected = await dualDb.aiosClient.connect();
    report.aios.connected = report.aios_connected;
    if (dualDb.sqliteDb) {
      dualDb.sqliteDb.exec('CREATE TABLE IF NOT EXISTS benchmark_duel (id INT PRIMARY KEY, title VARCHAR(255), payload TEXT);');
    } else {
      fs.mkdirSync(baselineDir, { recursive: true });
    }

    if (!report.aios_connected) {
      report.error = `could not reach an AIOS wire server at ${report.aios_endpoint} — ` +
        `the AIOS column below is unmeasured; only the ${baselineEngine} baseline ran.`;
    }

    // 2. Measure Writes. The AIOS side goes through INSERT INTO OBJECTS --
    // a real StoredObject, AQL-queryable -- not a flat SQL table row, so
    // this actually exercises the ASQL path end to end.
    const writeTimesAios = [];
    const writeTimesBase = [];

    for (let i = 1; i <= count; i++) {
      const title = `task_${i}`;
      const payload = `sample_turn_payload_data_${i}`;

      if (report.aios_connected) {
        const objSql = `INSERT INTO OBJECTS (kind, key, payload) VALUES ('${runId}', '${i}', '${payload}');`;
        const tAios0 = process.hrtime.bigint();
        await dualDb.aiosClient.query(objSql);
        const tAios1 = process.hrtime.bigint();
        writeTimesAios.push(Number(tAios1 - tAios0) / 1000);
      }

      const tBase0 = process.hrtime.bigint();
      if (dualDb.sqliteDb) {
        dualDb.sqliteDb.exec(`INSERT INTO benchmark_duel (id, title, payload) VALUES (${i}, '${title}', '${payload}');`);
      } else {
        fs.writeFileSync(path.join(baselineDir, `${i}.json`), JSON.stringify({ id: i, title, payload }));
      }
      writeTimesBase.push(Number(process.hrtime.bigint() - tBase0) / 1000);
    }

    report.writes.aios_avg_us = avg(writeTimesAios);
    report.writes.baseline_avg_us = avg(writeTimesBase);
    if (haveSqlite) report.writes.sqlite_avg_us = report.writes.baseline_avg_us;

    // 3. Measure Reads, and actually verify parity -- a real AQL SELECT for
    // each key, compared byte-for-byte against what was written.
    const readTimesAios = [];
    const readTimesBase = [];
    const readCount = Math.min(count, 50);

    for (let i = 1; i <= readCount; i++) {
      const expectedPayload = `sample_turn_payload_data_${i}`;

      if (report.aios_connected) {
        const objSql = `SELECT * FROM OBJECTS WHERE meta.kind = "${runId}" AND meta.key = "${i}" ORDER BY timestamp DESC LIMIT 1;`;
        const tAios0 = process.hrtime.bigint();
        const aiosRes = await dualDb.aiosClient.query(objSql);
        const tAios1 = process.hrtime.bigint();
        readTimesAios.push(Number(tAios1 - tAios0) / 1000);
        const aiosPayload = aiosRes && aiosRes.rows && aiosRes.rows[0] ? aiosRes.rows[0].payload : undefined;

        report.parity_checked++;
        if (aiosPayload !== expectedPayload) report.parity_mismatches++;
      }

      const tBase0 = process.hrtime.bigint();
      if (dualDb.sqliteDb) {
        const stmt = dualDb.sqliteDb.prepare(`SELECT * FROM benchmark_duel WHERE id = ${i};`);
        stmt.all ? stmt.all() : (stmt.get ? [stmt.get()] : []);
      } else {
        JSON.parse(fs.readFileSync(path.join(baselineDir, `${i}.json`), 'utf8'));
      }
      readTimesBase.push(Number(process.hrtime.bigint() - tBase0) / 1000);
    }

    report.reads.aios_avg_us = avg(readTimesAios);
    report.reads.baseline_avg_us = avg(readTimesBase);
    if (haveSqlite) report.reads.sqlite_avg_us = report.reads.baseline_avg_us;
    report.parity_verified = report.parity_checked > 0 && report.parity_mismatches === 0;

    // 4. Say which one won, in words, from the numbers -- and never claim a
    // measurement that was not taken. The panel used to label AIOS the "Fast
    // Tier" in markup regardless of what came back.
    for (const phase of ['writes', 'reads']) {
      const a = report[phase].aios_avg_us;
      const b = report[phase].baseline_avg_us;
      if (a == null) {
        report[phase].speedup = `not measured (no AIOS server at ${report.aios_endpoint})`;
      } else if (b == null) {
        report[phase].speedup = `not measured (no ${baselineEngine} baseline)`;
      } else {
        const ratio = b / a;
        report[phase].speedup = ratio.toFixed(2) + 'x';
        report.verdict[phase] = ratio >= 1
          ? `aios ${ratio.toFixed(1)}x faster than ${baselineEngine}`
          : `aios ${(1 / ratio).toFixed(1)}x SLOWER than ${baselineEngine}`;
      }
    }

    report.aios.avg_write_us = report.writes.aios_avg_us;
    report.aios.avg_read_us = report.reads.aios_avg_us;
    report.aios.ops_per_sec = opsPerSec(report.writes.aios_avg_us);
    report.baseline.avg_write_us = report.writes.baseline_avg_us;
    report.baseline.avg_read_us = report.reads.baseline_avg_us;
    report.baseline.ops_per_sec = opsPerSec(report.writes.baseline_avg_us);
    if (haveSqlite) report.sqlite = report.baseline;
    report.winner = report.writes.aios_avg_us != null && report.writes.baseline_avg_us != null
      ? (report.writes.aios_avg_us <= report.writes.baseline_avg_us ? 'aios' : 'baseline')
      : null;

    // 5. What the CONSOLE actually pays per write, which is not the number
    // above: its store writes RAM synchronously and mirrors to ASQL through
    // the coalescing queue, so a burst of N versions of one key costs one
    // encode and one batched INSERT. This is the path being optimized, so it
    // is the path the panel should show.
    try {
      const probe = new AiosMemoryStore({ name: `duelprobe_${Date.now()}`, maxHotEntries: count + 16, aios: options.aios || {} });
      const setTimes = [];
      for (let i = 1; i <= count; i++) {
        const t0 = process.hrtime.bigint();
        probe.set(`probe:${i}`, { i, payload: `sample_turn_payload_data_${i}` });
        setTimes.push(Number(process.hrtime.bigint() - t0) / 1000);
      }
      const tFlush = process.hrtime.bigint();
      const stillPending = await probe.flushWriteBehind();
      const flushMs = Number(process.hrtime.bigint() - tFlush) / 1e6;
      const st = probe.stats();
      report.console_path = {
        note: 'store.set() = RAM now + coalesced ASQL mirror; this is what the console pays',
        set_avg_us: avg(setTimes),
        set_ops_per_sec: opsPerSec(avg(setTimes)),
        mirror_flush_ms: Number(flushMs.toFixed(2)),
        mirror_batches: st.write_behind_batches,
        mirror_coalesced: st.write_behind_coalesced,
        mirror_ok: st.write_behind_ok,
        mirror_failed: st.write_behind_failed,
        mirror_pending_after_flush: stillPending,
        mirror_error: st.last_write_behind_error || null
      };
      probe.close && probe.close();
    } catch (err) {
      report.console_path = { error: err.message };
    }

  } catch (err) {
    report.error = err.message;
  } finally {
    dualDb.close();
    if (!haveSqlite) { try { fs.rmSync(baselineDir, { recursive: true, force: true }); } catch {} }
  }

  return report;
}

// Global Singleton Memory Stores
const globalConvStore = new AiosMemoryStore({ name: 'conversations', maxHotEntries: 5000 });
const globalFleetStore = new AiosMemoryStore({ name: 'fleet_missions', maxHotEntries: 2000 });
const globalTaskStore = new AiosMemoryStore({ name: 'tasks', maxHotEntries: 2000 });

// The wire client closes its socket after ~3s idle (see MysqlWireClient's
// timeoutMs) and reconnects on the next write — that is by design, not a
// failure, so `aiosClient.connected` reads false between writes even on a
// perfectly healthy link. "Recently landed a write" is the honest signal;
// this window just needs to be comfortably wider than the idle timeout.
const RECENT_WRITE_BEHIND_WINDOW_MS = 60000;

function describeEndpoint(client) {
  if (!client) return null;
  return {
    host: client.host,
    port: client.port,
    port_resolved: client.portResolved !== undefined ? client.portResolved : !!client.portExplicit,
    port_candidates: client.portCandidates || null,
    database: client.database,
    user: client.user,
    server_version: client.serverVersion || null,
    connect_attempts: client.lastConnectAttempts && client.lastConnectAttempts.length
      ? client.lastConnectAttempts
      : null
  };
}

function getStorageDiagnostics() {
  const convStats = globalConvStore.stats();
  const fleetStats = globalFleetStore.stats();
  const taskStats = globalTaskStore.stats();
  const socketConnected = !!(globalConvStore.aiosClient && globalConvStore.aiosClient.connected);
  const recentOkAgo = Math.min(
    convStats.last_write_behind_ok_ms_ago ?? Infinity,
    fleetStats.last_write_behind_ok_ms_ago ?? Infinity,
    taskStats.last_write_behind_ok_ms_ago ?? Infinity
  );
  const recentlyLanded = recentOkAgo <= RECENT_WRITE_BEHIND_WINDOW_MS;
  // A real socket right now OR a write that landed within the window both
  // count as "reachable" — the socket reconnects on demand, so neither on
  // its own is proof of the other's absence.
  const aiosConnected = socketConnected || recentlyLanded;
  const anyWriteBehindFailures = (convStats.write_behind_failed || 0) + (fleetStats.write_behind_failed || 0) + (taskStats.write_behind_failed || 0) > 0;

  return {
    // Reflects the RAM cache (hotCache, always up) plus the write-behind
    // link to AIOS, which can be down while the cache keeps serving.
    status: aiosConnected ? 'operational' : (anyWriteBehindFailures ? 'degraded (write-behind failing)' : 'ram-only (aios write-behind not connected)'),
    backend: 'aios-tiered-residency',
    aios_connected: aiosConnected,
    aios_socket_open_now: socketConnected,
    // WHERE it is talking, and when it is not, which ports were tried and what
    // each one said. Without this the only symptom of the wrong port was
    // aios_connected: false with no way to tell a down engine from a
    // misaddressed one.
    endpoint: describeEndpoint(globalConvStore.aiosClient),
    pool: (globalConvStore.aiosClient && typeof globalConvStore.aiosClient.getPoolStats === 'function') ? globalConvStore.aiosClient.getPoolStats() : null,
    sqlite_engine: sqliteEngineType,
    // Total RAM held across every store, against the shared per-store budget.
    // Previously nothing summed this, so the only way to see the cache growing
    // was to watch the process RSS from outside.
    ram_bytes_total: (convStats.bytes_in_ram || 0) + (fleetStats.bytes_in_ram || 0) + (taskStats.bytes_in_ram || 0),
    ram_budget_bytes_per_store: convStats.max_bytes,
    stores: {
      conversations: convStats,
      fleet: fleetStats,
      tasks: taskStats
    },
    // Labels for what each tier IS, not a measured number — real per-store
    // read/write latency is in `stores.*.avg_read_latency_us` above, and
    // that number describes the RAM cache, not AIOS itself.
    residency_tiers: {
      hot: 'In-process RAM cache (hotCache)',
      active: 'Write-Behind to AIOS via INSERT INTO OBJECTS (async, unmeasured here)',
      cool: 'AIOS sparse block index (on the AIOS side, not this process)',
      sealed: 'AIOS on-disk sealed blocks + bloom filter (on the AIOS side, not this process)'
    }
  };
}

// Is ASQL reachable RIGHT NOW? getStorageDiagnostics() answers from evidence
// it already has -- an open socket or a write that landed recently -- which is
// free, but reads `false` on a healthy link that simply has not been written to
// for a minute (the wire client closes its socket when idle). That showed up in
// the console's Storage tab as a red "asql reachable: false" directly above a
// benchmark that had just round-tripped 150 queries to it. A status poll can
// afford one localhost connect to answer honestly.
async function probeAiosReachable(timeoutMs = 500) {
  const client = globalConvStore && globalConvStore.aiosClient;
  if (!client) return false;
  if (client.connected && client.socket && !client.socket.destroyed) return true;
  if (typeof client.connect !== 'function') return false;
  try {
    return !!(await Promise.race([
      client.connect(),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ]));
  } catch {
    return false;
  }
}

async function vacuumAiosStorage(store = globalConvStore) {
  try {
    if (store && typeof store.vacuum === 'function') {
      return await store.vacuum();
    }
    return { error: 'vacuum not supported on this store' };
  } catch (err) {
    return { error: err.message };
  }
}

async function drainAllStorage(timeoutMs = 5000) {
  const promises = [];
  // Queued RETRIES first, and awaited: they are writes ASQL has not seen at
  // all, so draining the socket without them drains nothing that was lost.
  for (const store of [globalConvStore, globalFleetStore, globalTaskStore]) {
    // The COALESCED queue first: those versions have not been sent at all yet,
    // so draining sockets or retries without them drains nothing that is
    // actually still owed to ASQL. Then the retry queue (writes ASQL rejected).
    if (store && typeof store.flushWriteBehind === 'function') {
      promises.push(
        store.flushWriteBehind()
          .then(() => (typeof store.flushRetries === 'function' ? store.flushRetries() : 0))
          .catch(() => {})
      );
    } else if (store && typeof store.flushRetries === 'function') {
      promises.push(store.flushRetries().catch(() => {}));
    }
  }
  if (globalConvStore && globalConvStore.aiosClient && typeof globalConvStore.aiosClient.drain === 'function') {
    promises.push(globalConvStore.aiosClient.drain(timeoutMs));
  }
  if (globalFleetStore && globalFleetStore.aiosClient && typeof globalFleetStore.aiosClient.drain === 'function') {
    promises.push(globalFleetStore.aiosClient.drain(timeoutMs));
  }
  if (globalTaskStore && globalTaskStore.aiosClient && typeof globalTaskStore.aiosClient.drain === 'function') {
    promises.push(globalTaskStore.aiosClient.drain(timeoutMs));
  }
  await Promise.allSettled(promises);
}

module.exports = {
  describeEndpoint,
  resolveAiosEndpoint,
  MysqlWireClient,
  MysqlWirePool,
  DualDatabase,
  AiosMemoryStore,
  globalConvStore,
  globalFleetStore,
  globalTaskStore,
  migrateJsonDirectory,
  runDuelBenchmark,
  getStorageDiagnostics,
  vacuumAiosStorage,
  probeAiosReachable,
  drainAllStorage,
  toHexPayload,
  createDualDatabase: (opts) => new DualDatabase(opts)
};

