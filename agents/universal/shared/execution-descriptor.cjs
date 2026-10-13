'use strict';

const os = require('os');

/**
 * Creates and freezes an ExecutionDescriptor.
 * Resolves provider/model/host/credentials/permissions/machine identity exactly once into an immutable contract.
 *
 * @param {Object} opts Call or mission options (provider, model, host, apiKey, perms, etc.)
 * @param {Object} [env] Environment map (defaults to process.env)
 * @param {Object} [config] Loaded configuration (defaults to {})
 * @returns {Readonly<Object>} Immutable ExecutionDescriptor
 */
function resolveExecutionDescriptor(opts = {}, env = process.env, config = {}) {
  // If opts is already a valid frozen ExecutionDescriptor, return it directly
  if (isExecutionDescriptor(opts)) {
    return opts;
  }

  const requested = {
    provider: opts.provider || null,
    model: opts.model || null,
    host: opts.host || opts.baseUrl || opts.apiHost || null,
    apiKey: opts.apiKey || null,
    perms: opts.perms || opts.permsMode || null,
    workflow: opts.workflow || null,
  };

  // 1. Resolve Provider
  let provider = requested.provider;
  let providerSource = 'explicit';
  let providerReason = 'Explicitly requested in call options';

  if (!provider) {
    if (env.EDIT_PROVIDER || env.CONVERGE_PROVIDER || env.MODEL_PROVIDER) {
      provider = env.EDIT_PROVIDER || env.CONVERGE_PROVIDER || env.MODEL_PROVIDER;
      providerSource = 'env';
      providerReason = 'Resolved from environment variable';
    } else if (config.provider || config.EDIT_PROVIDER) {
      provider = config.provider || config.EDIT_PROVIDER;
      providerSource = 'config';
      providerReason = 'Resolved from user/project configuration';
    } else {
      provider = 'ollama';
      providerSource = 'default';
      providerReason = 'Default harness provider fallback';
    }
  }

  if (provider) {
    const pLower = String(provider).toLowerCase().trim();
    if (pLower === 'antigravity' || pLower === 'agy') provider = 'antigravity-cli';
    else if (pLower === 'codex') provider = 'codex-cli';
    else if (pLower === 'cursor') provider = 'cursor-cli';
    else if (pLower === 'spark') provider = 'qwen';
  }

  // 2. Resolve Model
  let model = requested.model;
  let modelSource = 'explicit';
  let modelReason = 'Explicitly requested in call options';

  if (!model) {
    if (env.EDIT_MODEL || env.CONVERGE_MODEL || env.MODEL_NAME) {
      model = env.EDIT_MODEL || env.CONVERGE_MODEL || env.MODEL_NAME;
      modelSource = 'env';
      modelReason = 'Resolved from environment variable';
    } else if (config.model || config.EDIT_MODEL) {
      model = config.model || config.EDIT_MODEL;
      modelSource = 'config';
      modelReason = 'Resolved from user/project configuration';
    } else {
      const defaults = {
        'ollama': 'gemma4:31b',
        'anthropic': 'claude-sonnet-5-5',
        'claude': 'claude-sonnet-5-5',
        'openai': 'gpt-4o',
        'gemini': 'gemini-2.5-flash',
        'nebius': 'nvidia/llama-3.1-nemotron-70b-instruct',
        // A subscription CLI picks its own default model (its account's): none is passed. A pinned name here sent
        // Claude Code an outdated claude-3-7-sonnet on every run where no model was picked.
        'claude-cli': '',
        'codex-cli': '',
        'cursor-cli': '',
        'gemini-cli': '',
        'antigravity-cli': '',
        'qwen': 'spark',
        'spark': 'spark',
      };
      model = provider in defaults ? defaults[provider] : 'gemma4:31b';
      modelSource = 'provider_default';
      modelReason = `Default model for provider "${provider}"`;
    }
  }

  // 3. Resolve Host / BaseURL
  let host = requested.host;
  let hostSource = 'explicit';

  if (!host) {
    const defaultHosts = {
      'ollama': 'http://127.0.0.1:11434',
      'anthropic': 'https://api.anthropic.com',
      'claude': 'https://api.anthropic.com',
      'openai': 'https://api.openai.com',
      'gemini': 'https://generativelanguage.googleapis.com',
      'nebius': 'https://api.studio.nebius.ai/v1',
      'claude-cli': 'https://api.anthropic.com',
      'codex-cli': 'https://api.openai.com',
      'cursor-cli': 'https://api.cursor.com',
      'gemini-cli': 'https://generativelanguage.googleapis.com',
      'antigravity-cli': 'https://generativelanguage.googleapis.com',
      'qwen': 'http://127.0.0.1:8000',
      'spark': 'http://127.0.0.1:8000',
    };

    if ((provider === 'anthropic' || provider === 'claude') && env.ANTHROPIC_BASE_URL) {
      host = env.ANTHROPIC_BASE_URL;
      hostSource = 'env:ANTHROPIC_BASE_URL';
    } else if (provider === 'openai' && env.OPENAI_BASE_URL) {
      host = env.OPENAI_BASE_URL;
      hostSource = 'env:OPENAI_BASE_URL';
    } else if (provider === 'nebius' && (env.NEBIUS_BASE_URL || env.NEBIUS_API_HOST)) {
      host = env.NEBIUS_BASE_URL || env.NEBIUS_API_HOST;
      hostSource = 'env:NEBIUS_BASE_URL';
    } else if (provider === 'ollama' && env.OLLAMA_HOST) {
      host = env.OLLAMA_HOST;
      hostSource = 'env:OLLAMA_HOST';
    } else if (env.EDIT_PROVIDER && env.EDIT_PROVIDER === provider && (env.EDIT_API_HOST || env.CONVERGE_API_HOST)) {
      host = env.EDIT_API_HOST || env.CONVERGE_API_HOST;
      hostSource = 'env';
    } else if ((!config.provider || config.provider === provider) && (config.host || config.baseUrl || config.EDIT_API_HOST)) {
      host = config.host || config.baseUrl || config.EDIT_API_HOST;
      hostSource = 'config';
    } else if (defaultHosts[provider]) {
      host = defaultHosts[provider];
      hostSource = 'provider_default';
    } else if (!env.EDIT_PROVIDER || env.EDIT_PROVIDER === provider) {
      if (env.EDIT_API_HOST || env.CONVERGE_API_HOST) {
        host = env.EDIT_API_HOST || env.CONVERGE_API_HOST;
        hostSource = 'env';
      } else {
        host = '';
        hostSource = 'none';
      }
    } else {
      host = '';
      hostSource = 'none';
    }
  }

  // 4. Resolve Credentials (API key)
  let apiKey = requested.apiKey;
  let credentialsSource = 'explicit';

  if (!apiKey) {
    if ((!env.EDIT_PROVIDER || env.EDIT_PROVIDER === provider) && (env.EDIT_API_KEY || env.CONVERGE_API_KEY)) {
      apiKey = env.EDIT_API_KEY || env.CONVERGE_API_KEY;
      credentialsSource = 'env:CONVERGE_API_KEY';
    } else if ((provider === 'anthropic' || provider === 'claude') && env.ANTHROPIC_API_KEY) {
      apiKey = env.ANTHROPIC_API_KEY;
      credentialsSource = 'env:ANTHROPIC_API_KEY';
    } else if (provider === 'openai' && env.OPENAI_API_KEY) {
      apiKey = env.OPENAI_API_KEY;
      credentialsSource = 'env:OPENAI_API_KEY';
    } else if (provider === 'nebius' && (env.NEBIUS_API_KEY || env.NEBIUS_TOKEN)) {
      apiKey = env.NEBIUS_API_KEY || env.NEBIUS_TOKEN;
      credentialsSource = 'env:NEBIUS_API_KEY';
    } else if (provider === 'gemini' && env.GEMINI_API_KEY) {
      apiKey = env.GEMINI_API_KEY;
      credentialsSource = 'env:GEMINI_API_KEY';
    } else if (config.apiKeys && (provider in config.apiKeys)) {
      apiKey = config.apiKeys[provider] || '';
      credentialsSource = config.apiKeys[provider] ? 'config' : 'none';
    } else if (config.provider === provider && config.apiKey && (!config.apiKeys || !Object.keys(config.apiKeys).length)) {
      apiKey = config.apiKey;
      credentialsSource = 'config';
    } else {
      apiKey = '';
      credentialsSource = 'none';
    }
  }

  // 5. Resolve Permissions Floor / Mode
  let perms = requested.perms;
  if (!perms) {
    perms = env.CONVERGE_PERMS || config.permissions || config.perms || 'full';
  }

  // Machine identity metadata
  const machine = {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
  };

  const descriptor = {
    __isExecutionDescriptor: true,
    resolvedAt: new Date().toISOString(),
    requested: Object.freeze(requested),
    effective: Object.freeze({
      provider,
      model,
      host,
      apiKey: apiKey ? '***' : '', // masked key for inspect/logs
      realApiKey: apiKey,          // actual key used for execution
      credentialsSource,
      perms,
      source: Object.freeze({
        provider: providerSource,
        model: modelSource,
        host: hostSource,
      }),
      reason: Object.freeze({
        provider: providerReason,
        model: modelReason,
      }),
    }),
    machine: Object.freeze(machine),
  };

  return Object.freeze(descriptor);
}

function isExecutionDescriptor(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.__isExecutionDescriptor === true);
}

function toSummary(descriptor) {
  if (!isExecutionDescriptor(descriptor)) return 'Invalid ExecutionDescriptor';
  const { provider, model, host, credentialsSource, perms } = descriptor.effective;
  return `ExecutionDescriptor[provider=${provider}, model=${model}, host=${host || 'default'}, key=${credentialsSource}, perms=${perms}]`;
}

// Named for callers that just want the harness-wide default literals (e.g.
// universal-agent.cjs's own flag/env/config `setting()` resolver, which has
// its own precedence chain and only needs a final fallback value) without
// building a full descriptor. Must match the 'ollama' branch of the
// per-provider tables above exactly — these ARE that table's zero-argument
// case, not a second, independently-maintained default.
const DEFAULT_PROVIDER = 'ollama';
const DEFAULT_MODEL = 'gemma4:31b';

module.exports = {
  resolveExecutionDescriptor,
  isExecutionDescriptor,
  toSummary,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
};
