// Pure decision logic for continuing a stopped converge worker as a new agent.
//
// A worker that stops without finishing (out of cycles) and whose change has not landed is
// continued by the same command as a new agent that takes over its work (join with { from }),
// with a fresh cycle budget, up to --resumes times. A reviewer is never resumed.

/**
 * Whether a stopped worker should be continued as a new agent (takes over its work with --from).
 * Pure: finished (the entity completed its work), state landed/superseded (nothing left to do),
 * no resumes left, or a reviewer: false. Otherwise true.
 */
export function shouldResume({ finished, state, resumesLeft, role }) {
  if (finished) return false;
  if (state === 'landed' || state === 'superseded') return false;
  if (!(Number(resumesLeft) > 0)) return false;
  if (role === 'reviewer') return false;
  return true;
}

/**
 * How a run ended, from what the runtime returned and converge's status after it. aios's runtime lets a writer
 * finish after its third refused done even with checks outstanding (res.finished.outstanding); converge does not
 * count that as done: the run ends failed with the reason, and (resumes left) is continued like a stopped one.
 * Pure: { done, reason }.
 */
export function runOutcome({ finished, state, role }) {
  if (state === 'landed') return { done: true, reason: 'its change landed' };
  if (state === 'superseded') return { done: true, reason: 'its change was superseded by another contender' };
  if (!finished) return { done: false, reason: 'stopped before it finished' };
  const left = role === 'reviewer' ? [] : (Array.isArray(finished.outstanding) ? finished.outstanding : []);
  if (left.length) return { done: false, reason: `failed: it said done with checks outstanding (${left.join('; ').slice(0, 600)})` };
  return { done: true, reason: String(finished.summary || 'finished') };
}
