'use strict';

// Deterministic self-healing, fault reflexion, and auto-mitigation subsystem.
// Captures structured post-mortem receipts, clusters failure signatures,
// applies deterministic pre/post tool mitigations (stale locks, permissions),
// synthesizes regression fixtures, and promotes negative rules.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { atomicJson, appendJsonl, readJsonl, sha256: sha, readJson } = require('./utils.cjs');

let negativeLearning = null;
try { negativeLearning = require('./negative-learning.cjs'); } catch { /* optional */ }
let failureTaxonomy = null;
try { failureTaxonomy = require('./failure-taxonomy.cjs'); } catch { /* optional */ }
let regressionCorpus = null;
try { regressionCorpus = require('./regression-corpus.cjs'); } catch { /* optional */ }
let harnessReflexion = null;
try { harnessReflexion = require('./harness-reflexion.cjs'); } catch { /* optional */ }
let memory = null;
try { memory = require('./memory.cjs'); } catch { /* optional */ }

const VERSION = 1;

function sanitize(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 30).map((x) => sanitize(x, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 2000) : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = /key|token|secret|password|authorization|cookie/i.test(key) ? '[redacted]' : sanitize(item, depth + 1);
  }
  return out;
}

function environmentState(root) {
  return {
    cwd: path.resolve(root || process.cwd()),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    // Do not write the environment itself: it commonly contains credentials.
    configured: ['AGENT_VALIDATE', 'AGENT_WORKDIR', 'CONVERGE_REFLEXION_WORKDIR'].filter((name) => Boolean(process.env[name])),
  };
}

function paths(root) {
  const base = path.join(root || process.cwd(), '.converge', 'reflexion');
  return {
    dir: base,
    receipts: path.join(base, 'receipts.jsonl'),
    mitigations: path.join(base, 'mitigations.json'),
    audit: path.join(base, 'heal-audit.jsonl'),
  };
}

// Derive a normalized failure signature from an error, tool, or provider event.
function deriveSignature(fault) {
  const tool = String(fault.toolName || 'system').toLowerCase();
  const msg = String(fault.error?.message || fault.error || fault.output || '').toLowerCase();
  const code = String(fault.exitCode || fault.error?.code || '');

  if (/index\.lock|another git process is running/.test(msg)) return 'git:lock:index';
  if (/eacces|permission denied/.test(msg)) return 'fs:eacces:permission';
  if (/enoent|no such file or directory/.test(msg)) return 'fs:enoent:not-found';
  if (/eaddrinuse|address already in use/.test(msg)) return 'net:eaddrinuse:port';
  if (/econnreset|connection reset/.test(msg)) return 'net:econnreset';
  if (/etimedout|request timed out|command timed out/.test(msg)) return 'net:timeout';
  if (/stream drop|truncated json|malformed output|invalid json/i.test(msg)) return 'provider:stream-malformed';
  if (/exit status 128/i.test(msg) || (code === '128' && tool === 'run_command')) return 'git:exit-128';
  if (code === '124' || /timed out after \d+ms/.test(msg)) return 'tool:timeout';
  if (fault.toolName === 'harness_mission' || fault.kind === 'mission_halt' || /mission halted|mission failed|stage.*failed/i.test(msg)) return 'harness:mission:stage-failed';
  if (fault.toolName === 'gate_validate' || /gate did not pass|validation gate failed|gate check failed/i.test(msg)) return 'gate:validation:failed';
  if (/fatal crash|unhandled exception|uncaught exception|daemon disconnected/i.test(msg)) return 'harness:crash:fatal';

  const cleanMsg = msg.slice(0, 40).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  return `${tool}:${code || 'err'}:${cleanMsg}`;
}

// Classify the failure using standard taxonomy.
function classifyFault(root, fault) {
  const msg = String(fault.error?.message || fault.error || fault.output || '').toLowerCase();
  const sig = deriveSignature(fault);

  let failureClass = 'execution';
  let rootCause = 'unknown';
  let capability = 'tool-use';

  if (/gate|validat|test|assert/.test(msg) || sig.startsWith('gate:')) {
    failureClass = 'verification';
    capability = 'validation';
  } else if (/quota|timeout|network|econn|provider|50\d|stream drop/.test(msg)) {
    failureClass = 'infrastructure';
    capability = 'reasoning';
    rootCause = /timeout/.test(msg) ? 'resource-exhaustion' : 'unknown';
  } else if (sig.startsWith('harness:mission:')) {
    failureClass = 'verification';
    capability = 'planning';
    rootCause = 'stage-checkpoint-failed';
  }

  if (/permission|eacces|denied/.test(msg)) rootCause = 'permission-denied';
  else if (/index\.lock/.test(msg)) rootCause = 'resource-exhaustion';

  return {
    failureClass,
    rootCause,
    affectedRole: fault.role || 'worker',
    capability,
    recoveryThatWorked: fault.recovery || (fault.recovered ? 'retry' : 'none'),
    signature: sig,
  };
}

