// The MySQL wire-protocol client for ASQL (the aios SQL engine, port 3307 or a socket), with no third-party
// dependencies: handshake, text queries, and prepared statements with typed parameters and typed rows.
// What converge keeps in ASQL (provider keys, the Cloudflare config) is in provider-store.mjs, the logins in auth/.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { asqlPort } from './asql-port.mjs';

const readText = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

function resolveCredentials() {
  const host = process.env.AIOS_MYSQL_HOST || '127.0.0.1';
  const port = asqlPort(process.env);
  const user = process.env.AIOS_MYSQL_USER || 'root';
  const database = process.env.AIOS_MYSQL_DATABASE || 'aios_db';

  // The password: AIOS_MYSQL_PASSWORD, else AIOS_MYSQL_PASS_FILE, else the one converge made for the ASQL it starts
  // (scripts/lib/asql-server.mjs: asql.pass in the local state folder).
  const passwordFiles = [
    process.env.AIOS_MYSQL_PASS_FILE,
    process.env.CONVERGE_LOCAL_STATE ? path.join(process.env.CONVERGE_LOCAL_STATE, 'asql.pass') : '',
    path.join(os.homedir(), '.converge-local', 'asql.pass'),
  ].filter(Boolean);
  const password = process.env.AIOS_MYSQL_PASSWORD || passwordFiles.map(readText).find(Boolean) || '';

  // A socket only when one is named (an ASQL engine of your own); otherwise host:port, the ASQL converge starts.
  const socketPath = process.env.AIOS_MYSQL_SOCKET || '';

  return { host, port, user, password, database, socketPath };
}

function scramblePassword(password, scramble) {
  if (!password || !scramble || scramble.length < 20) return Buffer.alloc(0);
  const stage1 = crypto.createHash('sha1').update(password).digest();
  const stage2 = crypto.createHash('sha1').update(stage1).digest();
  const stage3 = crypto.createHash('sha1').update(scramble.subarray(0, 20)).update(stage2).digest();
  const reply = Buffer.alloc(stage1.length);
  for (let i = 0; i < stage1.length; i++) reply[i] = stage1[i] ^ stage3[i];
  return reply;
}

// --- MySQL binary protocol: prepared statements ------------------------------
// COM_STMT_PREPARE (0x16) answers with a server statement id plus the column and
// parameter counts and the parameter definitions; COM_STMT_EXECUTE (0x17) then
// sends the null bitmap and the typed values bound to that handle. prepare(sql)
// hands back a handle synchronously and runs the prepare round trip on the first
// execute().

/** MySQL field/parameter type codes this client serializes. */
export const MYSQL_TYPE = {
  TINY: 1, SHORT: 2, LONG: 3, FLOAT: 4, DOUBLE: 5, NULL: 6, TIMESTAMP: 7,
  LONGLONG: 8, INT24: 9, DATE: 10, TIME: 11, DATETIME: 12, YEAR: 13,
  VARCHAR: 15, BIT: 16, JSON: 245, NEWDECIMAL: 246, ENUM: 247, SET: 248,
  TINY_BLOB: 249, MEDIUM_BLOB: 250, LONG_BLOB: 251, BLOB: 252,
  VAR_STRING: 253, STRING: 254,
};

const BLOB_TYPES = new Set([
  MYSQL_TYPE.TINY_BLOB, MYSQL_TYPE.MEDIUM_BLOB, MYSQL_TYPE.LONG_BLOB,
  MYSQL_TYPE.BLOB,
]);
const STRING_TYPES = new Set([
  MYSQL_TYPE.VARCHAR, MYSQL_TYPE.VAR_STRING, MYSQL_TYPE.STRING,
  MYSQL_TYPE.JSON, MYSQL_TYPE.NEWDECIMAL, MYSQL_TYPE.ENUM, MYSQL_TYPE.SET,
]);

const EMPTY_BUFFER = Buffer.alloc(0);

/** Length-encoded integer, as it appears in the MySQL protocol. */
function lenEncInt(n) {
  const v = Number(n);
  if (v < 0xFB) return Buffer.from([v]);
  if (v < 0x10000) { const b = Buffer.alloc(3); b[0] = 0xFC; b.writeUInt16LE(v, 1); return b; }
  if (v < 0x1000000) { const b = Buffer.alloc(4); b[0] = 0xFD; b[1] = v & 0xFF; b[2] = (v >> 8) & 0xFF; b[3] = (v >> 16) & 0xFF; return b; }
  const b = Buffer.alloc(9); b[0] = 0xFE; b.writeBigUInt64LE(BigInt(v), 1); return b;
}

