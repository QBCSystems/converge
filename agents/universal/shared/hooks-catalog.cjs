'use strict';
// Hook event catalog — shared by the harness (runHook) and the GUI Setup
// surface so the UI never invents event names the agent won't fire.

const HOOK_EVENTS = [
  { name: 'onStart', env: [], help: 'Start of every chat/mission turn. Cwd = workdir.' },
  { name: 'postEdit', env: ['CONVERGE_HOOK_FILE'], help: 'After write_file or edit_file succeeds. CONVERGE_HOOK_FILE is the relative path.' },
  { name: 'postTool', env: ['CONVERGE_HOOK_TOOL', 'CONVERGE_HOOK_OK'], help: 'After any tool returns. CONVERGE_HOOK_TOOL = name, CONVERGE_HOOK_OK = 1|0.' },
  { name: 'onDone', env: ['CONVERGE_HOOK_FILES'], help: 'End of a turn. CONVERGE_HOOK_FILES = comma-separated relative paths changed.' },
  { name: 'onFail', env: ['CONVERGE_HOOK_REASON'], help: 'Turn ended blocked/failed. CONVERGE_HOOK_REASON is a short explanation.' },
  { name: 'onSubtaskDone', env: ['CONVERGE_HOOK_TASK', 'CONVERGE_HOOK_OK'], help: 'A parallel/sequential subtask finished. CONVERGE_HOOK_TASK is the prompt.' },
];

const HOOK_NAMES = HOOK_EVENTS.map((e) => e.name);

function sanitizeHooks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const name of HOOK_NAMES) {
    const v = raw[name];
    if (typeof v === 'string' && v.trim()) out[name] = v.trim();
  }
  return out;
}

module.exports = { HOOK_EVENTS, HOOK_NAMES, sanitizeHooks };
