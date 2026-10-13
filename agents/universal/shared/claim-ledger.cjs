// Claim-ledger verification — shared by the harness and tests so they cannot drift.
// A research mission's claims[] must be evidence-backed by this turn's real tool
// output (worldEvidence). Model confidence is not evidence.

function extractLastJsonBlock(text) {
  const s = String(text || '');
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = fenceRe.exec(s)) !== null) last = m[1];
  if (last == null) return null;
  try {
    const obj = JSON.parse(last.trim());
    return (obj && typeof obj === 'object') ? obj : null;
  } catch {
    return null;
  }
}

const OVERGENERALIZED_RE = /\b(all|every|each|every single)\b/i;

function overGeneralizedClaims(claims) {
  return (Array.isArray(claims) ? claims : []).filter((c) => OVERGENERALIZED_RE.test(String((c && c.claim) || '')));
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Strip markdown emphasis / fancy dashes so model excerpts like "Dress** — $68"
// still match preload text "**Dress**  —  $68".
function soft(s) {
  return norm(s).replace(/[*_`~]/g, '').replace(/\s*[—–-]+\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// A CODE claim does not cite a web page — it cites `file.cjs:412`. The matcher
// only ever looked at worldEvidence (this turn's fetched-page / tool-output blob),
// so a file-backed excerpt was STRUCTURALLY unmatchable: a diagnostic whose judge
// passed and whose every excerpt sat verbatim on disk still produced a blanket
// "N of N claims could not be automatically matched" and a medium-confidence
// receipt. That is matcher blindness, not missing evidence — so resolve the ref
// and read the file. A claim citing a file that does not exist, or an excerpt
// that is not in it, still fails exactly as before: this widens where the matcher
// looks, it does not lower the bar.
// A verifiable excerpt must be SUBSTANTIVE, not a generic coincidence: a bare
// "2024"/"true" found anywhere in an evidence blob laundered a fabricated claim
// to verified:true. The signal is specificity, not raw length — a multi-word
// phrase, OR a concrete figure/spec token (a price, a decimal, a number+unit
// like "165Hz" or "4x") is strong even when short.
const wordCount = (s) => String(s || '').split(' ').filter(Boolean).length;
const hasSpecificToken = (e) => /[$€£]\s?\d|\d[.,]\d|\d\s?(?:hz|khz|mhz|ghz|hdmi|gb|tb|mm|cm|oz|ml|k|w|in|"|x)\b|\bx\s?\d/i.test(e);
const strongExcerpt = (e) => !!e && (wordCount(e) >= 3 || hasSpecificToken(e) || e.length >= 12);
// A claim asserting a FIGURE still needs a digit-bearing excerpt.
const numberOkFor = (claim) => { const needs = /\d/.test(String(claim || '')); return (e) => !needs || /\d/.test(e); };
// Does `haystack` contain this claim's excerpt, strictly enough to count?
function excerptIn(c, haystackNorm, haystackSoft) {
  const excerpt = norm(c && c.excerpt);
  const excerptSoft = soft(c && c.excerpt);
  const numberOk = numberOkFor(c && c.claim);
  return (strongExcerpt(excerpt) && numberOk(excerpt) && haystackNorm.includes(excerpt))
    || (strongExcerpt(excerptSoft) && numberOk(excerptSoft) && haystackSoft.includes(excerptSoft));
}

const FILE_REF_RE = /^(?:file:\/\/)?((?:[\w.~-]+\/)*[\w.~-]*[\w~-]\.[A-Za-z0-9]{1,8})(?:[:#](\d{1,7}))?(?:[-:]\d{1,7})?$/;

function fileRefOf(c) {
  for (const raw of [c && c.file, c && c.refs && c.refs.file, c && c.url, c && c.source]) {
    const s = String(raw || '').trim();
    if (!s || /^[a-z][a-z0-9+.-]*:\/\//i.test(s.replace(/^file:\/\//i, ''))) continue; // http(s) etc. are not file refs
    const m = FILE_REF_RE.exec(s);
    if (m) return { path: m[1], line: m[2] ? parseInt(m[2], 10) : null };
  }
  return null;
}

// Default reader: rooted at the workdir, never escapes it, never slurps a blob.
function defaultRefReader(root) {
  const path = require('path');
  const fs = require('fs');
  const base = path.resolve(root || process.cwd());
  return (rel) => {
    try {
      const abs = path.resolve(base, rel);
      if (abs !== base && !abs.startsWith(base + path.sep)) return null;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
      return fs.readFileSync(abs, 'utf8');
    } catch { return null; }
  };
}

/**
 * @param {string} text
 * @param {{ worldEvidence: () => string, fetchLog?: Array<{url:string,retrievedAt?:string,contentSha256?:string}>, cwd?: string, readRef?: (rel:string)=>string|null }} opts
 */
function verifyClaimLedger(text, opts = {}) {
  const worldEvidence = typeof opts.worldEvidence === 'function' ? opts.worldEvidence : () => '';
  const fetchLog = Array.isArray(opts.fetchLog) ? opts.fetchLog : [];
  const readRef = typeof opts.readRef === 'function' ? opts.readRef : defaultRefReader(opts.cwd);
  const obj = extractLastJsonBlock(text);
  const claims = Array.isArray(obj && obj.claims) ? obj.claims : [];
  if (!claims.length) return text;
  const findings = Array.isArray(obj.findings) ? obj.findings.slice() : [];
  const checksNotPerformed = Array.isArray(obj.checksNotPerformed) ? obj.checksNotPerformed.slice() : [];
  const harnessUncertainty = Array.isArray(obj.harnessUncertainty) ? obj.harnessUncertainty.slice() : [];
  let changed = false;

  // cursor-cli/claude-cli often leave worldEvidence empty — BUT harness
  // preloads (find_listings) DO land in messages. Verify whenever evidence
  // is present; skip stamping only when there is nothing to check against.
  const evidenceRaw = String(worldEvidence() || '');
  const evidence = evidenceRaw.toLowerCase();
  const evidenceNorm = norm(evidenceRaw);
  const evidenceSoft = soft(evidenceRaw);

  // FILE/LINE-BACKED SUPPORT — checked first and INDEPENDENTLY of the
  // web-evidence floor below. Proof on disk does not become weaker because this
  // turn fetched no pages, and a delegated CLI (which runs its own reads inside
  // its own process, so worldEvidence never sees them) leaves this as the only
  // evidence channel the harness can actually check.
  const fileSupported = new Set();
  for (const c of claims) {
    const ref = fileRefOf(c);
    if (!ref || !norm(c && c.excerpt)) continue;
    const body = readRef(ref.path);
    if (body == null) continue;
    if (!excerptIn(c, norm(body), soft(body))) continue;
    c.verified = true;
    c.supportStatus = 'supported';
    c.evidence = { file: ref.path, ...(ref.line ? { line: ref.line } : {}) };
    fileSupported.add(c);
    changed = true;
  }

  if (evidenceNorm.length >= 40) {
    const urlOf = (c) => String((c && (c.url || c.source)) || '');
    const receiptFor = (c) => {
      const u = urlOf(c);
      return fetchLog.find((f) => f.url === u)
        || fetchLog.find((f) => u && (u.includes(f.url) || f.url.includes(u)))
        || null;
    };
    const unverified = [];
    for (const c of claims) {
      // Already proved against its own cited file — re-testing it against the
      // web blob it never came from is what produced the blanket warning.
      if (fileSupported.has(c)) continue;
      const excerpt = norm(c && c.excerpt);
      const claimHasNumber = /\d/.test(String((c && c.claim) || ''));
      const excerptHit = excerptIn(c, evidenceNorm, evidenceSoft);
      const u = urlOf(c);
      const priceTok = String((c && c.claim) || '').match(/\$\s?\d+(?:\.\d{2})?/);
      const listingHit = u && evidence.includes(u.toLowerCase())
        && priceTok && evidenceSoft.includes(soft(priceTok[0]));
      if (excerptHit || listingHit) {
        c.verified = true;
        c.supportStatus = 'supported';
        const r = receiptFor(c);
        if (r) c.evidence = { url: r.url, retrievedAt: r.retrievedAt, contentSha256: r.contentSha256 };
      } else {
        // A failed string match is uncertainty in this matcher, not proof that
        // the claim is unsupported. Only a checker that finds contradictory
        // evidence may stamp `contradicted`.
        delete c.verified;
        c.supportStatus = 'matcher_could_not_determine';
        const needle = (norm(c && c.source) || norm(c && c.claim)).slice(0, 60);
        const topicSeen = needle.length > 3 && evidence.includes(needle);
        // A cited file separates the two failures that used to share one label:
        // the file was READ and the excerpt is genuinely not in it (substantive)
        // vs. the ref could not be resolved at all (matcher-side).
        const ref = fileRefOf(c);
        const refRead = ref ? readRef(ref.path) != null : false;
        unverified.push({
          c,
          reason: ref && excerpt && refRead
            ? `excerpt not found in the cited file ${ref.path}`
            : ref && excerpt
              ? `cited file ${ref.path} could not be read from the workdir`
              : !excerpt
                ? (topicSeen ? 'no supporting excerpt provided' : 'no supporting evidence in tool output')
                : !strongExcerpt(excerpt)
              ? 'excerpt too short — quote at least 3 words verbatim from the tool output'
              : (claimHasNumber && !/\d/.test(excerpt))
                ? 'a numeric claim needs an excerpt that contains the figure'
                : 'excerpt not found verbatim in tool output',
        });
      }
    }
    if (unverified.length) {
      changed = true;
      harnessUncertainty.push({
        checker: 'claim_matcher',
        status: 'matcher_could_not_determine',
        count: unverified.length,
        detail: `${unverified.length} of ${claims.length} claim(s) could not be automatically matched: ${unverified.map((u) => `${truncate(String((u.c && u.c.claim) || ''), 60)} (${u.reason})`).join(' | ')}`,
      });
      checksNotPerformed.push(`${unverified.length} claim(s) could not be automatically matched to a verbatim excerpt from this turn's tool output.`);
    }
  }

  const broad = overGeneralizedClaims(claims);
  if (broad.length) {
    changed = true;
    harnessUncertainty.push({
      checker: 'absolute_quantifier_heuristic',
      status: 'matcher_could_not_determine',
      count: broad.length,
      detail: `${broad.length} claim(s) use "all/every/each" and may overstate a per-unit exception: ${broad.map((c) => truncate(String((c && c.claim) || ''), 80)).join(' | ')}`,
    });
    checksNotPerformed.push(`${broad.length} claim(s) using an absolute quantifier (all/every/each) were flagged as a heuristic, not individually re-verified per unit.`);
  }

  const stamped = claims.some((c) => typeof c.verified === 'boolean');
  if (!changed && !stamped) return text;
  // Preserve sibling keys the model put beside the ledger (a subtask's
  // `result`, a confidence field): the rewrite corrects the ledger, it must
  // not delete the rest of the block. The four ledger keys still win.
  const corrected = { ...obj, findings, claims, checksNotPerformed, harnessUncertainty };
  // REPLACE the model's block in place — never append a second one. Display
  // strips the LAST fenced block, so an appended correction was the exact
  // block that got deleted: the operator kept the model's uncorrected
  // self-report (confidence:"high", no verified flags) while the harness's
  // falsification vanished. One authoritative block means the strip removes
  // the corrected data from display and every machine reader parses it.
  const fence = /```(?:json)?\s*[\s\S]*?```/gi;
  let m2, lastSpan = null;
  while ((m2 = fence.exec(text)) !== null) lastSpan = { start: m2.index, end: m2.index + m2[0].length };
  const block = `\`\`\`json\n${JSON.stringify(corrected, null, 2)}\n\`\`\``;
  return lastSpan
    ? `${text.slice(0, lastSpan.start)}${block}${text.slice(lastSpan.end)}`
    : `${text}\n\n${block}\n`;
}

module.exports = {
  extractLastJsonBlock,
  overGeneralizedClaims,
  verifyClaimLedger,
  OVERGENERALIZED_RE,
  soft,
  norm,
  // Matcher internals, exported so the MCP server's subtask verifier applies the
  // SAME evidence bar (and can embed them verbatim in a node-side checker)
  // instead of drifting on a copy.
  wordCount,
  hasSpecificToken,
  strongExcerpt,
  numberOkFor,
  excerptIn,
};
