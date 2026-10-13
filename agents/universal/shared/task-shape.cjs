'use strict';
// task-shape.cjs — the ONE place the harness reads a task's *shape*.
//
// History: universal-agent.cjs grew four separate vocabulary classifiers that
// all tried to answer "what kind of ask is this" — looksBuildShaped (its own
// verb list), buildIntent (a DIFFERENT verb list), briefIntent (a THIRD,
// typo-tolerant list), and looksLikeItNeedsTools (~40 topic words deciding
// whether tools were even advertised). They drifted independently, and each
// divergence was a works-sometimes bug: "delete the stale tarballs" was build
// work to one list and not another; "write a script with error handling"
// matched a smalltalk pattern and got ZERO tools while "create a script…"
// worked. Same ask, different phrasing, different capability.
//
// Principles, in force here:
//   1. SYNTAX over vocabulary. A path, a file extension, a backticked
//      command, a URL, a tool's own name — those are observable facts about
//      the text. "trello"/"inbox"/"database" are guesses about topic, and
//      topic lists always have a hole with someone's real task in it.
//   2. LITERAL FORMS only for smalltalk. A greeting is the WHOLE message, not
//      a prefix — "hi, what's in my inbox?" is a task wearing a greeting.
//   3. ONE list per concept. Every consumer imports it; divergence is now a
//      merge conflict instead of a silent fork.
//
// Everything here is deterministic and cheap — shape decides prompt dressing,
// budgets, and nudges. It must never gate capability hard: the model can
// always ignore advertised tools, and a steer always re-opens them.

