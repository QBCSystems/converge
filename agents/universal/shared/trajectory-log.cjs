/**
 * shared/trajectory-log.cjs - Append-Only Trajectory Auditor & Offline Replay
 *
 * Records deterministic trajectory entries (state hashes, tool calls, context diffs,
 * prompt updates) for full auditability and offline replay capabilities inspired by DSH.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class TrajectoryLogger {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    if (filePath && fs.existsSync(filePath)) {
      this._loadExisting();
    }
  }

  _loadExisting() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      this.entries = lines.map(line => JSON.parse(line));
    } catch (e) {
      this.entries = [];
    }
  }

  /**
   * Append a new trajectory step record.
   */
  append(type, payload = {}) {
    const prevHash = this.entries.length > 0
      ? this.entries[this.entries.length - 1].hash
      : '0000000000000000000000000000000000000000000000000000000000000000';

    const timestamp = Date.now();
    const stepIndex = this.entries.length;

    const dataToHash = JSON.stringify({ stepIndex, prevHash, type, payload, timestamp });
    const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');

    const entry = {
      stepIndex,
      timestamp,
      type,
      payload,
      prevHash,
      hash
    };

    this.entries.push(entry);

    if (this.filePath) {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    }

    return entry;
  }

  /**
   * Verify integrity of the recorded trajectory log.
   */
  verifyIntegrity() {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const expectedPrev = i === 0
        ? '0000000000000000000000000000000000000000000000000000000000000000'
        : this.entries[i - 1].hash;

      if (entry.prevHash !== expectedPrev) {
        return { valid: false, errorStep: i, reason: 'Previous hash mismatch' };
      }

      const dataToHash = JSON.stringify({
        stepIndex: entry.stepIndex,
        prevHash: entry.prevHash,
        type: entry.type,
        payload: entry.payload,
        timestamp: entry.timestamp
      });
      const calcHash = crypto.createHash('sha256').update(dataToHash).digest('hex');

      if (calcHash !== entry.hash) {
        return { valid: false, errorStep: i, reason: 'Entry hash mismatch' };
      }
    }
    return { valid: true, totalSteps: this.entries.length };
  }

  /**
   * Filter trajectory steps by type.
   */
  getStepsByType(type) {
    return this.entries.filter(e => e.type === type);
  }
}

module.exports = {
  TrajectoryLogger
};
