(function () {
'use strict';
// Harness scaffolding is not conversation, and must never be rendered as one.
//
// Mid-turn the harness injects user-role messages the operator never typed: raw
// TOOL RESULT dumps (up to 20KB of file content), HARNESS CHECK nudges, MODEL
// HANDOFF notices, compaction summaries. universal-agent.cjs scrubs these out of
// its own chat.json on load and save — but every OTHER surface reads its own
// copy, and only some of them knew to filter.
//
// Measured 2026-08-02: the GUI reimplemented three of these eight patterns from
// memory, and the console had none at all. So a reopened console thread showed
// `TOOL RESULT (read_file): 'use strict'; …` as a user bubble — a whole file,
// unfenced, rendered as prose. Reported as "why does it sometimes escape
// markdown and dump whole files".
//
// One list, one steer rule, three consumers (the harness requires it, the
// console server scrubs with it, the GUI renderer loads it off /shared/), so a
// new scaffold shape is added once rather than in three places and forgotten in
// two of them.

// Every prefix the harness has ever injected as a user-role message. Anchored:
// an operator who genuinely starts a sentence with "You have NOT answered yet"
// is writing prose, and would be matched by a loose search.
const SCAFFOLD = [
  /^TOOL RESULT \(/,
  /^\[?HARNESS\b/,          // "HARNESS CHECK…", "[HARNESS WARNING]…", "[HARNESS INTERCEPTOR]…", "HARNESS — …"
  /^\[?SYSTEM\b/,           // "[SYSTEM WARNING]…"
  /^MODEL HANDOFF\b/,
  /^CONVERSATION SO FAR \([^)]*compacted/,
  /^Your last three tool calls all failed/,
  /^You have made \d+ consecutive read-only tool calls/,
  /^You are out of (time|budget|token budget)\b/,
  /^You have NOT answered yet\b/,
];

// A steer is NOT scaffolding to delete. It is the operator's own message with a
// harness preamble wrapped round it, so the words come back out — otherwise the
// thing you typed either vanishes or shows up wearing machine boilerplate.
const STEER_WRAPPER = /^USER MESSAGE \(sent while you were working[^)]*\):\n([\s\S]*)$/;

function isScaffold(content) {
  const s = typeof content === 'string' ? content : '';
  return !!s && SCAFFOLD.some((re) => re.test(s));
}

// A CLI inner-tool ceiling dump (providers.cjs formatCeilingStop). When a turn
// continues or recovers after the budget pause, this text used to be saved as a
// real assistant message beside the eventual answer — reload then showed
// "Last calls: mcp → …" as full bubbles and Copy looked incomplete/scrambled.
function isCeilingReport(content) {
  return typeof content === 'string' && /⚠ Harness ceiling:/.test(content);
}

// A caveat the harness APPENDS to a finished reply for the operator. The model
// did not write it, and must not read one back next turn as a live instruction
// (a reply ended "not Verified, until the harness confirms it",
// the user typed "?", and the turn went and verified the PREVIOUS task).
const CAVEAT_LINE = /^(?:⚠ Harness (?:check|ceiling):|ℹ Repository state \(pre-existing)/;
function stripHarnessCaveats(content) {
  if (typeof content !== 'string' || !/[⚠ℹ]/.test(content)) return content;
  const kept = content.split(/\n{2,}/).filter((block) => !CAVEAT_LINE.test(block.trim()));
  const out = kept.join('\n\n').trim();
  // A reply that was ONLY caveats still has to occupy its slot in the history.
  return out || content;
}

// The operator's words if this is a wrapped steer, else ''.
function recoverSteer(content) {
  const m = typeof content === 'string' ? STEER_WRAPPER.exec(content) : null;
  return m ? String(m[1] || '').trim() : '';
}

const USER_REQUEST_WRAPPER = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i;
function unwrapUserRequest(content) {
  if (typeof content !== 'string') return content;
  const m = USER_REQUEST_WRAPPER.exec(content);
  let str = m ? m[1].trim() : content;
  str = str.replace(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/gi, '').trim();
  return str || content;
}

// Filter a rendered transcript. Deliberately NOT the harness's full
// scrubChatHistory: that one also drops assistant answers the harness rejected,
// which is right for what the model gets fed and wrong for what a human reads —
// a rejected answer is part of what happened and the operator may want to see
// it. This only removes messages the operator never sent, and unwraps the ones
// they did.
function scrubForDisplay(messages) {
  const src = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i];
    if (!m || typeof m.content !== 'string') { if (m) out.push(m); continue; }
    if (m.role === 'assistant') {
      if (isCeilingReport(m.content)) {
        let superseded = false;
        for (let k = i + 1; k < src.length; k++) {
          const n = src[k];
          if (n && n.role === 'assistant' && !n._harness && !isCeilingReport(n.content)) {
            superseded = true;
            break;
          }
        }
        if (superseded) continue;
      }
      out.push(m);
      continue;
    }
    if (m.role !== 'user') { out.push(m); continue; }
    const steer = recoverSteer(m.content);
    if (steer) { out.push({ ...m, content: unwrapUserRequest(steer) }); continue; }
    if (isScaffold(m.content)) continue;
    out.push({ ...m, content: unwrapUserRequest(m.content) });
  }
  return out;
}

const api = { SCAFFOLD, STEER_WRAPPER, CAVEAT_LINE, isScaffold, isCeilingReport, stripHarnessCaveats, recoverSteer, unwrapUserRequest, scrubForDisplay };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ConvergeChatScaffold = api;
})();