function lenEncBytes(buf) { return Buffer.concat([lenEncInt(buf.length), buf]); }
function lenEncString(str) { return lenEncBytes(Buffer.from(String(str), 'utf8')); }

let nextStatementHandle = 1;

/** The MySQL type code a JS value binds as. */
export function paramTypeFor(value) {
  if (value === null || value === undefined) return MYSQL_TYPE.NULL;
  if (Buffer.isBuffer(value)) return MYSQL_TYPE.BLOB;
  if (typeof value === 'boolean') return MYSQL_TYPE.TINY;
  if (typeof value === 'bigint') return MYSQL_TYPE.LONGLONG;
  if (typeof value === 'number') return Number.isInteger(value) ? MYSQL_TYPE.LONGLONG : MYSQL_TYPE.DOUBLE;
  if (value instanceof Date) return MYSQL_TYPE.DATETIME;
  return MYSQL_TYPE.VAR_STRING;
}

/** Serializes one bound value in the binary protocol encoding for a MySQL type. */
export function serializeParam(value, type) {
  switch (type) {
    case MYSQL_TYPE.NULL:
      return EMPTY_BUFFER;
    case MYSQL_TYPE.TINY: {
      const b = Buffer.alloc(1);
      b.writeInt8(value ? 1 : 0, 0);
      return b;
    }
    case MYSQL_TYPE.SHORT: {
      const b = Buffer.alloc(2);
      b.writeInt16LE(Number(value), 0);
      return b;
    }
    case MYSQL_TYPE.LONG:
    case MYSQL_TYPE.INT24: {
      const b = Buffer.alloc(4);
      b.writeInt32LE(Number(value), 0);
      return b;
    }
    case MYSQL_TYPE.LONGLONG: {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(value), 0);
      return b;
    }
    case MYSQL_TYPE.FLOAT: {
      const b = Buffer.alloc(4);
      b.writeFloatLE(Number(value), 0);
      return b;
    }
    case MYSQL_TYPE.DOUBLE: {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(Number(value), 0);
      return b;
    }
    case MYSQL_TYPE.DATE:
    case MYSQL_TYPE.DATETIME:
    case MYSQL_TYPE.TIMESTAMP: {
      const d = value instanceof Date ? value : new Date(value);
      const t = Number.isNaN(d.getTime()) ? new Date() : d;
      const b = Buffer.alloc(12);
      b[0] = 11; // length of the datetime payload
      b.writeUInt16LE(t.getUTCFullYear(), 1);
      b[3] = t.getUTCMonth() + 1;
      b[4] = t.getUTCDate();
      b[5] = t.getUTCHours();
      b[6] = t.getUTCMinutes();
      b[7] = t.getUTCSeconds();
      b.writeUInt32LE(t.getUTCMilliseconds() * 1000, 8);
      return b;
    }
    case MYSQL_TYPE.BLOB:
    case MYSQL_TYPE.TINY_BLOB:
    case MYSQL_TYPE.MEDIUM_BLOB:
    case MYSQL_TYPE.LONG_BLOB:
      return lenEncBytes(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
    default: {
      const s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
      return lenEncString(s);
    }
  }
}

const serializerCache = new Map();

/** A cached (value) => Buffer serializer for one MySQL parameter type. */
export function serializerForType(type) {
  let fn = serializerCache.get(type);
  if (!fn) {
    fn = (value) => serializeParam(value, type);
    serializerCache.set(type, fn);
  }
  return fn;
}

/** COM_STMT_PREPARE (0x16): the command byte followed by the SQL text. */
export function buildPreparePayload(sql) {
  const sqlBuf = Buffer.from(String(sql), 'utf8');
  const payload = Buffer.alloc(1 + sqlBuf.length);
  payload[0] = 0x16;
  sqlBuf.copy(payload, 1);
  return payload;
}
export const encodeComStmtPrepare = buildPreparePayload;

