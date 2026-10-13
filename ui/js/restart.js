/** What "Start over" does with a run: stop it first if it is still going, then ask again with the same request. */
export function restartRequest(run) {
  return { stop: run.status === 'planning' || run.status === 'running', request: run.request };
}
