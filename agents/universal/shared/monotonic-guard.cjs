'use strict';
const { authorityWideningGuard } = require('./trust-taint.cjs');
/**
 * shared/monotonic-guard.cjs
 *
 * Monotonic Tool Guard Pipeline.
 * Invariant: Any guard in the pipeline can DENY or RESTRICT/NARROW permissions.
 * No guard downstream can ever elevate or widen authority previously denied or restricted.
 */

function createMonotonicGuardPipeline(initialGuards = []) {
  const guards = [authorityWideningGuard, ...initialGuards];

  function registerGuard(guard) {
    if (typeof guard !== 'function' && typeof guard?.evaluate !== 'function') {
      throw new Error('Guard must be a function or an object with an evaluate method');
    }
    guards.push(guard);
  }

  function evaluate(req) {
    const { tool, args, descriptor, permissionFloor } = req || {};
    let activeFloor = permissionFloor || descriptor?.permissionFloor || 'X'; // R (read-only), S (standard), X (execute)

    // Permission floor guard: if R (read-only), block mutating operations
    const MUTATING_TOOLS = new Set([
      'write_file', 'edit_file', 'replace_file', 'run_command', 'bash',
      'spawn_task', 'fleet_exec', 'git_commit', 'git_push'
    ]);

    if (activeFloor === 'R' && MUTATING_TOOLS.has(tool)) {
      return {
        allowed: false,
        action: 'deny',
        guard: 'PermissionFloorGuard',
        reason: `Tool '${tool}' rejected by read-only permission floor ('R')`
      };
    }

    let accumulatedRestrictions = {};

    for (const g of guards) {
      const fn = typeof g === 'function' ? g : g.evaluate.bind(g);
      const res = fn(req);
      if (!res) continue;

      if (res.action === 'deny' || res.allowed === false) {
        return {
          allowed: false,
          action: 'deny',
          guard: res.guard || g.name || 'Guard',
          reason: res.reason || `Execution denied by ${res.guard || g.name || 'guard'}`
        };
      }

      if (res.action === 'restrict' || res.restrictions) {
        const r = res.restrictions || {};
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === 'boolean') {
            accumulatedRestrictions[k] = accumulatedRestrictions[k] === false ? false : v;
          } else if (typeof v === 'number') {
            accumulatedRestrictions[k] = accumulatedRestrictions[k] !== undefined
              ? Math.min(accumulatedRestrictions[k], v)
              : v;
          } else if (Array.isArray(v)) {
            if (accumulatedRestrictions[k] === undefined) {
              accumulatedRestrictions[k] = [...v];
            } else {
              const setV = new Set(v);
              accumulatedRestrictions[k] = accumulatedRestrictions[k].filter(x => setV.has(x));
            }
          }
        }
      }
    }

    return {
      allowed: true,
      action: Object.keys(accumulatedRestrictions).length > 0 ? 'restrict' : 'allow',
      restrictions: accumulatedRestrictions
    };
  }

  return {
    registerGuard,
    evaluate,
    guards
  };
}

const globalPipeline = createMonotonicGuardPipeline();

function registerMonotonicGuard(guard) {
  globalPipeline.registerGuard(guard);
}

function evaluateMonotonicGuards(req) {
  return globalPipeline.evaluate(req);
}

module.exports = {
  createMonotonicGuardPipeline,
  registerMonotonicGuard,
  evaluateMonotonicGuards,
  globalPipeline
};
