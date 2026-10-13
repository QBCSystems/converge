// Turns a plan-check snapshot ({ current, tasks: { key: [label...] }, done }) into text lines for the board.
const LABELS = {
  'fails-on-main': 'fails on main, as it should',
  'already-passes': 'already passes',
  broken: 'broken',
  'timed-out': 'timed out',
};

export function describePlanProgress(snapshot) {
  if (!snapshot || snapshot.current == null) return ['Checking the plan\u2026'];
  const lines = ['Checking task ' + snapshot.current + '\u2026'];
  const tasks = snapshot.tasks || {};
  for (const key of Object.keys(tasks)) {
    (tasks[key] || []).forEach((result, index) => {
      lines.push(key + ' check ' + (index + 1) + ': ' + (LABELS[result] || result));
    });
  }
  return lines;
}