'use strict';
// Workdir codebase index — symbols + lexical inverted terms + hashing-trick
// dense vectors (no npm, no external embedding API). Search blends BM25-ish
// lexical score with cosine over hashed n-grams so "auth middleware" still
// finds login/session files that don't share the exact token.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP_DIR = new Set(['node_modules', '.git', '.agent', 'dist', 'build', 'coverage', '.next', 'vendor', '__pycache__', '.cache', 'site']);
const TEXT_EXT = /\.(c|m)?[jt]sx?$|\.json$|\.md$|\.txt$|\.css$|\.html?$|\.py$|\.go$|\.rs$|\.java$|\.rb$|\.php$|\.sh$|\.ya?ml$|\.toml$|\.cjs$|\.mjs$/i;
const DECL = /^\s{0,4}(?:export\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z0-9_$]+)|(?:const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)|def\s+([A-Za-z0-9_]+)|fn\s+([A-Za-z0-9_]+)|func\s+([A-Za-z0-9_]+)|#{1,6}\s+(\S.+))/;
const DIM = 128;
const INDEX_NAME = 'code-index.json';

// CHUNKING, AND WHY THE INDEX USED TO MISS THE MOST-SEARCHED FILE IN THE REPO.
//
// fileRecord() used to `return null` for anything over 512 KB. universal-agent.cjs
// is 1,045,812 bytes — so the single file agents search most was not in the index
// AT ALL, and every question about it fell back to a ripgrep sweep plus several
// full reads. It also tokenized only the first 80 KB of whatever it did index, so
// a 400 KB file was silently half-indexed.
//
// Both are fixed the same way: index large files as a SEQUENCE OF CHUNKS instead
// of skipping them. That buys a second thing for free — a chunk knows its line
// range, so a hit points at `path:from-to` and the next call can be a ranged
// read_file rather than another search. That index→exact-range hop is the whole
// point; without it a model needs a grep between the two.
//
// A record is keyed `rel` when a file fits in one chunk (unchanged shape) and
// `rel#from-to` when it does not, so small files are byte-identical to before.
const CHUNK_LINES = parseInt(process.env.CONVERGE_INDEX_CHUNK_LINES || '', 10) || 800;
// Above this a file is genuinely not source we should be ranking — a bundled
// dist file, a checked-in dataset. Skipped, not chunked, so one blob cannot
// dominate the index.
const MAX_FILE_BYTES = parseInt(process.env.CONVERGE_INDEX_MAX_BYTES || '', 10) || 8 * 1024 * 1024;
// Per-chunk tokenization cap. Chunks are line-bounded, not byte-bounded, so a
// minified single-line file still needs a guard.
const CHUNK_TOKEN_BYTES = 120000;
// One file must not fill the whole result set with its own chunks — a 20-chunk
// file would crowd out every other match. Same idea as the round-robin in
// shared/tool-result-projections.cjs's evidence ordering.
const MAX_CHUNKS_PER_PATH_IN_RESULTS = parseInt(process.env.CONVERGE_INDEX_MAX_CHUNK_HITS || '', 10) || 3;

function indexPath(workdir) {
  return path.join(workdir, '.agent', INDEX_NAME);
}

function shouldSkip(name) {
  return SKIP_DIR.has(name) || name.startsWith('.');
}

function walkFiles(root, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (shouldSkip(ent.name)) continue;
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) walkFiles(abs, out);
    else if (ent.isFile() && TEXT_EXT.test(ent.name)) out.push(abs);
  }
  return out;
}

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9_$]+/).filter((t) => t.length >= 2 && t.length <= 48);
}

function hashDim(token, i) {
  const h = crypto.createHash('sha1').update(`${token}:${i}`).digest();
  return h.readUInt16BE(0) % DIM;
}

