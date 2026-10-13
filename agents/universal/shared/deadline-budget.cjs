// deadline-budget.cjs — can a multi-stage mission afford another stage, or must
// it stop and deliver? Pure, and pinned by tests, because this bug escaped twice:
// runMission never read the clock, and raising wrapupLeadMs 45s→150s changed
// nothing (that lead steers the active stage child, which wraps up and returns,
// and the mission loop starts the next stage anyway). Asking a model to wrap up
// is a request; refusing to start work that cannot finish is a decision.
'use strict';

const RESERVE_MIN_MS = 90000;
const RESERVE_MAX_MS = 240000;
const RESERVE_FRACTION = 0.20;

function wrapReserveMs(totalBudgetMs) {
  const b = Number(totalBudgetMs);
  if (!Number.isFinite(b) || b <= 0) return 0;
  return Math.min(RESERVE_MAX_MS, Math.max(RESERVE_MIN_MS, Math.round(b * RESERVE_FRACTION)));
}

// Median, not mean: one retry-heavy stage must not scare the estimator off every
// remaining stage.
function predictStageMs(durations, fallbackMs) {
  const ds = (Array.isArray(durations) ? durations : []).filter((d) => Number.isFinite(d) && d > 0);
  const fallback = Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : 300000;
  if (!ds.length) return fallback;
  const sorted = [...ds].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 1.25);
}

// isFirstStage never truncates, and that is load-bearing: on a short deadline the
// no-history estimate exceeds the whole budget, so a naive check would refuse to
// start and guarantee a mission that produced nothing.
function shouldTruncateStages({ msLeft, durations = [], totalBudgetMs = 0, stageTimeoutMs = 300000, isFirstStage = false, reserveMs } = {}) {
  const reserve = Number.isFinite(reserveMs) ? reserveMs : wrapReserveMs(totalBudgetMs);
  const predictMs = predictStageMs(durations, stageTimeoutMs);
  const needMs = predictMs + reserve;
  const base = { truncate: false, predictMs, needMs, reserveMs: reserve };
  if (!Number.isFinite(msLeft)) return { ...base, reason: 'no deadline' };
  if (isFirstStage) return { ...base, reason: 'first stage always runs' };
  if (msLeft >= needMs) return { ...base, reason: 'budget sufficient' };
  return {
    ...base, truncate: true,
    reason: `${Math.max(0, Math.round(msLeft / 1000))}s left, needs ~${Math.round(predictMs / 1000)}s for the stage plus ${Math.round(reserve / 1000)}s to deliver`,
  };
}

// Can a wrap-up phase still run? A verification that does not run must be
// REPORTED as not run, never silently assumed.
function stageBudget(msLeft, needMs) {
  if (!Number.isFinite(msLeft)) return { afford: true, shortBy: 0 };
  const need = Number(needMs) || 0;
  return { afford: msLeft >= need, shortBy: Math.max(0, need - msLeft) };
}

// 0/null/absent = no wall-clock kill. Was inexpressible: every call site read
// `Number(x) || DEFAULT`, so asking for none silently restored the default.
const noDeadline = (ms) => !(Number(ms) > 0);

// Unlimited still has to SETTLE, so it engages an inactivity backstop instead.
// Kill what is STALLED, never what is merely slow.
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;
const QUEUE_TTL_FALLBACK_MS = 15 * 60 * 1000;
const HARD_KILL_MARGIN_MIN_MS = 60 * 1000;
const HARD_KILL_MARGIN_MAX_MS = 3 * 60 * 1000;

// Strictly shorter than the kill timer. It used to be identical, so the self-wrap
// and the axe fired at the same instant and any skew killed it mid-delivery.
function selfWrapBudgetMs(nodeDeadlineMs) {
  if (noDeadline(nodeDeadlineMs)) return 0;
  const margin = Math.min(HARD_KILL_MARGIN_MAX_MS, Math.max(HARD_KILL_MARGIN_MIN_MS, Math.round(nodeDeadlineMs * 0.1)));
  return Math.max(30 * 1000, nodeDeadlineMs - margin);
}

// Human-readable duration: 950ms, 1.50s, 1m 30s, 1h 0m. Seconds keep two decimals
// (1500 -> 1.50s). A negative duration formats its absolute value with a leading '-'
// (-950 -> -950ms, -95000 -> -1m 35s).
function formatMs(ms) {
  const raw = Number(ms);
  if (!Number.isFinite(raw)) return '';
  const sign = raw < 0 ? '-' : '';
  const n = Math.abs(raw);
  // Each range is picked after rounding to its own unit, so a value just under the next unit reads as that unit:
  // 999.6 is 1.00s (not 1000ms), 59,999 is 1m 0s (not 60.00s), 3,599,999 is 1h 0m (not 60m 0s).
  if (Math.round(n) < 1000) return `${sign}${Math.round(n)}ms`;
  if (Math.round(n / 10) < 6000) return `${sign}${(n / 1000).toFixed(2)}s`;
  const totalSec = Math.round(n / 1000);
  if (totalSec < 3600 && Math.round(n / 60000) < 60) return `${sign}${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
  const totalMin = Math.round(n / 60000);
  return `${sign}${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

module.exports = {
  wrapReserveMs, predictStageMs, shouldTruncateStages, stageBudget, formatMs,
  RESERVE_MIN_MS, RESERVE_MAX_MS, RESERVE_FRACTION,
  noDeadline, selfWrapBudgetMs, DEFAULT_IDLE_TIMEOUT_MS, IDLE_SWEEP_MS,
  QUEUE_TTL_FALLBACK_MS, HARD_KILL_MARGIN_MIN_MS, HARD_KILL_MARGIN_MAX_MS,
};
