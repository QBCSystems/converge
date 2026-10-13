'use strict';
// Keep tool traffic from eating the context window — without throwing away the
// part of the output that actually matters.
//
// The harness already pruned old tool results, but it did so in a way that
// caused the very re-running it was meant to prevent:
//
//   * HEAD-ONLY. It kept the first 3 lines / 150 chars. Tool output puts its
//     verdict at the END — the failing assertion, the stack trace, the "3
//     passed, 1 failed", the last line of a build log. Head-only pruning
//     reliably preserved the banner and discarded the diagnosis, so the model
//     re-ran the tool to see the ending. A pruner that provokes a re-run has
//     negative value: it pays the stub cost AND the full result cost again.
//   * A CLIFF, NOT A GRADIENT. Result #7 went from 12,000 chars to 150 in one
//     round. There was no middle state for "recent enough to still matter".
//   * NO DEDUPE. Re-running a command stored its identical output twice.
//
// This replaces it with a tiered ladder. Results age through states rather than
// falling off an edge, every state keeps the tail, and byte-identical repeats
// collapse to a back-reference:
//
//   newest KEEP_FULL       verbatim            (actively being worked on)
//   next  KEEP_DIGEST      head+tail ~700c     (recent; verdict still readable)
//   older than that        head+tail ~220c     (archival; shape + ending only)
//
// Aging is idempotent and in place: it runs before each model call, the array
// only ever shrinks, and re-running it on aged messages is a no-op. Persisted
// chat history is unaffected — scrubChatHistory() strips tool traffic before
// anything reaches disk.

// Verbatim tier. Enough to cover a read → edit → verify → re-read working set.
const KEEP_FULL = intEnv('CONVERGE_CTX_KEEP_FULL', 6);
// How many results sit in the mid tier below the verbatim ones.
const KEEP_DIGEST = intEnv('CONVERGE_CTX_KEEP_DIGEST', 6);
// Mid-tier target size: a failing test's name and assertion stay legible.
const DIGEST = intEnv('CONVERGE_CTX_DIGEST', 700);
// Archival target size: enough to recognise what the call was and how it ended.
const STUB = intEnv('CONVERGE_CTX_STUB', 220);
// Below this a result is left alone — shrinking it would not cover the cost of
// the marker line explaining that it was shrunk.
const MIN_TO_AGE = intEnv('CONVERGE_CTX_MIN_AGE', 260);
// Share of the budget spent on the head; the remainder holds the tail.
const HEAD_SHARE = 0.55;

const MARK = '✂ aged';
const DUP_MARK = '↻ identical';

