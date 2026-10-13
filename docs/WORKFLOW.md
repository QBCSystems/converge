# Workflow

This is the lifecycle of one change.

## 1. Task
A task has a title, description, done-when checks, and optionally a project test command. Modes are **split** (compatible changes may all land) and **compete** (a reviewer chooses a winner).

Before work starts, done-when checks are run against current `main`. A check that already passes, or cannot run, proves nothing about the future change and is refused.

## 2. Workers
Each worker gets its own fork, a git token scoped to that fork, and an MCP connection. Workers may be started by `converge run`, the swarm, or an external MCP client.

Recorded events begin with `TaskCreated`, `AgentAdded`, and, for kernel-run workers, `Contained`.

## 3. Claim
Workers claim files, folders, line ranges (`net/tcp.cpp:40-80`) or named units (`src/user.php#UserService.find`, `ci.yml#jobs.build`: a function, class, method, key or table, as `git outline` lists them) before editing. Claims are leases; an inactive claim expires after 20 minutes.

The engine checks overlap. Every overlap on a file is reported; it `collides` only when the claims genuinely conflict: the same line ranges, identical or nested AST units, or an entire file. Two agents can hold `Store.get` and `Store.put` in one file and both land safely.

Against in-flight changes, a unit claim collides only with a change that modified that specific unit. Narrow claims are strictly enforced: on submission, changed lines outside a claimed range and changed units outside declared scopes block landing until the claim is widened. Any imports and syntax outside every unit map to any claim on that file. For kernel-run workers, the claim is also the write permission: edits, whole-file writes, or shell commands mutating units outside a `file#Scope` claim are refused, and incomplete edits must remain strictly within the claimed unit's lines.

With `converge config --leases exclusive`, claims operate as strict exclusive leases. Any claim colliding with an active agent's claim or an in-flight change is rejected immediately. Furthermore, pushes modifying unclaimed units or files are rejected directly at the git pre-receive hook. On hosts without pre-receive hook support (e.g. Cloudflare Artifacts), the push is quarantined as `PushRefused`. In contrast, advisory leasing (`--leases soft`, the default) grants claims and reports potential collisions without hard-failing pushes.

Events: `IntentClaimed`, `IntentReleased`.

## 4. Work
The worker reads, writes claimed files, runs commands, commits, and pushes to its own fork. A kernel-run worker has every action checked and recorded as `Acted`.

A worker cannot push `main`.

## 5. Fetch and preview
converge fetches the exact pushed commit by hash. It does not inspect the worker's live filesystem or trust its summary.

The engine previews the merge against current `main` and reports conflicts.

Events: `Pushed`, `Preview`.

## 6. Submit
A submission contains a summary, the test command the worker ran, and optional claims with reproducible evidence.

The submission starts verification.

## 7. Verify
Checks run against the exact submitted commit in a clean workspace:

| Check | Purpose |
| --- | --- |
| Project test | Regression check |
| Worker test rerun | Reproduce the worker's report |
| Claim evidence | Verify factual claims |
| Done-when | Prove the task is complete |
| Scope | Prove only claimed files changed |

A shell check passes only with exit code 0 and no timeout. Reported test counts must match the rerun. Documentation deletion requires a claim and evidence.

Every result becomes a `Verified` event.

## 8. Ready and merge train
When required checks pass, the change becomes ready. Gate cells wake the engine; they do not make the landing decision.

The train takes up to eight ready changes, oldest first, merges them onto current `main`, and runs the combined project tests plus relevant done-when checks.

If the combined result fails, the train isolates the failing change. Other compatible changes can continue.

While one train verifies, the next is built on its tip and verified at the same time (a speculative line of trains). With `tracks` configured (`converge config --tracks auto` or `--tracks backend/,frontend/`), a train whose changes are independent of every train in flight (no file in common, or under a different one of the declared prefixes) is built on `main` instead: a track of its own, verified beside the others, landing as soon as it passes, and failing alone. A change that needs a train in flight is built on the latest train whose line holds all it needs; one that needs trains on two tracks at once (a change touching backend and frontend) is built on a merge of those tracks' tips, and lands after both. When a track lands on a `main` another track moved, its changes are merged again onto that `main`, and the result must be exactly that `main` plus the track's verified files; otherwise it is rebuilt. That `main` as a whole was never checked, so the train's checks then run on it; if they fail, the track's landings are undone (receipted undo commits, `CombinedFailed`), and its changes go back to the train, which builds and checks them on `main` as it now is, the other track's work included.

