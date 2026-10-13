'use strict';
// Model pricing — USD per 1,000,000 tokens (input / output), so a usage report
// can show REAL dollars, not just token counts. Zero-dep, pure data + lookup.

const fs = require('fs');
const os = require('os');
const path = require('path');

// User-editable pricing overrides, persisted as JSON. Anything written here
// wins over the built-in tables below (and over PROVIDER_FALLBACK/UNKNOWN_RATE
// for a provider key 'provider:<name>'), so a model can be priced — or a stale
// figure corrected — without touching code. Both console and gui maintain this
// file; the CLI engine reads it on every rateFor() call, so edits apply
// immediately with no restart. Key shapes:
//   'provider/model'        -> overrides/extends that model's EXACT entry
//   'provider:<name>'       -> overrides that provider's fallback (or UNKNOWN_RATE
//                              if the provider has no fallback yet — how a brand
//                              new provider gets priced without a code change)
const PRICING_FILE = process.env.CONVERGE_PRICING_FILE || path.join(os.homedir(), '.converge', 'pricing-overrides.json');
//
// Sources: Fireworks serverless pricing (docs.fireworks.ai/serverless/pricing),
// Anthropic + OpenAI public pricing. Figures are point-in-time — update here
// when a provider changes them (one file, one place). Ollama Cloud is free.
//
// costOf() returns { usd, estimated } — `estimated:true` means the exact model
// wasn't in the table and a provider/size tier was used, so the UI can flag it
// rather than imply a precise bill.

// Exact per-model rates, keyed by the "provider/model" ref the registry uses.
const EXACT = {
  // Fireworks serverless (input / output per 1M)
  'fireworks/accounts/fireworks/models/gpt-oss-120b': { in: 0.15, out: 0.60 },
  'fireworks/accounts/fireworks/models/deepseek-v4-pro': { in: 1.74, out: 3.48 },
  // Cloudflare Workers AI through its OpenAI-compatible endpoint (the try-it free path): its published prices.
  'openai-compat/@cf/openai/gpt-oss-120b': { in: 0.35, out: 0.75 },
  'openai-compat/@cf/zai-org/glm-5.3-flash': { in: 0.15, out: 0.50, cacheIn: 0.03 },
  'openai-compat/@cf/deepseek-ai/deepseek-v4-flash-0731': { in: 0.44, out: 1.32, cacheIn: 0.014 },
  'openai-compat/@cf/moonshotai/kimi-k2.7-code': { in: 0.95, out: 4.00, cacheIn: 0.19 },
  'fireworks/accounts/fireworks/models/glm-5p2': { in: 1.40, out: 4.40 },
  'fireworks/accounts/fireworks/models/glm-5p1': { in: 1.40, out: 4.40 }, // not separately listed; matches the glm-5 tier
  'fireworks/accounts/fireworks/models/kimi-k2p6': { in: 0.95, out: 4.00, cacheIn: 0.19 },
  'fireworks/accounts/fireworks/models/kimi-k2p7-code': { in: 0.95, out: 4.00, cacheIn: 0.19 },
  // Standard tier (docs.fireworks.ai/serverless/pricing); Priority tier runs
  // 1.5x these. Without this entry it fell to the generic Fireworks fallback
  // ($0.90/$0.90 below) — overpriced input ~3x and underpriced output ~2x
  // versus MiniMax M3's real, individually-priced rate (confirmed 2026-08-17).
  'fireworks/accounts/fireworks/models/minimax-m3': { in: 0.30, out: 1.20, cacheIn: 0.06 },

  // DeepSeek direct (api.deepseek.com). Two models: deepseek-v4-flash and deepseek-v4-pro.
  // Both support non-thinking and thinking (default) modes.
  'deepseek/deepseek-v4-flash': { in: 0.22, out: 0.66, cacheIn: 0.007 },
  'deepseek/deepseek-v4-pro': { in: 0.66, out: 1.98, cacheIn: 0.022 },

  // Anthropic (for when a Claude chat account is added)
  'anthropic/claude-opus-4-8': { in: 15, out: 75 },
  'anthropic/claude-sonnet-5': { in: 3, out: 15 },
  'anthropic/claude-haiku-4-5-20251001': { in: 1, out: 5 },

  // OpenAI (common defaults; refine when used)
  'openai/gpt-5': { in: 1.25, out: 10 },
  'openai/gpt-4o': { in: 2.5, out: 10 },

  // OpenRouter (stealth models / free tier)
  'openrouter/stealth/ox-alpha': { in: 0, out: 0, free: true },
};