function embedTokens(tokens) {
  const v = new Array(DIM).fill(0);
  for (const t of tokens) {
    v[hashDim(t, 0)] += 1;
    if (t.length >= 4) v[hashDim(t.slice(0, 3), 1)] += 0.5;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => Math.round((x / norm) * 1000) / 1000);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// `lineOffset` is the 0-based index of the first line of `src` within the whole
// file, so a chunk's symbols carry ABSOLUTE line numbers. Without it every
// chunk's `name:line` would be relative to the chunk and point at the wrong
// place — worse than having no symbols at all.
function extractSymbols(src, lineOffset = 0) {
  const symbols = [];
  const lines = String(src).split('\n');
  for (let i = 0; i < lines.length && symbols.length < 80; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || m[4] || m[5] || (m[6] && m[6].trim().slice(0, 60));
    if (name) symbols.push({ name: String(name), line: lineOffset + i + 1 });
  }
  return symbols;
}

// The index key for a record: the bare path when the file is one chunk (so small
// files keep exactly the shape they had), `path#from-to` when it is not.
function recordKey(rec) {
  return rec.from ? `${rec.path}#${rec.from}-${rec.to}` : rec.path;
}

// Build one record from a slice of a file. `from`/`to` are 1-based inclusive
// line numbers, and are omitted entirely for a whole-file record.
function chunkRecord(rel, mtime, text, lineOffset, whole) {
  const symbols = extractSymbols(text, lineOffset);
  const tokens = tokenize(text.slice(0, CHUNK_TOKEN_BYTES));
  const termFreq = Object.create(null);
  for (const t of tokens) termFreq[t] = (termFreq[t] || 0) + 1;
  // Keep top terms only — index stays small.
  const top = Object.entries(termFreq).sort((a, b) => b[1] - a[1]).slice(0, 120);
  const terms = Object.fromEntries(top);
  const embTokens = [...symbols.map((s) => s.name.toLowerCase()), ...top.slice(0, 40).map(([t]) => t)];
  const rec = { path: rel, mtime, bytes: Buffer.byteLength(text), symbols, terms, vec: embedTokens(embTokens) };
  if (!whole) { rec.from = lineOffset + 1; rec.to = lineOffset + text.split('\n').length; }
  return rec;
}

// Every record for one file. Returns [] when the file cannot or should not be
// indexed, so callers treat "skipped" and "empty" the same way.
function fileRecords(workdir, abs) {
  let src = '';
  let mtime = 0;
  try {
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_BYTES) return [];
    mtime = st.mtimeMs;
    src = fs.readFileSync(abs, 'utf8');
  } catch { return []; }
  const rel = path.relative(workdir, abs).split(path.sep).join('/');
  const lines = src.split('\n');
  if (lines.length <= CHUNK_LINES) return [chunkRecord(rel, mtime, src, 0, true)];
  const out = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    out.push(chunkRecord(rel, mtime, lines.slice(i, i + CHUNK_LINES).join('\n'), i, false));
  }
  return out;
}

// v2 = chunked records. A v1 index on disk is not upgraded in place, it is simply
// not loaded — loadIndex returns empty and the next query rebuilds. That is the
// cheap, correct migration: the index is a derived cache, never a source of truth.
const INDEX_VERSION = 2;
function emptyIndex() {
  return { v: INDEX_VERSION, builtAt: 0, files: {}, df: {} };
}

function loadIndex(workdir) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(workdir), 'utf8'));
    if (raw && raw.v === INDEX_VERSION && raw.files) return raw;
  } catch {}
  return emptyIndex();
}

