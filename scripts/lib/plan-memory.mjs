// What planning in a project has learned, kept in ASQL (converge_plan_memory): the checks the plan check refused there,
// and why (so the planner does not write them again), and the tasks whose checks landed, with the request they came
// from (so a request like an earlier one is planned the way that one worked). agents/plan.mjs reads it through
// GET /api/projects/<name>/plan-memory?request=... and adds refused checks with POST; a run's landed tasks are added
// when the run ends (local-run.mjs).
import { getAsql } from './asql.mjs';

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = getAsql().query(`
      CREATE TABLE IF NOT EXISTS converge_plan_memory (
        id BIGINT PRIMARY KEY,
        project VARCHAR(128) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        request TEXT,
        body TEXT NOT NULL,
        at BIGINT NOT NULL
      );
    `).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
let seq = Date.now() * 1000;
const add = async (project, kind, request, body) => {
  await ensureTable();
  await getAsql().run('INSERT INTO converge_plan_memory (id, project, kind, request, body, at) VALUES (?, ?, ?, ?, ?, ?)',
    [++seq, project, kind, String(request || '').slice(0, 4000), JSON.stringify(body).slice(0, 16000), Date.now()]);
};

/** A refused check and why ("a check already passes on main, ..."), without the task's key. */
export async function rememberRefused(project, request, problems) {
  for (const p of (problems || []).slice(0, 20)) await add(project, 'refused', request, { why: String(p).replace(/^task [\w-]+:\s*/, '').slice(0, 600) });
}
/** The tasks of a run that landed: [{title, description, accept}]. */
export async function rememberLanded(project, request, tasks) {
  if (tasks?.length) await add(project, 'landed', request, { tasks: tasks.map((t) => ({ title: String(t.title || '').slice(0, 200), accept: (t.accept || []).slice(0, 4) })) });
}

const grams = (s) => {
  const t = ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
};
const similarity = (a, b) => { let n = 0; for (const g of a) if (b.has(g)) n++; return n / Math.max(1, a.size + b.size - n); };

/** For planning `request` in `project`: the last refused checks (newest first, each reason once) and the most similar
 *  earlier request whose tasks landed (similarity of letter trigrams, at least 0.2). */
export async function recall(project, request) {
  await ensureTable();
  const rows = (await getAsql().run('SELECT kind, request, body FROM converge_plan_memory WHERE project = ? ORDER BY id DESC LIMIT 400', [project])).rows || [];
  const refused = [];
  const seen = new Set();
  let best = null;
  const want = grams(request);
  for (const r of rows) {
    let body; try { body = JSON.parse(r.body); } catch { continue; }
    if (r.kind === 'refused' && body.why && refused.length < 12) {
      const k = body.why.replace(/:.*$/, '');
      if (!seen.has(k)) { seen.add(k); refused.push(body.why); }
    }
    if (r.kind === 'landed' && body.tasks?.length) {
      const score = similarity(want, grams(r.request));
      if (score >= 0.2 && (!best || score > best.score)) best = { score: +score.toFixed(2), request: r.request, tasks: body.tasks };
    }
  }
  return { refused, similar: best };
}

export async function deletePlanMemory(project) {
  try { await ensureTable(); await getAsql().run('DELETE FROM converge_plan_memory WHERE project = ?', [project]); } catch { /* ASQL down */ }
}
