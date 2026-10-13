// The models agents can run on, asked of the providers themselves (not a list kept here): the universal agent's own
// providers.cjs lists each provider's models live (an API's /models, a CLI's own catalog), and its pricing table and
// capability checks say what each costs and can do. The same code the agents run, so the picker never offers what
// the agent cannot use. Used by the platform (API providers and the container's CLIs) and by the Mac helper (the
// Mac's CLIs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { missingUniversalAgent } from '../../agents/common.mjs';
import { readAsql } from './provider-store.mjs';

const TTL = 10 * 60_000;
const cache = new Map(); // provider|host -> { at, data }

function kit(ua) {
  if (!ua) return null;
  const req = createRequire(ua);
  const dir = path.dirname(ua);
  let providers = null, pricing = null;
  try { providers = req(path.join(dir, 'providers.cjs')); } catch { /* none */ }
  try { pricing = req(path.join(dir, 'pricing.cjs')); } catch { /* none */ }
  return providers ? { providers, pricing } : null;
}
export const readAgentConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.converge', 'config.json'), 'utf8')); } catch { return {}; } };

/** One provider's models: [{ id, price: { in, out, cached } per 1M | null, free, estimated, effort, vision }], live. */
export async function modelsOf(ua, provider, { host = '', fresh = false, include = [] } = {}) {
  const k = kit(ua);
  if (!k) throw Object.assign(new Error(`nothing to ask: ${missingUniversalAgent()}`), { status: 503 });
  let c;
  try { c = await readAsql(); } catch { c = readAgentConfig(); }
  const h = host || c.providers?.[provider]?.host || (c.models || []).find((m) => m.provider === provider && m.host)?.host || '';
  const key = c.apiKeys?.[provider] || (c.accounts || []).find((a) => a.provider === provider && (a.apiKey || a.key))?.apiKey || '';
  const ck = `${provider}|${h}|${include.join(',')}`;
  const hit = cache.get(ck);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.data;
  const r = await k.providers.listModels(provider, h, key);
  if (!r?.ok) throw Object.assign(new Error(`${provider} did not list its models: ${r?.error || 'no answer'}`), { status: 502 });
  const vision = new Set(r.visionModels || []);
  const listed = new Set((c.models || []).filter((m) => m.provider === provider).map((m) => m.model));
  const models = [...new Set([...include, ...(r.models || [])])].map((id) => {
    const rate = k.pricing?.rateFor ? k.pricing.rateFor(provider, id) : null;
    const info = r.info?.[id] || {};
    return {
      id, listed: listed.has(id) || include.includes(id), default: include.includes(id),
      price: rate && !rate.unknown ? { in: rate.rate.in, out: rate.rate.out, cached: rate.rate.cacheIn ?? null } : null,
      free: Boolean(rate?.rate?.free), estimated: Boolean(rate?.estimated),
      effort: Boolean(k.providers.effortSupported?.(provider, id)),
      vision: vision.has(id) || Boolean(k.providers.visionSupported?.(provider, id) && !/-cli$/.test(provider)),
      thinking: Boolean(info.thinking), context: info.context || info.contextWindow || null,
    };
  });
  // The models in the agent config's own list first (the owner's picks), then the rest by name.
  models.sort((a, b) => Number(b.listed) - Number(a.listed) || a.id.localeCompare(b.id));
  const data = { provider, host: h, models, effortLevels: (k.providers.EFFORT_LEVELS || []).filter((l) => l !== 'off'), at: Date.now() };
  cache.set(ck, { at: data.at, data });
  return data;
}
