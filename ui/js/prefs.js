const KEY = "agents";
const DEFAULT_AGENTS = 3;

export function rememberAgents(storage, n) {
  storage.setItem(KEY, String(n));
}

export function recallAgents(storage) {
  const raw = storage.getItem(KEY);
  const v = raw === null ? NaN : Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_AGENTS;
}