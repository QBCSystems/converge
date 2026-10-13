import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAsql,
  prepare,
  execute,
  encodeComStmtPrepare,
  encodeComStmtExecute,
  paramTypeFor,
  serializeParam,
  serializerForType,
  MYSQL_TYPE,
  AsqlClient,
} from '../scripts/lib/asql.mjs';
import { startAsql, asqlMissing } from './fixtures/asql-server.mjs';

test('prepare returns synchronous statement handle with id and stmtId', () => {
  const stmt = prepare('SELECT 1 + ? AS num');
  assert.equal(typeof stmt, 'object');
  assert.ok('id' in stmt || 'stmtId' in stmt);
  assert.equal(typeof stmt.id, 'number');
  assert.equal(stmt.sql, 'SELECT 1 + ? AS num');
  assert.equal(stmt.prepared, false);
});

test('encodeComStmtPrepare encodes COM_STMT_PREPARE (0x16) packet payload', () => {
  const sql = 'SELECT id, username FROM users WHERE role = ?';
  const payload = encodeComStmtPrepare(sql);
  assert.equal(payload[0], 0x16);
  assert.equal(payload.subarray(1).toString('utf8'), sql);
});

test('encodeComStmtExecute encodes COM_STMT_EXECUTE (0x17) with null bitmap and parameters', () => {
  const stmt = prepare('SELECT ? AS a, ? AS b, ? AS c');
  stmt.statementId = 42;
  const params = ['test-string', null, 12345];
  const payload = encodeComStmtExecute(stmt, params);

  assert.equal(payload[0], 0x17); // COM_STMT_EXECUTE
  assert.equal(payload.readUInt32LE(1), 42); // statement id
  assert.equal(payload[5], 0x00); // flags
  assert.equal(payload.readUInt32LE(6), 1); // iteration count

  // Null bitmap byte (params count = 3 -> 1 byte):
  // param 0: not null (bit 0 = 0)
  // param 1: null (bit 1 = 1 -> 0x02)
  // param 2: not null (bit 2 = 0)
  const nullBitmapByte = payload[10];
  assert.equal(nullBitmapByte & 0x02, 0x02, 'bit 1 should be set for null parameter');
  assert.equal(nullBitmapByte & 0x01, 0x00, 'bit 0 should be clear for non-null parameter');
  assert.equal(nullBitmapByte & 0x04, 0x00, 'bit 2 should be clear for non-null parameter');

  // Check new-params-bound flag
  assert.equal(payload[11], 0x01);
});

test('parameter types and serializer caching', () => {
  assert.equal(paramTypeFor(null), MYSQL_TYPE.NULL);
  assert.equal(paramTypeFor('hello'), MYSQL_TYPE.VAR_STRING);
  assert.equal(paramTypeFor(42), MYSQL_TYPE.LONGLONG);
  assert.equal(paramTypeFor(3.14), MYSQL_TYPE.DOUBLE);
  assert.equal(paramTypeFor(true), MYSQL_TYPE.TINY);
  assert.equal(paramTypeFor(Buffer.from('blob')), MYSQL_TYPE.BLOB);

  const fn1 = serializerForType(MYSQL_TYPE.VAR_STRING);
  const fn2 = serializerForType(MYSQL_TYPE.VAR_STRING);
  assert.strictEqual(fn1, fn2, 'serializer function should be cached');
});

test('AsqlClient fails fast and throws an Error on disconnected engine', async () => {
  const client = new AsqlClient({ host: '127.0.0.1', port: 19999, socketPath: '' });
  await assert.rejects(
    async () => {
      await client.query('SELECT 1');
    },
    (err) => {
      assert.match(err.message, /Could not connect to ASQL engine|ASQL connection lost/);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await client.execute('SELECT ?', [1]);
    },
    (err) => {
      assert.match(err.message, /Could not connect to ASQL engine|ASQL connection lost/);
      return true;
    }
  );
});

test('execute runs prepared statements against a real ASQL, with typed results and a statement cache', { skip: asqlMissing() }, async () => {
  const server = await startAsql();
  try {
    const stmt = prepare('SELECT 100 + ? AS val, ? AS str');
    stmt.client = server.client;
    const res = await execute(stmt, [23, 'hello world']);
    assert.equal(res.rows.length, 1);
    assert.equal(String(res.rows[0].val), '123');
    assert.equal(res.rows[0].str, 'hello world');

    // run() prepares each statement text once per connection and rebinds it.
    const a = await server.client.run('SELECT ? + 1 AS n', [1]);
    const b = await server.client.run('SELECT ? + 1 AS n', [41]);
    assert.equal(a.statementId, b.statementId);
    assert.equal(b.rows[0].n, '42');
    assert.equal(server.client.statements.size, 1);
  } finally {
    server.stop();
  }
});
