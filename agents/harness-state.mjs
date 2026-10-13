// What the harness (agents/universal/universal-agent.cjs) knows about a task, carried from one agent to whoever continues
// it: its memory and knowledge (.converge/: memory.json, knowledge/, forge/ ledgers), its conversation and task ledger
// (.agent/: chat.json and the ledger beside it, LEDGER.md), and its task state (AGENT_STATE_DIR: tasks/). All of it lives
// in folders converge keeps out of git, so a fresh clone for the next agent would start without it.
//
// collectHarnessState(repo, stateDir) -> { files: { "<root>:<path>": base64 }, skipped: [...] }
// restoreHarnessState(repo, stateDir, files) -> number of files written
// The platform keeps it in ASQL (scripts/lib/handover-store.mjs) with the rest of the handover.
import fs from 'node:fs';
import path from 'node:path';

// Bulky or rebuilt on demand: screenshots, checkpoints of the work tree (git has the work), the code index.
const SKIP = /(^|\/)(shots|checkpoints|listings|node_modules|tmp|knowledge-cache)(\/|$)|(^|\/)code-index[^/]*$|\.(png|jpe?g|gif|webp|mp4|zip|gz)$/i;
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;   // base64 and JSON on top stay under the platform's 4 MB request limit

/** The roots carried, by name: where each is for a given run. */
const roots = (repo, stateDir) => ({ converge: path.join(repo, '.converge'), agent: path.join(repo, '.agent'), state: stateDir });

export function collectHarnessState(repo, stateDir) {
  const files = {};
  const skipped = [];
  let total = 0;
  const found = [];
  for (const [name, root] of Object.entries(roots(repo, stateDir))) {
    if (!root || !fs.existsSync(root)) continue;
    (function walk(dir, rel) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (SKIP.test(r)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, r);
        else if (ent.isFile()) found.push({ key: `${name}:${r}`, full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs });
      }
    })(root, '');
  }
  // Newest first: when the budget runs out, what was written last (the live conversation and ledger) is kept.
  for (const f of found.sort((a, b) => b.mtime - a.mtime)) {
    if (f.size > MAX_FILE || total + f.size > MAX_TOTAL) { skipped.push(`${f.key} (${f.size} bytes)`); continue; }
    try { files[f.key] = fs.readFileSync(f.full).toString('base64'); total += f.size; } catch { skipped.push(`${f.key} (unreadable)`); }
  }
  return { files, skipped };
}

export function restoreHarnessState(repo, stateDir, files = {}) {
  const where = roots(repo, stateDir);
  let n = 0;
  for (const [key, b64] of Object.entries(files)) {
    const i = key.indexOf(':');
    const root = where[key.slice(0, i)];
    const rel = key.slice(i + 1);
    // Only inside its own root: a handover names files, never a way out of the folder.
    if (!root || !rel || rel.split('/').some((p) => p === '..' || p === '') || path.isAbsolute(rel)) continue;
    const dest = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(String(b64), 'base64'));
    n++;
  }
  return n;
}

/** The task the agent before this one was in the middle of, made ready for `universal-agent.cjs resume <id>`: its whole
 *  conversation carries on, instead of a fresh `run` that starts the task from nothing and re-reads everything. The
 *  harness resumes into the workdir its index names, which was the previous agent's checkout: both the index and the
 *  task point at this agent's now. Whatever step was half done is dropped (its tools ran in the other checkout), and
 *  `note` (this agent's own instructions: who it is now, its fork, what changed) is the newest message.
 *  -> { id, step } or null when there is nothing unfinished to resume. */
// evenDone: continue a conversation that ended with done too (converge hands the change in, and a failed check goes back
// to the agent that wrote it, in its own conversation).
export function prepareResume(stateDir, repo, note, { evenDone = false } = {}) {
  const indexPath = path.join(stateDir, 'index.json');
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { return null; }
  const newest = Object.entries(index).sort(([, a], [, b]) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const [id, entry] of newest) {
    const statePath = path.join(stateDir, 'tasks', id, 'state.json');
    let state;
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { continue; }
    if ((state.status === 'done' && !evenDone) || !Array.isArray(state.messages) || state.messages.length < 2) continue;
    state.workdir = repo;
    state.status = 'running';
    state.pending = null;
    state.messages.push({ role: 'user', content: note });
    fs.writeFileSync(statePath, JSON.stringify(state));
    index[id] = { ...entry, workdir: repo, status: 'running', updatedAt: new Date().toISOString() };
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    return { id, step: Number(state.step) || 1 };
  }
  return null;
}