// Provider-level fallbacks when the exact model isn't listed. Ollama Cloud is
// free on every account. Fireworks' "over 16B" standard tier is the safe
// default for an unknown Fireworks text model.
const PROVIDER_FALLBACK = {
  ollama: { in: 0, out: 0, free: true },
  llamacpp: { in: 0, out: 0, free: true },
  vllm: { in: 0, out: 0, free: true },
  // claude-cli/cursor-cli shell out to the operator's own logged-in, already-
  // paid-for subscription CLI (gui/server.js: "needsKey: false ... Uses your
  // installed, logged-in `claude` CLI") — zero MARGINAL API cost per call.
  // These are KNOWN providers, not mystery ones, so they must not fall through
  // to UNKNOWN_RATE: that fail-closed path is for a genuinely unrecognized
  // provider that might secretly be metered, not a CLI we already know is a
  // flat-rate subscription. Getting this wrong priced a real turn's tokens at
  // Sonnet-class rates (4.0M in / 133k out billed ~$14) and, since routing
  // policies (balanced/cheapest/value) call rateFor() to decide free-vs-paid,
  // silently made these free CLIs lose to an actually-free ollama model in
  // exploration and cost-based routing.
  'claude-cli': { in: 0, out: 0, free: true },
  'cursor-cli': { in: 0, out: 0, free: true },
  'codex-cli': { in: 0, out: 0, free: true },
  'gemini-cli': { in: 0, out: 0, free: true },
  'antigravity-cli': { in: 0, out: 0, free: true },
  fireworks: { in: 0.90, out: 0.90 },   // Fireworks >16B standard tier
  anthropic: { in: 3, out: 15 },         // Sonnet-class as a neutral default
  openai: { in: 2.5, out: 10 },
  gemini: { in: 1.25, out: 10 },         // Pro-class neutral default; refine when used
  deepseek: { in: 0.22, out: 0.66, cacheIn: 0.007 },     // DeepSeek official default fallback (v4-flash)
  nebius: { in: 0.35, out: 0.80 },               // Nebius standard tier neutral fallback
  xai: { in: 3, out: 15 },               // Grok-class neutral default; refine when used
  openrouter: { in: 1, out: 3 },         // Neutral default; model pricing varies
};

// The router accepts provider spellings pricing must not treat as strangers.
const PROVIDER_ALIAS = { claude: 'anthropic', 'open-router': 'openrouter', 'openrouter.ai': 'openrouter', 'nebius.ai': 'nebius' };

// Unknown provider ⇒ fail CLOSED, never free. Two guardrails read a $0 rate
// as a green light — the registry's "a PAID model is never auto-explored"
// gate and the harness's free-by-default AI judge — so an unpriced provider
// (a new one, an openai-compat proxy, a CLI subscription) returning {0,0}
// silently voided both: real Claude/Gemini spend on paths documented as
// $0-only. A conservative paid-tier estimate keeps the math finite and the
// gates shut; `unknown:true` lets UIs say "unpriced" instead of a fake bill.
const UNKNOWN_RATE = { in: 3, out: 15 };

function getOverrides() {
  try {
    return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
  } catch {
    return {}; // missing/corrupt file = no overrides; built-ins stand
  }
}

