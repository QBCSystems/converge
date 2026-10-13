'use strict';

/**
 * shared/trajectory-replay.cjs - Deterministic Offline Trajectory Replayer
 *
 * Replays append-only SHA-256 trajectory audit logs offline without invoking live LLM APIs.
 * Re-verifies cryptographic integrity of steps, gate checks, and tool results.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TrajectoryLogger } = require('./trajectory-log.cjs');

function findTrajectoryFile(taskIdOrPath, workdir = process.cwd()) {
  const target = String(taskIdOrPath || '').trim();

  // If directly a file path that exists
  if (fs.existsSync(target)) {
    return target;
  }

  // Candidate paths
  const candidates = [
    path.join(workdir, '.converge', 'trajectory', `${target}.jsonl`),
    path.join(workdir, '.agent', 'trajectory', `${target}.jsonl`),
    path.join(workdir, '.agent', 'trajectory.jsonl'),
    path.join(os.homedir(), '.converge', 'trajectory', `${target}.jsonl`),
    path.join(os.homedir(), '.converge', 'trajectory', 'latest.jsonl')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  return null;
}

function replayTrajectory(taskIdOrPath, opts = {}) {
  const filePath = findTrajectoryFile(taskIdOrPath, opts.workdir || process.cwd());
  if (!filePath) {
    return {
      success: false,
      error: `Trajectory log not found for "${taskIdOrPath}". Checked local .converge/trajectory/ and ~/.converge/trajectory/.`
    };
  }

  const logger = new TrajectoryLogger(filePath);
  const integrity = logger.verifyIntegrity();

  const toolSteps = logger.getStepsByType('tool_call') || [];
  const gateSteps = logger.getStepsByType('gate_check') || [];
  const checkpointSteps = logger.getStepsByType('checkpoint') || [];

  let gatePassed = 0;
  let gateFailed = 0;

  for (const g of gateSteps) {
    if (g.payload && (g.payload.passed || g.payload.ok)) {
      gatePassed++;
    } else {
      gateFailed++;
    }
  }

  return {
    success: integrity.valid,
    filePath,
    integrity,
    summary: {
      totalSteps: logger.entries.length,
      toolCallsCount: toolSteps.length,
      gateChecksCount: gateSteps.length,
      gatePassed,
      gateFailed,
      checkpointsCount: checkpointSteps.length
    },
    entries: logger.entries
  };
}

function formatReplayReport(replayResult, opts = {}) {
  if (opts.json) {
    return JSON.stringify(replayResult, null, 2);
  }

  if (!replayResult.success && replayResult.error) {
    return `\x1b[38;5;203m[REPLAY ERROR]\x1b[0m ${replayResult.error}`;
  }

  const { filePath, integrity, summary } = replayResult;
  const lines = [];

  lines.push(`\x1b[1m\x1b[38;5;44mDeterministic Trajectory Replay Report\x1b[0m`);
  lines.push(`\x1b[2mSource:\x1b[0m ${filePath}`);
  lines.push(`\x1b[2mSHA-256 Integrity Chain:\x1b[0m ${integrity.valid ? '\x1b[38;5;42mVERIFIED (Clean Chain)\x1b[0m' : '\x1b[38;5;203mCORRUPTED\x1b[0m'}`);
  lines.push('');
  lines.push(`\x1b[1mStep Breakdown:\x1b[0m`);
  lines.push(`  • Total Trajectory Steps: ${summary.totalSteps}`);
  lines.push(`  • Tool Executions:        ${summary.toolCallsCount}`);
  lines.push(`  • Gate Validations:       ${summary.gateChecksCount} (${summary.gatePassed} passed, ${summary.gateFailed} failed)`);
  lines.push(`  • Checkpoints Recorded:   ${summary.checkpointsCount}`);

  if (!integrity.valid) {
    lines.push(`\n\x1b[38;5;203mIntegrity Failure Details:\x1b[0m Error at step ${integrity.errorStep}: ${integrity.reason}`);
  }

  return lines.join('\n');
}

module.exports = {
  findTrajectoryFile,
  replayTrajectory,
  formatReplayReport
};
