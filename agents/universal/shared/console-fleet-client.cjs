'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// console-fleet-client.cjs — the smallest CJS-callable client the executive
// loop needs to reach the EXISTING console fleet mission route
// (POST/GET /api/fleet/mission). This is deliberately NOT a second
// scheduler: selector resolution, fanout, durable persistence, reconciliation
// and quorum all stay in console/fleet/*.mjs exactly as they already work for
// the GUI and the MCP server. This module only knows how to call that route.
//
// Reuses the same CONVERGE_CONSOLE_URL/CONVERGE_CONSOLE_SESSION configuration and
// the same fetch/cookie/401/403 handling the MCP server's
// consoleConfig()/consoleJson() already use, so a process that already works
// as an MCP server (or already has those two env vars set for any other
// reason) works here with zero extra configuration.

function consoleConfig() {
  let base = process.env.CONVERGE_CONSOLE_URL || '';
  let cookie = process.env.CONVERGE_CONSOLE_SESSION || '';

  // Normal CLI usage stores console auth in ~/.converge/config.json via
  // the `login` command. Environment variables remain the explicit override for
  // services/CI, but the Executive must work from the same persisted login
  // state as the rest of the CLI instead of requiring duplicate setup.
  if (!base || !cookie) {
    const configFile = process.env.CONVERGE_CONFIG
      ? path.resolve(process.env.CONVERGE_CONFIG.replace(/^~(?=$|\/|\\)/, os.homedir()))
      : path.join(os.homedir(), '.converge', 'config.json');
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (!base) base = cfg?.console?.url || '';
      if (!cookie) cookie = cfg?.console?.session || '';
    } catch { /* absent/malformed config is handled by the caller */ }
  }

  return {
    base: String(base).replace(/\/+$/, ''),
    cookie: String(cookie),
  };
}

async function consoleJson(path, { method = 'GET', body } = {}) {
  const { base, cookie } = consoleConfig();
  if (!base || !cookie) throw new Error('Fleet not configured: set CONVERGE_CONSOLE_URL and CONVERGE_CONSOLE_SESSION.');
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Cannot reach the console fleet API (transport): ${e.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Console session expired/unauthorized — refresh CONVERGE_CONSOLE_SESSION (sign in to the console again).');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // status/body ride along on the thrown Error (not swallowed into a plain
    // message string) so a caller can tell a structured, actionable response
    // — e.g. POST /api/fleet/mission's 409 {needConfirm:true, targeted, perms}
    // — apart from an opaque failure. launchFleetMission below is the first
    // caller that needs this; a generic launch/transport error still reads
    // fine as just e.message everywhere else.
    const err = new Error((data && data.error) || `Console fleet API returned HTTP ${res.status}.`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Launch a fleet mission through the EXISTING console route. `opts.goal` is
// the missionGoal to dispatch; everything else maps onto the route's own
// body fields (server.mjs POST /api/fleet/mission) — build/readonly become
// policy.mode/policy.perms (what the route actually reads) and are ALSO sent
// top-level per the spec's schema; objectiveId/executiveCycle ride top-level
// so the objective status tool (which reads top-level first) can group every
// child fleet mission dispatched by this executive objective.
async function launchFleetMission(opts) {
  const o = opts || {};
  const concurrency = Number(o.concurrency) > 0 ? Number(o.concurrency) : 5;
  const body = {
    goal: String(o.goal || ''),
    selector: String(o.selector || ''),
    policy: {
      mode: o.build ? 'build' : 'investigate',
      perms: o.readonly ? 'readonly' : 'full',
      concurrency,
    },
    build: !!o.build,
    readonly: !!o.readonly,
    confirm: !!o.confirm,
    ...(o.objectiveId ? { objectiveId: String(o.objectiveId) } : {}),
    ...(o.executiveCycle !== undefined && o.executiveCycle !== null ? { executiveCycle: o.executiveCycle } : {}),
    ...(Array.isArray(o.executiveAllowedModels) && o.executiveAllowedModels.length ? { executiveAllowedModels: o.executiveAllowedModels.map((x) => String(x || '').trim()).filter(Boolean) } : {}),
    ...(o.provider ? { provider: { name: String(o.provider), ...(o.model ? { model: String(o.model) } : {}), ...(o.effort ? { effort: String(o.effort) } : {}) } } : {}),
  };
  return consoleJson('/api/fleet/mission', { method: 'POST', body });
}

async function getFleetMission(id) {
  if (!id) throw new Error('getFleetMission requires a mission id');
  return consoleJson(`/api/fleet/mission?id=${encodeURIComponent(id)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll the EXISTING console mission-status route to durable terminal
// settlement. Deliberately not the MCP tool's own ~25s response cap — that
// is a transport ceiling on one request/response pair, not the executive's
// mission horizon (a fleet mission can legitimately run far longer).
// `mission.status` is 'running' until the coordinator reconciles/settles it
// (console/fleet/coordinator.mjs); anything else is terminal.
async function pollFleetMissionUntilSettled(id, opts) {
  const o = opts || {};
  const intervalMs = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : 3000;
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 0; // 0 = no timeout
  const startedAt = Date.now();
  for (;;) {
    const data = await getFleetMission(id);
    const status = data && data.mission && data.mission.status;
    if (status && status !== 'running') return data;
    if (timeoutMs && (Date.now() - startedAt) >= timeoutMs) {
      throw new Error(`Fleet mission ${id} did not settle within ${timeoutMs}ms (last status: ${status || 'unknown'})`);
    }
    await sleep(intervalMs);
  }
}

module.exports = { launchFleetMission, getFleetMission, pollFleetMissionUntilSettled, consoleConfig };