### Release branches
`converge config --targets release/1.x` names release branches besides `main`. A change submitted with `targets: ["release/1.x"]` lands on `main` first; then its landing is merged onto the branch's tip (one commit, "Backport ... to release/1.x"), the project's tests and the task's checks run there, and it is pushed with a receipt in that branch's own chain (`converge verify --target release/1.x` on a clone of the branch). One that does not merge onto the branch, or fails there, is held for that branch only (`TargetHeld`, shown in `status` and on the board) and stays landed on `main`. Events: `LandedOn`, `TargetHeld`.

### Stacks
A worker whose change is submitted can start the next one on top of it with `stack` instead of waiting for it to land. The next push is a new change that depends on the first: it lands after it (or on the same train right behind it), and its scope is its own edits on top of it. To amend a change lower in the stack, `switch_change` to it, reset the branch to its head, commit and push; converge rebases what is stacked on it onto the new head, publishes the rebased head at `refs/converge/stacks/<change>/<commit>` on main's remote, and checks it again. `status` says where to fetch it.

## 9. Review
With auto-land off, a reviewer must ship. Reviewers can pick a winner, select compatible split changes, ship, or hold with a reason. The same landing rule applies.

## 10. Land
Landing uses a safe compare-and-set operation: set `main` to X only if it is still Y. A stale landing cannot overwrite a newer `main`.

A signing key is required.

## 11. Receipt
A successful landing gets an Ed25519-signed git note under `refs/notes/converge`. The receipt records the landing facts and the previous receipt hash, and `signer`: the agent key whose SSH signature the landed head carries (null when it was not signed).

Verify it from a clone:

```sh
converge verify --repo <clone> --project <name>
```

This checks the receipt chain, each agent's signature on the head it landed (an independent SSHSIG check, the same one `git verify-commit` does), and, with `--project`, that every receipt is in the engine's transparency log under a tree head the engine key signed.

### Signed commits
Each agent signs its commits with its own Ed25519 key, the way git signs with `gpg.format=ssh`. Agents converge runs get a key in their run folder (beside the clone, not in it), git configured to sign with it, and its public half registered with the `signing_key` tool. Agents run elsewhere do the same themselves:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/converge_agent -N ''
git config gpg.format ssh
git config user.signingkey ~/.ssh/converge_agent
git config commit.gpgsign true
```

then call `signing_key` with the `.pub` line. An agent registers a key once; only the operator replaces one (`POST /api/projects/:p/agents/:a/key {key}`), so a stolen MCP key cannot swap in its own. With `converge config --signing required`, a push whose head is unsigned, or signed by any key but its agent's, is refused by the fork's pre-receive check (set aside, with a notice, on a host that cannot refuse), and such a head cannot be submitted.

### Transparency log
Every receipt the engine signs (landings, undos and rewinds of main, landings on release branches) is also a leaf of an append-only Merkle log, as Certificate Transparency keeps one (RFC 9162). `GET /api/projects/:p/log` serves its signed tree head; `/log/inclusion?commit=C`, `/log/consistency?from=M&size=N` and `/log/leaves` serve the proofs. The chain already shows order to anyone holding the engine key; the log adds what the chain cannot: whoever keeps a tree head can later demand proof that the log only grew. Run a witness somewhere converge does not control (another machine, a scheduled CI job):

```sh
converge witness --project <name> [--state witness.json]
```

It remembers the tree head and, each time, checks that the new one extends it; a receipt rewritten or dropped since, even by someone holding the engine key, fails that check.

### The engine's key
The receipt key is the engine's own (a seed in its data or in `CONVERGE_RECEIPT_SEED`), or held in a key service the engine never reads it from: `CONVERGE_RECEIPT_SIGNER` (or `--receipt-signer`) names a command that prints the public key (`<cmd> public`) and signs stdin (`<cmd> sign`). `scripts/receipt-signer.sh` fronts Google Cloud KMS (an `EC_SIGN_ED25519` key), HashiCorp Vault transit (an `ed25519` key) or, to try the interface, a local PEM file. Every signature it returns is checked against the public key, and a receipt is signed before main moves: when the signer is down, nothing lands. On Cloudflare the engine runs as WebAssembly and cannot run a command: its seed is the `RECEIPT_SEED` secret.

## 12. Failure and retry
- Failed check → fix and submit again.
- Conflict → rebase against current `main`, then submit again.
- Stale claim → claim expires.
- Stalled worker → another worker can take over its committed state.
- Interrupted run → unfinished commits remain in the worker fork.
- Agent rewind → restore an earlier recorded cycle.
- Main rewind → create a new commit containing the earlier content; history is not erased.

## Collaboration
Workers do not need direct model-to-model messaging. They share state through `peers`, `contenders`, `diff`, `context`, claims, conflicts, and the repository itself.
