'use strict';
// WHERE THE INPUT TOKENS WENT — measurement only, per model call.
//
// A harmless "add one MCP server" task consumed ~540k input tokens and nobody
// could say why. Every plausible culprit — the system prompt, project
// instructions, tool schemas, conversation history, accumulated tool output, or
// the same block injected on every round — is invisible at the only place it
// matters, which is the individual call. So the argument about compaction was
// being had without a number.
//
// This module measures and does nothing else. It drops nothing, summarizes
// nothing, and changes no behaviour: compacting before measuring is how you
// shrink the 8k section and leave the 390k one alone. Sibling context-budget.cjs
// is the thing that DOES prune; this is the thing that says whether it should.
//
// Estimates are labelled as estimates. Sections are sized with the same
// approxTokens ratio the pruner uses, and the provider's own reported input
// count rides alongside as `reported`, with the ratio between them exposed —
// so a reader can see when chars/3.6 is lying rather than assume it isn't.

const { approxTokens } = require('./context-budget.cjs');

const SECTIONS = [
  'system_instructions',
  'project_instructions',
  'tool_schemas',
  'conversation_history',
  'mission_evidence',
  'current_request',
  'other',
];

// Message content may be a string or a provider's content-part array.
function contentText(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('\n');
  if (c && typeof c === 'object') return String(c.text || '');
  return '';
}
const tok = (s) => approxTokens(String(s == null ? '' : s).length);

// The cheapest possible win, and the one most often merely suspected: a section
// that arrives more than once in the same call. Reported as fact — what it is,
// how many copies, and what the extra copies cost.
function duplicateSections(messages, minChars = 400) {
  const seen = new Map();
  for (const m of messages || []) {
    const text = contentText(m).trim();
    if (text.length < minChars) continue;
    const key = text.replace(/\s+/g, ' ');
    const prev = seen.get(key);
    if (prev) prev.times += 1;
    else seen.set(key, { times: 1, chars: text.length, label: key.slice(0, 120), role: (m && m.role) || 'unknown' });
  }
  return [...seen.values()]
    .filter((d) => d.times > 1)
    .map((d) => ({ label: d.label, role: d.role, times: d.times, chars_each: d.chars, wasted_tokens_est: approxTokens(d.chars * (d.times - 1)) }))
    .sort((a, b) => b.wasted_tokens_est - a.wasted_tokens_est)
    .slice(0, 8);
}

// One call's accounting. `classify(message, index) -> section` is supplied by
// the caller, because only the caller knows which messages came from the
// history file and which are this turn's evidence.
function accountContext({
  system = '',
  projectInstructions = '',
  messages = [],
  tools = null,
  classify = () => 'other',
  role = 'worker',          // worker | judge | router | repair
  provider = '',
  model = '',
  reported = null,          // { in, cacheRead, cacheWrite } as the provider reported it
  truncated = [],
  summarized = [],
  // The provider runs its OWN tool loop inside its own process (claude-cli,
  // cursor-cli — capability `delegatedTools`). Two consequences, both of them
  // measurement facts rather than policy:
  //   1. it never receives opts.tools, so counting the harness's tool schemas
  //      as "sent" inflated the estimate with bytes that were never on the wire;
  //   2. the model's real context also holds that CLI's own system prompt,
  //      native tool schemas and per-inner-turn history, so the difference
  //      between the bill and our payload is CLI-internal/session context, not
  //      a generic "unaccounted" mystery. See attachReported.
  delegated = false,
} = {}) {
  const sys = String(system || '');
  const proj = String(projectInstructions || '');
  // Project instructions are embedded IN the system prompt. Subtract rather
  // than double-count: the buckets have to sum to the total or the whole
  // exercise is decorative.
  const projInSystem = !!proj && sys.includes(proj);
  const buckets = Object.fromEntries(SECTIONS.map((k) => [k, 0]));
  buckets.system_instructions = Math.max(0, tok(sys) - (projInSystem ? tok(proj) : 0));
  buckets.project_instructions = proj ? tok(proj) : 0;
  // A delegated-tools provider is handed no schemas at all — the harness's
  // tool table stays on this side of the process boundary. Keep the number it
  // WOULD have cost visible under not_sent instead of silently zeroing it, so a
  // reader can tell an exclusion from a measurement that never ran.
  const schemaTokens = tools ? tok(JSON.stringify(tools)) : 0;
  buckets.tool_schemas = delegated ? 0 : schemaTokens;

  const perMessage = [];
  (messages || []).forEach((m, i) => {
    const bucket = SECTIONS.includes(classify(m, i)) ? classify(m, i) : 'other';
    const t = tok(contentText(m));
    buckets[bucket] += t;
    perMessage.push({ i, role: m && m.role, bucket, tokens_est: t });
  });

  const total = SECTIONS.reduce((a, k) => a + buckets[k], 0);
  const out = {
    role,
    destination: [provider, model].filter(Boolean).join('/') || 'unknown',
    est: { ...buckets, total_input: total },
    // Biggest first. The reason this exists is to name the monster.
    largest: SECTIONS.map((k) => [k, buckets[k]]).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => ({ section: k, tokens_est: v, share_pct: total ? Math.round((v / total) * 100) : 0 })),
    duplicates: duplicateSections(messages),
    messages: perMessage.length,
  };
  if (delegated) {
    out.delegated = true;
    if (schemaTokens) out.not_sent = { tool_schemas: schemaTokens, reason: 'provider runs its own tool loop; harness tool schemas are never sent' };
  }
  if (truncated && truncated.length) out.truncated = truncated;
  if (summarized && summarized.length) out.summarized = summarized;
  if (reported && (reported.in || reported.cacheRead || reported.cacheWrite)) attachReported(out, reported);
  return out;
}

