// The code of a project's main, indexed in ASQL for the planner: every name (an identifier of four or more characters)
// on every line of every text file, with its file, line and the line's text; and the same in lower case for plain words.
// Refreshed file by file, only where a file's blob changed since the last refresh, so after the first one a refresh
// costs what changed. agents/plan.mjs asks GET /api/projects/<name>/code (where the request's names are, which files
// mention its words most) instead of reading every file of the checkout: on a big codebase that read was most of the
// time before the model was asked.
import { spawn, spawnSync } from 'node:child_process';
import { getAsql } from './asql.mjs';

let ready = null;
function ensureTables() {
  if (!ready) {
    ready = (async () => {
      const a = getAsql();
      await a.query(`CREATE TABLE IF NOT EXISTS converge_code_files (id VARCHAR(700) PRIMARY KEY, project VARCHAR(128) NOT NULL, path VARCHAR(512) NOT NULL, oid VARCHAR(64) NOT NULL);`);
      await a.query(`CREATE TABLE IF NOT EXISTS converge_code_terms (id BIGINT PRIMARY KEY, project VARCHAR(128) NOT NULL, path VARCHAR(512) NOT NULL, line INT NOT NULL, name VARCHAR(128) NOT NULL, lname VARCHAR(128) NOT NULL, text VARCHAR(200));`);
      for (const [ix, col] of [['converge_code_terms_name', 'name'], ['converge_code_terms_lname', 'lname'], ['converge_code_terms_path', 'path'], ['converge_code_files_project', 'project']]) {
        try { await a.query(`CREATE INDEX ${ix} ON ${ix.startsWith('converge_code_files') ? 'converge_code_files' : 'converge_code_terms'} (${col});`); } catch { /* already there */ }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const SKIP = /\.min\.|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$|\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|xz|bz2|7z|jar|so|dylib|dll|exe|bin|o|a|class|wasm|mp[34]|mov|lock)$/i;
let seq = Date.now() * 1000;
const locks = new Map();
const built = new Set();   // projects whose index has been brought up to main at least once since this server started
/** Whether `project`'s index has been built (a first build of a big codebase takes a minute: asked meanwhile, the
 *  planner reads the files itself). */
export const indexBuilt = (project) => built.has(project);

/** Every blob of `branch` in the bare repository `gitDir`: Map path -> oid (submodules and links left out). */
function treeOf(gitDir, branch) {
  const r = spawnSync('git', ['--git-dir', gitDir, 'ls-tree', '-r', '-z', `refs/heads/${branch}`], { encoding: 'utf8', maxBuffer: 512 << 20 });
  const out = new Map();
  if (r.status !== 0) return out;
  for (const e of r.stdout.split('\0')) {
    const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(e);
    if (m && m[1] !== '120000' && !SKIP.test(m[3])) out.set(m[3], m[2]);
  }
  return out;
}

/** The contents of `oids` (git cat-file --batch, one process): Map oid -> text, binary and big blobs left out. */
function blobs(gitDir, oids) {
  return new Promise((resolve) => {
    const out = new Map();
    if (!oids.length) return resolve(out);
    const c = spawn('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    c.stdout.on('data', (d) => chunks.push(d));
    c.on('close', () => {
      const buf = Buffer.concat(chunks);
      let at = 0;
      while (at < buf.length) {
        const nl = buf.indexOf(10, at);
        if (nl < 0) break;
        const [oid, type, size] = buf.slice(at, nl).toString().split(' ');
        const n = Number(size) || 0;
        const body = type === 'blob' ? buf.slice(nl + 1, nl + 1 + n) : Buffer.alloc(0);
        at = nl + 1 + (type === 'missing' ? 0 : n + 1);
        if (n <= (1 << 20) && !body.includes(0)) out.set(oid, body.toString('utf8'));
      }
      resolve(out);
    });
    c.on('error', () => resolve(out));
    c.stdin.end(`${oids.join('\n')}\n`);
  });
}

/** Brings `project`'s index up to `branch` of `gitDir`. {files, changed, removed, terms, ms}. */
export function refreshIndex(project, gitDir, branch = 'main') {
  const prev = locks.get(project) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const t0 = Date.now();
    await ensureTables();
    const a = getAsql();
    const tree = treeOf(gitDir, branch);
    const had = new Map(((await a.run('SELECT path, oid FROM converge_code_files WHERE project = ?', [project])).rows || []).map((r) => [r.path, r.oid]));
    const changed = [...tree].filter(([p, oid]) => had.get(p) !== oid);
    const removed = [...had.keys()].filter((p) => !tree.has(p));
    for (const p of [...removed, ...changed.filter(([p]) => had.has(p)).map(([p]) => p)]) {
      await a.run('DELETE FROM converge_code_terms WHERE path = ? AND project = ?', [p, project]);
      if (!tree.has(p)) await a.run('DELETE FROM converge_code_files WHERE id = ?', [`${project}\0${p}`]);
    }
    const text = await blobs(gitDir, [...new Set(changed.map(([, oid]) => oid))]);
    let terms = 0;
    let rows = [];
    const flush = async () => {
      if (!rows.length) return;
      await a.run(`INSERT INTO converge_code_terms (id, project, path, line, name, lname, text) VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`, rows.flat());
      terms += rows.length;
      rows = [];
    };
    for (const [p, oid] of changed) {
      const body = text.get(oid);
      if (body != null) {
        const lines = body.split('\n');
        let n = 0;
        for (let i = 0; i < lines.length && n < 20000; i++) {
          const names = new Set(lines[i].match(/[A-Za-z_$][\w$]{3,127}/g) || []);
          for (const name of names) { rows.push([++seq, project, p, i + 1, name, name.toLowerCase(), lines[i].trim().slice(0, 200)]); n++; }
          if (rows.length >= 400) await flush();
        }
      }
      await flush();
      await a.run('REPLACE INTO converge_code_files (id, project, path, oid) VALUES (?, ?, ?, ?)', [`${project}\0${p}`, project, p, oid]);
    }
    built.add(project);
    return { files: tree.size, changed: changed.length, removed: removed.length, terms, ms: Date.now() - t0 };
  });
  locks.set(project, next);
  return next;
}

/** Where `names` are (exact names: up to 4 lines a file, 12 a name) and which files hold the most of `words` (lower-case
 *  plain words: up to 8 files, each with the words found and 3 of its lines). */
export async function lookup(project, names = [], words = []) {
  await ensureTables();
  const a = getAsql();
  const found = {};
  for (const n of names.slice(0, 24)) {
    const rows = (await a.run('SELECT path, line, text FROM converge_code_terms WHERE name = ? AND project = ? LIMIT 400', [n, project])).rows || [];
    const perFile = new Map();
    found[n] = rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : Number(x.line) - Number(y.line)))
      .filter((r) => { const c = perFile.get(r.path) || 0; if (c >= 4) return false; perFile.set(r.path, c + 1); return true; })
      .slice(0, 12).map((r) => ({ path: r.path, line: Number(r.line), text: r.text }));
  }
  const files = new Map();
  for (const w of words.slice(0, 16)) {
    const rows = (await a.run('SELECT path, line, text FROM converge_code_terms WHERE lname = ? AND project = ? LIMIT 2000', [w, project])).rows || [];
    for (const r of rows) {
      const f = files.get(r.path) || { path: r.path, words: new Map(), lines: new Map() };
      f.words.set(w, (f.words.get(w) || 0) + 1);
      const l = f.lines.get(Number(r.line)) || { line: Number(r.line), text: r.text, n: 0 };
      l.n++;
      f.lines.set(Number(r.line), l);
      files.set(r.path, f);
    }
  }
  const candidates = [...files.values()]
    .filter((f) => f.words.size >= Math.min(2, words.length))
    .map((f) => ({ ...f, score: f.words.size * 100 + [...f.words.values()].reduce((n, c) => n + Math.min(20, c), 0) }))
    .sort((x, y) => y.score - x.score).slice(0, 8)
    .map((f) => ({ path: f.path, words: [...f.words.keys()], lines: [...f.lines.values()].sort((x, y) => y.n - x.n).slice(0, 3).sort((x, y) => x.line - y.line).map((l) => ({ line: l.line, text: l.text })) }));
  return { names: found, candidates };
}

export async function deleteIndex(project) {
  try {
    await ensureTables();
    await getAsql().run('DELETE FROM converge_code_terms WHERE project = ?', [project]);
    await getAsql().run('DELETE FROM converge_code_files WHERE project = ?', [project]);
  } catch { /* ASQL down */ }
}