function ruleTemplate(signature) {
  if (signature === 'git:lock:index') return { id: 'clear-stale-git-index-lock', condition: 'git index lock failure is observed and the lock is stale', action: 'remove only the stale .git/index.lock, then retry the failed command' };
  if (signature === 'fs:eacces:permission') return { id: 'repair-local-executable-permission', condition: 'a workspace-local executable fails with permission denied', action: 'restore executable permission on the workspace-local target, then retry once' };
  if (signature === 'harness:mission:stage-failed') return { id: 'harness-mission-stage-recovery', condition: 'a multi-stage mission halted on an unpassed stage', action: 'review the failing stage validation output, apply localized correction, and resume the mission from the failed stage checkpoint' };
  if (signature === 'gate:validation:failed') return { id: 'harness-gate-verification-recovery', condition: 'validation gate did not pass after maximum turns', action: 're-evaluate gate test conditions against project files, check exit codes, and fix the failing assertions before resubmitting' };
  return null;
}

// Promotion is intentionally a proposal, not an executable rule.  The negative
// learning module requires three independent recovered runs plus validation and
// review before a rule can become active.
function synthesizeNegativeRule(root, receipt) {
  if (!negativeLearning || !receipt.recovered) return null;
  const template = ruleTemplate(receipt.signature);
  if (!template) return null;
  try {
    const candidate = negativeLearning.candidates(root).find((x) => x.eligible && x.signature.includes(receipt.classification.recoveryThatWorked));
    if (!candidate) return null;
    const proposal = negativeLearning.propose(root, { ...template, signature: candidate.signature, scope: 'workspace' }, 'self-healing');
    if (memory) memory.remember(root, `Self-healing proposed negative rule ${proposal.id}: ${template.condition}. ${template.action}. It is inactive until independent deterministic validation and review pass.`, { tags: ['self-healing', 'negative-learning'], mutable: true, source: 'self-healing' });
    return { id: proposal.id, status: proposal.status };
  } catch {
    // The proposal may already exist, or the evidence may have changed under a
    // parallel process. Neither changes the fault that was being recorded.
    return null;
  }
}

// Record a structured post-mortem reflexion receipt.
function recordReceipt(root, faultData, opts = {}) {
  const p = paths(root);
  const now = new Date(opts.now || Date.now()).toISOString();
  const classification = classifyFault(root, faultData);
  const signature = classification.signature;
  const id = `rcpt-${sha(now + signature + Math.random()).slice(0, 12)}`;

  const receipt = {
    version: VERSION,
    id,
    timestamp: now,
    signature,
    toolName: faultData.toolName || null,
    toolArgs: sanitize(faultData.toolArgs) || null,
    provider: faultData.provider || null,
    model: faultData.model || null,
    toolMode: faultData.mode || faultData.toolMode || null,
    workdir: path.resolve(root || process.cwd()),
    environment: environmentState(root),
    error: {
      message: String(faultData.error?.message || faultData.error || faultData.output || '').slice(0, 2000),
      code: faultData.exitCode || faultData.error?.code || null,
      stack: faultData.error?.stack ? String(faultData.error.stack).slice(0, 1000) : null,
    },
    classification,
    mitigationApplied: faultData.mitigationApplied || null,
    recovered: Boolean(faultData.recovered),
    suggestedAction: faultData.suggestedAction || null,
  };

  // If negative-learning module is available and recovery was observed, feed evidence
  if (negativeLearning && receipt.recovered) {
    try {
      negativeLearning.record(root, {
        runId: receipt.id,
        classification: {
          failureClass: classification.failureClass,
          rootCause: classification.rootCause,
          affectedRole: classification.affectedRole,
          capability: classification.capability,
          recoveryThatWorked: classification.recoveryThatWorked,
        },
        recovered: true,
        source: `reflexion:${signature}`,
      });
    } catch {
      // Best effort evidence recording
    }
  }
  receipt.negativeRuleProposal = synthesizeNegativeRule(root, receipt);

  try {
    appendJsonl(p.receipts, receipt);
    appendJsonl(p.audit, { at: now, action: 'record-receipt', id, signature, recovered: receipt.recovered });
  } catch {
    // Audit write failures must not crash caller
  }

  return { recorded: true, receipt };
}

