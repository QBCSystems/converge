// Where a run's time goes, kept in ASQL (converge_timeline, one row per measured step): the engine's verifier and merge
// train print a line per check and train (verify.cpp "timing verify ...", train.cpp "train ...: N change(s) passed in Xs"),
// the platform parses them here. GET /api/projects/<name>/timeline reads them back.
import { getAsql } from './asql.mjs';

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = getAsql().query(`
      CREATE TABLE IF NOT EXISTS converge_timeline (
        id BIGINT PRIMARY KEY,
        project VARCHAR(128) NOT NULL,
        at BIGINT NOT NULL,
        step VARCHAR(32) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        ms BIGINT NOT NULL,
        detail TEXT
      );
    `).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

let seq = Date.now() * 1000;
/** A row from one engine stderr line, or null when the line is not a measurement. */
export function parseTiming(line) {
  let m = /^timing verify (\S+) (\S+) (\S+) (.*)$/.exec(line);
  if (m) {
    const kv = Object.fromEntries(m[4].split(/\s+/).map((p) => p.split('=')).filter((p) => p.length === 2));
    return { step: `verify:${m[1]}`, subject: `${m[2]} ${m[3]}`, ms: Number(kv.run_ms) || 0, detail: m[4] };
  }
  m = /^train pick: (.*)$/.exec(line);
  if (m) return { step: 'train-pick', subject: '', ms: 0, detail: m[1] };
  m = /^train (train-\S+): (\d+) change\(s\) (passed|failed|timed out) in ([\d.]+)s(?: \((.*)\))?$/.exec(line);
  if (m) return { step: 'train', subject: m[1], ms: Math.round(Number(m[4]) * 1000), detail: `${m[2]} change(s) ${m[3]}${m[5] ? `; ${m[5]}` : ''}` };
  return null;
}

/** Records `row` (parseTiming's) for `project`; ASQL down: dropped (the line is still in the log). */
export async function recordTiming(project, row) {
  try {
    await ensureTable();
    await getAsql().run('INSERT INTO converge_timeline (id, project, at, step, subject, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [++seq, project, Date.now(), row.step, row.subject.slice(0, 255), row.ms, row.detail || '']);
  } catch { /* ASQL down */ }
}

/** The last `limit` rows of `project`, oldest first, and per step its count, total and slowest. */
export async function readTimeline(project, limit = 200) {
  await ensureTable();
  const rows = (await getAsql().run('SELECT at, step, subject, ms, detail FROM converge_timeline WHERE project = ? ORDER BY id DESC LIMIT ?', [project, Number(limit)])).rows || [];
  const steps = (await getAsql().run('SELECT step, COUNT(*) AS n, SUM(ms) AS total_ms, MAX(ms) AS max_ms FROM converge_timeline WHERE project = ? GROUP BY step', [project])).rows || [];
  return { rows: rows.reverse(), steps };
}

/** Forgets `project`'s rows (the project was deleted). */
export async function deleteTimeline(project) {
  try { await ensureTable(); await getAsql().run('DELETE FROM converge_timeline WHERE project = ?', [project]); } catch { /* ASQL down */ }
}