function intEnv(name, dflt) {
  const v = parseInt(String(process.env[name] || ''), 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// A message carrying tool output, in either transport the harness uses: native
// tool messages (role 'tool') or the text fallback non-native providers get
// (role 'user' with a "TOOL RESULT (name):" preamble).
function isToolResult(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.role === 'tool') return true;
  return m.role === 'user' && typeof m.content === 'string' && /^TOOL RESULT \(/.test(m.content);
}

const contentOf = (m) => (typeof m.content === 'string' ? m.content : '');
// Aged content carries its marker, so a second pass skips it. Without this the
// ladder would re-digest its own digests and grind results down to nothing.
const isAged = (s) => s.includes(MARK) || s.includes(DUP_MARK);

// Record the ORIGINAL content's digest before the first mutation. providers.cjs
// reads it (cliMsgFingerprint) so a claude-cli --resume survives aging; without
// it the first digested result looked like a rewritten history and every later
// step re-sent the full transcript uncached. Enumerable on purpose: it has to
// survive the JSON round-trip a resumed run makes through .agent state, or the
// session breaks again on restart. Never reaches a provider — every toX()
// builder copies named fields onto fresh objects.
function stampIdentity(m, original) {
  if (!m._fp) m._fp = require('crypto').createHash('sha1').update(original).digest('hex');
}


// Create a LifecycleBus middleware function for dynamic context budgeting.
// Head + tail. The tail is the whole point: it is where the failure is.
function shrink(text, budget) {
  const headLen = Math.max(100, Math.floor(budget * HEAD_SHARE));
  const tailLen = Math.max(80, budget - headLen);
  if (text.length <= headLen + tailLen) return text;
  const head = text.slice(0, headLen).trimEnd();
  const tail = text.slice(-tailLen).trimStart();
  const elided = text.length - head.length - tail.length;
  if (elided <= 0) return text;
  return `${head}\n   [${MARK}: ${elided.toLocaleString()} chars elided from the middle — the ending is kept below; re-run the tool for the full output]\n${tail}`;
}

// Shrink stale tool results in `messages`, in place. Returns a report so the
// caller can log what was reclaimed.
function ageToolResults(messages, opts) {
  const o = opts || {};
  const keepFull = o.keepFull != null ? o.keepFull : KEEP_FULL;
  const keepDigest = o.keepDigest != null ? o.keepDigest : KEEP_DIGEST;
  const digestTo = o.digest != null ? o.digest : DIGEST;
  const stubTo = o.stub != null ? o.stub : STUB;
  const minAge = o.minAge != null ? o.minAge : MIN_TO_AGE;
  if (!Array.isArray(messages)) return { digested: 0, stubbed: 0, deduped: 0, saved: 0 };

  const idx = [];
  for (let i = 0; i < messages.length; i++) if (isToolResult(messages[i])) idx.push(i);
  if (idx.length <= keepFull) return { digested: 0, stubbed: 0, deduped: 0, saved: 0 };

  // Positions counted from the newest result backwards: 0 is the newest.
  const ageOf = new Map();
  idx.forEach((pos, k) => ageOf.set(pos, idx.length - 1 - k));

  let digested = 0, stubbed = 0, deduped = 0, saved = 0;
  const seen = new Map(); // exact content -> the position it first appeared at

  for (const i of idx) {
    const rank = ageOf.get(i);
    if (rank < keepFull) continue;            // verbatim tier — untouched
    const m = messages[i];
    const text = contentOf(m);
    if (!text || isAged(text)) { if (text) seen.set(text, i); continue; }
    // Images on an aged result are dead weight: the model has already seen
    // them and they re-upload on every subsequent round.
    if (m.images) delete m.images;

    // Byte-identical repeat — the model re-ran a tool and got the same answer.
    // Two copies of one fact is the purest form of context waste.
    if (seen.has(text) && text.length > 200) {
      const note = `[${DUP_MARK}: this call returned exactly the same ${text.length.toLocaleString()} chars as an earlier call this turn — see above. Result unchanged.]`;
      if (note.length < text.length) { stampIdentity(m, text); saved += text.length - note.length; m.content = note; deduped++; continue; }
    }
    seen.set(text, i);

    if (text.length <= minAge) continue;
    const target = rank < keepFull + keepDigest ? digestTo : stubTo;
    const short = shrink(text, target);
    if (short.length >= text.length) continue;
    stampIdentity(m, text);
    saved += text.length - short.length;
    m.content = short;
    if (target === digestTo) digested++; else stubbed++;
  }
  return { digested, stubbed, deduped, saved };
}

// Total characters currently in the model-facing message array.
function contextChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) n += contentOf(m).length;
  return n;
}

// Rough char->token ratio, for logging only. Never used for billing or limits.
const approxTokens = (chars) => {
  const n = typeof chars === 'string' ? chars.length : chars;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.ceil(n / 3.6);
};

function createContextBudgetMiddleware(defaultOpts = {}) {
  return async function contextBudgetMiddleware(ctx) {
    if (ctx && Array.isArray(ctx.messages)) {
      const charsBefore = contextChars(ctx.messages);
      const report = ageToolResults(ctx.messages, {
        keepFull: ctx.keepFull ?? defaultOpts.keepFull,
        keepDigest: ctx.keepDigest ?? defaultOpts.keepDigest,
        digest: ctx.digest ?? defaultOpts.digest,
        stub: ctx.stub ?? defaultOpts.stub,
        minAge: ctx.minAge ?? defaultOpts.minAge,
      });
      const charsAfter = contextChars(ctx.messages);
      ctx.budgetReport = {
        ...report,
        charsBefore,
        charsAfter,
        saved: charsBefore - charsAfter,
      };
    }
    return ctx;
  };
}

function registerContextBudgetMiddleware(lifecycleBus, defaultOpts = {}) {
  if (!lifecycleBus || typeof lifecycleBus.use !== 'function') return;
  lifecycleBus.use('transform-prompt', createContextBudgetMiddleware(defaultOpts), 'context-budget');
}

module.exports = {
  ageToolResults,
  contextChars,
  approxTokens,
  createContextBudgetMiddleware,
  registerContextBudgetMiddleware,
  _internals: { isToolResult, shrink, KEEP_FULL, KEEP_DIGEST, DIGEST, STUB, MIN_TO_AGE, MARK, DUP_MARK },
};