// List historical reflexion receipts.
function listReceipts(root, opts = {}) {
  const p = paths(root);
  let list = readJsonl(p.receipts, opts.limit || 200);
  if (opts.signature) list = list.filter((r) => r.signature === opts.signature);
  if (opts.toolName) list = list.filter((r) => r.toolName === opts.toolName);
  if (opts.provider) list = list.filter((r) => r.provider === opts.provider);
  if (opts.recovered != null) list = list.filter((r) => r.recovered === opts.recovered);
  return list.reverse();
}

// Attempt immediate deterministic auto-mitigation for common environmental faults.
function handleToolFault(root, fault) {
  const workdir = path.resolve(root || process.cwd());
  const msg = String(fault.error?.message || fault.error || fault.output || '').toLowerCase();
  const sig = deriveSignature(fault);

  // 1. Git Index Lock Auto-Repair
  if (/index\.lock|another git process is running/.test(msg)) {
    const lockPath = path.join(workdir, '.git', 'index.lock');
    try {
      if (fs.existsSync(lockPath)) {
        const stat = fs.statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        // If the lock file is older than 2s or orphaned, remove it safely
        if (ageMs > 2000) {
          fs.unlinkSync(lockPath);
          const mitigation = `cleared stale .git/index.lock (age: ${Math.round(ageMs / 1000)}s)`;
          recordReceipt(root, { ...fault, mitigationApplied: mitigation, recovered: true, recovery: 'clear-git-lock' });
          return {
            mitigated: true,
            action: 'clear_git_lock',
            retryable: true,
            message: `Harness auto-mitigation: ${mitigation}`,
          };
        }
      }
    } catch { /* proceed if unlink fails */ }
  }

  // 2. Permission Denied on Local Executable Script
  if (/permission denied|eacces/.test(msg) && fault.toolName === 'run_command') {
    const cmd = String(fault.toolArgs?.CommandLine || fault.toolArgs?.command || '');
    const tokens = cmd.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (token.startsWith('./') || token.endsWith('.sh') || token.endsWith('.cjs') || token.endsWith('.js') || token.endsWith('.py')) {
        const abs = path.resolve(workdir, token);
        if (abs.startsWith(workdir) && fs.existsSync(abs)) {
          try {
            fs.chmodSync(abs, 0o755);
            const mitigation = `applied executable permission (0o755) to ${path.relative(workdir, abs)}`;
            recordReceipt(root, { ...fault, mitigationApplied: mitigation, recovered: true, recovery: 'chmod-executable' });
            return {
              mitigated: true,
              action: 'chmod_executable',
              retryable: true,
              message: `Harness auto-mitigation: ${mitigation}`,
            };
          } catch { /* ignore */ }
        }
      }
    }
  }

  // 3. Record the unrecovered fault for diagnostic aggregation
  recordReceipt(root, { ...fault, recovered: false });
  return { mitigated: false, retryable: false, signature: sig };
}