// ---------- smalltalk: literal, whole-message forms ----------
// The tail allowance is punctuation/emoji only. The old form allowed 80 chars
// of ANYTHING after the greeting, which is why a topic-word veto list had to
// exist at all — "hi, check my trello board" matched "hi…". Kill the tail,
// kill the list.
const GREETING_FORM_RE = /^(?:hi|hiya|hello|hey|yo|sup|thanks?|thank you|ty|good (?:morning|afternoon|evening|night)|who are you\??|what are you\??|who r u\??|what can you do\??|what do you do\??|how are you\??|how'?s it going\??|are you (?:there|alive|ok|okay|working)\??)[\s!?.😀-🙏]{0,12}$/iu;

// "Reply with exactly: X" / 'say "hello"' — a pure text task ONLY when the
// payload is literally present in the message (after a colon, or quoted).
// Presence of the payload is syntax; "reply with my last email" has no
// payload and therefore is NOT this form — it needs tools to fetch the email.
const REPLY_WITH_VERB_RE = /^(?:please\s+)?(?:reply|respond|say|answer|print|output|echo)\b/i;
const INLINE_PAYLOAD_RE = /(?::\s*\S|"[^"]{1,200}"|'[^']{1,200}'|`[^`]{1,200}`|\b(?:exactly|verbatim)\b)/;

function isGreetingForm(t) {
  return GREETING_FORM_RE.test(String(t || '').trim());
}
function isReplyWithForm(t) {
  const s = String(t || '').trim();
  return REPLY_WITH_VERB_RE.test(s) && INLINE_PAYLOAD_RE.test(s);
}

// ---------- external state: syntax, not topic ----------
// True when the text refers to something only a tool can see: a path, a file
// extension, a backticked command, a URL, an @mention, or one of the
// harness's OWN tool names (passed in — the tool roster is a system fact that
// updates itself; an English topic list never does).
// THE TRIGGER HAS TO BE NARROWER THAN THE PUNISHMENT.
//
// This decides looksLikeItNeedsTools, which sets mustUseTools, which THROWS AWAY
// a finished answer and tells the model "this task requires using tools and you
// have made ZERO tool calls — do not answer from memory". So a false positive
// here costs a discarded correct reply and a wasted round trip, every time.
//
// It was firing on ordinary English (measured 2026-08-04):
//   - `[~\\/]` matched any slash: "and/or", "he/she", "8/4".
//   - `\.[a-z0-9]{1,5}\b` matched any dotted pair: "e.g.", "i.e.", "v2.1".
//   - the tool-name loop was a SUBSTRING match over a roster containing `done`
//     and `blocked`, so "are we done?", "thanks, all done" and "why are you
//     blocked" all claimed to need tools.
// It also contradicted the system prompt, which tells the model that greetings,
// acknowledgements and questions about prior conversation take ZERO tool calls —
// and it disabled the smallTalk exemption, which requires this to be false.
//
// Now: a path needs a real separator or a real extension, a tool name must match
// on WORD BOUNDARIES, and the two control verbs are not evidence of anything.
// A slash is a path separator OR an English idiom, and `src/utils` has to stay a
// path while `and/or` stops being one. Rooted and multi-segment forms are
// unambiguous; a bare `a/b` is a path unless BOTH sides are idiom/number words.
const ROOTED_PATH_RE = /(?:^|\s|["'(])(?:~|\.{1,2})?\/[\w.@-]/;           // /a, ./a, ~/a
const MULTI_SEG_RE = /\S\/\S+\/\S/;                                       // a/b/c
const SLASH_PAIR_RE = /(?:^|[\s"'(])([\w.@-]+)\/([\w.@-]+)(?=[\s"').,;:!?]|$)/g;
const SLASH_IDIOM_RE = /^(?:and|or|nor|and-or|he|she|his|her|him|they|them|it|yes|no|on|off|true|false|in|out|up|down|i|o|w|km|mi|hr?|s|m|a|b|ab|\d+)$/i;
function pathish(s) {
  if (ROOTED_PATH_RE.test(s) || MULTI_SEG_RE.test(s)) return true;
  for (const m of String(s).matchAll(SLASH_PAIR_RE)) {
    if (!SLASH_IDIOM_RE.test(m[1]) || !SLASH_IDIOM_RE.test(m[2])) return true;
  }
  return false;
}
const FILE_EXT_RE = /\b[\w.-]+\.(?:jsx?|tsx?|cjs|mjs|json|md|txt|html?|css|scss|py|sh|bash|zsh|ya?ml|toml|ini|env|xml|csv|tsv|sql|log|lock|png|jpe?g|gif|svg|webp|pdf|zip|tar|gz|go|rs|java|rb|php|cs|swift|kt|cpp?|hh?|hpp)\b/i;
// Control-flow tools. `done`/`blocked` are how a run REPORTS, not things only a
// tool can see, and both are common English in a chat message.
const CONTROL_TOOLS = new Set(['done', 'blocked']);
function mentionsExternalState(t, toolNames = []) {
  const s = String(t || '');
  if (pathish(s) || FILE_EXT_RE.test(s)) return true;             // paths, real filenames
  if (/`[^`]+`|https?:\/\/|\bwww\./i.test(s)) return true;        // commands, urls
  if (/(^|\s)@\w/.test(s)) return true;                           // @file mentions
  const low = s.toLowerCase();
  for (const n of toolNames) {
    const name = String(n || '').toLowerCase();
    if (!name || CONTROL_TOOLS.has(name)) continue;
    // Word-boundary, and \b is wrong for names containing '_' (\w includes it),
    // so bound on a non-name character instead.
    if (new RegExp(`(^|[^a-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`).test(low)) return true;
  }
  return false;
}

// ---------- build shape: one verb list, shared guards ----------
// THE canonical build/change verb list (the broadest of the three it replaces
// — the narrower copies existed only by accident of when each was written).
const BUILD_VERB_RE = /\b(?:buil[dt]\w*|bild|creat\w*|mak\w*|implement\w*|scaffold|generat\w*|set ?up|refactor\w*|rebuil\w*|rewrit\w*|redesign\w*|restyle|revamp|initiali[sz]\w*|fix\w*|patch\w*|wire\w*|add\w*|updat\w*|chang\w*|design\w*|writ\w*|improv\w*|enhanc\w*|polish\w*|extend\w*|expand\w*|upgrad\w*|optimi[sz]\w*|port\w*|migrat\w*|convert\w*|integrat\w*|remov\w*|delet\w*|replac\w*|render\w*|draw\w*|animat\w*|styl\w*)\b/i;
// "make it look cooler/sleeker" — an aesthetic-improvement ask with no verb
// from the list above.
const AESTHETIC_RE = /\b(?:looks?|feels?|renders?)\s+(?:way\s+|much\s+|a bit\s+|far\s+)?(?:cooler|better|nicer|cleaner|slicker|sleeker|smoother|polished|sharper)\b/i;
// A leading interrogative/read-only word → conversational, whatever verbs follow.
const QUESTION_LEAD_RE = /^\s*(?:what|why|how|who|whom|when|where|which|whose|is|are|am|was|were|do|does|did|can|could|should|would|will|shall|may|might|list|show|tell|explain|describe|summar\w*|read|open|find|search|look|check|status|help|hi|hey|hello|yo|thanks|thank|please tell|remind|draft|reply|respond|send|email|message|schedule|book)\b/i;
// A question or complaint ANYWHERE stays conversation. Watched live: "tell me
// why you opened another company's website... render back to me here"
// contains "render" — and an angry complaint became a hallucinated build
// mission, twice.
const CONVERSATION_ANYWHERE_RE = /\?|\b(?:tell me|explain|why (?:did|do|does|is|are|was|were|have|has|it|you)|what (?:happened|went wrong|did you|is going on)|you (?:opened|did|broke|deleted|changed|failed|ignored)|check your)\b/i;

function isQuestionLead(t) { return QUESTION_LEAD_RE.test(String(t || '')); }
function isConversation(t) { return CONVERSATION_ANYWHERE_RE.test(String(t || '')); }
function hasBuildVerb(t) { const s = String(t || ''); return BUILD_VERB_RE.test(s) || AESTHETIC_RE.test(s); }

// Build-shaped enough to auto-route toward mission/gate machinery. Strictest
// guards: any conversational signal anywhere vetoes.
// WHEN THE OPERATOR HAS ALREADY SAID "BUILD", DO NOT RE-GUESS FROM THE TEXT.
//
// looksBuildShaped below decides whether an AMBIGUOUS chat message should be
// auto-routed into build machinery, so its guards are deliberately veto-heavy:
// anything long, anything with a question mark, anything with a conversational
// tell is refused. That is right for auto-routing and INVERTED for a mission an
// operator dispatched on purpose (`the harness mission …`, `/mission …`, fleet
// mode:'build'), because the two most build-shaped things an operator ever
// writes are a long detailed brief and a brief containing a question mark —
// and both were vetoed.
//
// What that cost, watched live: a build mission to add destructible fortresses
// was classed not-build on text alone, so the RESEARCH planner ran ("the LAST
// stage delivers the finished written result (report / analysis /
// recommendation / memo)"). The worker diagnosed the integration points across
// 34 real tool steps and then turned its final stage into a recommendation memo
// — and the pass rule, which counts prose as output on non-build missions,
// accepted it. The game was never changed.
//
// A declared build only has to still be about making something. Nothing else
// gets a vote.
function looksBuildShapedDeclared(t) {
  return hasBuildVerb(String(t || '').trim());
}
function looksBuildShaped(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 2000) return false;
  if (isQuestionLead(s)) return false;
  if (isConversation(s)) return false;
  return hasBuildVerb(s);
}

// Build INTENT for in-turn machinery (verify gate, token ceiling, permission
// nudge). Milder guard than looksBuildShaped on purpose: a trailing question
// ("add a null check — why does it crash?") is still change work.
function buildIntent(t) {
  const s = String(t || '');
  return hasBuildVerb(s) && !isQuestionLead(s);
}

// Brief-worthy: a from-scratch creation ask (typo-tolerant stems — real users
// type "buil me duck hutn"), NOT a small change, NOT a question. The brief
// invents a 4–8 requirement spec; running it on "fix the null check" derails
// a one-line change (watched live).
const CREATION_STEM_RE = /\b(?:buil[a-z]*|bild|creat[a-z]*|mak[a-z]*|implement[a-z]*|scaffold|generat[a-z]*|set\s?up)\b/i;
const SMALL_CHANGE_RE = /\b(?:fix|patch|add|updat[a-z]*|chang[a-z]*|edit|refactor|rewrit)\b/i;
function briefEligible(t) {
  const s = String(t || '');
  return CREATION_STEM_RE.test(s) && !SMALL_CHANGE_RE.test(s) && !isQuestionLead(s);
}

// ---------- explicit execution-policy directives (user-authored) ----------
// A user can put HARD constraints in the objective that outrank the harness's
// own governance. Two are load-bearing:
//
//   * "do not use tools / advisory only" must stop the minimum-tool-call and
//     evidence-repair bounces from ever REPLACING a valid answer — the harness
//     must take the model's first valid reply as the deliverable, not force a
//     tool call the user forbade.
//   * "focused tests only / no full suite / do not run npm test" must stop the
//     project-wide auto-gate (npm test, pytest, cargo…) from being stapled onto
//     a turn whose focused tests already passed.
//
// Both read ONLY the user's own objective text. They must never see harness
// boilerplate (the OUTPUT CONTRACT) or model output — otherwise a sentence the
// harness wrote ("do NOT use tools" in a handoff nudge) or the model narrated
// would trip the user's policy. Callers pass the contract-stripped objective.

// An explicit prohibition of tools/commands/file inspection, or a self-declared
// advisory turn. Anchored on a negating verb ("do not use tools") or a
// standalone directive form ("tool-free", "no tool calls", "advisory only") —
// NOT on the bare adjective "no tools", which also appears in build asks like
// "add a no-tools flag", so those still gate normally.
const FORBIDS_TOOLS_RES = [
  /\b(?:do\s*n[o']?t|don'?t|do\s+not|never|please\s+do\s+not|no\s+need\s+to)\s+(?:\w+\s+){0,4}?(?:use|using|call|calling|invoke|invoking|need)\s+(?:any\s+|the\s+)?tools?\b/i,
  /\b(?:do\s*n[o']?t|don'?t|do\s+not|never)\s+(?:\w+\s+){0,3}?(?:run|running|execute|executing|use)\s+(?:any\s+)?commands?\b/i,
  /\b(?:do\s*n[o']?t|don'?t|do\s+not|never)\s+(?:\w+\s+){0,3}?(?:inspect|inspecting|read|reading|open|opening|touch|access|accessing)\s+(?:any\s+)?files?\b/i,
  /\bwithout\s+(?:using\s+|running\s+|calling\s+|invoking\s+)?(?:any\s+)?(?:tools?|tool\s+calls?|commands?)\b/i,
  /\btool[\s-]?free\b/i,
  /\bno\s+tool\s+calls?\b/i,
  /\b(?:purely|strictly)\s+advisory\b|\badvisory[\s-]only\b|\bno[\s-]?tools?\s+(?:advisory|mode|turn|answer|response)\b/i,
];
function forbidsTools(t) {
  const s = String(t || '');
  return FORBIDS_TOOLS_RES.some((re) => re.test(s));
}

// A prohibition of the project-wide/whole-repo test suite, or an explicit
// "focused tests only" scope. Sentence-scoped negation for the suite phrasing
// (same technique as the harness's explicit-verify extractor) so a NEGATED
// mention of "npm test" is read as a prohibition, not a request to run it.
const FULL_SUITE_RE = /\b(?:full|whole|entire|complete)\s+(?:npm\s+)?(?:test\s+)?suite\b|\bnpm\s+(?:run\s+)?test\b|\bnode\s+test\/run(?:\.cjs)?\b|\byarn\s+test\b|\bpnpm\s+test\b|\bthe\s+(?:full|whole|entire)\s+suite\b/gi;
const SCOPE_FORBID_RE = /\b(?:do\s*n[o']?t|don'?t|do\s+not|never|no|avoid|skip|without|refrain\s+from|under\s+no\s+circumstance)\b/i;
function restrictsTestScope(t) {
  const s = String(t || '');
  // "focused tests only" / "only the focused|relevant|specific|new|nearest tests"
  if (/\b(?:focused|relevant|specific|targeted|new|nearest)\s+tests?\s+only\b/i.test(s)) return true;
  if (/\bonly\s+(?:the\s+)?(?:focused|relevant|specific|targeted|new|nearest)\s+(?:\w+\s+){0,2}?tests?\b/i.test(s)) return true;
  // A PHP task that names its complete verification pair explicitly should
  // not have an unrelated JavaScript project-wide suite stapled on afterward.
  // This is the common repository-safe contract: lint every touched PHP file
  // and check the diff itself. It is narrower than treating any named command
  // as exclusive; both signals must be present.
  if (/\bphp\s+-l\b/i.test(s) && /\bgit\s+diff\s+--check\b/i.test(s)) return true;
  // an explicit prohibition of the full suite, negation in the same sentence
  const re = new RegExp(FULL_SUITE_RE.source, 'gi');
  let m;
  while ((m = re.exec(s))) {
    const start = Math.max(s.lastIndexOf('.', m.index), s.lastIndexOf('!', m.index), s.lastIndexOf('?', m.index), s.lastIndexOf('\n', m.index), s.lastIndexOf(';', m.index)) + 1;
    const sentence = s.slice(start, m.index);
    if (SCOPE_FORBID_RE.test(sentence)) return true;
  }
  return false;
}

// ---------- an explicitly requested ceiling on tool calls ----------
// "use at most 8 tool calls" is a BOUNDARY the operator set, and the harness has
// to hold it: a diagnostic that asked for 8 came back with a receipt reporting 9,
// because the only ceilings that existed were the harness's own defaults
// (CONVERGE_CLI_TOOL_CAP 12/25, AGENT_RESEARCH_HARD_CAP 45) and none of them read
// the request. Strictest match wins — a task naming two numbers means the smaller.
// A ceiling only; "use 8 tool calls" without a limiting word is not a cap.
const NUMBER_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
const N = '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)';
const CALLS = '(?:tool[- ]?calls?|tool[- ]?uses?|tools?)';
const TOOL_CAP_RES = [
  // "at most 8 tool calls", "no more than 8 tools", "maximum of 8 tool calls"
  new RegExp(`\\b(at most|no more than|not more than|fewer than|less than|maximum of|maximum|max|up to|limited to|limit to|capped at|capped to|cap at|cap to)\\s+${N}\\s+${CALLS}\\b`, 'gi'),
  // "8 tool calls at most", "8 tool calls maximum", "8 tool calls or fewer"
  new RegExp(`\\b${N}\\s+${CALLS}\\s+(at most|maximum|max|or fewer|or less)\\b`, 'gi'),
];
function requestedToolCallCap(t) {
  const s = String(t || '');
  let cap = null;
  for (const [i, re] of TOOL_CAP_RES.entries()) {
    const r = new RegExp(re.source, 'gi');
    let m;
    while ((m = r.exec(s))) {
      const [word, raw] = i === 0 ? [m[1], m[2]] : [m[2], m[1]];
      const n = /^\d+$/.test(raw) ? parseInt(String(raw), 10) : NUMBER_WORD[String(raw).toLowerCase()];
      if (!Number.isFinite(n)) continue;
      // "fewer than 8" means 7; every other phrasing includes the number.
      const bound = /^(?:fewer than|less than)$/i.test(String(word).trim()) ? n - 1 : n;
      if (bound >= 1 && (cap == null || bound < cap)) cap = bound;
    }
  }
  return cap;
}

// ---------- workflow bucketing (for the model capability registry) ----------
// Which KIND of work a task is, for per-workflow model ratings ("best at").
// Lived in registry.cjs as yet another private keyword list; one home now.
// Order matters: specific intents win over the 'coding' default.
function classifyWorkflow(text) {
  const t = String(text || '').toLowerCase();
  if (/\bplan\b|\bplanning\b|split .* stages|roadmap|milestones/.test(t)) return 'planning';
  if (/\b(ui|css|layout|visual|design|responsive|contrast|spacing|theme|styling|graphics?|screenshot|polish|dark mode|mobile)\b/.test(t)) return 'ui';
  if (/\b(fix|repair|debug|diagnos\w*|broken|failing|regress\w*)\b/.test(t)) return 'repair';
  if (/\b(readme|document\w*|docs|changelog|write-?up)\b/.test(t)) return 'documentation';
  if (/\b(investigat\w*|research|find out|locate|inspect|audit|why does|analy[sz]e|trace|understand)\b/.test(t)) return 'investigation';
  return 'coding';
}

module.exports = {
  classifyWorkflow,
  isGreetingForm, isReplyWithForm, mentionsExternalState,
  hasBuildVerb, isQuestionLead, isConversation,
  looksBuildShaped, looksBuildShapedDeclared, buildIntent, briefEligible,
  forbidsTools, restrictsTestScope, requestedToolCallCap,
};