/** COM_STMT_EXECUTE (0x17): handle, flags, iteration count, null bitmap, typed values. */
export function buildExecutePayload(stmt, params) {
  const values = Array.isArray(params) ? params : (params === undefined || params === null ? [] : [params]);
  const count = values.length;
  const types = new Array(count);
  const serialized = new Array(count);
  const nullBitmap = Buffer.alloc(Math.floor((count + 7) / 8));

  for (let i = 0; i < count; i++) {
    const value = values[i];
    const type = paramTypeFor(value);
    types[i] = type;
    if (type === MYSQL_TYPE.NULL) {
      nullBitmap[i >> 3] |= 1 << (i & 7);
      serialized[i] = EMPTY_BUFFER;
    } else {
      const reusable = stmt && Array.isArray(stmt.paramTypes) && stmt.paramTypes[i] === type ? stmt.serializers[i] : null;
      const fn = reusable || serializerForType(type);
      if (stmt && Array.isArray(stmt.paramTypes)) { stmt.paramTypes[i] = type; stmt.serializers[i] = fn; }
      serialized[i] = fn(value);
    }
  }

  const header = Buffer.alloc(9);
  header.writeUInt32LE((stmt && stmt.statementId ? stmt.statementId : 0) >>> 0, 0);
  header[4] = 0x00; // flags: CURSOR_TYPE_NO_CURSOR
  header.writeUInt32LE(1, 5); // iteration count
  const parts = [Buffer.from([0x17]), header, nullBitmap, Buffer.from([0x01])]; // 0x01: new-params-bound
  if (count > 0) {
    const typeBuf = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) {
      typeBuf[i * 2] = types[i];
      typeBuf[i * 2 + 1] = 0x00; // unsigned flag
    }
    parts.push(typeBuf);
  }
  for (let i = 0; i < count; i++) parts.push(serialized[i]);
  return Buffer.concat(parts);
}

export const encodeComStmtExecute = buildExecutePayload;

/** A prepared statement handle. The COM_STMT_PREPARE round trip happens on first use. */
function createStatement(client, sql) {
  return {
    id: nextStatementHandle++,
    stmtId: 0,
    statementId: 0,
    sql,
    client,
    prepared: false,
    paramCount: 0,
    columnCount: 0,
    columns: [],
    params: [],
    paramTypes: [],
    serializers: [],
  };
}

/** The endpoint this client talks to, for error messages. */
function endpointOf(client) {
  return client.socketPath || `${client.host}:${client.port}`;
}

export class AsqlClient {
  constructor(opts = {}) {
    const creds = resolveCredentials();
    this.host = opts.host || creds.host;
    this.port = opts.port || creds.port;
    this.socketPath = opts.socketPath !== undefined ? opts.socketPath : creds.socketPath;
    this.user = opts.user || creds.user;
    this.password = opts.password !== undefined ? opts.password : creds.password;
    // Not given: read again on every connection (npm run dev writes the password file when it starts ASQL, which
    // can be after this client was made; and a changed password is picked up without a restart).
    this.passwordFromFiles = opts.password === undefined;
    this.database = opts.database || creds.database;

    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this._connectPromise = null;
    this.buffer = Buffer.alloc(0);
    this.seq = 0;
    this.inFlight = null;
    this.requestQueue = [];
    this.serverVersion = null;
    this.statements = new Map(); // sql text -> prepared handle (server statement ids die with the connection)
  }

  async connect() {
    if (this.connected && this.socket && !this.socket.destroyed) return true;
    if (this._connectPromise) return this._connectPromise;
    this.connecting = true;
    this._connectPromise = this._doConnect().then(
      (ok) => { this.connecting = false; this._connectPromise = null; return ok; },
      (err) => { this.connecting = false; this._connectPromise = null; throw err; }
    );
    return this._connectPromise;
  }