// Diagnose workspace and harness health.
function diagnose(root, opts = {}) {
  const workdir = path.resolve(root || process.cwd());
  const receipts = listReceipts(workdir, { limit: 100 });
  const issues = [];
  const mitigations = [];

  // Check 1: Stale Git Lock
  const gitLock = path.join(workdir, '.git', 'index.lock');
  if (fs.existsSync(gitLock)) {
    try {
      const stat = fs.statSync(gitLock);
      const ageSec = Math.round((Date.now() - stat.mtimeMs) / 1000);
      issues.push({
        severity: ageSec > 10 ? 'high' : 'medium',
        type: 'git_index_lock',
        message: `Stale .git/index.lock detected (${ageSec}s old). May block git operations.`,
        action: 'clean_git_lock',
      });
      mitigations.push({ id: 'clean_git_lock', label: 'Remove stale .git/index.lock' });
    } catch {}
  }

  // Check 2: Fault Clustering in recent receipts
  const signatureCounts = new Map();
  for (const r of receipts) {
    signatureCounts.set(r.signature, (signatureCounts.get(r.signature) || 0) + 1);
  }

  const topFaults = [...signatureCounts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count);

  if (topFaults.length && topFaults[0].count >= 3) {
    issues.push({
      severity: 'medium',
      type: 'recurring_fault',
      message: `Frequent failure signature detected: "${topFaults[0].signature}" (${topFaults[0].count} occurrences).`,
      topSignature: topFaults[0].signature,
    });
  }

  // Check 3: Negative Learning Proposals / Rules
  let activeRules = [];
  let candidateRules = [];
  let providerAdaptations = [];
  if (negativeLearning) {
    try {
      activeRules = negativeLearning.active(workdir);
      candidateRules = negativeLearning.candidates(workdir).filter((c) => c.eligible);
    } catch {}
  }
  if (harnessReflexion) {
    try { providerAdaptations = harnessReflexion.status(workdir).providers; } catch {}
  }

  // Check 4: Zombie / Orphaned tasks in .agent/tasks or .converge/tasks
  const taskDirs = [path.join(workdir, '.agent', 'tasks'), path.join(workdir, '.converge', 'tasks')];
  let zombieTasks = 0;
  for (const td of taskDirs) {
    if (fs.existsSync(td)) {
      try {
        const entries = fs.readdirSync(td);
        for (const f of entries) {
          if (f.endsWith('.json')) {
            try {
              const raw = fs.readFileSync(path.join(td, f), 'utf8');
              const taskObj = JSON.parse(raw);
              if (taskObj.status === 'running') {
                const mtime = fs.statSync(path.join(td, f)).mtimeMs;
                if (Date.now() - mtime > 60000) {
                  zombieTasks++;
                }
              }
            } catch {}
          }
        }
      } catch {}
    }
  }
  if (zombieTasks > 0) {
    issues.push({
      severity: 'medium',
      type: 'stale_running_tasks',
      message: `${zombieTasks} orphaned task(s) stuck in "running" state detected in task store.`,
      action: 'reconcile_tasks',
    });
    mitigations.push({ id: 'reconcile_tasks', label: 'Reconcile orphaned running task records' });
  }

  // Compute Health Score (0 - 100)
  let healthScore = 100;
  if (issues.some((i) => i.severity === 'high')) healthScore -= 30;
  if (issues.some((i) => i.severity === 'medium')) healthScore -= 15;
  const recentFailures = receipts.slice(0, 20).filter((r) => !r.recovered).length;
  healthScore = Math.max(10, healthScore - recentFailures * 3);

  return {
    version: VERSION,
    workdir,
    healthScore,
    status: healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'degraded' : 'critical',
    issues,
    mitigations,
    stats: {
      totalReceipts: receipts.length,
      recentFailures,
      topFaults: topFaults.slice(0, 5),
      activeRulesCount: activeRules.length,
      candidateRulesCount: candidateRules.length,
      providerAdaptationsCount: providerAdaptations.length,
      zombieTasks,
    },
    activeRules,
    candidateRules,
    providerAdaptations,
  };
}

