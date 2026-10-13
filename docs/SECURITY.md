# Security and Trust Boundaries

> **Never let the model be the authority over the thing it is trying to change.**

## Trust model

Trusted enforcement lives in the platform and engine: repository operations, check association, scope calculation, merging, landing decisions, and receipt signing.

Untrusted inputs include model output, worker claims, test reports, summaries, evidence, commits, code under test, and external MCP clients.

A worker can be useful without being trusted.

## Credentials
Workers do not receive the credential used to move `main`. Each worker gets a token scoped to its own fork.

MCP credentials are scoped to the worker. Reviewer and administrator credentials expose different operations.

Admin access controls projects, tasks, workers, and recovery. View access is read-only.

Landing requires the platform's Ed25519 receipt key.

## Kernel containment
For kernel-run workers, the model emits an action request and the kernel decides whether it is allowed.

Examples:

| Request | Result |
| --- | --- |
| Read worker files | Allowed |
| Write claimed file | Allowed |
| Write unclaimed file | Refused |
| Push own fork | Allowed |
| Push `main` | Refused |
| Run outside the execution boundary | Refused |

The model does not directly operate the host.

External MCP workers are not kernel-run, but their repository and API credentials remain scoped.

## Verification
Checks run against the exact submitted commit in a clean workspace.

The engine does not trust the worker's filesystem or summary.

A worker test report is rerun. If counts or exit status differ, the submission is held.

## Scope
The engine computes changed files and AST scopes (`file#Scope`), comparing them against the worker's active claims.

This creates two barriers:

1. **At authoring time**: the kernel and git pre-receive hooks block unauthorized file writes or edits outside claimed AST scopes;
2. **At verification time**: post-commit scope analysis catches any out-of-scope mutations, rejecting the submission before it can enter the merge train.

## Evidence
Claims must have reproducible evidence: exact file text, or command output plus expected exit status.

A statement such as "this function is unused" has no authority without evidence that converge can reproduce.

## Documentation deletion
Deleting documentation requires a claim naming the affected file and evidence supporting the deletion. Supported documentation includes common text/markup files and anything under `docs/`.

## Merge safety
Individual checks do not authorize a landing. The merge train verifies the combined result so individually passing changes cannot silently break one another.

Landing uses compare-and-set semantics:

```
set main = X only if main is still Y
```

A stale train cannot overwrite newer main.

## Receipts
Every landing gets an Ed25519-signed note under `refs/notes/converge`, chained to the previous receipt. Verification fails on a missing receipt, invalid signature, or broken chain.

Receipts name the agent key whose SSH signature the landed head carries; with `signing: required`, unsigned heads and heads signed by another agent's key are refused at push. Each receipt is also a leaf of an RFC 9162 Merkle log with signed tree heads, so a witness that kept an earlier head detects any later rewrite, including one made with the engine's own key (`converge witness`). The engine key can live in a key service behind `CONVERGE_RECEIPT_SIGNER` (Google Cloud KMS, Vault transit), so the engine host never holds it.

What this does not cover: an agent's key is only as safe as the machine it runs on; a witness only protects the history it saw (run one early, and from somewhere converge does not control); and the log proves what the engine signed, not that the checks it records were right.

## Local execution
Linux checks use Landlock. macOS uses Seatbelt. Windows runs agents at low integrity under converge-jail.

The actual boundary depends on the selected local mode.

## Cloudflare limitation
Cloudflare runner containers provide filesystem isolation and use an unprivileged user.

**Their network is not fenced.**

Do not describe Cloudflare checks as network-isolated. The local Linux boundary and Cloudflare runner boundary are not identical.

## Threats addressed

| Threat | Control |
| --- | --- |
| Model pushes main | No main credential |
| Model lies about tests | Exact-commit rerun |
| Undeclared file change | Claim enforcement + scope verification |
| Tested code differs from submitted code | Verification fetches submitted commit |
| Concurrent main race | Atomic main update |
| Individually good changes break together | Merge-train verification |
| Reviewer requests invalid landing | Same landing rule still applies |
| Dashboard history is disputed | Event log + signed receipts |

## What converge does not prove

converge does not prove that code is good in a human sense. It proves the facts its checks are designed to prove.

If a project has weak checks, converge can faithfully land code that satisfies weak checks.

**Good checks are part of the security boundary.**