  _doConnect() {
    if (this.passwordFromFiles) this.password = resolveCredentials().password;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      const connectOpts = this.socketPath && fs.existsSync(this.socketPath)
        ? { path: this.socketPath }
        : { host: this.host, port: this.port };

      const sock = net.createConnection(connectOpts, () => {
        this.socket = sock;
        this.buffer = Buffer.alloc(0);
      });

      sock.setTimeout(8000);
      let handshakeState = 'init';

      const onError = (err) => {
        this.connected = false;
        this.statements.clear();
        this._drainQueue(err || new Error('ASQL connect failed'));
        try { sock.destroy(); } catch { /* already closed */ }
        finish(false);
      };

      sock.on('error', onError);
      sock.on('timeout', () => onError(new Error('ASQL socket timeout')));
      sock.on('close', () => {
        this.connected = false;
        this.statements.clear();
        this._drainQueue(new Error('ASQL socket closed'));
        finish(false);
      });

      sock.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (handshakeState === 'init') {
          const pkt = this._readPacket();
          if (pkt) {
            try {
              this._handleHandshake(pkt);
              handshakeState = 'auth_sent';
            } catch (err) {
              onError(err);
            }
          }
        } else if (handshakeState === 'auth_sent') {
          const pkt = this._readPacket();
          if (pkt) {
            if (pkt.payload[0] === 0xFF) {
              onError(new Error('ASQL authentication failed'));
            } else if (pkt.payload[0] === 0x00 || pkt.payload[0] === 0xFE) {
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
    const payload = this.buffer.subarray(4, totalLen);
    this.buffer = this.buffer.subarray(totalLen);
    this.seq = (seq + 1) & 0xFF;
    return { seq, payload };
  }

  _writePacket(payload, seq) {
    if (!this.socket || this.socket.destroyed) throw new Error('ASQL socket not connected');
    const len = payload.length;
    const header = Buffer.alloc(4);
    header[0] = len & 0xFF;
    header[1] = (len >> 8) & 0xFF;
    header[2] = (len >> 16) & 0xFF;
    header[3] = (seq !== undefined ? seq : this.seq) & 0xFF;
    this.socket.write(Buffer.concat([header, payload]));
    this.seq = (header[3] + 1) & 0xFF;
  }

  _handleHandshake(pkt) {
    const nullIdx = pkt.payload.indexOf(0, 1);
    this.serverVersion = nullIdx > 1 ? pkt.payload.subarray(1, nullIdx).toString('latin1') : '';
    let scramble = Buffer.alloc(0);
    if (this.password) {
      let pos = nullIdx + 1 + 4; // skip threadId
      const salt1 = pkt.payload.subarray(pos, pos + 8); pos += 8 + 1 + 2 + 1 + 2 + 2;
      const authLen = pkt.payload[pos]; pos += 1 + 10;
      const salt2Len = Math.max(12, authLen - 8);
      const salt2 = pkt.payload.subarray(pos, pos + salt2Len);
      scramble = Buffer.concat([salt1, salt2]);
    }

    const clientFlags = 0x00000200 | 0x00008000 | 0x00000008; // PROTOCOL_41 | PLUGIN_AUTH | CONNECT_WITH_DB
    const maxPacketSize = 0x01000000;
    const charset = 33; // utf8_general_ci
    const authResp = scramble.length >= 20 ? scramblePassword(this.password, scramble) : Buffer.alloc(0);

    const resp = Buffer.alloc(512);
    let offset = 0;
    resp.writeUInt32LE(clientFlags, offset); offset += 4;
    resp.writeUInt32LE(maxPacketSize, offset); offset += 4;
    resp.writeUInt8(charset, offset); offset += 1;
    resp.fill(0, offset, offset + 23); offset += 23;

    const userBuf = Buffer.from(this.user, 'utf8');
    userBuf.copy(resp, offset); offset += userBuf.length;
    resp[offset++] = 0;

    if (authResp.length > 0) {
      resp.writeUInt8(authResp.length, offset); offset += 1;
      authResp.copy(resp, offset); offset += authResp.length;
    } else {
      resp[offset++] = 0;
    }

    if (this.database) {
      const dbBuf = Buffer.from(this.database, 'utf8');
      dbBuf.copy(resp, offset); offset += dbBuf.length;
      resp[offset++] = 0;
    }

    const pluginBuf = Buffer.from('mysql_native_password\0', 'utf8');
    pluginBuf.copy(resp, offset); offset += pluginBuf.length;

    this._writePacket(resp.subarray(0, offset), 1);
  }

  _sendNext() {
    if (this.inFlight || this.requestQueue.length === 0) return;

    if (!this.connected || !this.socket || this.socket.destroyed) {
      // Fail fast: the connection is gone, so nothing will ever answer these
      // requests. Reject them with an Error instead of leaving them pending
      // (or letting a caller mistake silence for an empty result set).
      this._drainQueue(new Error('ASQL connection lost to ' + endpointOf(this)));
      return;
    }

    const item = this.requestQueue.shift();
    this.inFlight = item;
    item.columnsExpected = null;
    item.colEofReceived = false;
    item.columns = [];
    item.rows = [];
    item.preparePhase = item.kind === 'prepare' ? 'meta' : null;

    let payload;
    if (item.kind === 'prepare') {
      payload = buildPreparePayload(item.sql);
    } else if (item.kind === 'execute') {
      payload = buildExecutePayload(item.stmt, item.params);
    } else {
      const sqlBuf = Buffer.from(item.sql, 'utf8');
      payload = Buffer.alloc(1 + sqlBuf.length);
      payload[0] = 0x03; // COM_QUERY
      sqlBuf.copy(payload, 1);
    }

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

    while (this.buffer.length >= 4) {
      const pkt = this._readPacket();
      if (!pkt) break;
      const current = this.inFlight;
      if (!current) break;

      const marker = pkt.payload[0];
      let finished;
      if (marker === 0xFF) {
        let errMsg = pkt.payload.length > 3 ? pkt.payload.subarray(3).toString('utf8') : 'ASQL error';
        if (pkt.payload.length >= 9 && pkt.payload[3] === 0x23) errMsg = pkt.payload.subarray(9).toString('utf8');
        current.reject(new Error(errMsg));
        finished = true;
      } else if (current.kind === 'prepare') {
        finished = this._consumePreparePacket(current, pkt);
      } else {
        finished = this._consumeResultPacket(current, pkt);
      }

      if (finished) {
        this.inFlight = null;
        this._sendNext();
        return;
      }
    }
  }

  /**
   * Consumes one packet of a COM_STMT_PREPARE response: the 0x00 STMT_PREPARE_OK
   * header (statement id, column count, param count) followed by the parameter
   * definitions and their EOF, then the column definitions and their EOF.
   */
  _consumePreparePacket(current, pkt) {
    const marker = pkt.payload[0];

    if (current.preparePhase === 'meta') {
      current.statementId = pkt.payload.readUInt32LE(1);
      current.numColumns = pkt.payload.readUInt16LE(5);
      current.numParams = pkt.payload.readUInt16LE(7);
      current.paramDefs = [];
      current.columnDefs = [];
      if (current.numParams > 0) { current.preparePhase = 'params'; return false; }
      if (current.numColumns > 0) { current.preparePhase = 'columns'; return false; }
      current.resolve(this._prepareResult(current));
      return true;
    }

    if (current.preparePhase === 'params') {
      if (marker === 0xFE && pkt.payload.length < 9) {
        if (current.numColumns > 0) { current.preparePhase = 'columns'; return false; }
        current.resolve(this._prepareResult(current));
        return true;
      }
      current.paramDefs.push(this._parseColDef(pkt.payload));
      return false;
    }

    if (current.preparePhase === 'columns') {
      if (marker === 0xFE && pkt.payload.length < 9) {
        current.resolve(this._prepareResult(current));
        return true;
      }
      current.columnDefs.push(this._parseColDef(pkt.payload));
      return false;
    }

    return true;
  }

  _prepareResult(current) {
    return {
      statementId: current.statementId,
      columnCount: current.numColumns,
      paramCount: current.numParams,
      columns: current.columnDefs || [],
      params: current.paramDefs || [],
    };
  }

  /** Consumes one packet of a COM_QUERY / COM_STMT_EXECUTE result. */
  _consumeResultPacket(current, pkt) {
    const marker = pkt.payload[0];

    if (current.columnsExpected === null) {
      if (marker === 0x00) {
        const [affectedRows] = this._readLenEncInt(pkt.payload, 1);
        current.resolve({ affectedRows, rows: [], columns: [], statementId: current.statementId || 0 });
        return true;
      }
      const [numCols] = this._readLenEncInt(pkt.payload, 0);
      current.columnsExpected = numCols;
      return false;
    }

    if (current.columns.length < current.columnsExpected) {
      current.columns.push(this._parseColDef(pkt.payload));
      return false;
    }

    if (!current.colEofReceived && marker === 0xFE && pkt.payload.length < 9) {
      current.colEofReceived = true;
      return false;
    }

    if (marker === 0xFE && pkt.payload.length < 9) {
      current.resolve({ affectedRows: current.rows.length, rows: current.rows, columns: current.columns, statementId: current.statementId || 0 });
      return true;
    }

    if (current.kind === 'execute') {
      current.rows.push(this._parseBinaryRow(pkt.payload, current.columns));
    } else {
      current.rows.push(this._parseRow(pkt.payload, current.columns));
    }
    return false;
  }

  _parseColDef(buf) {
    let pos = 0;
    const [, c1] = this._readLenEncString(buf, pos); pos += c1;
    const [, s1] = this._readLenEncString(buf, pos); pos += s1;
    const [table, t1] = this._readLenEncString(buf, pos); pos += t1;
    const [, ot1] = this._readLenEncString(buf, pos); pos += ot1;
    const [name, n1] = this._readLenEncString(buf, pos); pos += n1;
    const [, on1] = this._readLenEncString(buf, pos); pos += on1;
    // 0x0c, charset(2), length(4), type(1), flags(2), decimals(1)
    const type = buf.length >= pos + 10 ? buf[pos + 7] : MYSQL_TYPE.VAR_STRING;
    const flags = buf.length >= pos + 10 ? buf.readUInt16LE(pos + 8) : 0;
    return { name, table, type, unsigned: Boolean(flags & 0x20) };
  }

  _parseBinaryRow(buf, cols) {
    const row = {};
    if (buf[0] !== 0x00) return this._parseRow(buf, cols);
    const numCols = cols.length;
    const nullBitmapLen = Math.floor((numCols + 7 + 2) / 8);
    let pos = 1 + nullBitmapLen;
    for (let i = 0; i < numCols; i++) {
      const byteIdx = 1 + Math.floor((i + 2) / 8);
      const bitIdx = (i + 2) % 8;
      if ((buf[byteIdx] & (1 << bitIdx)) !== 0) {
        row[cols[i].name] = null;
        continue;
      }
      if (pos >= buf.length) break;
      const [val, used] = this._readBinaryValue(buf, pos, cols[i]);
      row[cols[i].name] = val;
      pos += used;
    }
    return row;
  }

  /** One binary-protocol value. Like the text protocol, everything comes back as a string. */
  _readBinaryValue(buf, pos, col) {
    const T = MYSQL_TYPE;
    const u = col.unsigned;
    switch (col.type) {
      case T.TINY: return [String(u ? buf.readUInt8(pos) : buf.readInt8(pos)), 1];
      case T.SHORT: case T.YEAR: return [String(u ? buf.readUInt16LE(pos) : buf.readInt16LE(pos)), 2];
      case T.LONG: case T.INT24: return [String(u ? buf.readUInt32LE(pos) : buf.readInt32LE(pos)), 4];
      case T.LONGLONG: return [String(u ? buf.readBigUInt64LE(pos) : buf.readBigInt64LE(pos)), 8];
      case T.FLOAT: return [String(buf.readFloatLE(pos)), 4];
      case T.DOUBLE: return [String(buf.readDoubleLE(pos)), 8];
      case T.DATE: case T.DATETIME: case T.TIMESTAMP: {
        const len = buf[pos];
        const p2 = (n) => String(n).padStart(2, '0');
        if (len === 0) return ['0000-00-00 00:00:00', 1];
        const y = buf.readUInt16LE(pos + 1);
        let out = `${String(y).padStart(4, '0')}-${p2(buf[pos + 3])}-${p2(buf[pos + 4])}`;
        if (col.type !== T.DATE) out += ` ${len >= 7 ? `${p2(buf[pos + 5])}:${p2(buf[pos + 6])}:${p2(buf[pos + 7])}` : '00:00:00'}`;
        return [out, 1 + len];
      }
      case T.TIME: {
        const len = buf[pos];
        if (len === 0) return ['00:00:00', 1];
        const p2 = (n) => String(n).padStart(2, '0');
        const days = buf.readUInt32LE(pos + 2);
        const out = `${buf[pos + 1] ? '-' : ''}${p2(days * 24 + buf[pos + 6])}:${p2(buf[pos + 7])}:${p2(buf[pos + 8])}`;
        return [out, 1 + len];
      }
      default: return this._readLenEncString(buf, pos);
    }
  }

  _parseRow(buf, cols) {
    const row = {};
    let pos = 0;
    for (let i = 0; i < cols.length; i++) {
      if (pos >= buf.length) break;
      if (buf[pos] === 0xFB) {
        row[cols[i].name] = null;
        pos += 1;
      } else {
        const [val, vLen] = this._readLenEncString(buf, pos);
        row[cols[i].name] = val;
        pos += vLen;
      }
    }
    return row;
  }

  _readLenEncInt(buf, pos) {
    if (pos >= buf.length) return [0, 0];
    const b = buf[pos];
    if (b < 0xFB) return [b, 1];
    if (b === 0xFC) return [buf.readUInt16LE(pos + 1), 3];
    if (b === 0xFD) return [buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16), 4];
    return [Number(buf.readBigUInt64LE(pos + 1)), 9];
  }

  _readLenEncString(buf, pos) {
    const [len, intLen] = this._readLenEncInt(buf, pos);
    const strStart = pos + intLen;
    const str = buf.subarray(strStart, strStart + len).toString('utf8');
    return [str, intLen + len];
  }

  _drainQueue(err) {
    if (this.inFlight) {
      this.inFlight.reject(err);
      this.inFlight = null;
    }
    while (this.requestQueue.length) {
      this.requestQueue.shift().reject(err);
    }
  }

  /** Queues one request behind the connection and returns its promise. */
  _enqueue(item) {
    return new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
      this.requestQueue.push(item);
      this._sendNext();
    });
  }

