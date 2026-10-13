'use strict';

/**
 * Tool Concurrency Contract module.
 *
 * Implements explicit tool concurrency classification ('safe' vs 'exclusive')
 * and an async ToolConcurrencyManager that enforces safe concurrent tool executions
 * while queueing/locking exclusive (stateful/mutating) operations.
 */

const SAFE_TOOLS = new Set([
  'read_file',
  'fetch_url',
  'web_search',
  'code_search',
  'list_dir',
  'validate',
  'gate_check',
  'ask',
  'probe',
  'fleet_list',
  'inspect',
  'timeline',
  'task_list',
  'task_status'
]);

const EXCLUSIVE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'exec',
  'run_command',
  'fleet_update',
  'subtask',
  'apply_changes',
  'update_task',
  'delete_file'
]);

/**
 * Resolves tool concurrency mode ('safe' or 'exclusive').
 *
 * @param {string} toolName Name of the tool
 * @param {'safe'|'exclusive'} [explicitMode] Explicitly declared concurrency mode
 * @returns {'safe'|'exclusive'} Resolved mode (defaults to 'exclusive' on unrecognized)
 */
function getToolConcurrencyMode(toolName, explicitMode) {
  if (explicitMode === 'safe' || explicitMode === 'exclusive') {
    return explicitMode;
  }
  const name = String(toolName || '').toLowerCase();
  if (SAFE_TOOLS.has(name)) {
    return 'safe';
  }
  if (EXCLUSIVE_TOOLS.has(name)) {
    return 'exclusive';
  }

  // Prefix matching heuristics for custom tool extensions
  if (
    name.startsWith('read_') ||
    name.startsWith('get_') ||
    name.startsWith('check_') ||
    name.startsWith('inspect_') ||
    name.startsWith('list_') ||
    name.startsWith('search_') ||
    name.startsWith('validate_') ||
    name.startsWith('probe_')
  ) {
    return 'safe';
  }

  // Default invariant: un-declared or unclassified tools default to exclusive
  return 'exclusive';
}

/**
 * Determines whether two tools can execute concurrently.
 *
 * @param {string} tool1
 * @param {string} tool2
 * @param {Object} [modesMap] Optional map of explicit tool modes
 * @returns {boolean} True if both are safe, false if either is exclusive
 */
function canToolsRunConcurrently(tool1, tool2, modesMap = {}) {
  const mode1 = getToolConcurrencyMode(tool1, modesMap[tool1]);
  const mode2 = getToolConcurrencyMode(tool2, modesMap[tool2]);
  return mode1 === 'safe' && mode2 === 'safe';
}

class ToolConcurrencyManager {
  constructor() {
    this.activeLocks = new Map();
    this.queue = [];
    this.lockSeq = 0;
  }

  /**
   * Acquire execution lock for a tool.
   *
   * @param {string} toolName
   * @param {'safe'|'exclusive'} [explicitMode]
   * @returns {Promise<{ lockId: string, mode: 'safe'|'exclusive', release: Function }>}
   */
  async acquire(toolName, explicitMode) {
    const mode = getToolConcurrencyMode(toolName, explicitMode);

    return new Promise((resolve) => {
      const item = { toolName, mode, resolve };
      this.queue.push(item);
      this._drainQueue();
    });
  }

  /**
   * Release an acquired lock.
   *
   * @param {string} lockId
   */
  release(lockId) {
    if (this.activeLocks.has(lockId)) {
      this.activeLocks.delete(lockId);
      this._drainQueue();
    }
  }

  _drainQueue() {
    if (this.queue.length === 0) return;

    let activeExclusiveCount = 0;
    let activeSafeCount = 0;

    for (const lock of this.activeLocks.values()) {
      if (lock.mode === 'exclusive') activeExclusiveCount++;
      if (lock.mode === 'safe') activeSafeCount++;
    }

    // Process items in queue
    while (this.queue.length > 0) {
      const next = this.queue[0];

      if (next.mode === 'safe') {
        // Safe tool can run if no exclusive lock is active
        if (activeExclusiveCount > 0) {
          break;
        }
        this.queue.shift();
        const lockId = `lock-${++this.lockSeq}-${Date.now()}`;
        const lockHandle = {
          lockId,
          toolName: next.toolName,
          mode: 'safe',
          release: () => this.release(lockId)
        };
        this.activeLocks.set(lockId, lockHandle);
        activeSafeCount++;
        next.resolve(lockHandle);
      } else {
        // Exclusive tool requires ZERO active locks of any kind
        if (activeExclusiveCount > 0 || activeSafeCount > 0) {
          break;
        }
        this.queue.shift();
        const lockId = `lock-${++this.lockSeq}-${Date.now()}`;
        const lockHandle = {
          lockId,
          toolName: next.toolName,
          mode: 'exclusive',
          release: () => this.release(lockId)
        };
        this.activeLocks.set(lockId, lockHandle);
        activeExclusiveCount++;
        next.resolve(lockHandle);
        // An exclusive lock blocks all subsequent queue items
        break;
      }
    }
  }
}

const globalConcurrencyManager = new ToolConcurrencyManager();

module.exports = {
  SAFE_TOOLS,
  EXCLUSIVE_TOOLS,
  getToolConcurrencyMode,
  canToolsRunConcurrently,
  ToolConcurrencyManager,
  globalConcurrencyManager
};