// The provider's own numbers, married to the estimate on one record. Exported
// because the harness attaches them AFTER the call returns — two copies of this
// arithmetic is how `unaccounted` ended up undefined on the only path that
// actually runs.
// `sent` is the EXACT outbound payload the provider layer actually wrote, when
// it can say so — { total_chars, prompt_chars, turns }. For a delegated CLI it
// is the one honest measure of "our" share: the estimate above is derived from
// the message array, while the CLI flattens that array into a single prompt.
function attachReported(acct, usage, sent = null) {
  if (!acct || !usage) return acct;
  const total = (acct.est && acct.est.total_input) || 0;
  const input = usage.in || usage.input || 0;
  const cached = usage.cacheRead || usage.cached || 0;
  const gap = Math.max(0, input - total);
  const gapPct = input ? Math.round((gap / input) * 100) : null;
  const rep = {
    input,
    cached,
    uncached: Math.max(0, input - cached),
    cache_write: usage.cacheWrite || usage.cache_write || 0,
    // If this drifts far from 1.0 the ESTIMATE is wrong, not the bill.
    est_over_reported: input ? Number((total / input).toFixed(2)) : null,
  };
  if (acct.delegated) {
    // THE PART THE HARNESS CANNOT SEE, NAMED. With a CLI provider (claude-cli,
    // cursor-cli) the billed input is CUMULATIVE over that CLI's own inner
    // turns and contains its own system prompt, its native tool schemas and its
    // cache preamble — none of which pass through this harness, so no amount of
    // compaction on our side touches them. Measured on a trivial turn: 4,623
    // estimated against 27,505 billed. Calling that gap "unaccounted" read as a
    // hole in OUR accounting; it is a different context, and saying so is the
    // difference between "our prompt is huge" and "most of this is not ours",
    // which are opposite fixes.
    rep.cli_internal_context = gap;
    rep.cli_internal_pct = gapPct;
    // Honest unknown: a CLI that does not report its inner-turn count gets
    // null, never 1 and never a guess — the per-turn share of that cumulative
    // figure is simply not derivable without it.
    const turns = [usage.turns, usage.num_turns, sent && sent.turns].find((t) => Number.isFinite(t));
    rep.cli_inner_turns = Number.isFinite(turns) ? turns : null;
  } else {
    rep.unaccounted = gap;
    rep.unaccounted_pct = gapPct;
  }
  acct.reported = rep;
  if (sent && Number.isFinite(sent.total_chars)) {
    acct.sent = {
      chars: sent.total_chars,
      ...(Number.isFinite(sent.prompt_chars) ? { prompt_chars: sent.prompt_chars } : {}),
      tokens_est: approxTokens(sent.total_chars),
    };
  }
  return acct;
}

