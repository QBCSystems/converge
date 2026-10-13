// Arguments the swarm is started with that depend on the planner's preflight. --checks-tried tells the swarm the plan's
// checks already passed (agents/swarm.mjs), so it does not check them again. Only a run that starts right after such a
// plan passes it; every other start gets none.
export function swarmCheckArgs(planChecked) {
  return planChecked ? ['--checks-tried'] : [];
}