'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanTitle, shortenPath, fmtDur, readJson: readJsonSafe, isProcessAlive } = require('./utils.cjs');

// WHERE THE CONVERSATIONS ACTUALLY ARE. The daemon (gui/server.js), the harness
// and the CLI all keep the global store under AGENT_STATE_DIR — default
// ~/.universal-agent — as gui-chats/, active-turns.json and index.json. This
// module defaulted to ~/.converge, which holds config and never a chat, so every
// the `convos` command, `:convos` and the conversations tool call answered "No
// conversations found" on machines with two thousand of them
// while the harness's own list_conversations tool, which passes its state dir
// explicitly, saw them fine. CONVERGE_AGENT_HOME stays as the last fallback for an
// install that really did put the store there.
function defaultStateDir() {
  if (process.env.AGENT_STATE_DIR) return path.resolve(process.env.AGENT_STATE_DIR);
  const modern = path.join(os.homedir(), '.universal-agent');
  const legacy = path.resolve(process.env.CONVERGE_AGENT_HOME || path.join(os.homedir(), '.converge'));
  if (fs.existsSync(path.join(modern, 'gui-chats'))) return modern;
  if (fs.existsSync(path.join(legacy, 'gui-chats'))) return legacy;
  return modern;
}
// The file behind a conversation id, exactly as gui/server.js names it: a
// terminal thread ("term-<base64url workdir>") is that folder's
// .agent/chat.json; every other id is gui-chats/<sanitized id>.json in the
// state dir. Exposed so the CLI/TUI can continue a console/GUI thread by
// pointing the harness (AGENT_CHAT_FILE) at the very same file.
function conversationFilePath(id, options = {}) {
  const sid = String(id || '');
  if (!sid) return null;
  if (sid.startsWith('term-')) {
    try { return path.join(Buffer.from(sid.slice(5), 'base64url').toString('utf8'), '.agent', 'chat.json'); } catch { return null; }
  }
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  return path.join(stateDir, 'gui-chats', `${sid.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

function listConversations(options = {}) {
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const chatDir = path.join(stateDir, 'gui-chats');
  const chatIndexFile = path.join(chatDir, 'index.json');
  const activeTurnsFile = path.join(stateDir, 'active-turns.json');
  const taskIndexFile = path.join(stateDir, 'index.json');

  const chatIdx = readJsonSafe(chatIndexFile, { activeId: null, conversations: [] });
  const activeTurns = readJsonSafe(activeTurnsFile, []);
  const taskIndex = readJsonSafe(taskIndexFile, {});

  const activeTurnMap = new Map();
  if (Array.isArray(activeTurns)) {
    for (const t of activeTurns) {
      if (t && t.conversationId) activeTurnMap.set(t.conversationId, t);
    }
  }

  const rawList = Array.isArray(chatIdx.conversations) ? [...chatIdx.conversations] : [];

  // Terminal chat check for current working directory or explicit workdir
  const currentWorkdir = path.resolve(options.workdir || process.cwd());
  const terminalChatFile = path.join(currentWorkdir, '.agent', 'chat.json');
  if (fs.existsSync(terminalChatFile)) {
    const termId = 'term-' + Buffer.from(currentWorkdir).toString('base64url');
    if (!rawList.some((c) => c.id === termId)) {
      let msgs = [];
      try { msgs = readJsonSafe(terminalChatFile, []); } catch {}
      const mtime = (() => { try { return fs.statSync(terminalChatFile).mtime.toISOString(); } catch { return new Date().toISOString(); } })();
      const firstUser = msgs.find((m) => m && m.role === 'user' && m.content);
      rawList.unshift({
        id: termId,
        title: firstUser ? cleanTitle(firstUser.content) || 'Terminal session' : 'Terminal session',
        workdir: currentWorkdir,
        createdAt: mtime,
        updatedAt: mtime,
        count: msgs.length,
        isTerminal: true,
      });
    }
  }

  const result = [];
  for (const c of rawList) {
    if (!c || !c.id) continue;
    // Archived threads are hidden in every UI list; keep the terminal listing in step.
    if (c.archived && !options.archived) continue;
    const active = activeTurnMap.get(c.id);
    const pid = active && active.pid ? active.pid : null;
    const isAlive = pid ? isProcessAlive(pid) : false;

    // Check latest task record linked to this conversation
    let latestTask = null;
    let latestTaskAt = '';
    for (const [taskId, row] of Object.entries(taskIndex || {})) {
      if (!row || !row.conversation) continue;
      const match = row.conversation.includes(c.id) || (c.isTerminal && row.workdir === c.workdir);
      if (match) {
        const at = String(row.updatedAt || row.createdAt || '');
        if (!latestTask || at > latestTaskAt) {
          latestTask = { taskId, ...row };
          latestTaskAt = at;
        }
      }
    }

    let status = 'idle';
    if (isAlive) {
      status = 'running';
    } else if (active && !isAlive) {
      status = 'interrupted';
    } else if (latestTask && latestTask.status === 'running') {
      status = 'running';
    }

    // Inspect UI file for model, tool counts, and tokens
    const uiFile = path.join(chatDir, `${c.id}.ui.json`);
    const uiTurns = readJsonSafe(uiFile, []);
    let toolCallsCount = 0;
    let modelRef = c.model || (latestTask && `${latestTask.provider}/${latestTask.model}`) || '';
    let tokensIn = latestTask ? (latestTask.tokensIn || (latestTask.tokens && latestTask.tokens.in) || 0) : 0;
    let tokensOut = latestTask ? (latestTask.tokensOut || (latestTask.tokens && latestTask.tokens.out) || 0) : 0;

    if (Array.isArray(uiTurns) && uiTurns.length) {
      for (const t of uiTurns) {
        if (!modelRef && t.model) modelRef = t.model;
        if (t.tools && Array.isArray(t.tools)) toolCallsCount += t.tools.length;
        if (t.usage) {
          if (t.usage.tokensIn) tokensIn += t.usage.tokensIn;
          if (t.usage.tokensOut) tokensOut += t.usage.tokensOut;
        }
      }
    }

    if (active && active.tokens) {
      tokensIn = Math.max(tokensIn, active.tokens.in || 0);
      tokensOut = Math.max(tokensOut, active.tokens.out || 0);
    }

    result.push({
      id: c.id,
      title: c.title || 'Untitled conversation',
      workdir: c.workdir || (active && active.workdir) || (latestTask && latestTask.workdir) || '',
      status,
      pid: isAlive ? pid : null,
      model: modelRef,
      phase: (active && active.phase) || (status === 'running' ? 'Running' : ''),
      lastStep: (active && active.lastStep) || '',
      secs: (active && active.secs) || 0,
      count: c.count || (Array.isArray(uiTurns) ? uiTurns.length : 0),
      toolCallsCount,
      tokensIn,
      tokensOut,
      createdAt: c.createdAt || '',
      updatedAt: (active && new Date().toISOString()) || c.updatedAt || latestTaskAt || '',
    });
  }

  // Sort: running first, then newest updatedAt
  result.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  return result.slice(0, options.limit || 50);
}

function inspectConversation(targetId, options = {}) {
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const chatDir = path.join(stateDir, 'gui-chats');
  const convos = listConversations({ stateDir, limit: 100, workdir: options.workdir });

  if (!convos.length) {
    return { error: 'No conversations found in ' + stateDir };
  }

  let selected = null;
  const target = String(targetId || '').trim();
  if (!target || target === 'latest' || target === 'active') {
    selected = convos.find((c) => c.status === 'running') || convos[0];
  } else {
    selected = convos.find((c) => c.id === target || c.id.startsWith(target));
  }

  if (!selected) {
    return { error: `Conversation "${target}" not found` };
  }

  const id = selected.id;
  let chatFile = path.join(chatDir, `${id}.json`);
  let ledgerFile = path.join(chatDir, `${id}.ledger.json`);
  if (id.startsWith('term-')) {
    try {
      const wd = Buffer.from(id.slice(5), 'base64url').toString('utf8');
      chatFile = path.join(wd, '.agent', 'chat.json');
      ledgerFile = path.join(wd, '.agent', 'chat.ledger.json');
    } catch {}
  }

  const messages = readJsonSafe(chatFile, []);
  const uiTurns = readJsonSafe(path.join(chatDir, `${id}.ui.json`), []);
  const ledgerData = readJsonSafe(ledgerFile, { items: [] });

  // Extract recent tool executions across UI turns
  const tools = [];
  if (Array.isArray(uiTurns)) {
    for (const turn of uiTurns) {
      if (!turn) continue;
      if (Array.isArray(turn.tools)) {
        for (const t of turn.tools) {
          if (!t) continue;
          tools.push({
            name: t.name || 'tool',
            label: t.label || t.name || '',
            detail: t.detail || '',
            ok: t.ok != null ? !!t.ok : (t.status ? t.status === 'success' : true),
            secs: t.secs || 0,
            preview: t.preview || '',
            path: t.path || '',
            at: t.at || turn.updatedAt || '',
          });
        }
      }
    }
  }

  // If uiTurns had no tools or for live task tracking, also inspect events.jsonl from tasks/<taskId> if present
  if (selected && selected.taskId) {
    const eventsFile = path.join(stateDir, 'tasks', selected.taskId, 'events.jsonl');
    if (fs.existsSync(eventsFile)) {
      try {
        const evLines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of evLines) {
          try {
            const e = JSON.parse(line);
            if (e.type === 'tool_result') {
              const ok = e.ok != null ? !!e.ok : (e.status ? e.status === 'success' : true);
              tools.push({
                name: e.name || 'tool',
                label: e.label || e.name || '',
                detail: e.detail || '',
                ok,
                secs: e.ms ? +(e.ms / 1000).toFixed(2) : (e.secs || 0),
                preview: e.preview || e.output || '',
                path: e.path || '',
                at: e.ts || '',
              });
            }
          } catch {}
        }
      } catch {}
    }
  }

  // Format message history (last N user/assistant messages)
  const messageHistory = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
      hasImages: Array.isArray(m.images) && m.images.length > 0,
    }));

  // Ledger summary
  const ledgerItems = Array.isArray(ledgerData.items) ? ledgerData.items : [];
  const ledger = {
    open: ledgerItems.filter((i) => !i.done).length,
    done: ledgerItems.filter((i) => i.done).length,
    total: ledgerItems.length,
    items: ledgerItems.slice(0, 10),
  };

  return {
    conversation: selected,
    messages: messageHistory.slice(-options.messageLimit || -10),
    tools: tools.slice(-options.toolLimit || -20),
    ledger,
  };
}

function formatConversationList(list, { color = true } = {}) {
  if (!Array.isArray(list) || !list.length) return color ? '\x1b[2mNo conversations found.\x1b[0m' : 'No conversations found.';
  const activeList = list.filter((c) => c.status === 'running');
  const pastList = list.filter((c) => c.status !== 'running');

  const lines = [];

  if (activeList.length > 0) {
    lines.push(color ? '\x1b[1;32m⚡ ACTIVE SESSIONS (RUNNING)\x1b[0m' : '⚡ ACTIVE SESSIONS (RUNNING)');
    lines.push(color ? '\x1b[2mID               STATUS     MODEL                   WORKDIR                  PHASE / LAST STEP\x1b[0m'
                     : 'ID               STATUS     MODEL                   WORKDIR                  PHASE / LAST STEP');
    lines.push(color ? '\x1b[2m───────────────────────────────────────────────────────────────────────────────────────────────────\x1b[0m'
                     : '---------------------------------------------------------------------------------------------------');
    for (const c of activeList) {
      const idShort = c.id.length > 15 ? c.id.slice(0, 15) : c.id.padEnd(15);
      const statusStr = (color ? '\x1b[32m🟢 running\x1b[0m' : 'running').padEnd(color ? 19 : 10);
      const modelShort = (c.model ? shortenPath(c.model, 22) : '-').padEnd(23);
      const workdirShort = (c.workdir ? shortenPath(path.basename(c.workdir), 22) : '-').padEnd(24);
      const phaseInfo = c.phase ? (color ? `\x1b[33m⚡ ${c.phase}\x1b[0m` : `⚡ ${c.phase}`) : c.title;
      lines.push(`${idShort}  ${statusStr} ${modelShort} ${workdirShort} ${phaseInfo}`);
      if (c.lastStep) {
        lines.push(`                 ↳ ${color ? '\x1b[36m' : ''}${c.lastStep}${color ? '\x1b[0m' : ''}`);
      }
    }
    lines.push('');
  }

  lines.push(color ? '\x1b[1mRecent Conversations\x1b[0m' : 'Recent Conversations');
  lines.push(color ? '\x1b[2mID               STATUS        MODEL                   WORKDIR                  TITLE\x1b[0m'
                   : 'ID               STATUS        MODEL                   WORKDIR                  TITLE');
  lines.push(color ? '\x1b[2m───────────────────────────────────────────────────────────────────────────────────────────────────\x1b[0m'
                   : '---------------------------------------------------------------------------------------------------');

  for (const c of pastList.slice(0, 15)) {
    const statusDot = c.status === 'interrupted' ? (color ? '\x1b[31m🔴 stopped\x1b[0m' : 'stopped')
      : (color ? '\x1b[2m⚪ idle\x1b[0m   ' : 'idle   ');

    const idShort = c.id.length > 15 ? c.id.slice(0, 15) : c.id.padEnd(15);
    const modelShort = (c.model ? shortenPath(c.model, 22) : '-').padEnd(23);
    const workdirShort = (c.workdir ? shortenPath(path.basename(c.workdir), 22) : '-').padEnd(24);

    lines.push(`${idShort}  ${statusDot}  ${modelShort} ${workdirShort} ${c.title}`);
  }

  return lines.join('\n');
}

function formatConversationInspection(inspection, { color = true } = {}) {
  if (inspection.error) return color ? `\x1b[31m${inspection.error}\x1b[0m` : inspection.error;

  const c = inspection.conversation;
  const isRun = c.status === 'running';
  const statusStr = isRun
    ? (color ? `\x1b[32m🟢 LIVE (${c.pid ? `PID ${c.pid}` : 'active'}, ${fmtDur(c.secs * 1000)})\x1b[0m` : `LIVE (PID ${c.pid || 'active'})`)
    : c.status === 'interrupted'
      ? (color ? '\x1b[31m🔴 INTERRUPTED\x1b[0m' : 'INTERRUPTED')
      : (color ? '\x1b[2m⚪ IDLE\x1b[0m' : 'IDLE');

  const lines = [
    color ? `\x1b[1mConversation: ${c.id}\x1b[0m  ·  ${statusStr}` : `Conversation: ${c.id}  ·  ${statusStr}`,
    `Title:   ${c.title}`,
    `Workdir: ${c.workdir || '-'}`,
    `Model:   ${c.model || '-'}`,
    `Tokens:  ${c.tokensIn || 0} in / ${c.tokensOut || 0} out  ·  ${c.count || 0} message(s)  ·  ${inspection.tools.length} tool call(s)`,
  ];

  if (isRun) {
    lines.push('');
    lines.push(color ? `\x1b[33m⚡ Active Phase: ${c.phase || 'Working'}\x1b[0m` : `⚡ Active Phase: ${c.phase || 'Working'}`);
    if (c.lastStep) lines.push(`   Last Step:    ${c.lastStep}`);
  }

  if (inspection.messages && inspection.messages.length) {
    lines.push('');
    lines.push(color ? '\x1b[1mRecent Messages:\x1b[0m' : 'Recent Messages:');
    for (const m of inspection.messages.slice(-4)) {
      const roleLabel = m.role === 'user' ? (color ? '\x1b[36m👤 User:\x1b[0m' : 'User:') : (color ? '\x1b[32m🤖 Assistant:\x1b[0m' : 'Assistant:');
      const text = String(m.content || '').replace(/\s+/g, ' ').trim();
      lines.push(`  ${roleLabel} ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);
    }
  }

  if (inspection.tools && inspection.tools.length) {
    lines.push('');
    lines.push(color ? '\x1b[1mRecent Tool Actions:\x1b[0m' : 'Recent Tool Actions:');
    for (const t of inspection.tools.slice(-8)) {
      const okMark = t.ok ? (color ? '\x1b[32m✓\x1b[0m' : '✓') : (color ? '\x1b[31m✗\x1b[0m' : '✗');
      const dur = t.secs ? ` (${t.secs}s)` : '';
      const preview = t.preview ? ` => ${String(t.preview).replace(/\s+/g, ' ').slice(0, 80)}` : '';
      lines.push(`  ${okMark} ${t.label || t.name}${dur}${preview}`);
    }
  }

  if (inspection.ledger && inspection.ledger.total > 0) {
    lines.push('');
    lines.push(color ? `\x1b[1mTask Ledger:\x1b[0m ${inspection.ledger.done}/${inspection.ledger.total} done (${inspection.ledger.open} open)`
                     : `Task Ledger: ${inspection.ledger.done}/${inspection.ledger.total} done (${inspection.ledger.open} open)`);
    for (const item of inspection.ledger.items) {
      const box = item.done ? '[x]' : '[ ]';
      lines.push(`  ${box} ${item.text || item.title || item.name || 'task item'}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  defaultStateDir,
  conversationFilePath,
  listConversations,
  inspectConversation,
  formatConversationList,
  formatConversationInspection,
};
