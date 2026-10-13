'use strict';

const VALID_PROJECTIONS = new Set(['count', 'files', 'matches', 'evidence', 'full']);

function projectionName(args, fallback = 'evidence') {
  const requested = String((args && args.projection) || fallback).toLowerCase();
  return VALID_PROJECTIONS.has(requested) ? requested : fallback;
}

function parseSearchText(text) {
  if (typeof text !== 'string') return null;
  const matchHeader = text.match(/^(\d+)(\+\s*\(capped\))?\s*match\(es\):/m);
  const lineHit = /^[^\s:]+:\d+:/m.test(text);
  if (!matchHeader && !lineHit) return null;
  const lines = text.split('\n');
  const hits = [];
  for (const line of lines) {
    if (/^[^\s:]+:\d+:/.test(line)) {
      hits.push(line);
    }
  }
  if (!matchHeader && !hits.length) return null;
  const total = matchHeader ? (parseInt(matchHeader[1], 10) || hits.length) : hits.length;
  const capped = Boolean(matchHeader && matchHeader[2]);
  return { kind: 'search_matches', hits, total, capped };
}

function parseFileListText(text) {
  if (typeof text !== 'string') return null;
  const fileHeader = text.match(/^(\d+)(\+\s*\(capped\))?\s*file\(s\):/m);
  if (!fileHeader) {
    const sample = text.slice(0, 1000).split('\n').map((l) => l.trim()).filter(Boolean);
    if (!sample.length || sample.length < 2) return null;
    const isPathList = sample.every((l) => /^[\.a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+$/.test(l) || /^[a-zA-Z0-9_\-\/]+\/[a-zA-Z0-9_\-\.\/]+$/.test(l));
    if (!isPathList) return null;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => Boolean(l) && !/^\d+(\+.*)?\s*file\(s\):/i.test(l) && !/^showing\b/i.test(l));
  if (!lines.length && !fileHeader) return null;
  const capped = Boolean(fileHeader && fileHeader[2]);
  const total = fileHeader ? (parseInt(fileHeader[1], 10) || lines.length) : lines.length;
  return { kind: 'file_list', files: lines, total, capped };
}

function charBudget(args, projection) {
  if (projection === 'count') return 500;
  const requested = Number(args && args.maxTokens);
  const tokens = Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : projection === 'full' ? 3000 : 800;
  return Math.max(256, Math.min(32000, tokens * 4));
}

function hitFile(hit) {
  const m = String(hit).match(/^(.*?):\d+:/);
  return m ? m[1] : String(hit);
}

// Prefer breadth for the evidence view. One hit from ten files is generally
// better locating evidence than ten adjacent hits from the first file.
function evidenceOrder(hits) {
  const groups = new Map();
  for (const hit of hits) {
    const file = hitFile(hit);
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(hit);
  }
  const ordered = [];
  let depth = 0;
  while (ordered.length < hits.length) {
    let added = false;
    for (const group of groups.values()) {
      if (depth < group.length) { ordered.push(group[depth]); added = true; }
    }
    if (!added) break;
    depth++;
  }
  return ordered;
}

function fitLines(lines, budget) {
  const shown = [];
  let chars = 0;
  for (const line of lines) {
    const size = String(line).length + 1;
    if (shown.length && chars + size > budget) break;
    shown.push(String(line));
    chars += size;
  }
  return shown;
}

function omissionLine(shown, total, capped) {
  const omitted = Math.max(0, total - shown);
  return `shown=${shown} total=${total}${capped ? '+' : ''} omitted=${omitted}${capped ? '+' : ''} truncated=${omitted > 0 || capped}`;
}

function projectSearchResult(result, args = {}) {
  let target = result;
  if (typeof result === 'string') {
    target = parseSearchText(result);
  } else if (result && typeof result === 'object' && !result.kind && Array.isArray(result.hits)) {
    target = { kind: 'search_matches', ...result };
  }
  if (!target || target.kind !== 'search_matches') return undefined;
  const hits = Array.isArray(target.hits) ? target.hits.map(String) : [];
  const total = Number.isFinite(target.total) ? target.total : hits.length;
  const capped = Boolean(target.capped);
  const projection = projectionName(args);
  const files = [...new Set(hits.map(hitFile))];

  if (projection === 'count') {
    return `projection=count matches=${total}${capped ? '+' : ''} files=${files.length}${capped ? '+' : ''}`;
  }

  const candidates = projection === 'files'
    ? files
    : projection === 'evidence' ? evidenceOrder(hits) : hits;
  const shown = fitLines(candidates, charBudget(args, projection));
  const noun = projection === 'files' ? 'files' : 'matches';
  return [
    `projection=${projection} ${noun}:`,
    shown.join('\n') || '(none)',
    omissionLine(shown.length, candidates.length, capped),
    (shown.length < candidates.length || capped) && projection !== 'full'
      ? 'Request projection="full" or raise maxTokens if more detail is required.'
      : '',
  ].filter(Boolean).join('\n');
}

function projectFileList(result, args = {}) {
  let target = result;
  if (typeof result === 'string') {
    target = parseFileListText(result);
  } else if (result && typeof result === 'object' && !result.kind && Array.isArray(result.files)) {
    target = { kind: 'file_list', ...result };
  }
  if (!target || target.kind !== 'file_list') return undefined;
  const files = Array.isArray(target.files) ? target.files.map(String) : [];
  const total = Number.isFinite(target.total) ? target.total : files.length;
  const capped = Boolean(target.capped);
  const projection = projectionName(args, 'files');
  if (projection === 'count') return `projection=count files=${total}${capped ? '+' : ''}`;
  const shown = fitLines(files, charBudget(args, projection));
  return [
    `projection=${projection} files:`,
    shown.join('\n') || '(empty)',
    omissionLine(shown.length, total, capped),
    (shown.length < total || capped) && projection !== 'full'
      ? 'Request projection="full" or raise maxTokens if more paths are required.'
      : '',
  ].filter(Boolean).join('\n');
}

function projectGenericResult(result, args = {}) {
  const projection = projectionName(args, 'full');
  const requestedMax = Number(args && args.maxTokens);
  const hasMax = Number.isFinite(requestedMax) && requestedMax > 0;
  if (projection === 'full' && !hasMax) return undefined;

  let text = typeof result === 'string'
    ? result
    : (result && typeof result === 'object'
      ? (typeof result.text === 'string' ? result.text : typeof result.output === 'string' ? result.output : JSON.stringify(result, null, 2))
      : String(result || ''));

  if (projection === 'count') {
    const lines = text.split('\n');
    return `projection=count lines=${lines.length} chars=${text.length}`;
  }

  const budget = charBudget(args, projection);
  if (text.length <= budget) return text;

  const lines = text.split('\n');
  const shown = fitLines(lines, budget);
  return [
    `projection=${projection} text:`,
    shown.join('\n'),
    omissionLine(shown.length, lines.length, false),
    shown.length < lines.length && projection !== 'full'
      ? 'Request projection="full" or raise maxTokens if more detail is required.'
      : '',
  ].filter(Boolean).join('\n');
}

function projectUniversal(result, args = {}) {
  if (!result) return undefined;
  if (typeof result === 'object') {
    if (result.kind === 'search_matches' || Array.isArray(result.hits)) {
      return projectSearchResult(result, args);
    }
    if (result.kind === 'file_list' || Array.isArray(result.files)) {
      return projectFileList(result, args);
    }
  }
  const text = typeof result === 'string' ? result : (result && typeof result === 'object' ? (result.text || result.output || null) : null);
  if (text) {
    const searchMatch = parseSearchText(text);
    if (searchMatch) {
      return projectSearchResult(searchMatch, args);
    }
    const fileMatch = parseFileListText(text);
    if (fileMatch) {
      return projectFileList(fileMatch, args);
    }
    if (args.projection || args.maxTokens || text.length > 400) {
      return projectGenericResult(text, args);
    }
  }
  if (args.projection || args.maxTokens) {
    return projectGenericResult(result, args);
  }
  return undefined;
}

module.exports = {
  projectSearchResult,
  projectFileList,
  parseSearchText,
  parseFileListText,
  projectGenericResult,
  projectUniversal,
};
