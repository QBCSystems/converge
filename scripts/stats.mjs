#!/usr/bin/env node
// Recomputes a project's run figures from its event log, read live and read-only through the platform's
// GET /api/projects/<p>/sql route (one SELECT at a time, inside the project's aios ASQL database).
//
//   node scripts/stats.mjs pocket pocket-40 arcade        [--json]
//
// env: CONVERGE_API_URL (the Worker), and VIEW_KEY or ADMIN_KEY (sent as a header, never printed). Both are read
// from the environment, else from .env.converge in the repository root (what scripts/provision.sh writes).
//
// What it counts, per project (all from converge.events):
//   tasks        distinct tasks, not counting the seed task that brings the codebase in
//   agents       workers added (AgentAdded role worker), not counting the seed agent; reviewers separately
//   repos        main plus one Artifacts fork per agent (workers and the seed agent; reviewers have none)
//   submissions  Submitted events
//   checks       Verified events: every check run's result (project tests, re-run, evidence, acceptance, train)
//   failed       checks with a non-zero exit or a timeout, and on how many distinct changes
//   landed_bad   landings whose landed head still had a failing check when it landed: should be 0
//   landings     Landed events not counting the seed's
//   run_landings those inside the run: from the first agent task to the first hour with no event at all
//   minutes      from the first agent task to the run's last landing
//   receipts     signed Landed and MainRewound events; rewinds = MainRewound events
// Not shown, because the event log cannot reproduce them: spend, the model an agent used, and how many tests
// main holds (each check run records its own commit's output, not a count for main).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const projects = args.filter((a) => !a.startsWith('--'));
if (!projects.length) { console.error('usage: node scripts/stats.mjs <project>... [--json]'); process.exit(2); }

const env = { ...readEnvFile(path.join(ROOT, '.env.converge')), ...pick(process.env, ['CONVERGE_API_URL', 'VIEW_KEY', 'ADMIN_KEY']) };
const base = String(env.CONVERGE_API_URL || '').replace(/\/$/, '');
if (!base) { console.error('set CONVERGE_API_URL (or put it in .env.converge)'); process.exit(2); }
const headers = env.ADMIN_KEY ? { 'X-Admin-Key': env.ADMIN_KEY } : env.VIEW_KEY ? { 'X-View-Key': env.VIEW_KEY } : {};
if (!Object.keys(headers).length) { console.error('set VIEW_KEY or ADMIN_KEY (or put one in .env.converge): every read needs a key'); process.exit(2); }

function readEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').map((l) => /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, '')]));
  } catch { return {}; }
}
function pick(o, keys) { return Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, o[k]])); }

async function sql(project, q) {
  const res = await fetch(`${base}/api/projects/${encodeURIComponent(project)}/sql?q=${encodeURIComponent(q)}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${project}: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Every event of the project, in order, paged by seq so no one answer is large. */
async function events(project) {
  const out = [];
  for (let after = 0; ;) {
    const r = await sql(project, `SELECT seq, json FROM converge.events WHERE seq > ${after} ORDER BY seq LIMIT 100`);
    if (!r.rows?.length) break;
    for (const [seq, j] of r.rows) { out.push(JSON.parse(j)); after = Math.max(after, Number(seq)); }
    if (r.rows.length < 100) break;
  }
  return out;
}

function stats(project, ev) {
  const of = (t) => ev.filter((e) => e.type === t);
  const seedTasks = new Set(of('TaskCreated').filter((e) => /^Seed:/.test(e.title || '')).map((e) => e.task_id));
  const tasks = new Set(of('TaskCreated').filter((e) => !seedTasks.has(e.task_id)).map((e) => e.task_id));
  const seedAgents = new Set(of('TaskCreated').filter((e) => seedTasks.has(e.task_id)).flatMap((e) => (e.agents || []).map((a) => a.agent_id)));
  const added = of('AgentAdded');
  const workers = added.filter((e) => e.role !== 'reviewer' && !seedAgents.has(e.agent_id));
  const reviewers = added.filter((e) => e.role === 'reviewer');
  const checks = of('Verified');
  const failed = checks.filter((e) => e.exit_code !== 0 || e.timed_out);
  const landed = of('Landed');
  // A landing's receipt names its agent and the head commit that landed.
  const receipt = (e) => { try { return JSON.parse(e.receipt || '{}'); } catch { return {}; } };
  const agentLandings = landed.filter((e) => !seedAgents.has(receipt(e).agent));
  // A landing that went in over a failed check: for its landed head, the latest result of some check kind before
  // the landing was a failure. (A failed claim check that was restated and re-run passing is not one.)
  const landedBad = landed.filter((l) => {
    const h = receipt(l).head_commit;
    const latest = new Map();
    for (const c of checks) if (c.seq < l.seq && c.change_id === l.change_id && c.commit === h) latest.set(c.kind, c);
    return [...latest.values()].some((c) => c.exit_code !== 0 || c.timed_out);
  });
  const rewinds = of('MainRewound');
  const receipts = [...landed, ...rewinds].filter((e) => e.signature).length;
  // The run itself: from the first agent task to the first hour with no event at all (later sessions on the same
  // project, such as a rewind demo or a late extra task, are counted in the totals but not in the run's minutes).
  const firstTask = of('TaskCreated').find((e) => tasks.has(e.task_id));
  let end = ev.length - 1;
  if (firstTask) for (let i = ev.indexOf(firstTask) + 1; i < ev.length; i++) if (ev[i].at - ev[i - 1].at > 3600_000) { end = i - 1; break; }
  const inRun = (e) => firstTask && e.seq >= firstTask.seq && e.seq <= ev[end].seq;
  const runLandings = agentLandings.filter(inRun);
  const lastLanding = runLandings.at(-1);
  const minutes = lastLanding ? (lastLanding.at - firstTask.at) / 60000 : null;
  return {
    project,
    tasks: tasks.size,
    agents: workers.length,
    reviewers: reviewers.length,
    repos: 1 + workers.length + seedAgents.size,
    submissions: of('Submitted').length,
    checks: checks.length,
    failed: failed.length,
    failed_changes: new Set(failed.map((e) => e.change_id)).size,
    landed_bad: landedBad.length,
    landings: agentLandings.length,
    run_landings: runLandings.length,
    receipts,
    rewinds: rewinds.length,
    minutes: minutes === null ? null : Math.round(minutes * 10) / 10,
    events: ev.length,
  };
}

const rows = [];
for (const p of projects) rows.push(stats(p, await events(p)));
const total = { project: 'total' };
for (const k of ['tasks', 'agents', 'reviewers', 'repos', 'submissions', 'checks', 'failed', 'failed_changes', 'landed_bad', 'landings', 'run_landings', 'receipts', 'rewinds', 'events']) total[k] = rows.reduce((s, r) => s + r[k], 0);
if (rows.length > 1) rows.push(total);

if (asJson) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
const cols = ['project', 'tasks', 'agents', 'reviewers', 'repos', 'submissions', 'checks', 'failed', 'failed_changes', 'landed_bad', 'landings', 'run_landings', 'minutes', 'receipts', 'rewinds'];
const cell = (v) => (v === null || v === undefined ? '-' : String(v));
const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
console.log(cols.map((c, i) => c.padEnd(width[i])).join('  '));
for (const r of rows) console.log(cols.map((c, i) => cell(r[c]).padEnd(width[i])).join('  '));
console.log(`\nfrom ${base}/api/projects/<p>/sql (read-only). Spend is not in the event log: not recorded here.`);
