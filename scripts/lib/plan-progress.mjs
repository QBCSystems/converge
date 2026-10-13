// Server-side reducer for the live progress of a plan check: the check runner's events in, one snapshot out for the board.

export function createPlanProgress() {
  let current = null;
  let done = false;
  const tasks = {};
  return {
    apply(event) {
      if (!event) return;
      if (event.type === 'task') {
        current = event.key;
        tasks[event.key] = [];
      } else if (event.type === 'check') {
        if (!tasks[event.key]) tasks[event.key] = [];
        tasks[event.key][event.index] = event.status;
      } else if (event.type === 'done') {
        current = null;
        done = true;
      }
    },
    snapshot() {
      return { current, tasks: Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, [...v]])), done };
    },
  };
}