function saveIndex(workdir, idx) {
  const dest = indexPath(workdir);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Atomic tmp+rename with a per-process tmp name — a bare writeFileSync on the
  // live file left truncated JSON on a crash or a concurrent writer, which
  // loadIndex swallows into emptyIndex(), forcing a full synchronous re-walk of
  // the workdir on the very next query.
  const rand = crypto.randomBytes(4).toString('hex');
  const tmp = `${dest}.${process.pid}.${rand}.${(saveIndex._seq = (saveIndex._seq || 0) + 1)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx));
  fs.renameSync(tmp, dest);
}

function recomputeDf(idx) {
  const df = Object.create(null);
  for (const f of Object.values(idx.files)) {
    for (const t of Object.keys(f.terms || {})) df[t] = (df[t] || 0) + 1;
  }
  idx.df = df;
}

function buildIndex(workdir) {
  const idx = emptyIndex();
  const files = walkFiles(workdir);
  const paths = new Set();
  for (const abs of files) {
    for (const rec of fileRecords(workdir, abs)) { idx.files[recordKey(rec)] = rec; paths.add(rec.path); }
  }
  recomputeDf(idx);
  idx.builtAt = Date.now();
  saveIndex(workdir, idx);
  // `records` and `files` are now different numbers, so report both rather than
  // calling a record count a file count.
  return { files: paths.size, records: Object.keys(idx.files).length, bytes: Buffer.byteLength(JSON.stringify(idx)), path: indexPath(workdir) };
}

function normalizeRelPath(workdir, rel) {
  const abs = path.isAbsolute(rel) ? rel : path.resolve(workdir, rel);
  return path.relative(workdir, abs).replace(/\\/g, '/');
}

function updateFile(workdir, rel) {
  const norm = normalizeRelPath(workdir, rel);
  const abs = path.resolve(workdir, rel);
  const idx = loadIndex(workdir);
  // Drop EVERY record for this path before re-adding. A chunked file has many,
  // and deleting only `idx.files[rel]` would leave stale chunks behind that
  // still match queries and still point at line ranges the edit has moved.
  const dropped = dropPath(idx, norm);
  if (!existsReadable(abs) || !TEXT_EXT.test(abs)) {
    if (dropped) { recomputeDf(idx); saveIndex(workdir, idx); }
    return idx;
  }
  for (const rec of fileRecords(workdir, abs)) idx.files[recordKey(rec)] = rec;
  recomputeDf(idx);
  idx.builtAt = Date.now();
  saveIndex(workdir, idx);
  return idx;
}

function dropPath(idx, rel) {
  const target = String(rel || '').replace(/\\/g, '/');
  let n = 0;
  for (const key of Object.keys(idx.files)) {
    const f = idx.files[key];
    if (key === target || key.startsWith(target + '#') || (f && f.path === target)) { delete idx.files[key]; n++; }
  }
  return n;
}

// Is the index visibly out of date? Samples a handful of records and compares the
// recorded mtime with disk. Returns true on the first disagreement — a rebuild is
// cheap (2.5s on a 1700-file repo) next to answering from a wrong index.
const STALE_SAMPLE = parseInt(process.env.CONVERGE_INDEX_STALE_SAMPLE || '', 10) || 12;
function staleSample(workdir, idx) {
  if (process.env.CONVERGE_INDEX_STALE_CHECK === '0') return false;
  const recs = Object.values(idx.files);
  if (!recs.length) return false;
  // Spread the sample across the index rather than taking the first N, which on
  // an alphabetical walk would only ever check the same corner of the tree.
  const step = Math.max(1, Math.floor(recs.length / STALE_SAMPLE));
  const seen = new Set();
  for (let i = 0; i < recs.length && seen.size < STALE_SAMPLE; i += step) {
    const f = recs[i];
    if (!f || !f.path || seen.has(f.path)) continue;
    seen.add(f.path);
    const abs = path.join(workdir, f.path);
    let st = null;
    try { st = fs.statSync(abs); } catch { return true; }   // indexed file is gone
    if (f.mtime && st.mtimeMs && Math.abs(st.mtimeMs - f.mtime) > 1) return true;
  }
  return false;
}

function existsReadable(abs) {
  try { return fs.statSync(abs).isFile(); } catch { return false; }
}

function searchIndex(workdir, query, limit) {
  const q = String(query || '').trim();
  if (!q) return { hits: [], note: 'empty query' };
  let idx = loadIndex(workdir);
  if (!Object.keys(idx.files).length) {
    buildIndex(workdir);
    idx = loadIndex(workdir);
  } else if (staleSample(workdir, idx)) {
    // A stale index was served silently: the only rebuild trigger was an EMPTY
    // index, so once built it was answered from forever unless someone called
    // index_codebase by hand. Records already carry `mtime`, so a cheap spot
    // check on a few of them turns that into self-healing. Bounded on purpose —
    // this must not stat the whole tree on every query.
    buildIndex(workdir);
    idx = loadIndex(workdir);
  }
  const qTokens = tokenize(q);
  const qVec = embedTokens(qTokens);
  const N = Math.max(1, Object.keys(idx.files).length);
  const hits = [];
  for (const f of Object.values(idx.files)) {
    let lexical = 0;
    for (const t of qTokens) {
      const tf = (f.terms && f.terms[t]) || 0;
      if (!tf) continue;
      const df = (idx.df && idx.df[t]) || 1;
      const idf = Math.log(1 + N / df);
      lexical += (1 + Math.log(tf)) * idf;
    }
    for (const s of f.symbols || []) {
      const name = String(s.name).toLowerCase();
      if (qTokens.some((t) => name === t || name.includes(t))) lexical += 2.5;
    }
    const semantic = cosine(qVec, f.vec) * 4;
    const score = lexical + semantic;
    if (score <= 0) continue;
    hits.push({
      path: f.path,
      ...(f.from ? { from: f.from, to: f.to } : {}),
      score: Math.round(score * 1000) / 1000,
      lexical: Math.round(lexical * 1000) / 1000,
      semantic: Math.round(semantic * 1000) / 1000,
      symbols: (f.symbols || []).slice(0, 8).map((s) => `${s.name}:${s.line}`),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  // Take the best hits, but no more than a few chunks from any one path, so a
  // large chunked file cannot crowd every other file out of the answer.
  const cap = Math.min(limit || 12, 40);
  const perPath = new Map();
  const top = [];
  for (const h of hits) {
    const n = perPath.get(h.path) || 0;
    if (n >= MAX_CHUNKS_PER_PATH_IN_RESULTS) continue;
    perPath.set(h.path, n + 1);
    top.push(h);
    if (top.length >= cap) break;
  }
  const paths = new Set(Object.values(idx.files).map((f) => f.path));
  pinpointLines(workdir, top, qTokens);
  return { hits: top, indexed: N, files: paths.size, builtAt: idx.builtAt };
}

// WHICH LINES, not just which 800-line chunk.
//
// A hit named `path:FROM-TO`, and with CHUNK_LINES at 800 that range is most of a
// screenful of screenfuls — so a model still had to run search_code (or read the
// whole range) to find the actual lines. That extra hop is the "20 calls grepping
// a giant repo" this index exists to remove.
//
// Done by READING the hit files rather than by storing a term->line posting list
// in the index, for three reasons: a posting list over every token of every chunk
// dwarfs the records it annotates; it goes stale exactly when the index does; and
// it cannot see a line that was edited since the last build. Reading now is exact
// by construction, and it costs one file read per SHOWN hit (a handful), not per
// indexed record.
//
// Scored by DISTINCT query terms on the line, then by total occurrences, so a line
// mentioning two of the three search words beats one that repeats a single word.
// Ties break toward the earlier line, which is where a definition usually sits
// relative to its uses.
const MAX_PINPOINT_LINES = 3;
const MAX_PINPOINT_BYTES = 4 * 1024 * 1024;
function pinpointLines(workdir, hits, qTokens) {
  if (!hits.length || !qTokens.length) return;
  const wanted = qTokens.filter((t) => t.length >= 3);
  if (!wanted.length) return;
  const cache = new Map(); // rel -> lines[]
  for (const h of hits) {
    try {
      let lines = cache.get(h.path);
      if (!lines) {
        const abs = path.join(workdir, h.path);
        const st = fs.statSync(abs);
        if (st.size > MAX_PINPOINT_BYTES) continue;
        lines = fs.readFileSync(abs, 'utf8').split('\n');
        cache.set(h.path, lines);
      }
      // 1-based, inclusive, matching how `from`/`to` and read_file both count.
      const from = h.from || 1;
      const to = Math.min(h.to || lines.length, lines.length);
      const scored = [];
      for (let i = from; i <= to; i++) {
        const low = String(lines[i - 1] || '').toLowerCase();
        if (!low.trim()) continue;
        let distinct = 0, total = 0;
        for (const t of wanted) {
          let at = low.indexOf(t), n = 0;
          while (at >= 0) { n++; at = low.indexOf(t, at + t.length); }
          if (n) { distinct++; total += n; }
        }
        if (distinct) scored.push({ line: i, distinct, total });
      }
      if (!scored.length) continue;
      scored.sort((a, b) => (b.distinct - a.distinct) || (b.total - a.total) || (a.line - b.line));
      h.lines = scored.slice(0, MAX_PINPOINT_LINES).map((x) => x.line);
    } catch { /* an unreadable hit keeps its range; it just gets no pinpoint */ }
  }
}

function formatHits(result) {
  if (!result.hits.length) return `No index hits (indexed ${result.indexed || 0} record(s)). Try different terms, or call index_codebase then search again.`;
  const ranged = result.hits.some((h) => h.from);
  const pinned = result.hits.some((h) => Array.isArray(h.lines) && h.lines.length);
  const lines = result.hits.map((h, i) =>
    `${i + 1}. ${h.path}${h.from ? `:${h.from}-${h.to}` : ''}  score=${h.score} (lex=${h.lexical} sem=${h.semantic})`
    + `${Array.isArray(h.lines) && h.lines.length ? `\n   best lines: ${h.lines.join(', ')}` : ''}`
    + `${h.symbols.length ? `\n   symbols: ${h.symbols.join(', ')}` : ''}`);
  // Say what to do next, and be specific about the WINDOW. Naming a chunk range
  // still left the model to find the line inside it, which it did by running
  // another search — the hop this index exists to remove. With `best lines` the
  // next call can be a tight ranged read.
  const next = pinned
    ? '\n\nEach hit names the LINES its terms are actually on. Read one tight window — read_file(path, startLine, endLine) around a best line (about ±40 lines) — rather than the whole chunk, the whole file, or another search.'
    : ranged
      ? '\n\nA hit shown as path:FROM-TO is a line range — read exactly that with read_file(path, startLine, endLine) rather than reading the whole file or searching again.'
      : '';
  return `Codebase index — ${result.hits.length} hit(s) across ${result.files || result.indexed} file(s):\n\n${lines.join('\n')}${next}`;
}

module.exports = {
  buildIndex, updateFile, loadIndex, searchIndex, formatHits, indexPath, extractSymbols, embedTokens, cosine,
  fileRecords, recordKey, dropPath, staleSample, CHUNK_LINES, MAX_FILE_BYTES,
};
