// A model that answers with its own tool-call markup instead of the JSON action the loop asks for (DeepSeek's
//   <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="run"><｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜DSML｜｜ parameter>...)
// means exactly what the JSON would: the same action with the same fields. The loop reads only JSON ("not an action"
// otherwise, a wasted cycle each time), so the markup is turned into that JSON where the model's answer comes in.
// A reply that already holds a JSON action is left alone, and so is anything that is not a recognisable call.

const INVOKE = /<[^<>]*?\binvoke\s+name="([^"]+)"[^<>]*>([\s\S]*?)<\/[^<>]*?\binvoke\s*>/;
const PARAM = /<[^<>]*?\bparameter\s+name="([^"]+)"([^<>]*)>([\s\S]*?)<\/[^<>]*?\bparameter\s*>/g;

/** The JSON action text for a reply in tool-call markup, or null when the reply is not that (or has a JSON action already). */
export function dsmlToAction(text) {
  const s = String(text || '');
  if (/\{\s*"action"\s*:/.test(s)) return null;
  const call = INVOKE.exec(s);
  if (!call) return null;
  const action = { action: call[1] };
  for (const m of call[2].matchAll(PARAM)) {
    const [, name, attrs, raw] = m;
    // string="false" marks a value that is JSON (a number, a boolean, an object); string="true" is text as written.
    let value = raw;
    if (/\bstring="false"/.test(attrs)) { try { value = JSON.parse(raw.trim()); } catch { value = raw.trim(); } }
    action[name] = value;
  }
  return JSON.stringify(action);
}

/** A model's answer, with a tool-call-markup answer replaced by the JSON action it stands for. */
export const normalizeAnswer = (answer) => dsmlToAction(answer) ?? answer;
