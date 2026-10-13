'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const VERSION = 1;
const DEFAULT_POLICY = Object.freeze({ maxCandidates: 3, minFailures: 2, minFlakeRate: 0.25, reviewWeight: 1 });
const SECURITY = /security|credential|auth|permission|payment|deploy|production|migration|delete|destructive/i;
const sh = (command, cwd, env = {}) => cp.execSync(command, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
const safeId = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
function engineKey(c) { return [c.provider || '', c.model || '', c.host || ''].join('\0'); }
function assess(input = {}, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy }, failures = Math.max(0, Number(input.failures) || 0), attempts = Math.max(failures, Number(input.attempts) || 0);
  const flakeRate = attempts ? failures / attempts : 0, reasons = [];
  if (input.highRisk === true || SECURITY.test(`${input.taskClass || ''} ${input.task || ''}`)) reasons.push('high-risk');
  if (failures >= p.minFailures) reasons.push('repeated-failures');
  if (attempts >= 4 && flakeRate >= p.minFlakeRate) reasons.push('historically-flaky');
  return { mode: reasons.length ? 'best-of-n' : 'single', reasons, failures, attempts, flakeRate };
}
function plan(input = {}, policy = {}) {
  const risk = assess(input, policy), p = { ...DEFAULT_POLICY, ...policy }, seen = new Set(), candidates = [];
  for (const raw of input.candidates || []) {
    const id = safeId(raw.id || `${raw.provider}-${raw.model}`); if (!id || !raw.command) continue;
    const c = { ...raw, id }, key = engineKey(c); if (seen.has(key)) continue; seen.add(key); candidates.push(c);
  }
  const count = risk.mode === 'best-of-n' ? Math.min(p.maxCandidates, candidates.length) : Math.min(1, candidates.length);
  return { version: VERSION, ...risk, candidates: candidates.slice(0, count) };
}
function clean(root) { return sh('git status --porcelain', root).trim() === ''; }
function score(result, policy = {}) {
  if (!result.gatePassed) return Number.NEGATIVE_INFINITY;
  const p = { ...DEFAULT_POLICY, ...policy };
  return (Number(result.reviewScore) || 0) * p.reviewWeight - (Number(result.gateFailures) || 0) * 1000 - (Number(result.cost) || 0) - (Number(result.durationMs) || 0) / 1e9;
}
function choose(results, policy = {}) {
  const ranked = results.map((r, index) => ({ ...r, score: score(r, policy), index })).sort((a, b) => (b.score - a.score) || (a.index - b.index));
  if (!ranked.length || !Number.isFinite(ranked[0].score)) throw new Error('no candidate passed the independent gate');
  return { winner: ranked[0], ranked };
}
function runCommand(command, cwd, env) { const started = Date.now(); try { const stdout = sh(command, cwd, env); return { ok: true, stdout, stderr: '', durationMs: Date.now() - started }; } catch (e) { return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || ''), durationMs: Date.now() - started }; } }
function patchOf(cwd) { sh('git add -A', cwd); return sh('git diff --cached --binary --no-ext-diff HEAD', cwd); }
function audit(root, receipt) { const dir = path.join(root, '.converge', 'arbitrations'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `${receipt.id}.json`); fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`); return file; }
function execute(root, input, opts = {}) {
  root = path.resolve(root); if (!clean(root)) throw new Error('best-of-N requires a clean worktree so only the selected candidate can be applied');
  const prepared = plan(input, opts.policy); if (!prepared.candidates.length) throw new Error('no runnable candidates');
  if (typeof input.gateCommand !== 'string' || !input.gateCommand.trim()) throw new Error('gateCommand is required and must be the same for every candidate');
  if (prepared.mode === 'best-of-n' && prepared.candidates.length < 2) throw new Error('best-of-N requires at least two distinct provider/model/host candidates');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-best-of-n-')), results = [];
  try {
    for (const candidate of prepared.candidates) {
      const worktree = path.join(tmp, candidate.id); sh(`git worktree add --detach ${JSON.stringify(worktree)} HEAD`, root);
      const env = { CONVERGE_ARBITRATION_CANDIDATE: candidate.id, EDIT_PROVIDER: candidate.provider || '', EDIT_MODEL: candidate.model || '', EDIT_API_HOST: candidate.host || '' };
      const worker = runCommand(candidate.command, worktree, env); let gate = { ok: false, stdout: '', stderr: 'worker failed', durationMs: 0 };
      if (worker.ok) gate = runCommand(input.gateCommand, worktree, env);
      let reviewScore = 0, review = null, reviewPassed = !input.reviewCommand;
      if (gate.ok && input.reviewCommand) {
        review = runCommand(input.reviewCommand, worktree, env);
        if (review.ok) { try { const parsed = JSON.parse(review.stdout); if (Number.isFinite(Number(parsed.score))) { reviewScore = Number(parsed.score); reviewPassed = true; } } catch { review.stderr = 'review output was not valid score JSON'; } }
      }
      const patch = patchOf(worktree);
      const eligible = gate.ok && reviewPassed;
      results.push({ id: candidate.id, provider: candidate.provider || '', model: candidate.model || '', workerPassed: worker.ok, gatePassed: eligible, deterministicGatePassed: gate.ok, reviewPassed, gateFailures: eligible ? 0 : 1, reviewScore, cost: Number(candidate.cost) || 0, durationMs: worker.durationMs + gate.durationMs + (review ? review.durationMs : 0), patch, diagnostics: { worker: worker.stderr.slice(-2000), gate: gate.stderr.slice(-2000), review: review && review.stderr.slice(-2000) } });
      sh(`git worktree remove --force ${JSON.stringify(worktree)}`, root);
    }
    const selected = choose(results, opts.policy);
    if (selected.winner.patch) cp.execFileSync('git', ['apply', '--binary', '-'], { cwd: root, input: selected.winner.patch, stdio: ['pipe', 'pipe', 'pipe'] });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
    const receipt = { version: VERSION, id, at: new Date().toISOString(), mode: prepared.mode, reasons: prepared.reasons, applied: selected.winner.id, results: selected.ranked.map(({ patch, index, ...r }) => ({ ...r, patchHash: crypto.createHash('sha256').update(patch).digest('hex') })) };
    return { ...receipt, receiptFile: audit(root, receipt) };
  } finally {
    for (const c of prepared.candidates) { try { sh(`git worktree remove --force ${JSON.stringify(path.join(tmp, c.id))}`, root); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
module.exports = { VERSION, DEFAULT_POLICY, assess, plan, score, choose, execute, _internals: { safeId, engineKey } };
