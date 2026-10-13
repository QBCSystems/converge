// Runs each task's accept checks in order and reports progress as it goes: one "task" event when a task starts,
// one "check" event per command as soon as its result is known.
export async function runPlanChecks(tasks, runOne, onEvent = () => {}) {
  for (const t of tasks) {
    onEvent({ type: 'task', key: t.key });
    const cmds = t.accept || [];
    for (let index = 0; index < cmds.length; index++) {
      const t0 = Date.now();
      const r = (await runOne(cmds[index])) || {};
      const status = r.timedOut ? 'timed-out' : r.broken ? 'broken' : r.code === 0 ? 'already-passes' : 'fails-on-main';
      onEvent({ type: 'check', key: t.key, index, status, ms: Date.now() - t0 });
    }
  }
}