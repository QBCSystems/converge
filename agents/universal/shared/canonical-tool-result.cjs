'use strict';

/**
 * Creates a Canonical Tool Result v2 object.
 * Execution produces a lossless JSON value, validates it against declared output schema,
 * and allows deriving model, UI, and durable projections.
 *
 * @param {Object} params
 * @param {string} params.tool Name of the tool executed
 * @param {Object} [params.args] Lossless arguments passed to the tool
 * @param {'success'|'error'|'rejected'} [params.status='success'] Result status
 * @param {Object|any} [params.result] Lossless structured JSON execution result
 * @param {string|null} [params.error] Error message if failed
 * @param {Object} [params.meta] Execution metadata (duration_ms, machine, etc.)
 * @returns {Readonly<Object>} Immutable CanonicalToolResult v2 object
 */
function createCanonicalResult({ tool, args = {}, status = 'success', result = {}, error = null, meta = {} }) {
  const normStatus = status === 'error' || error ? 'error' : status === 'rejected' ? 'rejected' : 'success';
  return Object.freeze({
    version: 'v2',
    tool: String(tool || 'unknown_tool'),
    timestamp: Date.now(),
    status: normStatus,
    args: args && typeof args === 'object' ? Object.freeze({ ...args }) : args,
    result: result && typeof result === 'object' ? Object.freeze({ ...result }) : result,
    error: error ? String(error) : null,
    meta: meta && typeof meta === 'object' ? Object.freeze({ ...meta }) : {},
  });
}

function isCanonicalResult(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.version === 'v2' && typeof obj.tool === 'string');
}

const { projectUniversal } = require('./tool-result-projections.cjs');

/**
 * Derives model-visible text content from a Canonical Tool Result.
 *
 * @param {Object} canonical CanonicalToolResult object
 * @param {Function} [customProjection] Tool-defined model projection function
 * @returns {string} Model-visible text
 */
function projectModel(canonical, customProjection) {
  if (!isCanonicalResult(canonical)) {
    return String(canonical || '');
  }
  if (typeof customProjection === 'function') {
    try {
      const proj = customProjection(canonical.result, canonical.args, canonical);
      if (proj !== undefined && proj !== null) return String(proj);
    } catch {
      /* fall through to default */
    }
  }

  if (canonical.status === 'error') {
    const errText = canonical.error || (typeof canonical.result === 'string' ? canonical.result : JSON.stringify(canonical.result));
    return `TOOL ERROR: ${errText}`;
  }

  const res = canonical.result;
  if (res == null) return '';

  const universal = projectUniversal(res, canonical.args || {});
  if (universal !== undefined && universal !== null) return universal;

  if (typeof res === 'string') return res;
  if (typeof res.text === 'string') return res.text;
  if (typeof res.output === 'string') return res.output;

  return JSON.stringify(res, null, 2);
}

/**
 * Derives replay-safe UI presentation metadata from a Canonical Tool Result.
 *
 * @param {Object} canonical CanonicalToolResult object
 * @param {Function} [customProjection] Tool-defined UI projection function
 * @returns {Object} Replay-safe UI metadata ({ title, status, preview, pending, completed, diff, details })
 */
function projectUI(canonical, customProjection) {
  if (!isCanonicalResult(canonical)) {
    const text = String(canonical || '');
    return Object.freeze({
      title: 'Tool Result',
      status: 'completed',
      preview: text.length > 200 ? text.slice(0, 197) + '...' : text,
      pending: 'Running...',
      completed: 'Completed',
      diff: null,
      details: canonical,
    });
  }

  if (typeof customProjection === 'function') {
    try {
      const custom = customProjection(canonical.result, canonical.args, canonical);
      if (custom && typeof custom === 'object') {
        const text = projectModel(canonical);
        return Object.freeze({
          title: custom.title || canonical.tool,
          status: canonical.status,
          preview: custom.preview || (text.length > 200 ? text.slice(0, 197) + '...' : text),
          pending: custom.pending || `Running ${canonical.tool}...`,
          completed: custom.completed || (canonical.status === 'success' ? `Completed ${canonical.tool}` : `Failed ${canonical.tool}`),
          diff: custom.diff || null,
          details: custom.details !== undefined ? custom.details : canonical.result,
        });
      }
    } catch {
      /* fall through to default */
    }
  }

  const text = projectModel(canonical);
  const preview = text.length > 200 ? text.slice(0, 197) + '...' : text;
  const res = canonical.result || {};

  return Object.freeze({
    title: canonical.tool,
    status: canonical.status,
    preview,
    pending: `Running ${canonical.tool}...`,
    completed: canonical.status === 'success' ? `Completed ${canonical.tool}` : `Failed ${canonical.tool}`,
    diff: res.diff || null,
    details: canonical.result,
  });
}

/**
 * Derives lossless durable representation for event logs & mission transcripts.
 *
 * @param {Object} canonical CanonicalToolResult object
 * @param {Function} [customProjection] Tool-defined durable projection function
 * @returns {Object} Lossless durable event record
 */
function projectDurable(canonical, customProjection) {
  if (!isCanonicalResult(canonical)) {
    return Object.freeze({ tool: 'unknown', status: 'completed', raw: canonical });
  }
  if (typeof customProjection === 'function') {
    try {
      const custom = customProjection(canonical.result, canonical.args, canonical);
      if (custom !== undefined && custom !== null) {
        return typeof custom === 'object' ? Object.freeze({ ...custom }) : custom;
      }
    } catch {
      /* fall through to default */
    }
  }

  return Object.freeze({
    version: canonical.version,
    tool: canonical.tool,
    timestamp: canonical.timestamp,
    status: canonical.status,
    args: canonical.args,
    result: canonical.result,
    error: canonical.error,
    meta: canonical.meta,
  });
}

/**
 * Validates a canonical result against an optional output JSON Schema.
 *
 * @param {Object} canonical CanonicalToolResult object
 * @param {Object} [outputSchema] Expected output JSON schema
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateCanonicalResult(canonical, outputSchema) {
  if (!isCanonicalResult(canonical)) {
    return { valid: false, errors: ['Not a valid CanonicalToolResult v2 object'] };
  }
  if (!outputSchema || typeof outputSchema !== 'object') {
    return { valid: true, errors: [] };
  }

  const errors = [];
  const res = canonical.result;

  if (outputSchema.type === 'object' && (res === null || typeof res !== 'object' || Array.isArray(res))) {
    errors.push(`Expected output object, got ${res === null ? 'null' : Array.isArray(res) ? 'array' : typeof res}`);
  } else if (outputSchema.type === 'array' && !Array.isArray(res)) {
    errors.push(`Expected output array, got ${typeof res}`);
  } else if (outputSchema.type === 'string' && typeof res !== 'string') {
    errors.push(`Expected output string, got ${typeof res}`);
  }

  if (outputSchema.required && Array.isArray(outputSchema.required) && typeof res === 'object' && res !== null) {
    for (const reqField of outputSchema.required) {
      if (res[reqField] === undefined) {
        errors.push(`Missing required output field: "${reqField}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  createCanonicalResult,
  isCanonicalResult,
  projectModel,
  projectUI,
  projectDurable,
  validateCanonicalResult,
};
