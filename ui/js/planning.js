import { describePlanProgress } from './plan-progress.js';

// What the board says while a run has no tasks yet: which planning phase it is in, and the planner's newest step.
const TITLES = { planning: 'Planning', 'checking the plan': 'Checking the plan', replanning: 'Fixing the plan' };

export function planningView(run) {
  const title = run && TITLES[run.status || run.phase];
  if (!title) return null;
  return {
    title,
    detail: (title === TITLES['checking the plan'] && run.planProgress ? describePlanProgress(run.planProgress).join(' \u00b7 ') : '') || run.planNote || run.planStep || 'The planner is reading the request',
    active: true,
  };
}
