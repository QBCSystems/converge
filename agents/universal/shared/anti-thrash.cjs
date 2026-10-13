'use strict';

const { execSync } = require('child_process');

const DEFAULT_CONFIG = {
  browserMaxPerStage: parseInt(process.env.CONVERGE_ANTI_THRASH_BROWSER_MAX || '2', 10),
  failCmdMax: parseInt(process.env.CONVERGE_ANTI_THRASH_FAIL_CMD_MAX || '2', 10),
  stageVerifTimePct: parseFloat(process.env.CONVERGE_ANTI_THRASH_STAGE_VERIF_TIME_PCT || '0.35'),
  missionReservePct: parseFloat(process.env.CONVERGE_ANTI_THRASH_MISSION_RESERVE_PCT || '0.20'),
  visualJudgeMaxAttempts: parseInt(process.env.CONVERGE_ANTI_THRASH_VISUAL_JUDGE_MAX_ATTEMPTS || '2', 10),
  allowLegacyTests: process.env.CONVERGE_ALLOW_LEGACY_TESTS === '1',
  enabled: process.env.CONVERGE_ANTI_THRASH_ENABLED !== '0',
};

const ARTIFACT_PATH_RE = /\b(archive|legacy|legacy-tests|\.tmp|tmp|temp|logs|\.agent|\.converge|node_modules|dist|build|coverage|test-results|screenshots)\b/i;
const ARTIFACT_EXT_RE = /\.(tmp|log|png|jpg|jpeg|gif|svg|ico|map|txt|jsonl)$/i;

function isMeaningfulProductPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (ARTIFACT_PATH_RE.test(normalized)) return false;
  if (ARTIFACT_EXT_RE.test(normalized)) return false;
  if (normalized.endsWith('.json') && (normalized.includes('gate') || normalized.includes('config') || normalized.includes('.agent'))) return false;
  return true;
}

function isArchivedOrLegacyTestPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  return /\b(archive|legacy|legacy-tests)\b/i.test(normalized) || /\.legacy\./i.test(normalized) || /\blegacy-/i.test(normalized);
}

function normalizeCommandSignature(cmdStr) {
  if (!cmdStr || typeof cmdStr !== 'string') return '';
  let s = cmdStr.trim();
  s = s.replace(/^([A-Z0-9_]+=\S+\s+)+/, '');
  s = s.replace(/\s+/g, ' ');
  return s;
}

function isBrowserToolCall(name, args) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  if (n === 'browser' || n === 'fetch_url' || n === 'web_search' || n === 'find_listings' || n === 'browser_navigate' || n === 'browser_click' || n === 'browser_type' || n === 'browser_screenshot' || n === 'page_snapshot' || n === 'chrome_eval') return true;
  if (n.startsWith('browser') || n.startsWith('chrome') || n.startsWith('cdp') || n.startsWith('playwright') || n.startsWith('puppeteer') || n.startsWith('page_') || n.startsWith('web_')) return true;
  return /\b(browser|chrome|cdp|playwright|puppeteer)\b/i.test(n);
}

function extractCommandStr(args) {
  if (!args) return '';
  if (typeof args === 'string') return args;
  return String(args.command || args.cmd || args.commandLine || args.CommandLine || args.script || args.code || '');
}

function isVerificationToolCall(name, args) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  if (n === 'check_diagnostics' || n === 'task_status' || n === 'task_wait' || n === 'verify' || n === 'validate' || n === 'check' || n === 'run_test' || n === 'run_tests') return true;
  if (n === 'run_command' || n === 'task_start' || n.startsWith('bash') || n.startsWith('shell') || n.startsWith('cmd')) {
    const cmd = extractCommandStr(args);
    return /\b(test|verify|assert|check|validate|pytest|jest|mocha|vitest|ava|tape|playwright|puppeteer|cypress|selenium|npm\s+(run\s+)?(test|check|verify|lint|tsc|typecheck)|tsc|eslint|ruff|mypy|pyright|go\s+(test|vet)|cargo\s+(test|check)|\.test\.|\.spec\.|test-|verify-|check-|validate-)\b/i.test(cmd);
  }
  return false;
}

