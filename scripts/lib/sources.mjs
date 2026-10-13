// Where a local project's main comes from, and where it goes back to.
//
//   A folder on the owner's machine: its git history (when it is a repository) plus whatever is not committed yet
//   as one commit on top. Git reads the folder itself (--work-tree), honouring its .gitignore, and never writes to it.
//   When the platform goes through the host helper (scripts/local.sh sets HOST_AGENTS_URL), scripts/host-agents.mjs
//   packs the folder into a git bundle (bundleFolder) and the platform clones that; else it reads the folder here.
//
//   Any git server: https with a token (GitHub, GitLab, Bitbucket, Gitea, ...) or ssh with the owner's keys.
//
// A project remembers its remote (url, and the token if one was given; kept in DATA, never sent to a browser), so
// what lands can go back: pushed to a branch, and on GitHub opened as a pull request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const err = (status, message) => Object.assign(new Error(message), { status });
const run = (args, opts = {}) => execFileSync('git', ['-c', 'safe.directory=*', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 64 << 20, ...opts }).trim();
const IDENT = { GIT_AUTHOR_NAME: 'converge', GIT_AUTHOR_EMAIL: 'converge@localhost', GIT_COMMITTER_NAME: 'converge', GIT_COMMITTER_EMAIL: 'converge@localhost' };
const quiet = (e) => /could not read Username|Authentication failed|403|not found/i.test(String(e.stderr || e.message || e))
  ? 'not found, or private: check the URL, and give an access token for a private https repository'
  : /Permission denied \(publickey/i.test(String(e.stderr || '')) ? 'the server did not accept your SSH keys'
  : String(e.stderr || e.message || e).replace(/(Authorization: \w+ )\S+/g, '$1<redacted>').replace(/https:\/\/[^@\s]+@/g, 'https://<redacted>@').trim().split('\n').slice(-2).join(' ').slice(0, 300);

/** Auth for a URL: https gets an Authorization header (the token never goes into a URL or a git config file). */
export function authArgs(url, token, username = '') {
  if (!token || !/^https:\/\//.test(url)) return [];
  const user = username || (/gitlab/.test(url) ? 'oauth2' : /bitbucket/.test(url) ? 'x-token-auth' : 'x-access-token');
  return ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`];
}

// The home folder as this OS has it (os.homedir(): not $HOME, which Git Bash on Windows sets to /c/Users/you).
const HOME_DIR = () => path.resolve(os.homedir());

/** A folder the owner picked, as a full path of this OS: ~ is home (~/x and ~\x), anything else must be absolute.
 *  Any folder on this machine may be picked (the picker is the owner's, behind the admin sign-in); it must exist. */
export function folderPath(p, home = HOME_DIR()) {
  let f = String(p || '').trim();
  if (home && (f === '~' || f.startsWith('~/') || f.startsWith('~\\'))) f = path.join(home, f.slice(1));
  if (!path.isAbsolute(f)) throw err(400, `give the folder as a full path (${process.platform === 'win32' ? 'C:\\Dev\\app' : '/home/you/app'}) or ~/app`);
  f = path.resolve(f);
  if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) throw err(404, `no folder at ${p}`);
  return f;
}

/** One level of the folder browser: the subfolders of `p` (default: home), which of them are git repositories, and
 *  the way up (to the top of the drive or filesystem). Hidden folders, system ones and build output are left out. */
const NOISE = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'dist', 'build', 'target', 'vendor', '__pycache__', 'venv', 'Public',
  'System Volume Information', 'Recovery', 'PerfLogs']);
export function listDirs(p, home = HOME_DIR()) {
  const f = folderPath(p || '~', home);
  let dirs = [];
  try {
    dirs = fs.readdirSync(f, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$') && !NOISE.has(d.name))
      .map((d) => ({ name: d.name, git: fs.existsSync(path.join(f, d.name, '.git')) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch (e) { throw err(403, `cannot read ${f}: ${e.code || e.message}`); }
  const up = path.dirname(f);
  return { path: f, home, parent: up === f ? '' : up, git: fs.existsSync(path.join(f, '.git')), dirs: dirs.slice(0, 500) };
}

/** Several folders as one project: each in a subfolder named after it, every folder's history kept (the import is a
 *  merge of them all). One folder is just bundleFolder. Returns the bundle file; its directory is the caller's to remove. */
export function bundleFolders(folders, scratch) {
  if (folders.length === 1) return bundleFolder(folders[0], folders[0], scratch);
  const tmp = fs.mkdtempSync(path.join(scratch, 'folders-'));
  const gd = ['--git-dir', path.join(tmp, 'repo', '.git'), '--work-tree', path.join(tmp, 'repo')]; // read-tree --prefix wants a work tree; nothing is checked out into it
  const used = new Set();
  try {
    run(['init', '-q', '-b', 'main', path.join(tmp, 'repo')]);
    const env = { ...process.env, ...IDENT, GIT_INDEX_FILE: path.join(tmp, 'index') };
    run([...gd, 'read-tree', '--empty'], { env });
    const parents = [];
    folders.forEach((f, i) => {
      const b = bundleFolder(f, f, tmp);
      run([...gd, 'fetch', '-q', b, `HEAD:refs/import/${i}`]);
      fs.rmSync(path.dirname(b), { recursive: true, force: true });
      let name = path.basename(f).replace(/[^\w.-]+/g, '-') || `folder-${i + 1}`;
      for (let n = 2; used.has(name); n++) name = `${path.basename(f)}-${n}`;
      used.add(name);
      run([...gd, 'read-tree', `--prefix=${name}/`, `refs/import/${i}`], { env });
      parents.push('-p', run([...gd, 'rev-parse', `refs/import/${i}`]));
    });
    const tree = run([...gd, 'write-tree'], { env });
    const commit = run([...gd, 'commit-tree', tree, ...parents, '-m', `Imported ${folders.length} folders: ${[...used].join(', ')}`], { env });
    run([...gd, 'update-ref', 'refs/heads/main', commit]);
    for (let i = 0; i < folders.length; i++) run([...gd, 'update-ref', '-d', `refs/import/${i}`]);
    const out = path.join(tmp, 'folder.bundle');
    run([...gd, 'bundle', 'create', out, 'main']);
    fs.rmSync(path.join(tmp, 'repo'), { recursive: true, force: true });
    return out;
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e.status ? e : err(502, `could not combine the folders: ${quiet(e)}`); }
}

/** Packs a folder into a git bundle: its history (when it is a repository) plus what is not committed yet as one
 *  commit, honouring its .gitignore. Git reads the folder (--work-tree) and never writes to it. Returns the file. */
export function bundleFolder(folder, label, scratch, history = true) {
  const tmp = fs.mkdtempSync(path.join(scratch, 'folder-'));
  const repo = path.join(tmp, 'repo');
  const isRepo = history && fs.existsSync(path.join(folder, '.git'));
  try {
    if (isRepo) run(['clone', '--quiet', '--no-checkout', folder, repo]);
    else run(['init', '-q', '-b', 'main', repo]);
    const gd = ['--git-dir', path.join(repo, '.git'), '--work-tree', folder];
    if (isRepo) run([...gd, 'reset', '-q']); // the index at HEAD, so `add -A` adds only what differs
    run([...gd, 'add', '-A']);
    // Without its history (a shallow clone, missing objects: the retry below), a git folder's files are still the ones
    // it tracks: those its .gitignore matches too (force-added in it), which add -A alone left out. One large repository lost
    // 146 such files that way, and the "converge" branch written back would have deleted them.
    if (!isRepo && fs.existsSync(path.join(folder, '.git'))) {
      let tracked = [];
      try { tracked = run(['-C', folder, 'ls-files', '-z']).split('\0').filter(Boolean); } catch { /* not readable: what add -A took */ }
      const missing = tracked.filter((f) => { try { const st = fs.lstatSync(path.join(folder, f)); return st.isFile() || st.isSymbolicLink(); } catch { return false; } });
      // From inside the folder: a path is read relative to where git runs, and elsewhere it is "outside repository".
      for (let i = 0; i < missing.length; i += 500) run(['-C', folder, ...gd, 'add', '-f', '--', ...missing.slice(i, i + 500)]);
      // ...and its submodules, as the commits it records for them (a gitlink is not a file add can take).
      try {
        for (const line of run(['-C', folder, 'ls-files', '-s']).split('\n')) {
          const m = /^160000 ([0-9a-f]{40,64}) \d\t(.+)$/.exec(line);
          if (m) run([...gd, 'update-index', '--add', '--cacheinfo', `160000,${m[1]},${m[2]}`]);
        }
      } catch { /* no submodules readable */ }
    }
    // Staged against HEAD only (diff --cached): status without the folder as its work tree compared the index with
    // whatever folder it ran in, and always found a change (an empty "Uncommitted work" commit on every import).
    const changed = !isRepo || run(['--git-dir', path.join(repo, '.git'), 'diff', '--cached', '--name-only']) !== '';
    // Imported without its history from a git folder: the folder commit it started from is named in the message, so what
    // goes back (folderApply) can be built on that commit and merged, not handed over as unrelated history.
    let base = '';
    if (!isRepo && fs.existsSync(path.join(folder, '.git'))) { try { base = run(['-C', folder, 'rev-parse', 'HEAD']); } catch { /* no commits yet */ } }
    if (changed) run(['--git-dir', path.join(repo, '.git'), 'commit', '-q', '--allow-empty', '-m', isRepo ? `Uncommitted work from ${label}` : `Imported from ${label}${base ? `\n\nconverge-folder-base: ${base}` : ''}`], { env: { ...process.env, ...IDENT } });
    const out = path.join(tmp, 'folder.bundle');
    run(['--git-dir', path.join(repo, '.git'), 'bundle', 'create', out, 'HEAD', '--branches']);
    fs.rmSync(repo, { recursive: true, force: true });
    return out;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    // A history git cannot read in full (a shallow clone, missing objects): the files as they are, without it.
    if (isRepo) return bundleFolder(folder, label, scratch, false);
    throw err(502, `could not read ${label}: ${quiet(e)}`);
  }
}


/** Builds the bare repository `dest` from a source; returns the remote to remember (if any). */
export async function importSource(dest, source, scratch) {
  if (source.kind === 'git') {
    const url = String(source.url || '').trim();
    // A repository on this machine (`converge.mjs project --import <dir>` sends its snapshot of the working tree):
    // cloned as it is, with no remote to remember. Only the local platform imports this module.
    if (path.isAbsolute(url) && (fs.existsSync(path.join(url, '.git')) || fs.existsSync(path.join(url, 'HEAD')))) {
      try { run(['clone', '--bare', '--quiet', url, dest]); run(['--git-dir', dest, 'remote', 'remove', 'origin']); }
      catch (e) { throw err(502, `could not read ${url}: ${quiet(e)}`); }
      return { remote: null };
    }
    if (!/^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(url)) throw err(400, 'a git URL starts with https://, ssh:// or git@host:');
    try { run([...authArgs(url, source.token, source.username), 'clone', '--bare', '--quiet', url, dest], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' } }); }
    catch (e) { throw err(502, `could not clone ${url}: ${quiet(e)}`); }
    try { run(['--git-dir', dest, 'remote', 'remove', 'origin']); } catch { /* none */ }
    return { remote: { url, token: source.token || '', username: source.username || '' } };
  }
  if (source.kind === 'folder' || source.kind === 'folders') {
    // { kind: 'folders', paths: [...] } (one or more), or the older { kind: 'folder', path }.
    const paths = (source.kind === 'folders' ? (Array.isArray(source.paths) ? source.paths : []) : [source.path]).map((p) => String(p || '').trim()).filter(Boolean);
    if (!paths.length) throw err(400, 'choose at least one folder');
    if (paths.length > 20) throw err(400, 'at most 20 folders in one project');
    const label = paths.length === 1 ? paths[0] : `${paths.length} folders`;
    const bundle = await folderBundle(paths, scratch);
    try { run(['clone', '--bare', '--quiet', bundle, dest]); try { run(['--git-dir', dest, 'remote', 'remove', 'origin']); } catch { /* none */ } }
    catch (e) { throw err(502, `could not read ${label}: ${quiet(e)}`); }
    finally { fs.rmSync(path.dirname(bundle), { recursive: true, force: true }); }
    return { remote: null };
  }
  throw err(400, `unknown source: ${source.kind}`);
}

/** The folders as one git bundle (main), read where they are: by the host helper when there is one, else here. The
 *  bundle's directory is the caller's to remove. */
export async function folderBundle(paths, scratch) {
  fs.mkdirSync(scratch, { recursive: true });
  if (!process.env.HOST_AGENTS_URL) return bundleFolders(paths.map((p) => folderPath(p)), scratch);
  // On host system: helper reads the folders and sends one bundle.
  const r = await fetch(`${process.env.HOST_AGENTS_URL}/bundle`, { method: 'POST', headers: { 'X-Host-Token': process.env.HOST_AGENTS_TOKEN || '', 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }), signal: AbortSignal.timeout(600_000) })
    .catch(() => { throw err(503, 'the host helper is not answering (scripts/local.sh starts it)'); });
  if (!r.ok) throw err(r.status === 404 ? 404 : r.status === 400 ? 400 : 502, (await r.json().catch(() => ({}))).error || `the host helper answered ${r.status}`);
  const bundle = path.join(fs.mkdtempSync(path.join(scratch, 'bundle-')), 'folder.bundle');
  fs.writeFileSync(bundle, Buffer.from(await r.arrayBuffer()));
  return bundle;
}

// ---- remotes: a project's way back ---------------------------------------------------------------------------
export function remotes(dataDir) {
  const file = path.join(dataDir, 'remotes.json');
  const all = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = (o) => { fs.writeFileSync(file, JSON.stringify(o), { mode: 0o600 }); };
  return {
    get: (project) => all()[project] || null,
    set: (project, r) => { const o = all(); if (r) o[project] = r; else delete o[project]; save(o); },
  };
}

/** Checks a remote answers (and the token works) before it is kept. */
export function checkRemote(r) {
  try { run([...authArgs(r.url, r.token, r.username), 'ls-remote', '--heads', r.url], { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' } }); }
  catch (e) { throw err(502, `${r.url} did not answer: ${quiet(e)}`); }
}

/** Pushes main (the bare repo `src`) to `branch` on the remote; on GitHub with a token, opens a pull request. */
export async function pushToRemote(src, mainBranch, r, { branch, pr = false, title = '', body = '' }) {
  try { run(['--git-dir', src, ...authArgs(r.url, r.token, r.username), 'push', '--quiet', r.url, `refs/heads/${mainBranch}:refs/heads/${branch}`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' } }); }
  catch (e) { throw err(502, `push to ${r.url} failed: ${quiet(e)}`); }
  const gh = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(r.url);
  if (!pr || !gh) return { branch };
  if (!r.token) throw err(400, `pushed to ${branch}; a pull request needs a GitHub token on the link`);
  const api = (p, init = {}) => fetch(`https://api.github.com/repos/${gh[1]}/${gh[2]}${p}`, { ...init, headers: { Authorization: `Bearer ${r.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'converge', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const repo = await (await api('')).json();
  const res = await api('/pulls', { method: 'POST', body: JSON.stringify({ title: title || `converge: ${branch}`, head: branch, base: repo.default_branch || 'main', body }) });
  const j = await res.json();
  if (!res.ok) throw err(502, `pushed to ${branch}; GitHub did not open the pull request: ${j.message || res.status}${j.errors?.[0]?.message ? ` (${j.errors[0].message})` : ''}`);
  return { branch, pr: { url: j.html_url, number: j.number } };
}

// ---- a folder project's way back: what lands goes into the owner's folder(s) ----------------------------------
// The platform (which has main) works out what changed since the last sync, file by file, with each file's content
// before and after; whoever can reach the folder (scripts/host-agents.mjs on a Mac, or this machine) applies it:
//   a plain folder: each changed file is written (or removed) only if the folder still holds what converge last
//     knew there; a file the owner changed meanwhile is never overwritten: the new version goes beside it as
//     <file>.converge, and is reported;
//   a git folder: its working tree is not touched; main arrives as the branch "converge", to merge when wanted.
const SKIP = /^(\.agent|\.converge)\//;

/** Folders and their place in main: one folder is the whole tree; several are subfolders (as bundleFolders names them). */
export function folderPrefixes(paths) {
  if (paths.length === 1) return [{ path: paths[0], prefix: '' }];
  const used = new Set();
  return paths.map((f, i) => {
    let name = path.basename(f).replace(/[^\w.-]+/g, '-') || `folder-${i + 1}`;
    for (let n = 2; used.has(name); n++) name = `${path.basename(f)}-${n}`;
    used.add(name);
    return { path: f, prefix: `${name}/` };
  });
}

/** The converge commit message: what landed on main, up to head (12 chars). */
export function landedMessage(head, subjects) {
  const short = String(head).slice(0, 12);
  if (!subjects || subjects.length === 0) return `converge: what landed, up to ${short}`;
  const n = subjects.length;
  const lines = subjects.slice(0, 30).map((s) => `- ${s}`);
  if (n > 30) lines.push(`- and ${n - 30} more`);
  return `converge: ${n} change${n === 1 ? '' : 's'} landed\n\n${lines.join('\n')}\n\nmain: ${short}`;
}

/** What changed on main since `from` (a commit), for each folder: files with their content then and now (base64). */
export function folderExport(gitDir, branch, from, folders) {
  const g = (...a) => run(['--git-dir', gitDir, ...a]);
  const head = g('rev-parse', `refs/heads/${branch}`);
  const blob = (rev, p) => { try { return execFileSync('git', ['-c', 'safe.directory=*', '--git-dir', gitDir, 'show', `${rev}:${p}`], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString('base64'); } catch { return null; } };
  const changed = from === head ? [] : g('diff', '--name-only', '--no-renames', '-z', from || g('hash-object', '-t', 'tree', '/dev/null'), head).split('\0').filter(Boolean);
  const out = folders.map((f) => ({ path: f.path, prefix: f.prefix, files: [], head }));
  for (const p of changed) {
    if (SKIP.test(p)) continue;
    const f = out.find((x) => !x.prefix || p.startsWith(x.prefix));
    if (!f) continue;
    f.files.push({ path: f.prefix ? p.slice(f.prefix.length) : p, base: from ? blob(from, p) : null, next: blob(head, p) });
  }
  // The folder commits an import without history started from (bundleFolder names them): folderApply builds the
  // "converge" branch on the one its folder has.
  let bases = [];
  try { bases = [...g('log', '--format=%B', '--grep=converge-folder-base:', `refs/heads/${branch}`).matchAll(/converge-folder-base: ([0-9a-f]{40,64})/g)].map((m) => m[1]); } catch { /* none */ }
  // An import made before that marker existed: its root commit's files and time, so folderApply can find the folder
  // commit it was taken from. Without it the "converge" branch was unrelated history that could never be merged.
  let root = null;
  try {
    const r = g('rev-list', '--max-parents=0', `refs/heads/${branch}`).split('\n').filter(Boolean).pop();
    if (r) root = { commit: r, tree: g('rev-parse', `${r}^{tree}`), at: Number(g('log', '-1', '--format=%ct', r)) };
  } catch { root = null; }
  // The subjects of main's merge commits since `from`, newest first, with the 'Merge c-<id>: ' prefix removed.
  let landed = [];
  try { landed = g('log', '--first-parent', '--format=%s', from ? `${from}..${head}` : head).split('\n').filter(Boolean).map((s) => s.replace(/^Merge c-[^:]*: /, '')); } catch { landed = []; }
  return { head, folders: out, bases, landed, root };
}

// The converge commit's parent is the previous converge commit when that commit already descends from the base,
// so repeated runs extend one linked branch; otherwise (first run, or the previous commit is off the base's line)
// it is the base itself, so the new commit is never parented on a commit that does not descend from it.
export function convergeParent({ base, previous, previousDescendsFromBase }) {
  return typeof previous === 'string' && previous.length > 0 && previousDescendsFromBase === true ? previous : base;
}

/** The folder commit an unmarked import was taken from: the one whose files are exactly the import's, else the folder's
 *  last commit before the import was made (an import of a git folder takes its HEAD then). '' when neither is found. */
function importedFrom(dir, root) {
  try {
    for (const line of String(run(['-C', dir, 'log', '--first-parent', '-n', '3000', '--format=%H %T', 'HEAD'])).split('\n')) {
      const [c, t] = line.split(' ');
      if (t === root.tree) return c;
    }
  } catch { /* history not readable */ }
  if (!root.at) return '';
  try { return String(run(['-C', dir, 'rev-list', '-1', '--first-parent', `--before=${root.at}`, 'HEAD'])).trim(); } catch { return ''; }
}

/** `base`'s tree with what changed from `from` to `to` (two commits of converge's main) laid over it: added and changed
 *  files take `to`'s content, deleted ones go; everything else stays as `base` has it. Returns the tree id. */
function landedOnto(dir, base, from, to) {
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'converge-index-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    run(['-C', dir, 'read-tree', base], { env });
    const changes = String(run(['-C', dir, 'diff', '--name-status', '--no-renames', '-z', from, to])).split('\0').filter(Boolean);
    for (let i = 0; i + 1 < changes.length; i += 2) {
      const [st, p] = [changes[i], changes[i + 1]];
      if (st === 'D') { run(['-C', dir, 'update-index', '--force-remove', '--', p], { env }); continue; }
      const [mode, , oid] = String(run(['-C', dir, 'ls-tree', to, '--', p])).split(/\s+/);
      run(['-C', dir, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${p}`], { env });
    }
    return String(run(['-C', dir, 'write-tree'], { env })).trim();
  } finally { fs.rmSync(path.dirname(index), { recursive: true, force: true }); }
}

/** Applies an export to the folders on this machine. Returns, per folder, what was written, removed and kept beside. */
export function folderApply(exp, bundleFor) {
  const report = [];
  for (const f of exp.folders) {
    const dir = folderPath(f.path);
    const r = { path: f.path, written: 0, removed: 0, beside: [], git: false };
    const isGit = fs.existsSync(path.join(dir, '.git'));
    // A git folder is only ever given the branch "converge": without main's bundle it is left alone, not written into
    // (its working tree is the owner's), and when the owner has "converge" checked out, moving the branch would change
    // what their working tree is on, so it waits until they are on another branch.
    if (isGit && !bundleFor) { r.skipped = 'no bundle of main'; report.push(r); continue; }
    if (isGit) {
      let onConverge = false;
      try { onConverge = String(run(['-C', dir, 'symbolic-ref', '-q', 'HEAD'])).trim() === 'refs/heads/converge'; } catch { onConverge = false; }
      if (onConverge) { r.skipped = 'the folder has "converge" checked out'; report.push(r); continue; }
    }
    if (isGit) {
      // A git folder: main as the branch "converge" (its working tree and its own branches untouched).
      const b = bundleFor(f);
      try {
        run(['-C', dir, 'fetch', '-q', b.file, `+${b.ref}:refs/converge/main`]);
        // Unrelated to the folder's history (imported without it): the branch is main's files as one commit on the
        // folder commit the import started from, so merging "converge" brings exactly what landed and nothing else.
        let related = true;
        try { run(['-C', dir, 'merge-base', 'HEAD', 'refs/converge/main']); } catch { related = false; }
        const marked = related ? '' : (exp.bases || []).find((c) => { try { run(['-C', dir, 'cat-file', '-e', `${c}^{commit}`]); return true; } catch { return false; } });
        const found = related || marked || !exp.root ? '' : importedFrom(dir, exp.root);
        const base = marked || found;
        let previous = '';
        try { previous = String(run(['-C', dir, 'rev-parse', '--verify', '-q', 'refs/heads/converge'])).trim(); } catch { previous = ''; }
        let previousDescendsFromBase = false;
        if (previous && base) { try { run(['-C', dir, 'merge-base', '--is-ancestor', base, 'refs/heads/converge']); previousDescendsFromBase = true; } catch { previousDescendsFromBase = false; } }
        let same = false;
        if (base && previous) { try { same = String(run(['-C', dir, 'rev-parse', `${previous}^{tree}`])).trim() === String(run(['-C', dir, 'rev-parse', 'refs/converge/main^{tree}'])).trim(); } catch { same = false; } }
        if (base && same) { r.based_on = base; } else if (base) {
          // A found (unmarked) base: the import may have left out files the folder tracks (the old import dropped 142 of
          // one repository's), so main's whole tree would delete them. Only what landed since the import goes on the base.
          const tree = found ? landedOnto(dir, base, exp.root.commit, 'refs/converge/main') : 'refs/converge/main^{tree}';
          const c = run(['-C', dir, 'commit-tree', tree, '-p', convergeParent({ base, previous, previousDescendsFromBase }), '-m', landedMessage(exp.head, exp.landed || [])], { env: { ...process.env, ...IDENT } });
          run(['-C', dir, 'update-ref', 'refs/heads/converge', c]);
          r.based_on = base;
        } else run(['-C', dir, 'update-ref', 'refs/heads/converge', 'refs/converge/main']);
        run(['-C', dir, 'update-ref', '-d', 'refs/converge/main']);
        r.git = true;
      } finally { fs.rmSync(path.dirname(b.file), { recursive: true, force: true }); }
      report.push(r);
      continue;
    }
    for (const x of f.files) {
      const rel = path.normalize(x.path);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const target = path.join(dir, rel);
      const now = fs.existsSync(target) ? fs.readFileSync(target).toString('base64') : null;
      if (now === x.next) continue; // already so
      if (now !== x.base) { // the owner changed it: theirs stays, ours goes beside it
        if (x.next != null) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(`${target}.converge`, Buffer.from(x.next, 'base64')); }
        r.beside.push(rel);
        continue;
      }
      if (x.next == null) { fs.rmSync(target, { force: true }); r.removed++; continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(x.next, 'base64'));
      r.written++;
    }
    report.push(r);
  }
  return report;
}
