'use strict';
// "Did this turn rewrite the working tree wholesale, rather than author code?"
//
// This decides whether the harness's auto verify-gate should fire. A `git pull`
// / `merge` / `scp` rewrites hundreds of tracked source files; the turn-end
// sweep reports them all as changed, and treating that as "this turn changed
// code" made every deploy/merge/ops turn run the repo's ENTIRE test suite as
// its verify step — minutes and six figures of tokens verifying nothing about
// the deploy. Pulled code was verified where it was written; it is not this
// turn's deliverable.
//
// Detection is deliberately belt-and-braces, because command-string matching
// alone kept missing real cases:
//
//   * `npm run git-pull` does NOT match /git\s+pull/ — the hyphen is not
//     whitespace. This repo's own package.json defines `git-pull` and
//     `git-sync`, so the most convenient way to pull was the one route the
//     guard could not see.
//   * The pull can also arrive via a shell alias, a Makefile target, a deploy
//     script, or an inner CLI agent — none of which look like `git pull`.
//
// So the harness pairs two signals: this module's command matcher, and a HEAD
// comparison across the turn (any pull/merge/rebase/checkout/reset moves HEAD,
// whatever invoked it). The command matcher still earns its place because a
// non-git bulk sync — scp, rsync, tar -x, unzip — moves no commit and is
// invisible to the HEAD check.

// git subcommands that rewrite the working tree from another commit or remote.
// The leading run handles pre-subcommand flags, WITH OR WITHOUT a value, so
// both `git --no-pager merge` and `git -C /srv/app pull` are caught. The
// optional value is ambiguous with the subcommand itself (in `git --no-pager
// merge`, "merge" looks like a value) — backtracking resolves it, because a
// parse that swallows the subcommand leaves the alternation with nothing to
// match and is rejected.
// Only subcommands that bring in code the TURN DID NOT AUTHOR — verifying
// someone else's merged/pulled tree is not this turn's job. Deliberately
// EXCLUDES the authoring/no-op verbs that were here and inverted the purpose:
//   - `apply`/`am` apply a patch THIS turn is authoring → must stay GATED;
//   - `checkout -b`/`switch -c`/`worktree add` move NO tree at all.
// (A plain `checkout <branch>` does change the tree, but running the gate on
// an existing branch is harmless — the dangerous direction is skipping the
// gate on authored code, so these fail safe by no longer matching.)
const GIT_REWRITE = /\bgit\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*(?:pull|merge|rebase|reset|clone|revert|cherry-pick|subtree)\b/;
const GIT_STASH_RESTORE = /\bgit\s+stash\s+(?:pop|apply)\b/;
const GIT_SUBMODULE = /\bgit\s+submodule\b/;
const GIT_LFS = /\bgit\s+lfs\s+(?:pull|fetch)\b/;
// checkout/switch were dropped from GIT_REWRITE (so `checkout -b`/`switch -c`
// don't wrongly skip the gate) — but the PATHSPEC forms DO import another
// ref's file content into the tree with no commit move, exactly what this
// detector exists for. Catch those specifically: `git checkout <ref> -- path`
// (the ` -- ` separator) and `git restore --source=<ref>` / `--source <ref>`.
const GIT_REF_IMPORT = /\bgit\s+(?:checkout|restore)\b[^\n]*?(?:\s--\s|--source[=\s])/;

// Bulk file transfer and archive extraction. No commit moves for these, so the
// harness's HEAD comparison cannot see them — this is the only detector.
// Command-POSITION only (start, a shell separator/pipe, OR a command-
// substitution / subshell opener `( ` `$(` backtick): the bare word inside a
// filename, a heredoc, or `echo "rsync notes"` is not a sync, but
// `x=$(rsync …)` and `(scp …)` are.
const TRANSFER = /(?:^|[;&|(`$]|\s)(?:scp|rsync|sftp)\s/;
const TAR_EXTRACT = /\btar\s+(?:-?\w*x\w*\b|--extract)/;
const UNARCHIVE = /(?:^|[;&|(`$]|\s)(?:unzip|bsdtar)\s/;

// A package-manager script whose NAME describes a sync. Matching the script
// name rather than the whole command line is what keeps `npm test` and
// `npm run build` out of this, while catching `npm run git-sync`.
const PKG_SCRIPT = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:@/.-]+)/;
const SYNC_SCRIPT_NAME = /(?:^|[-:_.])(?:git|sync|pull|clone|deploy|fetch|rebase|merge)(?:[-:_.]|$)/i;

function isBulkSyncCommand(command) {
  const c = String(command || '');
  if (!c) return false;
  if (GIT_REWRITE.test(c) || GIT_REF_IMPORT.test(c) || GIT_STASH_RESTORE.test(c) || GIT_SUBMODULE.test(c) || GIT_LFS.test(c)) return true;
  if (TRANSFER.test(c) || TAR_EXTRACT.test(c) || UNARCHIVE.test(c)) return true;
  const m = c.match(PKG_SCRIPT);
  if (m && SYNC_SCRIPT_NAME.test(m[1])) return true;
  return false;
}

module.exports = { isBulkSyncCommand };
