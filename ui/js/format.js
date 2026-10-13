// Small, pure formatting helpers. No DOM access here so they can be unit-tested in Node.

export const shortSha = (sha, n = 8) => (sha ? String(sha).slice(0, n) : '');

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const UNITS = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
];

/** "just now", "42s ago", "3m ago", "5h ago", "2d ago". */
export function timeAgo(ts, now = nowMs()) {
  if (!ts) return '';
  const delta = now - ts;
  if (delta < 5000) return 'just now';
  for (const [label, ms] of UNITS) {
    if (delta >= ms) return `${Math.floor(delta / ms)}${label} ago`;
  }
  return 'just now';
}

/** Test-summary line shared by the contender card and the notes panel. */
function formatTests(tests) {
  if (!tests) return '';
  if (typeof tests === 'string') return tests;
  if (!tests.command) return '';
  return `${tests.command}: ${tests.passed ?? 0} passed, ${tests.failed ?? 0} failed`;
}

/** Lenient JSON parser that recovers truncated strings from logs and unwraps nested JSON. */
export function parseLenientJson(str) {
  if (!str || typeof str !== 'string') return null;
  let s = str.trim();
  s = s.replace(/^(?:TOOL ERROR:\s*[^:]+:\s*|->\s*)/, '');
  s = s.replace(/[\s\n]*(?:<truncated[^>]*>|\.{2,}\s*\[truncated[^\]]*\]|…\s*\(\d+\s+more\s+characters\)|\[truncated[^\]]*\])[\s\n]*\}?$/i, '');
  if (!s.startsWith('{') && !s.startsWith('[')) return null;

  try { return unwrapRecursive(JSON.parse(s)); } catch { /* not JSON: shown as it is */ }

  // Stack-based bracket/brace closer for truncated JSON, escaping unescaped newlines/tabs inside strings
  let inString = false, escape = false;
  const stack = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        out += ch;
      } else if (ch === '\\') {
        escape = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      out += ch;
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
    }
  }
  if (inString) out += '"';
  while (stack.length) {
    const top = stack.pop();
    out += (top === '{' ? '}' : ']');
  }
  try { return unwrapRecursive(JSON.parse(out)); } catch {
    out = out.replace(/,\s*([\}\]])/g, '$1')
             .replace(/,\s*"[^"]*":?\s*([\}\]])/g, '$1')
             .replace(/:\s*([\}\]])/g, ':null$1');
    try { return unwrapRecursive(JSON.parse(out)); } catch { return null; }
  }
}

