// What converge keeps in ASQL besides logins: the model providers' API keys, models and accounts, and the Cloudflare
// connection. Credentials are encrypted at rest (secrets.mjs). The keys are mirrored to the agent config file (~/.converge/config.json), which
// the external tools read; $CONVERGE_CONFIG moves it (tests point it at a temp file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAsql } from './asql.mjs';
import { seal, open, isEncrypted } from './secrets.mjs';
import { writePrivate } from './private-file.mjs';

const agentConfigPath = () => process.env.CONVERGE_CONFIG || path.join(os.homedir(), '.converge', 'config.json');

/** The agent config as an object, or null when there is none (or it does not parse). */
function readAgentConfig() {
  try { return JSON.parse(fs.readFileSync(agentConfigPath(), 'utf8')); } catch { return null; }
}

/** Applies `change` to the agent config and writes it back (0600). The mirror is a convenience for other tools, so a
 *  failure is said once on stderr and never fails the save to ASQL. */
function updateAgentConfig(change) {
  try {
    const cfg = readAgentConfig() || {};
    change(cfg);
    fs.mkdirSync(path.dirname(agentConfigPath()), { recursive: true });
    writePrivate(agentConfigPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn(`provider-store: could not update ${agentConfigPath()}: ${e.message}`);
  }
}

/** Initializes the required tables in ASQL */
export async function ensureAsqlTables() {
  const asql = getAsql();
  await asql.query(`
    CREATE TABLE IF NOT EXISTS converge_provider_keys (
      provider VARCHAR(64) PRIMARY KEY,
      api_key TEXT NOT NULL,
      host VARCHAR(255) DEFAULT '',
      updated_at BIGINT NOT NULL
    );
  `);
  await asql.query(`
    CREATE TABLE IF NOT EXISTS converge_provider_models (
      id INT AUTO_INCREMENT PRIMARY KEY,
      provider VARCHAR(64) NOT NULL,
      model VARCHAR(128) NOT NULL,
      host VARCHAR(255) DEFAULT '',
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uq_prov_model (provider, model)
    );
  `);
  await asql.query(`
    CREATE TABLE IF NOT EXISTS converge_provider_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      provider VARCHAR(64) NOT NULL,
      label VARCHAR(64) NOT NULL,
      api_key TEXT NOT NULL,
      is_free TINYINT DEFAULT 0,
      host VARCHAR(255) DEFAULT ''
    );
  `);
  await asql.query(`
    CREATE TABLE IF NOT EXISTS converge_cloudflare_config (
      id INT PRIMARY KEY,
      account_id VARCHAR(64) DEFAULT '',
      account_name VARCHAR(128) DEFAULT '',
      api_token TEXT NOT NULL,
      worker_url VARCHAR(255) DEFAULT '',
      admin_key TEXT NOT NULL,
      workers_ai TINYINT DEFAULT 0,
      updated_at BIGINT NOT NULL
    );
  `);
}

/** Encrypts every credential still stored as plaintext (rows from before encryption at rest). Returns how many were converted. */
export async function encryptStored() {
  const asql = getAsql();
  await ensureAsqlTables();
  let n = 0;
  const plan = [
    ['converge_provider_keys', 'provider', ['api_key']],
    ['converge_provider_accounts', 'id', ['api_key']],
    ['converge_cloudflare_config', 'id', ['api_token', 'admin_key']],
  ];
  for (const [table, idCol, cols] of plan) {
    const rows = (await asql.query(`SELECT ${idCol}, ${cols.join(', ')} FROM ${table}`)).rows || [];
    for (const row of rows) for (const col of cols) {
      if (!row[col] || isEncrypted(row[col])) continue;
      await asql.run(`UPDATE ${table} SET ${col} = ? WHERE ${idCol} = ?`, [seal(row[col]), row[idCol]]);
      n += 1;
    }
  }
  return n;
}

/** Reads all keys, models, and accounts from ASQL */
export async function readAsql() {
  const asql = getAsql();
  try {
    await ensureAsqlTables();
    const [keysRes, modelsRes, acctsRes] = await Promise.all([
      asql.query('SELECT provider, api_key, host FROM converge_provider_keys'),
      asql.query('SELECT provider, model, host FROM converge_provider_models'),
      asql.query('SELECT provider, label, api_key, is_free, host FROM converge_provider_accounts'),
    ]);

    const apiKeys = {};
    const providers = {};
    for (const r of keysRes.rows || []) {
      apiKeys[r.provider] = open(r.api_key);
      if (r.host) providers[r.provider] = { host: r.host };
    }

    const models = (modelsRes.rows || []).map((r) => ({
      provider: r.provider,
      model: r.model,
      ...(r.host ? { host: r.host } : {}),
    }));

    const accounts = (acctsRes.rows || []).map((r) => ({
      provider: r.provider,
      label: r.label,
      apiKey: open(r.api_key),
      key: open(r.api_key),
      free: Boolean(Number(r.is_free)),
      ...(r.host ? { host: r.host } : {}),
    }));

    return { apiKeys, models, accounts, providers };
  } catch {
    // ASQL is down: no keys. converge never takes them from another tool's config (~/.converge/config.json): you add your own.
    return { apiKeys: {}, models: [], accounts: [] };
  }
}

/** Seeds ASQL from ~/.converge/config.json */
export async function seedFromAgentConfig() {
  const c = readAgentConfig();
  if (!c) return { apiKeys: {}, models: [], accounts: [] };
  const asql = getAsql();
  await ensureAsqlTables();

  const now = Date.now();
  for (const [p, key] of Object.entries(c.apiKeys || {})) {
    if (!key) continue;
    const h = c.providers?.[p]?.host || '';
    await asql.run('REPLACE INTO converge_provider_keys (provider, api_key, host, updated_at) VALUES (?, ?, ?, ?)', [p, seal(key), h, now]);
  }

  for (const m of c.models || []) {
    if (!m.provider || !m.model) continue;
    await asql.run('REPLACE INTO converge_provider_models (provider, model, host, updated_at) VALUES (?, ?, ?, ?)', [m.provider, m.model, m.host || '', now]);
  }

  // Accounts have no natural key: seed them only into an empty table, or every re-seed would duplicate them.
  const have = await asql.query('SELECT COUNT(*) AS n FROM converge_provider_accounts');
  if (!Number(have.rows?.[0]?.n)) {
    for (const a of c.accounts || []) {
      if (!a.provider) continue;
      const k = a.apiKey || a.key || '';
      await asql.run('INSERT INTO converge_provider_accounts (provider, label, api_key, is_free, host) VALUES (?, ?, ?, ?, ?)', [a.provider, a.label || '', seal(k), a.free ? 1 : 0, a.host || '']);
    }
  }

  return {
    apiKeys: c.apiKeys || {},
    models: c.models || [],
    accounts: c.accounts || [],
    providers: c.providers || {},
  };
}

/** Saves or removes an API key and/or model in ASQL, and keeps ~/.converge/config.json in sync as mirror */
export async function setAsqlProvider(provider, key, models = [], keepKey = false) {
  const asql = getAsql();
  await ensureAsqlTables();
  const now = Date.now();

  if (!keepKey) {
    if (key) {
      await asql.run("REPLACE INTO converge_provider_keys (provider, api_key, host, updated_at) VALUES (?, ?, '', ?)", [provider, seal(key), now]);
    } else {
      await asql.run('DELETE FROM converge_provider_keys WHERE provider = ?', [provider]);
    }
  }

  if (!key && !keepKey && provider === 'cloudflare') {
    await asql.run('DELETE FROM converge_provider_models WHERE provider = ?', [provider]);
  }

  for (const m of models) {
    if (!m.model) continue;
    await asql.run('REPLACE INTO converge_provider_models (provider, model, host, updated_at) VALUES (?, ?, ?, ?)', [provider, m.model, m.host || '', now]);
  }

  // Mirror to the agent config so external tools and mind bridges have the keys too.
  const full = await readAsql();
  updateAgentConfig((cfg) => { cfg.apiKeys = full.apiKeys; cfg.models = full.models; cfg.accounts = full.accounts; });
}

/** Drops a single model from ASQL and mirror */
export async function dropAsqlModel(provider, model) {
  const asql = getAsql();
  await ensureAsqlTables();
  await asql.run('DELETE FROM converge_provider_models WHERE provider = ? AND model = ?', [provider, model]);

  updateAgentConfig((cfg) => { cfg.models = (cfg.models || []).filter((m) => !(m.provider === provider && m.model === model)); });
}

/** Reads Cloudflare config stored in ASQL */
export async function readAsqlCloudflare() {
  const asql = getAsql();
  try {
    await ensureAsqlTables();
    const res = await asql.query('SELECT account_id, account_name, api_token, worker_url, admin_key, workers_ai FROM converge_cloudflare_config WHERE id = 1');
    const row = res.rows?.[0];
    if (!row) return {}; // reachable, nothing stored yet (null means ASQL could not be asked)
    return {
      account_id: row.account_id || '',
      account_name: row.account_name || '',
      api_token: open(row.api_token),
      worker_url: row.worker_url || '',
      admin_key: open(row.admin_key),
      workers_ai: Boolean(row.workers_ai),
    };
  } catch {
    return null;
  }
}

/** Saves or updates Cloudflare config in ASQL. Throws when it could not be stored: a swallowed failure looks like a saved login. */
export async function saveAsqlCloudflare(cfg) {
  const asql = getAsql();
  await ensureAsqlTables();
  await asql.run(
    'REPLACE INTO converge_cloudflare_config (id, account_id, account_name, api_token, worker_url, admin_key, workers_ai, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
    [cfg.account_id || '', cfg.account_name || '', seal(cfg.api_token), cfg.worker_url || '', seal(cfg.admin_key), cfg.workers_ai ? 1 : 0, Date.now()],
  );
}