  async _request(item) {
    const connected = await this.connect();
    if (!connected) throw new Error('Could not connect to ASQL engine on ' + (this.socketPath || `${this.host}:${this.port}`));
    return this._enqueue(item);
  }

  async query(sql) {
    return this._request({ kind: 'query', sql });
  }

  /**
   * Runs COM_STMT_PREPARE (0x16) for a handle and fills in its server statement
   * id, column/param counts, definitions and the parameter serializers bound to
   * its types. Called on the first execute() of a handle.
   */
  async prepareStatement(stmt) {
    const handle = typeof stmt === 'string' ? createStatement(this, stmt) : stmt;
    if (!handle || typeof handle !== 'object') throw new Error('prepareStatement requires a statement handle or SQL text');
    if (handle.prepared && handle.statementId) return handle;
    const res = await this._request({ kind: 'prepare', sql: handle.sql, stmt: handle });
    handle.statementId = res.statementId;
    handle.stmtId = res.statementId;
    handle.paramCount = res.paramCount;
    handle.columnCount = res.columnCount;
    handle.columns = res.columns || [];
    handle.params = res.params || [];
    handle.paramTypes = new Array(res.paramCount || 0).fill(MYSQL_TYPE.NULL);
    handle.serializers = new Array(res.paramCount || 0).fill(null);
    handle.prepared = true;
    return handle;
  }