// Perform automated healing and maintenance on the harness workspace.
function heal(root, opts = {}) {
  const workdir = path.resolve(root || process.cwd());
  const actionsTaken = [];
  const p = paths(workdir);

  // 1. Clean Stale Git Lock
  const gitLock = path.join(workdir, '.git', 'index.lock');
  if (fs.existsSync(gitLock)) {
    try {
      const ageMs = Date.now() - fs.statSync(gitLock).mtimeMs;
      const minAgeMs = Number(opts.minLockAgeMs == null ? 10000 : opts.minLockAgeMs);
      if (opts.force === true || ageMs >= minAgeMs) {
        fs.unlinkSync(gitLock);
        actionsTaken.push(`Removed stale .git/index.lock (${Math.round(ageMs / 1000)}s old)`);
      } else {
        actionsTaken.push(`Skipped active-looking .git/index.lock (${Math.max(0, Math.round(ageMs / 1000))}s old)`);
      }
    } catch (e) {
      actionsTaken.push(`Failed to remove .git/index.lock: ${e.message}`);
    }
  }

  // 2. Clean temporary gate files older than 1 hour in /tmp
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    let cleanedTmp = 0;
    for (const f of files) {
      if (/^converge-(gate|step)-.*\.json$/.test(f)) {
        const fp = path.join(tmpDir, f);
        try {
          const stat = fs.statSync(fp);
          if (Date.now() - stat.mtimeMs > 3600000) {
            fs.unlinkSync(fp);
            cleanedTmp++;
          }
        } catch {}
      }
    }
    if (cleanedTmp > 0) actionsTaken.push(`Cleaned ${cleanedTmp} orphaned temporary gate file(s)`);
  } catch {}

  // 3. Reconcile zombie/stale task records stuck in 'running'
  let reconciledCount = 0;
  const taskDirs = [path.join(workdir, '.agent', 'tasks'), path.join(workdir, '.converge', 'tasks')];
  for (const td of taskDirs) {
    if (fs.existsSync(td)) {
      try {
        const entries = fs.readdirSync(td);
        for (const f of entries) {
          if (f.endsWith('.json')) {
            const fp = path.join(td, f);
            try {
              const raw = fs.readFileSync(fp, 'utf8');
              const taskObj = JSON.parse(raw);
              if (taskObj.status === 'running') {
                const mtime = fs.statSync(fp).mtimeMs;
                if (opts.force === true || Date.now() - mtime > 60000) {
                  taskObj.status = 'interrupted';
                  taskObj.endedAt = new Date().toISOString();
                  taskObj.haltReason = 'Harness self-healing reconciled orphaned running task';
                  atomicJson(fp, taskObj);
                  reconciledCount++;
                }
              }
            } catch {}
          }
        }
      } catch {}
    }
  }
  if (reconciledCount > 0) actionsTaken.push(`Reconciled ${reconciledCount} orphaned running task record(s) -> interrupted`);

  // 4. Reconcile stale unrecovered reflexion receipts older than stale window
  let reconciledReceipts = 0;
  if (fs.existsSync(p.receipts)) {
    try {
      const lines = fs.readFileSync(p.receipts, 'utf8').split('\n').filter(Boolean);
      let updated = false;
      const minAgeMs = Number(opts.minReceiptAgeMs == null ? 21600000 : opts.minReceiptAgeMs); // 6h default
      const newLines = lines.map((line) => {
        try {
          const r = JSON.parse(line);
          if (!r.recovered) {
            const ageMs = Date.now() - new Date(r.timestamp).getTime();
            if (opts.force === true || opts.reconcileReceipts === true || ageMs >= minAgeMs) {
              r.recovered = true;
              r.mitigationApplied = r.mitigationApplied || 'Reconciled during workspace self-healing';
              r.recovery = r.recovery || 'reconciled-stale-fault';
              reconciledReceipts++;
              updated = true;
            }
          }
          return JSON.stringify(r);
        } catch {
          return line;
        }
      });
      if (updated) {
        const tmp = `${p.receipts}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, newLines.join('\n') + '\n');
        fs.renameSync(tmp, p.receipts);
      }
    } catch {}
  }
  if (reconciledReceipts > 0) actionsTaken.push(`Reconciled ${reconciledReceipts} stale unrecovered reflexion receipt(s)`);

  // 5. Re-run diagnostics
  const postDiag = diagnose(workdir);

  const result = {
    version: VERSION,
    workdir,
    healedAt: new Date().toISOString(),
    actionsTaken,
    postHealthScore: postDiag.healthScore,
    status: postDiag.status,
  };

  try {
    appendJsonl(p.audit, { at: result.healedAt, action: 'heal-executed', actions: actionsTaken, postScore: postDiag.healthScore });
  } catch {}

  return result;
}

// Capture a regression test case directly from a recorded reflexion receipt.
function captureRegression(root, receiptId) {
  if (!regressionCorpus) throw new Error('shared/regression-corpus.cjs is unavailable');
  const workdir = path.resolve(root || process.cwd());
  const receipts = listReceipts(workdir, { limit: 500 });
  const rcpt = receipts.find((r) => r.id === receiptId);
  if (!rcpt) throw new Error(`no reflexion receipt found with id "${receiptId}"`);

  const spec = {
    title: `Regression from fault: ${rcpt.signature} (${rcpt.id})`,
    command: rcpt.toolName === 'run_command' && rcpt.toolArgs?.CommandLine
      ? rcpt.toolArgs.CommandLine
      : '',
    affected: [rcpt.toolName ? 'shared/*' : 'universal-agent.cjs'],
    tags: ['reflexion', rcpt.signature.split(':')[0]],
    source: {
      summary: `Auto-captured from reflexion receipt ${rcpt.id}`,
      receiptId: rcpt.id,
      timestamp: rcpt.timestamp,
    },
    classification: rcpt.classification,
  };

  if (!spec.command) throw new Error('receipt has no reproducible run_command; no regression fixture was synthesized');
  return regressionCorpus.capture(workdir, spec);
}

module.exports = {
  VERSION,
  paths,
  deriveSignature,
  classifyFault,
  recordReceipt,
  listReceipts,
  handleToolFault,
  diagnose,
  heal,
  captureRegression,
  environmentState,
  synthesizeNegativeRule,
};
