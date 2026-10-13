// Pure helpers for LIVE-WEB RESEARCH turns — finding facts, prices and links
// from real sources, with something verifiable to cite. Shared by the harness
// (universal-agent) and tests — no I/O.
//
// ── Why this file reads the way it does now ──────────────────────────────────
// It used to be shopping-specific, and not in a designed way: it was the fossil
// record of one bad dress-search session, where each failure got patched with a
// domain hack until the harness had a shopping MODE nobody asked for. Removed:
//
//   * an `isFashionListingTask` / `listingFashionScore` pair that up-weighted
//     "embroidered / sequin / mirror / belted" and down-weighted "striped /
//     plain / basic" — i.e. the harness held an opinion about clothes, and
//     retried queries until the results looked fancier.
//   * hardcoded category vocabulary (anarkali/kurta/saree/salwar) and an `anc`
//     noise-cancelling branch, each left over from one specific ask.
//   * `bits.push('ships USA')` — a US-shipping constraint appended to EVERY
//     query unconditionally, including ops turns that misrouted into research
//     (that is where the phantom "ships USA" queries came from).
//   * personal stopwords — 'wife', 'husband', 'her', 'his' — plus 'born' and
//     'lived', which are not shopping words at all; they are residue from a
//     biography lookup that once went through this same path.
//
// Then the mechanism itself went, not just the vocabulary: an intent classifier
// (isListingResearchTask) and a ~60-line regex query builder both tried to read
// MEANING out of prose with pattern matching, which has no stable form — every
// fix made the word lists longer, and the classifier caused the misroute it was
// meant to prevent (a listings search on `git log`). Both now live in the
// harness as ONE small model call, planWebResearch(), consistent with how this
// codebase already delegates judgment through routeFor(): checker, judge,
// planner, reviewer, vision.
//
// So the dividing line this file now sits on:
//
//   deterministic code  ->  observable FACTS   (did the fetch time out? is this
//                                               host a bot wall? is grep the
//                                               wrong instrument for a live
//                                               claim?)
//   model judgment      ->  MEANING            (what does the user want, what
//                                               should we search for)
//
// Everything left here is the first kind. Nothing here should ever need to know
// what is being shopped for, or care.

// Tool output that means "this host is a dead source this turn" — timeout,
// bot wall, or empty anti-bot interstitial. Used to quarantine the hostname
// so the model cannot burn the budget retrying it (watched live: one retailer
// timed out three times with no strategy change in between).
// ONE bot-wall vocabulary (task-shape.cjs rule: one list per concept). This
// used to exist as two diverged copies — looksBotBlocked (decides whether to
// pay for a real browser) lacked `datadome` while the quarantine list here
// had it, so a DataDome-walled retailer was never retried in the browser but
// WAS quarantined for the turn: a permanent give-up on a page never tried.
const BOT_WALL_RE = /\b(access denied|attention required|checking your browser|just a moment|cf-browser-verification|are you a robot|captcha|datadome|enable javascript and cookies)\b/i;

function isDeadSourceOutput(out) {
  const s = String(out || '');
  return /(?:^|\b)(?:FAILED|ERROR|Fetch timed out|timed out while retrieving|timeout|aborted|\(empty page\)|bot-blocked|looked bot-blocked)/i.test(s) || BOT_WALL_RE.test(s);
}

function hostFromUrl(url) {
  try { return new URL(String(url || '')).hostname.replace(/^www\./, '') || null; } catch { return null; }
}

function hostFromToolCall(name, args) {
  if (name === 'fetch_url') return hostFromUrl(args && args.url);
  if (name === 'browser' && String(args && args.action || '').toLowerCase() === 'navigate') return hostFromUrl(args && args.url);
  return null;
}

// Code-search tools are the wrong instrument for a claim about the live web: a
// grep of a local dump cannot corroborate a price or a fact on a page (watched
// live: a code-search over an agent-tools dump used to "confirm" a retail price).
const CODE_TOOLS = new Set([
  'search_code', 'search_index', 'index_codebase', 'check_diagnostics',
  'Grep', 'grep', 'Glob', 'glob',
]);

function isWrongInstrumentForResearch(name) {
  const n = String(name || '');
  if (CODE_TOOLS.has(n)) return true;
  if (/^cursor:(grep|glob|read|edit|write|shell)$/i.test(n) && !/^cursor:(webSearch|webFetch)$/i.test(n)) {
    // cursor:read of a saved image path is allowed elsewhere; block code
    // search and edits on a web-research turn.
    return /^cursor:(grep|glob|edit|write)$/i.test(n);
  }
  return false;
}

module.exports = {
  BOT_WALL_RE,
  isDeadSourceOutput,
  hostFromUrl,
  hostFromToolCall,
  isWrongInstrumentForResearch,
  CODE_TOOLS,
};
