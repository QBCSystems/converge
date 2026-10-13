// A map of the code on main: one line per git-tracked file, and what it defines at top level.
// Agents read this in their context header so they stop guessing at each other's code
// (which markup exists, whether a money formatter already exists, and so on).
//
// repoMap(dir, { maxBytes }) -> string. Never throws: unreadable or binary files are listed alone.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Names a JS/TS file defines at top level: `export function addExpense()`, `export const total = 1`,
// `export default function x()`, `export { a, b }`. Names that are not exported (inner helpers) are
// not part of the map: agents care about what they may import.
const JS_DECL = /^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const JS_DEFAULT = /^export\s+default\b/;
const JS_NAMES = /^export\s*\{([^}]*)\}\s*(?:from\b.*)?;?\s*$/;
const JS_NAMES_DEFAULT = /\bas\s+default\b/;

function jsNames(text) {
  const out = [];
  const seen = new Set();
  const add = (name) => { if (name && !seen.has(name)) { seen.add(name); out.push(name); } };
  // CommonJS `module.exports = { a, b: c, d() {} }`, on one line or several: each top-level key.
  const key = (part) => { const k = part.trim().match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:[:(,]|$)/); if (k) add(k[1]); };
  const one = String(text).match(/^module\.exports\s*=\s*\{([^\n]*)\}\s*;?\s*$/m);
  if (one) for (const part of one[1].split(',')) key(part);
  const many = String(text).match(/^module\.exports\s*=\s*\{[ \t]*\r?\n([\s\S]*?)^\}/m);
  if (many) {
    // Only the object's own lines (its first indent), not the bodies of methods inside it.
    const rows = many[1].split('\n').filter((l) => l.trim());
    const indent = rows.length ? rows[0].match(/^\s*/)[0] : '';
    for (const l of rows) if (l.startsWith(indent) && !/^\s/.test(l.slice(indent.length))) for (const part of l.split(',')) key(part);
  }
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    // CommonJS: `module.exports = { a, b: c }`, `module.exports = name`, `exports.x =` / `module.exports.x =`.
    const cjs = raw.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (cjs) { add(cjs[1]); continue; }
    const cjsOne = raw.match(/^module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/);
    if (cjsOne) { add(cjsOne[1]); continue; }
    if (!line.startsWith('export')) continue;
    if (JS_NAMES.test(line)) {
      const inner = line.match(JS_NAMES)[1];
      for (const part of inner.split(',')) {
        const spec = part.trim();
        if (!spec) continue;
        const as = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!as) continue;
        if (as[2] === 'default' || (!as[2] && as[1] === 'default')) add('default');
        else add(as[2] || as[1]);
      }
      continue;
    }
    const m = line.match(JS_DECL);
    if (m) {
      // `export default function x() {}` names the default export, not x: x is not importable by name.
      if (line.startsWith('export default')) add('default');
      else add(m[2]);
      continue;
    }
    if (JS_DEFAULT.test(line)) add('default');
  }
  return out;
}

// Top-level Python names: `def run():` and `class Thing:` with no leading whitespace.
function pyNames(text) {
  const out = [];
  const seen = new Set();
  const add = (name) => { if (name && !seen.has(name)) { seen.add(name); out.push(name); } };
  for (const raw of String(text).split('\n')) {
    if (/^\s/.test(raw)) continue;
    const m = raw.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/);
    if (m) add(m[2]);
  }
  return out;
}

// Top-level C++ names: `class Foo {};` and `struct Bar {};` with no leading whitespace.
function cppNames(text) {
  const out = [];
  const seen = new Set();
  const add = (name) => { if (name && !seen.has(name)) { seen.add(name); out.push(name); } };
  for (const raw of String(text).split('\n')) {
    const m = raw.match(/^(?:template\s*<.*>\s*)?(class|struct)\s+([A-Za-z_][\w]*)/);
    if (m) add(m[2]);
  }
  return out;
}

/** What a file defines at top level, or null when this file type has nothing to say. */
function namesFor(file, text) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.ts' || ext === '.cjs' || ext === '.jsx' || ext === '.tsx') return jsNames(text);
  if (ext === '.py') return pyNames(text);
  if (ext === '.hpp' || ext === '.h' || ext === '.hh' || ext === '.hxx') return cppNames(text);
  return null;
}

/**
 * One line per git-tracked file under dir, sorted:
 *   '<path>: <name>, <name>'   or   '<path>' when the file defines nothing we know.
 * Files with names beyond maxBytes are cut whole: the text ends '... (N more files)'.
 */
export function repoMap(dir, { maxBytes = 6000 } = {}) {
  let files = [];
  try {
    const out = execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    files = out.split('\0').filter(Boolean);
  } catch {
    return '';
  }
  files.sort();

  const lines = [];
  let used = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let names = null;
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!text.includes('\u0000')) names = namesFor(file, text);
    } catch {
      names = null; // binary or unreadable: list the file alone
    }
    const line = names && names.length ? `${file}: ${names.join(', ')}` : file;

    if (lines.length) {
      const rest = files.length - i;
      const tail = `\n... (${rest} more file${rest === 1 ? '' : 's'})`;
      if (used + 1 + line.length + tail.length > maxBytes) {
        lines.push(`... (${rest} more file${rest === 1 ? '' : 's'})`);
        break;
      }
      lines.push(line);
      used += 1 + line.length;
    } else {
      // A first line longer than the budget still has to land somewhere: keep it whole.
      lines.push(line);
      used += line.length;
    }
  }
  return lines.join('\n');
}

export default repoMap;
