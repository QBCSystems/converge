// What a universal agent does, step by step, reported to converge as it happens: follows the agent's own log
// (universal-agent.log: "[time] [step N] tool({args})" then "[time] [step N] -> result") and posts each finished
// step as an Acted event (POST /api/projects/:p/audit, the route aios's broker uses), so the dashboard shows every
// command, read and edit, not only the claims and pushes. Agents under aios report through aios instead.
//
//   const stop = followSteps({ log, api, adminKey, project, agentId });  ...  await stop();
import fs from 'node:fs';

const KIND = {
  run_command: 'run', bash: 'run', exec: 'run', shell: 'run',
  write_file: 'write', create_file: 'write',
  edit_file: 'edit', replace_in_file: 'edit', apply_patch: 'edit', str_replace: 'edit', patch: 'edit',
  read_file: 'read', list_dir: 'read', list_files: 'read', grep: 'read', search: 'read', glob: 'read', view: 'read',
  mcp_call: 'converge', mcp_list_tools: 'converge', done: 'done',
};
const field = (args, name) => {
  const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(args);
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
};
const FAILED = /^(TOOL ERROR|Error\b|error:|fatal:|command failed|exit (code|status) [1-9])|\bexit (code|status):? [1-9]\d*\s*$/i;

function extractTarget(tool, args) {
  if (tool === 'run_command' || tool === 'bash' || tool === 'exec' || tool === 'shell') {
    const cmd = field(args, 'command') || field(args, 'cmd');
    if (cmd) return cmd;
  }
  if (tool === 'mcp_call') {
    const sub = field(args, 'tool') || field(args, 'name');
    if (sub) {
      const p = field(args, 'path') || field(args, 'command') || field(args, 'summary');
      return p ? `${sub} ${p}` : sub;
    }
    const pathsMatch = /(?:\\"|")paths(?:\\"|")\s*:\s*\[([^\]]+)\]/.exec(args);
    if (pathsMatch) {
      const files = [...new Set((pathsMatch[1].match(/(?:[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-\.\/]+\/)/g) || []).filter((f) => !/^(json|args|paths|claims|mcp_call)$/.test(f)))];
      if (files.length) return `claim ${files.slice(0, 2).join(', ')}${files.length > 2 ? ` +${files.length - 2}` : ''}`;
    }
    const cmd = field(args, 'command');
    if (cmd) return `tests: ${cmd}`;
    if (args.includes('"wait":true') || args.includes('"wait": true')) return 'status (waiting)';
    return 'converge';
  }
  const p = field(args, 'path') || field(args, 'file') || field(args, 'pattern') || field(args, 'query') || field(args, 'server') || field(args, 'target') || '';
  if (p) return p;
  return '';
}

function cleanReason(out) {
  if (!out) return '';
  const msgMatch = /"message"\s*:\s*"([^"]+)"/.exec(out);
  if (msgMatch) return msgMatch[1];
  return out.replace(/^TOOL ERROR:\s*[^:]+:\s*/, '').slice(0, 200);
}

/** Parses log text into finished steps; returns them and the text not yet complete. */
export function parseSteps(text, open = new Map()) {
  const done = [];
  for (const line of text.split('\n')) {
    const call = /^\[([^\]]+)\] \[step (\d+)\] ([a-z_]+)\((.*)$/.exec(line); // long arguments run on to the next line
    if (call) {
      const [, at, step, tool, args] = call;
      const action = KIND[tool] || tool;
      const target = extractTarget(tool, args);
      // "cd <its own checkout> && …" says nothing: the command is what follows.
      open.set(step, { cycle: Number(step), action, target: target.replace(/^cd \S+ && /, '').replace(/\s+/g, ' ').trim().slice(0, 300), at });
      continue;
    }
    const res = /^\[([^\]]+)\] \[step (\d+)\] -> (.*)$/.exec(line);
    if (res && open.has(res[2])) {
      const s = open.get(res[2]);
      open.delete(res[2]);
      const out = res[3];
      done.push({ ...s, verdict: FAILED.test(out.trim()) ? 'failed' : 'allowed', observation: out.slice(0, 600), reason: FAILED.test(out.trim()) ? cleanReason(out) : '' });
    }
  }
  return done;
}

export function followSteps({ log, api, adminKey, project, agentId, everyMs = 1500 }) {
  let offset = 0, carry = '', stopped = false, sent = 0, broken = false;
  const open = new Map();
  const queue = [];
  const post = async () => {
    if (!queue.length || broken) return;
    const events = queue.splice(0, 100).map((s) => ({ type: 'Acted', agent_id: agentId, cycle: s.cycle, action: s.action, target: s.target, verdict: s.verdict, reason: s.reason, observation: s.observation }));
    try {
      const r = await fetch(`${api}/api/projects/${encodeURIComponent(project)}/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey }, body: JSON.stringify({ events }) });
      if (r.status === 404) broken = true; // a platform without the route: stop trying, the run goes on
      else sent += events.length;
    } catch { /* the next tick tries again with what comes next */ }
  };
  const tick = async () => {
    try {
      const st = fs.statSync(log);
      if (st.size > offset) {
        const fd = fs.openSync(log, 'r');
        const buf = Buffer.alloc(st.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = st.size;
        const text = carry + buf.toString('utf8');
        const cut = text.lastIndexOf('\n');
        carry = cut >= 0 ? text.slice(cut + 1) : text;
        queue.push(...parseSteps(cut >= 0 ? text.slice(0, cut) : '', open));
      }
    } catch { /* no log yet */ }
    await post();
  };
  const timer = setInterval(() => { if (!stopped) tick(); }, everyMs);
  return async () => { stopped = true; clearInterval(timer); await tick(); carry += '\n'; queue.push(...parseSteps(carry, open)); await post(); return sent; };
}
