'use strict';

// Reject extreme growth in an existing file before the validation gate can
// accept it. The two-part threshold avoids blocking large but balanced
// refactors, while catching accidental duplication or whole-app appendages.
const MASSIVE_ADDITION_LINES = 5000;
const MASSIVE_NET_GROWTH_LINES = 4000;

function pathologicalEditReason(files) {
  for (const file of files || []) {
    if (!file || file.action !== 'edited') continue;
    const added = Number(file.added) || 0;
    const removed = Number(file.removed) || 0;
    const net = added - removed;
    if (added < MASSIVE_ADDITION_LINES || net < MASSIVE_NET_GROWTH_LINES) continue;
    return `pathological edit blocked: ${file.path} adds ${added} lines and removes ${removed} (net +${net}). `
      + `This exceeds the harness safety limits (${MASSIVE_ADDITION_LINES} added and +${MASSIVE_NET_GROWTH_LINES} net) for an existing file. `
      + 'Inspect the diff for accidental duplication, then make focused edits or split an intentional expansion into reviewable files.';
  }
  return '';
}

module.exports = {
  pathologicalEditReason,
  MASSIVE_ADDITION_LINES,
  MASSIVE_NET_GROWTH_LINES,
};