function unwrapRecursive(val) {
  if (!val || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(unwrapRecursive);
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (typeof v === 'string' && (v.trim().startsWith('{') || v.trim().startsWith('['))) {
      const parsed = parseLenientJson(v);
      out[k] = parsed !== null ? parsed : v;
    } else if (typeof v === 'object' && v !== null) {
      out[k] = unwrapRecursive(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Parse NDJSON, JSON lines, or individual string lines. */
export function parseNdjsonOrLines(str) {
  if (!str || typeof str !== 'string') return [];
  const trimmed = str.trim();
  const single = parseLenientJson(trimmed);
  if (single) return [single];

  const items = [];
  const lines = trimmed.split('\n');

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    while (line) {
      if (line.startsWith('{') || line.startsWith('[')) {
        const parsedLine = parseLenientJson(line);
        if (parsedLine) {
          items.push(parsedLine);
          break;
        }

        let inString = false, escape = false, depth = 0, jsonEnd = -1;
        for (let j = 0; j < line.length; j++) {
          const ch = line[j];
          if (inString) {
            if (escape) escape = false;
            else if (ch === '\\') escape = true;
            else if (ch === '"') inString = false;
          } else {
            if (ch === '"') inString = true;
            else if (ch === '{' || ch === '[') depth++;
            else if (ch === '}' || ch === ']') {
              depth--;
              if (depth === 0) {
                jsonEnd = j + 1;
                break;
              }
            }
          }
        }

        if (jsonEnd > 0) {
          const jsonStr = line.slice(0, jsonEnd);
          const parsed = parseLenientJson(jsonStr);
          items.push(parsed || jsonStr);
          line = line.slice(jsonEnd).trim();
          continue;
        }

        const parsedTrunc = parseLenientJson(line);
        items.push(parsedTrunc || line);
        break;
      } else {
        items.push(line);
        break;
      }
    }
  }
  return items;
}

/** Summarize any arbitrary result object with a semantic badge, tone, and headline. */
export function summarizeObject(obj) {
  if (!obj || typeof obj !== 'object') return { badge: 'INFO', tone: '', title: String(obj || '') };

  // 0. Interrupted turn or halt
  if (obj.interrupted || obj.code === 143) {
    return {
      badge: 'HALT',
      tone: 'warn',
      title: obj.text ? (obj.text.length > 140 ? `${obj.text.slice(0, 139)}…` : obj.text) : 'Turn interrupted by SIGTERM (restart/stop)'
    };
  }

  // Stream tokens
  if (obj.t === 'end' || obj.type === 'end') {
    return { badge: 'END', tone: '', title: 'Turn finished' };
  }
  if (obj.t === 'answer' || obj.type === 'answer') {
    return {
      badge: 'REPLY',
      tone: 'info',
      title: obj.text ? (obj.text.length > 140 ? `${obj.text.slice(0, 139)}…` : obj.text) : 'Agent reply'
    };
  }

  // 1. Errors & exceptions
  if (typeof obj.code === 'number' && (obj.code < 0 || obj.code >= 400 || obj.message)) {
    return { badge: 'ERROR', tone: 'bad', title: obj.message || `Error ${obj.code}` };
  }
  if (obj.error) {
    const msg = typeof obj.error === 'string' ? obj.error : (obj.error.message || obj.error.title || 'Error');
    return { badge: 'ERROR', tone: 'bad', title: msg };
  }
  if (Array.isArray(obj.errors) && obj.errors.length) {
    return { badge: 'ERROR', tone: 'bad', title: String(obj.errors[0]?.message || obj.errors[0]) };
  }

  // 2. Status badges & tones
  let badge = 'DATA';
  let tone = '';
  if (typeof obj.exit_code === 'number') {
    badge = obj.exit_code === 0 ? 'PASS' : `EXIT ${obj.exit_code}`;
    tone = obj.exit_code === 0 ? 'good' : 'bad';
  } else if (obj.status || obj.state || obj.verdict) {
    const st = String(obj.status || obj.state || obj.verdict);
    badge = st.toUpperCase().slice(0, 8);
    tone = /^(ok|pass|clean|landed|submitted|success)$/i.test(st) ? 'good' : /^(fail|error|refused|conflicted|bad)$/i.test(st) ? 'bad' : /^(warn|wait|pending)$/i.test(st) ? 'warn' : 'info';
  } else if (obj.you) {
    badge = 'STATUS';
    tone = 'info';
  } else if ('overlaps' in obj || 'in_flight' in obj) {
    const hasOverlap = obj.overlaps?.length > 0;
    badge = 'CLAIM';
    tone = hasOverlap ? 'warn' : 'good';
  } else if (obj.verification) {
    badge = 'VERIFY';
    tone = 'info';
  } else if (obj.tests) {
    badge = 'TESTS';
    tone = obj.tests.failed === 0 ? 'good' : obj.tests.failed > 0 ? 'bad' : 'info';
  }

  // 3. Meaningful headline
  let title = '';
  if (obj.you) {
    const y = obj.you;
    const fork = y.fork_remote ? y.fork_remote.split('/').pop().replace(/\.git$/, '') : '';
    title = `${y.role || 'worker'} · ${fork || y.agent_id || 'ready'}${obj.main_head || y.main_head ? ` · main @ ${shortSha(obj.main_head || y.main_head, 7)}` : ''}${obj.state ? ` (${obj.state})` : ''}`;
  } else if ('overlaps' in obj || 'in_flight' in obj) {
    title = obj.overlaps?.length ? `${obj.overlaps.length} overlapping claim(s)` : 'Claim active · no conflicts';
  } else if (obj.verification) {
    const vStr = String(obj.verification).replace(/`/g, '').trim();
    if (/^queued:\s*converge checks your reported command/i.test(vStr)) {
      const rest = vStr.replace(/^queued:\s*converge checks your reported command\s*/i, '').replace(/^\(|\)$/g, '').trim();
      title = rest ? `Queued verification: ${rest.length > 100 ? `${rest.slice(0, 99)}…` : rest}` : 'Queued verification';
    } else {
      title = vStr.length > 120 ? `${vStr.slice(0, 119)}…` : vStr;
    }
  } else if (obj.tests && typeof obj.tests === 'object') {
    title = formatTests(obj.tests);
  } else if (obj.command && typeof obj.exit_code === 'number') {
    title = obj.command;
  } else if (obj.message || obj.summary || obj.title || obj.description) {
    title = String(obj.message || obj.summary || obj.title || obj.description);
  } else {
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      if (/^(notices|details|output|stdout|stderr|_)/.test(k)) continue;
      if (typeof v === 'boolean') parts.push(`${k}: ${v ? 'yes' : 'no'}`);
      else if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}: ${v}`);
      else if (Array.isArray(v)) parts.push(`${k} (${v.length})`);
      else if (typeof v === 'object' && v !== null) {
        const subKeys = Object.keys(v).slice(0, 2);
        if (subKeys.length) parts.push(`${k}: {${subKeys.join(', ')}}`);
      }
      if (parts.length >= 3) break;
    }
    title = parts.join(' · ') || (Array.isArray(obj) ? `${obj.length} items` : '');
  }

  return { badge, tone, title };
}

/** Why aios refused an action, in a line: what its first line of reply means, without the ids and long paths. */
export function refusalWhy(reason) {
  const r = String(reason || '').replace(/^refused by aios( and reverted)?:\s*/i, (m, rev) => (rev ? 'reverted: ' : '')).trim();
  if (!r || /^exit \d+$/.test(r)) return '';   // older records kept a command's first output line, which is not the reason
  const cmd = /^reverted: the command changed (\S+?),? which you hold no write capability over/.exec(r);
  if (cmd) return `a command changed ${cmd[1]}, which it had not claimed: undone`;
  if (/holds no write capability/.test(r)) return 'it had not claimed the file yet';
  if (/holds no read capability/.test(r)) return 'it had no right to read that';
  if (/holds no (\w+) capability/.test(r)) return `no ${/holds no (\w+) capability/.exec(r)[1]} right for that`;
  return r.length > 120 ? `${r.slice(0, 117)}…` : r;
}

/** Clean any tool target or action string, unwrapping JSON if present. */
export function formatStepTarget(action, target) {
  if (!target) return '';
  const str = String(target).trim();
  if (str.startsWith('{') || str.startsWith('[') || str.startsWith('{"')) {
    const data = parseLenientJson(str);
    if (data && typeof data === 'object') {
      const obj = (data.args && typeof data.args === 'object' && !Array.isArray(data.args)) ? data.args : data;
      const p = obj.path || obj.file_path || obj.file || obj.targetFile || obj.target || data.path || data.file_path || data.file || data.targetFile || data.target;
      if (p) return p;
      const paths = obj.paths || data.paths || obj.files || data.files;
      if (Array.isArray(paths) && paths.length) {
        return `${paths.slice(0, 2).join(', ')}${paths.length > 2 ? ` +${paths.length - 2}` : ''}`;
      }
      const claims = obj.claims || data.claims;
      if (Array.isArray(claims) && claims.length) {
        const files = claims.map((c) => c.file || c.statement).filter(Boolean);
        return `${files.slice(0, 2).join(', ')}${files.length > 2 ? ` +${files.length - 2}` : ''}`;
      }
      const cmd = obj.command || obj.cmd || obj.script || obj.tests?.command || data.command || data.cmd || data.tests?.command;
      if (cmd) return cmd;
      if (obj.tool || obj.name || data.tool || data.name) {
        const toolName = obj.tool || obj.name || data.tool || data.name;
        const summary = obj.summary || data.summary;
        return `${toolName}${summary ? `: ${summary}` : ''}`;
      }
      if (obj.summary || data.summary) return obj.summary || data.summary;
      if (obj.query || obj.pattern || data.query || data.pattern) return `"${obj.query || obj.pattern || data.query || data.pattern}"`;
      if (obj.content || data.content) return '(file content)';
    }

    // Fallbacks if structured parse failed or yielded generic object
    const pathMatch = /(?:\\"|")(?:path|file_path|file|targetFile|target)(?:\\"|")\s*:\s*(?:\\"|")([^"\\]+)/.exec(str);
    if (pathMatch) return pathMatch[1];

    const cmdMatch = /(?:\\"|")(?:command|cmd)(?:\\"|")\s*:\s*(?:\\"|")((?:[^"\\]|\\.)*)/.exec(str);
    if (cmdMatch) return cmdMatch[1].replace(/\\+"/g, '"').replace(/\\\\/g, '\\').trim();

    if (/(?:\\"|")(?:paths|claims)(?:\\"|")\s*:\s*\[/.test(str)) {
      const files = [...new Set((str.match(/(?:[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-\.\/]+\/)/g) || []).filter((f) => !/^(json|args|paths|claims|mcp_call)$/.test(f)))];
      if (files.length) return `${files.slice(0, 2).join(', ')}${files.length > 2 ? ` +${files.length - 2}` : ''}`;
    }

    if (/(?:\\"|")content(?:\\"|")\s*:/.test(str)) return '(file content)';
    return '';
  }
  return str.replace(/^cd \S+ && /, '').replace(/\\+"/g, '"');
}

export function formatObsSnippet(obs, maxLen = 90) {
  if (!obs) return '';
  const str = String(obs).trim();
  const items = parseNdjsonOrLines(str);
  if (items.length) {
    for (const item of items) {
      if (typeof item === 'object' && item !== null) {
        if ((item.t === 'end' || item.type === 'end') && Object.keys(item).length <= 2) continue;
        const s = summarizeObject(item);
        if (s.title) return s.title.length > maxLen ? `${s.title.slice(0, maxLen - 1)}…` : s.title;
      } else {
        const line = String(item).trim();
        if (line) return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
      }
    }
  }
  const first = str.split('\n').find((l) => l.trim()) || '';
  return first.length > maxLen ? `${first.slice(0, maxLen - 1)}…` : first;
}

/** The page's "now": the moment on screen while replaying the past (a silent agent is judged by that moment, not by today). */
export const clock = { at: 0 };
export const nowMs = () => clock.at || Date.now();

/** A link from the network is followed only if it is http(s): never a javascript: or data: URL. */
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : undefined);

/** Cut text at a word boundary so nothing is shown chopped mid-word. */
export function wordCut(text, max = 140) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1).replace(/\s+\S*$/, '');
  return `${(cut || t.slice(0, max)).replace(/[\s,;:.\-–]+$/, '')}…`;
}