const { atomicWrite } = require('./shared/utils.cjs');

// Persist a (partial or full) overrides object. Merged per-key so one UI
// editing a single row can never clobber another row/field it didn't send.
// Written atomically (tmp + rename); returns the merged store as persisted.
function saveOverrides(next) {
  const cur = getOverrides();
  const merged = { ...cur };
  for (const [k, v] of Object.entries(next || {})) {
    if (v === null || v === undefined) { delete merged[k]; continue; } // null = revert to built-in
    merged[k] = { ...(cur[k] || {}), ...v };
  }
  atomicWrite(PRICING_FILE, merged);
  return merged;
}

// The effective tables (built-ins + overrides merged) — what the UIs display.
function getMergedTables() {
  const ov = getOverrides();
  const exact = { ...EXACT };
  const fallback = { ...PROVIDER_FALLBACK };
  for (const [k, v] of Object.entries(ov)) {
    if (k === 'unknownRate') continue;
    if (k.startsWith('provider:')) {
      const p = k.slice('provider:'.length);
      fallback[p] = { ...(fallback[p] || {}), ...v };
    } else {
      exact[k] = { ...(exact[k] || {}), ...v };
    }
  }
  const unknownRate = { ...UNKNOWN_RATE, ...(ov.unknownRate || {}) };
  return { exact, fallback, unknownRate };
}

function rateFor(provider, model) {
  const p = PROVIDER_ALIAS[provider] || provider;
  const ov = getOverrides();
  // A Workers AI model named without its leading "@" (aios hands a mind no "@": the sandbox's agents use cf/...) is
  // the same model, at the same price.
  let ref = `${p}/${model}`;
  if (!ov[ref] && !EXACT[ref] && /^(cf|hf)\//.test(String(model))) ref = `${p}/@${model}`;
  const unknownRate = ov.unknownRate ? { ...UNKNOWN_RATE, ...ov.unknownRate } : UNKNOWN_RATE;
  if (ov[ref]) return { rate: { ...EXACT[ref], ...ov[ref] }, estimated: !EXACT[ref] };
  if (EXACT[ref]) return { rate: EXACT[ref], estimated: false };
  if (ov['provider:' + p]) return { rate: { ...unknownRate, ...ov['provider:' + p] }, estimated: true };
  const fb = PROVIDER_FALLBACK[p];
  if (fb) return { rate: fb, estimated: !fb.free }; // free is exact ($0), not an estimate
  return { rate: unknownRate, estimated: true, unknown: true };
}

// Dollars for a given token count on a given model. When cacheIn is set on the
// rate, cached prompt tokens (from stream usage.prompt_tokens_details) bill at
// the cheaper cached rate — Fireworks serverless does this for Kimi/GLM/etc.
function costOf(provider, model, tokensIn, tokensOut, cacheRead = 0) {
  const { rate, estimated, unknown } = rateFor(provider, model);
  const cr = Math.min(Math.max(0, Number(cacheRead) || 0), Number(tokensIn) || 0);
  const freshIn = Math.max(0, (Number(tokensIn) || 0) - cr);
  const inRate = rate.cacheIn != null ? rate.cacheIn : rate.in;
  const usd = (freshIn / 1e6) * rate.in + (cr / 1e6) * inRate + ((Number(tokensOut) || 0) / 1e6) * rate.out;
  return { usd, estimated, free: !!rate.free, ...(unknown ? { unknown: true } : {}) };
}

// Human $ formatting that never reads as "$0.00" for a real-but-tiny spend:
// shows more decimals for sub-cent amounts, so a $0.0004 turn is visible.
function fmtUsd(usd) {
  const n = Number(usd) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}

module.exports = { costOf, rateFor, fmtUsd, EXACT, PROVIDER_FALLBACK, UNKNOWN_RATE, getOverrides, saveOverrides, getMergedTables, PRICING_FILE };
