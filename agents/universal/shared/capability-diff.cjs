'use strict';

/**
 * shared/capability-diff.cjs - Model Capability Fingerprinting & Matrix Diff Engine
 *
 * Compares two AI provider/model specifications side-by-side:
 * capabilities (native tool calling, JSON schema, grammar, inner tools, vision),
 * pricing rates, default host, and cryptographic capability package hashes.
 */

const { resolveExecutionDescriptor } = require('./execution-descriptor.cjs');
// The engine (providers/pricing/mcp-remote…) was extracted to the standalone
// in this layout,
// an installed/flattened layout still has it as a sibling of shared/. Try both
// rather than assuming either. Returns null when neither is present.
const requireEngine = (mod) => {
  for (const rel of ['../' + mod]) {
    try { return require(require('path').resolve(__dirname, rel)); } catch (e) {
      if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  return null;
};
const providers = requireEngine('providers.cjs');
const pricing = requireEngine('pricing.cjs');
const { computeCapabilityHash } = require('./capability-versioner.cjs');

function parseSpec(specString, defaultProvider = 'ollama', defaultModel = 'gemma4:31b') {
  const str = String(specString || '').trim();
  if (!str) return { provider: defaultProvider, model: defaultModel };

  if (str.includes('/')) {
    const parts = str.split('/');
    const provider = parts[0].trim();
    const model = parts.slice(1).join('/').trim();
    return { provider, model: model || defaultModel };
  }

  // If no slash, check if it looks like a known provider or a model
  const knownProviders = ['ollama', 'anthropic', 'openai', 'gemini', 'claude', 'claude-cli', 'codex-cli', 'cursor-cli', 'gemini-cli', 'antigravity-cli', 'fireworks', 'vllm', 'llamacpp', 'raw'];
  if (knownProviders.includes(str.toLowerCase())) {
    return { provider: str.toLowerCase(), model: null };
  }

  return { provider: defaultProvider, model: str };
}

function getSpecProfile(specString) {
  const parsed = parseSpec(specString);
  const desc = resolveExecutionDescriptor({ provider: parsed.provider, model: parsed.model });
  const eff = desc.effective;

  const caps = providers.getCapabilities ? providers.getCapabilities(eff.provider) : {};
  const rate = pricing.rateFor ? pricing.rateFor(`${eff.provider}/${eff.model}`) : { in: 0, out: 0, free: false };

  const capabilityHash = computeCapabilityHash({
    name: `${eff.provider}/${eff.model}`,
    version: '1.0.0',
    code: JSON.stringify(caps),
    spec: { host: eff.host, rate }
  });

  return {
    ref: `${eff.provider}/${eff.model}`,
    provider: eff.provider,
    model: eff.model,
    host: eff.host,
    capabilities: caps,
    rate,
    capabilityHash
  };
}

function diffCapabilities(specA, specB) {
  const profileA = getSpecProfile(specA);
  const profileB = getSpecProfile(specB);

  const keys = [
    { key: 'provider', label: 'Provider' },
    { key: 'model', label: 'Model' },
    { key: 'host', label: 'Default Host' },
    { key: 'nativeTools', label: 'Native Tool Calling', isCap: true },
    { key: 'jsonSchema', label: 'JSON Schema Mode', isCap: true },
    { key: 'grammar', label: 'Grammar Constraints', isCap: true },
    { key: 'guidedJson', label: 'Guided JSON Decoding', isCap: true },
    { key: 'jsonMode', label: 'JSON Mode', isCap: true },
    { key: 'innerTools', label: 'Inner Tool Loop (CLI)', isCap: true },
    { key: 'delegatedTools', label: 'Delegated Tool Loop', isCap: true },
    { key: 'askMode', label: 'Conversational Ask Mode', isCap: true },
    { key: 'rateIn', label: 'Input Cost ($ / 1M tokens)', custom: (p) => `$${(p.rate.in || 0).toFixed(2)}` },
    { key: 'rateOut', label: 'Output Cost ($ / 1M tokens)', custom: (p) => `$${(p.rate.out || 0).toFixed(2)}` },
    { key: 'capabilityHash', label: 'Capability Fingerprint (SHA-256)', custom: (p) => p.capabilityHash.slice(0, 16) + '...' }
  ];

  const diffs = keys.map(({ key, label, isCap, custom }) => {
    let valA, valB;
    if (custom) {
      valA = custom(profileA);
      valB = custom(profileB);
    } else if (isCap) {
      valA = !!profileA.capabilities[key];
      valB = !!profileB.capabilities[key];
    } else {
      valA = profileA[key] ?? false;
      valB = profileB[key] ?? false;
    }

    const match = valA === valB;
    return { key, label, valA, valB, match };
  });

  return {
    specA: profileA,
    specB: profileB,
    timestamp: new Date().toISOString(),
    diffs
  };
}

function formatCapabilityDiff(diffResult, opts = {}) {
  if (opts.json) {
    return JSON.stringify(diffResult, null, 2);
  }

  const { specA, specB, diffs } = diffResult;

  const lines = [];
  lines.push(`\x1b[1m\x1b[38;5;44mModel Capability & Matrix Diff\x1b[0m`);
  lines.push(`\x1b[2mComparing [A] ${specA.ref} vs [B] ${specB.ref}\x1b[0m\n`);

  const col1 = 30;
  const col2 = 32;
  const col3 = 32;

  lines.push(`┌${'─'.repeat(col1)}┬${'─'.repeat(col2)}┬${'─'.repeat(col3)}┐`);
  lines.push(
    `│ \x1b[1m${'Feature / Capability'.padEnd(col1 - 2)}\x1b[0m │ \x1b[1m\x1b[38;5;214m${('[A] ' + specA.ref).slice(0, col2 - 2).padEnd(col2 - 2)}\x1b[0m │ \x1b[1m\x1b[38;5;213m${('[B] ' + specB.ref).slice(0, col3 - 2).padEnd(col3 - 2)}\x1b[0m │`
  );
  lines.push(`├${'─'.repeat(col1)}┼${'─'.repeat(col2)}┼${'─'.repeat(col3)}┤`);

  for (const d of diffs) {
    const formatVal = (val) => {
      if (typeof val === 'boolean') {
        return val ? '\x1b[38;5;42m✔ Yes\x1b[0m' : '\x1b[38;5;244m✘ No\x1b[0m';
      }
      return String(val);
    };

    const strA = formatVal(d.valA);
    const strB = formatVal(d.valB);

    // Calculate padding ignoring ANSI codes
    const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');
    const padAnsi = (str, width) => str + ' '.repeat(Math.max(0, width - stripAnsi(str).length));

    const marker = d.match ? '' : ' \x1b[38;5;203m≠\x1b[0m';
    const labelFormatted = padAnsi((d.label + marker), col1 - 2);
    const cellA = padAnsi(strA, col2 - 2);
    const cellB = padAnsi(strB, col3 - 2);

    lines.push(`│ ${labelFormatted} │ ${cellA} │ ${cellB} │`);
  }

  lines.push(`└${'─'.repeat(col1)}┴${'─'.repeat(col2)}┴${'─'.repeat(col3)}┘`);

  return lines.join('\n');
}

module.exports = {
  parseSpec,
  getSpecProfile,
  diffCapabilities,
  formatCapabilityDiff,
  formatCapabilityDiffTable: formatCapabilityDiff
};