// Per-turn (and upstream per-node, per-mission) rollup. Sums sections, keeps the
// worst repeat offenders, and counts calls by role so "the judge cost more than
// the work" is visible without arithmetic.
function rollupContext(accounts) {
  const list = (accounts || []).filter(Boolean);
  if (!list.length) return null;
  const sections = Object.fromEntries(SECTIONS.map((k) => [k, 0]));
  const byRole = {};
  let reportedIn = 0, cached = 0, cacheWrite = 0;
  // Split the gap by what it IS, per call, instead of re-deriving one aggregate
  // difference: a turn can mix a delegated CLI worker with a native-API judge,
  // and one subtraction over both labels the judge's overhead as CLI-internal.
  let cliInternal = 0, unaccounted = 0, delegatedCalls = 0, innerTurns = 0, turnsKnown = false;
  for (const a of list) {
    for (const k of SECTIONS) sections[k] += (a.est && a.est[k]) || 0;
    byRole[a.role] = (byRole[a.role] || 0) + 1;
    if (a.reported) {
      reportedIn += a.reported.input || 0; cached += a.reported.cached || 0; cacheWrite += a.reported.cache_write || 0;
      if (a.delegated) {
        delegatedCalls++;
        cliInternal += a.reported.cli_internal_context || 0;
        if (Number.isFinite(a.reported.cli_inner_turns)) { turnsKnown = true; innerTurns += a.reported.cli_inner_turns; }
      } else unaccounted += a.reported.unaccounted || 0;
    }
  }
  const total = SECTIONS.reduce((x, k) => x + sections[k], 0);
  const dupes = new Map();
  for (const a of list) {
    for (const d of a.duplicates || []) {
      const prev = dupes.get(d.label);
      if (prev) { prev.times += d.times - 1; prev.wasted_tokens_est += d.wasted_tokens_est; }
      else dupes.set(d.label, { ...d });
    }
  }
  return {
    calls: list.length,
    calls_by_role: byRole,
    est: { ...sections, total_input: total },
    largest: SECTIONS.map((k) => [k, sections[k]]).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => ({ section: k, tokens_est: v, share_pct: total ? Math.round((v / total) * 100) : 0 })),
    duplicates: [...dupes.values()].sort((a, b) => b.wasted_tokens_est - a.wasted_tokens_est).slice(0, 8),
    ...(reportedIn ? { reported: {
      input: reportedIn, cached, uncached: Math.max(0, reportedIn - cached), cache_write: cacheWrite,
      ...(delegatedCalls < list.length ? {
        unaccounted,
        unaccounted_pct: Math.round((unaccounted / reportedIn) * 100),
      } : {}),
      ...(delegatedCalls ? {
        cli_internal_context: cliInternal,
        cli_internal_pct: Math.round((cliInternal / reportedIn) * 100),
        cli_calls: delegatedCalls,
        cli_inner_turns: turnsKnown ? innerTurns : null,
      } : {}),
    } } : {}),
  };
}

// A human line for the log, because a JSON blob in a terminal is not a finding.
function contextLine(acct) {
  if (!acct || !acct.est) return '';
  const top = (acct.largest || []).map((l) => `${l.section} ${l.tokens_est}~ (${l.share_pct}%)`).join(', ');
  const dup = (acct.duplicates || []).length ? ` · ${acct.duplicates.length} repeated section(s) costing ~${acct.duplicates.reduce((a, d) => a + d.wasted_tokens_est, 0)}` : '';
  const r = acct.reported;
  const rep = !r ? ''
    : acct.delegated
      // Never "not from this harness" as a mystery: it is that CLI's own
      // context, accumulated across its inner turns.
      ? ` · provider says ${r.input} in (${r.cached} cached, ${r.cli_internal_context} CLI-internal/session context = ${r.cli_internal_pct}%, ${r.cli_inner_turns == null ? 'inner turns unknown' : `${r.cli_inner_turns} inner turn(s)`})`
      : ` · provider says ${r.input} in (${r.cached} cached, ${r.unaccounted} not from this harness = ${r.unaccounted_pct}%)`;
  const sent = acct.sent ? ` · sent ${acct.sent.chars} chars exactly` : '';
  return `context[${acct.role}→${acct.destination}]: ~${acct.est.total_input} est${sent} — ${top}${dup}${rep}`;
}

module.exports = { accountContext, attachReported, rollupContext, duplicateSections, contextLine, contentText, SECTIONS };
