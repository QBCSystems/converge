'use strict';

const crypto = require('crypto');

/**
 * Capability Versioning & Cryptographic Hashing Module.
 *
 * Computes deterministic SHA-256 fingerprint hashes over capability specs and definitions.
 */
function computeCapabilityHash({ name, version, code, spec = {}, gate = null }) {
  const payload = JSON.stringify({
    name: String(name || '').trim(),
    version: String(version || '1.0.0').trim(),
    code: String(code || ''),
    spec: spec && typeof spec === 'object' ? spec : {},
    gate: gate || null
  });

  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = {
  computeCapabilityHash
};

