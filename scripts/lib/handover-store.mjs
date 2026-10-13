// What a worker hands to whoever continues its task (agents/aios-runtime.mjs writeHandover: its notes, the file ranges it
// read, its claim and its last steps), kept in ASQL by the platform, one row per agent. The successor reads it from here
// wherever it runs: a run on another machine, or one the dashboard or the swarm starts later, finds it as well.
import { getAsql } from './asql.mjs';

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = getAsql().query(`
      CREATE TABLE IF NOT EXISTS converge_handovers (
        id VARCHAR(255) PRIMARY KEY,
        project VARCHAR(128) NOT NULL,
        agent_id VARCHAR(64) NOT NULL,
        body LONGTEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// The harness carries its memory, ledgers and conversation (agents/harness-state.mjs caps them at 2 MB before base64).
const MAX_BODY = 4_000_000;

/** Saves agent `agentId`'s handover in `project` (replacing its last one). */
export async function saveHandover(project, agentId, body) {
  const text = JSON.stringify(body);
  if (text.length > MAX_BODY) throw Object.assign(new Error(`a handover is at most ${MAX_BODY} characters`), { status: 413 });
  await ensureTable();
  await getAsql().run('REPLACE INTO converge_handovers (id, project, agent_id, body, updated_at) VALUES (?, ?, ?, ?, ?)',
    [`${project}/${agentId}`, project, agentId, text, Date.now()]);
}

/** Agent `agentId`'s last handover in `project`, or null. */
export async function loadHandover(project, agentId) {
  await ensureTable();
  const r = await getAsql().run('SELECT body FROM converge_handovers WHERE id = ?', [`${project}/${agentId}`]);
  const row = (r.rows || [])[0];
  if (!row) return null;
  try { return JSON.parse(row.body); } catch { return null; }
}

/** Forgets every handover of `project` (the project was deleted). */
export async function deleteHandovers(project) {
  await ensureTable();
  await getAsql().run('DELETE FROM converge_handovers WHERE project = ?', [project]);
}
