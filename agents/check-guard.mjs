// Which planned checks can never pass, told from their text alone (used by agents/swarm.mjs's preflight).
// A check that cannot pass however good the work is, told from its text alone. Failing on main (what the run below
// proves) is not enough: a check that fails for every agent forever sends each of them round in circles until the run
// escalates, having spent a model's whole budget on a task nobody could finish.
export function checkCannotPass(check) {
  // The sandbox every check runs in has no network at all, loopback included (no listening, no connecting).
  if (/(?<![\\\w-])(?:curl|wget|ncat|nc)(?![\w-])|(?:^|[\s'"/=])(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\[::1\])(?::\d+)?|\bnode\s+\S*(?:server|app|index)\.js\b[^|;]*&(?!&)/i.test(check))
    return 'a check needs the network (a server and curl, localhost): the checks run in a sandbox with no network at all, loopback included, so it fails whatever the agent writes. Check the code by calling it directly (require the module and call the function or handler), not through a server';
  // Starting the platform or a dev server is no check: it needs ports and the network the sandbox denies, so it runs to
  // its time limit for every agent (seen: a plan's check ran scripts/local.sh start).
  if (/(?:^|[\s;&|(])(?:\S*scripts\/local\.sh|\S*dev-server\.mjs|npm\s+(?:run\s+)?(?:start|dev)\b|wrangler\s+dev\b)/.test(check))
    return 'a check starts the platform or a dev server: the sandbox has no ports or network, so it can only time out. Check the code it would run directly instead (read the file it prints from, or call the function)';
  // A program handed to the shell in double quotes (node -e "...", python3 -c "...") may not contain double quotes of its
  // own: the shell ends the string there and strips them, so the program sees different text than the author wrote.
  const m = /^\s*(?:\w+=\S+\s+)*(?:node|python3?|ruby|perl)\s+(?:--[\w-]+(?:=\S+)?\s+)*-[ecp]\s+"/.exec(check);
  if (m) {
    let i = m[0].length, closed = -1;
    for (; i < check.length; i++) { if (check[i] === '\\') { i++; continue; } if (check[i] === '"') { closed = i; break; } }
    const rest = closed < 0 ? '' : check.slice(closed + 1).trimStart();
    if (closed >= 0 && rest && !/^(?:&&|\|\||[;|&)<>]|\d?>)/.test(rest))
      return `a check's quoting is broken: its double-quoted program contains double quotes of its own, which the shell strips before the program runs (it would see ${JSON.stringify(rest.slice(0, 24))} where the author wrote more). Put the program in single quotes and use only double quotes inside it, or write it to a file`;
  }
  // A check that reads a source file's text (grep, readFileSync, cat of a .js/.py/... file) passes on words, not on what
  // the code does: one such check let a change through that removed the very behaviour it was written for. Only a
  // removal checks the source, and negated (! git grep -nw name -- file): the name must be gone.
  const src = /(?:\b(?:git\s+grep|grep|egrep|fgrep|rg)\b|readFileSync\s*\(|\bcat\s)[^|;&]*?[\w./-]+\.(?:c?m?js|tsx?|py|c|cc|cpp|h|hpp|go|rs|java|rb)\b/g;
  for (const hit of check.matchAll(src)) {
    const before = check.slice(0, hit.index);
    if (/!\s*(?:\(\s*)?$/.test(before)) continue;   // ! grep ...: a removal
    return `a check reads the source's text (${hit[0].trim().slice(0, 80)}): it passes on what the file says, not on what the code does. Run the code instead (require the module and call the function, run the command), and check its result. Only a removal may look at the source, negated: ! git grep -nw <name> -- <file>`;
  }
  return '';
}
