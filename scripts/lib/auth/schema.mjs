// Auth schema migrations for converge, in the MySQL dialect ASQL speaks.
//
// MIGRATIONS is the single source of truth for the auth tables: an ordered
// array of {id, name, sql}. ids are positive integers; each id runs at most
// once per database. applyMigrations(conn) brings an open ASQL connection up
// to date, records every applied id in converge_migrations and skips the ones
// already there, so it is safe to call on each boot. The statements are plain
// MySQL: keys are VARCHAR (ASQL, like MySQL, cannot key a TEXT column), indexes
// are declared inside CREATE TABLE, and timestamps are ISO-8601 strings the
// store writes itself. Only the hash of a session, invitation or API token
// value is stored (token_hash columns), never the value itself.

export const MIGRATIONS_TABLE = 'converge_migrations';

const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS converge_migrations (
  id VARCHAR(64) PRIMARY KEY,
  applied_at VARCHAR(32) NOT NULL
)`;

export const MIGRATIONS = [
  { id: 1, name: 'converge_migrations', sql: MIGRATIONS_TABLE_SQL },
  {
    id: 2,
    name: 'converge_users',
    sql: `CREATE TABLE IF NOT EXISTS converge_users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY converge_users_email_idx (email)
)`,
  },
  {
    id: 3,
    name: 'converge_credentials',
    sql: `CREATE TABLE IF NOT EXISTS converge_credentials (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'password',
  algo VARCHAR(32) NOT NULL DEFAULT 'scrypt',
  hash TEXT NOT NULL,
  params TEXT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY converge_credentials_user_kind_idx (user_id, kind)
)`,
  },
  {
    id: 4,
    name: 'converge_sessions',
    sql: `CREATE TABLE IF NOT EXISTS converge_sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32),
  revoked_at VARCHAR(32),
  UNIQUE KEY converge_sessions_token_idx (token_hash),
  KEY converge_sessions_user_idx (user_id)
)`,
  },
  {
    id: 5,
    name: 'converge_memberships',
    sql: `CREATE TABLE IF NOT EXISTS converge_memberships (
  user_id VARCHAR(64) NOT NULL,
  project VARCHAR(128) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id, project),
  KEY converge_memberships_project_idx (project)
)`,
  },
  {
    id: 6,
    name: 'converge_tokens',
    sql: `CREATE TABLE IF NOT EXISTS converge_tokens (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  name VARCHAR(255),
  token_hash VARCHAR(64) NOT NULL,
  scopes TEXT,
  created_at VARCHAR(32) NOT NULL,
  last_used_at VARCHAR(32),
  expires_at VARCHAR(32),
  revoked_at VARCHAR(32),
  UNIQUE KEY converge_tokens_hash_idx (token_hash),
  KEY converge_tokens_user_idx (user_id)
)`,
  },
  {
    id: 7,
    name: 'converge_invites',
    sql: `CREATE TABLE IF NOT EXISTS converge_invites (
  id VARCHAR(64) PRIMARY KEY,
  project VARCHAR(128) NOT NULL,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  token_hash VARCHAR(64) NOT NULL,
  invited_by VARCHAR(64),
  created_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32),
  accepted_at VARCHAR(32),
  UNIQUE KEY converge_invites_hash_idx (token_hash),
  UNIQUE KEY converge_invites_project_email_idx (project, email),
  KEY converge_invites_project_idx (project)
)`,
  },
  {
    id: 8,
    name: 'converge_audit',
    sql: `CREATE TABLE IF NOT EXISTS converge_audit (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  at VARCHAR(32) NOT NULL,
  actor VARCHAR(255),
  project VARCHAR(128),
  action VARCHAR(64) NOT NULL,
  target VARCHAR(255),
  detail TEXT,
  KEY converge_audit_project_idx (project, at),
  KEY converge_audit_actor_idx (actor, at)
)`,
  },
];

// Every statement goes through the connection's own query(), which ASQL (AsqlClient) offers.
const rowsOf = (result) => (Array.isArray(result) ? result : result && Array.isArray(result.rows) ? result.rows : []);

// Bring `conn` up to date. Resolves to the ids actually applied this call, in
// order; ids already recorded in converge_migrations are skipped. Each id's
// DDL commits as it runs (MySQL DDL cannot roll back), so the ledger row is
// written last: a crash in between re-runs the id, which is why every
// statement is CREATE TABLE IF NOT EXISTS.
export async function applyMigrations(conn) {
  if (!conn || typeof conn.query !== 'function') {
    throw new TypeError('applyMigrations(conn): an open ASQL connection is required');
  }

  await conn.query(MIGRATIONS_TABLE_SQL);
  const applied = new Set(
    rowsOf(await conn.query(`SELECT id FROM ${MIGRATIONS_TABLE}`)).map((row) => String(row.id)),
  );

  const ran = [];
  for (const migration of MIGRATIONS) {
    const id = String(migration.id);
    if (applied.has(id)) continue;
    await conn.query(migration.sql);
    const insert = `INSERT IGNORE INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`;
    const when = new Date().toISOString();
    if (typeof conn.run === 'function') await conn.run(insert, [id, when]);
    else throw new TypeError('applyMigrations(conn): the connection must offer run(sql, params)');
    applied.add(id);
    ran.push(migration.id);
  }
  return ran;
}