class AntiThrashPolicy {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.resetStage();
  }

  resetStage() {
    this.stageStartMs = Date.now();
    this.stageBrowserAttempts = 0;
    this.stageVerifTimeMs = 0;
    this.hasMeaningfulProductDiff = false;
    this.failingCmdCounts = new Map();
    this.visualJudgeAttempts = 0;
    this.receipts = [];
  }

  recordReceipt(category, detail) {
    const receipt = `ANTI_THRASH_RECEIPT [${category}]: ${detail}`;
    this.receipts.push({ category, detail, timestamp: Date.now(), receipt });
    return receipt;
  }

  checkGitDiffMeaningful(cwd) {
    try {
      const diffOut = execSync('git status --porcelain', { cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 5000 });
      const lines = diffOut.split('\n').filter(Boolean);
      for (const line of lines) {
        const file = line.slice(3).trim();
        if (isMeaningfulProductPath(file)) {
          this.hasMeaningfulProductDiff = true;
          return true;
        }
      }
    } catch {}
    return this.hasMeaningfulProductDiff;
  }

  evaluateToolCall(name, args, { stageElapsedMs, msLeft, totalBudgetMs, cwd } = {}) {
    if (!this.config.enabled) return { allowed: true };

    const isBrowser = isBrowserToolCall(name, args);
    const isVerif = isVerificationToolCall(name, args);

    if (isBrowser) {
      if (!this.hasMeaningfulProductDiff && this.stageBrowserAttempts >= this.config.browserMaxPerStage) {
        const receipt = this.recordReceipt(
          'browser_cap_exceeded',
          `Browser verification cap of ${this.config.browserMaxPerStage} attempt(s) reached for this stage without a meaningful product diff.`
        );
        return {
          allowed: false,
          reason: `BLOCKED: [Anti-Thrash Policy] ${receipt}\nYou cannot use browser/visual tools again in this stage until you save a meaningful code edit to a product file.`,
          receipt,
        };
      }
    }

    if (name === 'run_command' || name === 'task_start' || isVerif) {
      const cmdStr = extractCommandStr(args);
      const sig = normalizeCommandSignature(cmdStr);
      if (sig) {
        const fails = this.failingCmdCounts.get(sig) || 0;
        if (!this.hasMeaningfulProductDiff && fails >= this.config.failCmdMax) {
          const receipt = this.recordReceipt(
            'command_signature_cap_exceeded',
            `Failing command signature "${sig}" failed ${fails} time(s) without product edits.`
          );
          return {
            allowed: false,
            reason: `BLOCKED: [Anti-Thrash Policy] ${receipt}\nDo not re-run this failing check without repairing the product code or taking an alternate action.`,
            receipt,
          };
        }
      }
    }

    const elapsed = stageElapsedMs != null ? stageElapsedMs : (Date.now() - this.stageStartMs);
    if (!this.hasMeaningfulProductDiff && elapsed >= 15000 && (isBrowser || isVerif)) {
      const verifRatio = this.stageVerifTimeMs / Math.max(1000, elapsed);
      if (verifRatio >= this.config.stageVerifTimePct) {
        const receipt = this.recordReceipt(
          'stage_verif_time_exceeded',
          `Verification wall-time ratio (${Math.round(verifRatio * 100)}%) exceeded ${Math.round(this.config.stageVerifTimePct * 100)}% limit before any product edit.`
        );
        return {
          allowed: false,
          reason: `BLOCKED: [Anti-Thrash Policy] ${receipt}\nVerification time budget exceeded before any product edits were made. Focus on implementation now.`,
          receipt,
        };
      }
    }

    if (msLeft != null && totalBudgetMs != null && totalBudgetMs > 0) {
      const reserveMs = totalBudgetMs * this.config.missionReservePct;
      if (msLeft <= reserveMs && (isBrowser || isVerif)) {
        const hasEdits = this.checkGitDiffMeaningful(cwd);
        if (hasEdits) {
          const receipt = this.recordReceipt(
            'mission_reserve_reached',
            `Mission deadline reserve boundary reached (${Math.round(msLeft / 1000)}s left <= ${Math.round(reserveMs / 1000)}s reserve) with coherent product edits present.`
          );
          return {
            allowed: false,
            reason: `BLOCKED: [Anti-Thrash Policy] ${receipt}\nBroad verification halted to preserve work. Deliver final answer, targeted syntax gate, or commit now.`,
            receipt,
            reserveMode: true,
          };
        }
      }
    }

    return { allowed: true };
  }

  recordToolExecution(name, args, { passed, durationMs } = {}) {
    if (!this.config.enabled) return;

    const isBrowser = isBrowserToolCall(name, args);
    const isVerif = isVerificationToolCall(name, args);

    if (isBrowser) {
      this.stageBrowserAttempts++;
    }

    if (durationMs > 0 && (isBrowser || isVerif)) {
      this.stageVerifTimeMs += durationMs;
    }

    if ((name === 'run_command' || name === 'task_start' || isVerif) && passed === false) {
      const cmdStr = extractCommandStr(args);
      const sig = normalizeCommandSignature(cmdStr);
      if (sig) {
        const count = (this.failingCmdCounts.get(sig) || 0) + 1;
        this.failingCmdCounts.set(sig, count);
        this.recordReceipt('failing_command_recorded', `Command signature "${sig}" failed (${count}/${this.config.failCmdMax})`);
      }
    }
  }
}

module.exports = {
  DEFAULT_CONFIG,
  AntiThrashPolicy,
  isMeaningfulProductPath,
  isArchivedOrLegacyTestPath,
  normalizeCommandSignature,
  isBrowserToolCall,
  isVerificationToolCall,
};