  /** Runs COM_STMT_EXECUTE (0x17) with the null bitmap plus typed values for a handle. */
  async executeStatement(stmt, params) {
    const handle = await this.prepareStatement(stmt);
    const res = await this._request({ kind: 'execute', stmt: handle, params });
    return { ...res, statementId: handle.statementId };
  }

  /** Alias of run(): `sql` with `?` placeholders bound to `params`. */
  execute(sql, params = []) { return this.run(sql, params); }

  /** Runs `sql` with `?` placeholders bound to `params`, preparing each distinct statement text once per connection. */
  async run(sql, params = []) {
    await this.connect();
    let handle = this.statements.get(sql);
    if (!handle) { handle = createStatement(this, sql); this.statements.set(sql, handle); }
    try {
      return await this.executeStatement(handle, params);
    } catch (err) {
      if (!handle.prepared) this.statements.delete(sql);
      throw err;
    }
  }

  close() {
    this.statements.clear();
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.connected = false;
  }
}

let singletonClient = null;
export function getAsql() {
  if (!singletonClient) singletonClient = new AsqlClient();
  return singletonClient;
}

/**
 * Prepares `sql` and returns a statement handle synchronously (the
 * COM_STMT_PREPARE round trip happens on the first execute). The handle carries
 * the statement id, the column/param counts and the parameter serializers.
 */
export function prepare(sql) {
  return createStatement(getAsql(), sql);
}

/** Runs a prepared statement (a handle from prepare(), or SQL text) with bound params. */
export async function execute(stmt, params) {
  const client = stmt && typeof stmt === 'object' && stmt.client ? stmt.client : getAsql();
  return client.executeStatement(stmt, params);
}
