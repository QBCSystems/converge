'use strict';
// Unified-diff hunks as data — parse the diff strings the harness emits
// (universal-agent.cjs unifiedDiff → `diff -u`) and apply ONE hunk to current
// file content. Used by both UIs for per-hunk "Apply" on diffs, and by the
// tests directly. UMD-lite: CommonJS for node/vite, window.ConvergeHunks for the
// desktop renderer's plain <script> include — the IIFE keeps these names out
// of the page's shared global scope (a top-level const here collides with
// app.js's declarations and kills BOTH scripts with a SyntaxError).
(function () {

// diff text → [{ header, oldStart, oldCount, newStart, newCount, lines:
// [{ tag: ' '|'-'|'+', text }] }] — both sides' ranges ride along so a
// renderer can show REAL file line numbers, not 1..N of the hunk text.
// File headers (---/+++), index lines, and "\ No newline" markers are
// tolerated and skipped; anything before the first @@ is ignored.
function parseHunks(diff) {
  const hunks = [];
  let cur = null;
  const rawLines = String(diff || '').split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (m) {
      cur = { header: raw, oldStart: parseInt(m[1], 10), oldCount: m[2] ? parseInt(m[2], 10) : 1, newStart: parseInt(m[3], 10), newCount: m[4] ? parseInt(m[4], 10) : 1, lines: [] };
      hunks.push(cur); continue;
    }
    if (!cur) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw === '' && i === rawLines.length - 1) continue; // Trailing newline at EOF
    if (raw === '' ) { cur.lines.push({ tag: ' ', text: '' }); continue; } // context blank line loses its leading space in some transports
    const tag = raw[0];
    if (tag === ' ' || tag === '-' || tag === '+') cur.lines.push({ tag, text: raw.slice(1) });
    else cur = null; // next file header / junk — stop accumulating into this hunk
  }
  return hunks;
}

// Find `seq` in `lines`, preferring the position the hunk header names, then
// scanning outward — a diff produced a few edits ago still applies when the
// file shifted. Returns -1 when the context can't be found anywhere.
function findSeq(lines, seq, preferred) {
  if (!seq.length) return Math.max(0, Math.min(preferred, lines.length));
  const matches = (at) => {
    if (at < 0 || at + seq.length > lines.length) return false;
    for (let i = 0; i < seq.length; i++) if (lines[at + i] !== seq[i]) return false;
    return true;
  };
  if (matches(preferred)) return preferred;
  for (let d = 1; d < lines.length; d++) {
    if (matches(preferred - d)) return preferred - d;
    if (matches(preferred + d)) return preferred + d;
  }
  return -1;
}

// Apply one parsed hunk to `content`. Returns the new content, or null when
// the hunk's old side no longer matches the file (already applied, or the
// file diverged) — callers surface that instead of guessing.
function applyHunk(content, hunk) {
  const lines = String(content == null ? '' : content).split('\n');
  const before = hunk.lines.filter((l) => l.tag !== '+').map((l) => l.text);
  const after = hunk.lines.filter((l) => l.tag !== '-').map((l) => l.text);
  const at = findSeq(lines, before, Math.max(0, (hunk.oldStart || 1) - 1));
  if (at < 0) return null;
  lines.splice(at, before.length, ...after);
  return lines.join('\n');
}

const api = { parseHunks, applyHunk };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ConvergeHunks = api;
})();
