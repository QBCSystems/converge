# Architecture

converge separates worker execution from deterministic verification and landing.

## Data flow

```
task → worker fork → claim → edit → commit/push
     → exact commit → checks/evidence/scope
     → ready → merge train → combined checks
     → landing rule → main + signed receipt
```

## Engine
The engine owns event/state handling, repository operations, merge logic, verification state, landing decisions, receipts, state persistence, and the merge train.

The engine has its own git implementation; it does not shell out to the host `git` binary for repository decisions. In Cloudflare Workers, it runs as WebAssembly (`worker/engine.wasm`). Locally, it runs as prebuilt native binaries in `kernel/<os>-<arch>/bin/`.

The landing decision is centralized in `landing_refusal`. Every route to `main` must satisfy the same rule.

## Runtime Kernel
converge uses a sandboxed runtime as its kernel boundary and execution substrate, packaged as prebuilt binaries in `kernel/` rather than requiring a local compiler toolchain.

## Worker
`worker/` contains the Cloudflare control plane: API, authentication, project Durable Objects, engine/WASM integration, runners, Artifacts, GitHub integration, and the runner watchdog.

The Worker carries requests and state; it does not replace the engine's landing authority.

## Runner
`runner/runner.mjs` and the runner image execute verification commands against clean workspaces created from exact commits.

## Agents
`agents/` contains the CLI, swarm, optional planner, MCP bridge, and runtime clients. Agents are clients of converge, not the authority over it.

## Kernel boundary
A kernel-run worker's model emits requests such as read, write, run, commit, push, or call converge. The kernel checks each request and either performs or refuses it.

The model therefore does not directly receive host file, shell, network, or main-repository authority.

External MCP workers are not kernel-run, but their fork credentials and converge permissions remain scoped.

## Claims and scope
Claims have two jobs:

1. prevent conflicting workers from editing the same area;
2. give the engine a declared scope to compare against the actual commit.

Kernel enforcement happens before a write. Engine scope verification happens after the commit exists.

## Verification
Checks are tied to the exact commit and record command, exit code, timeout state, output, and check kind. A pass on an older commit cannot satisfy a newer submission.

Evidence is mechanical: exact text, or command output plus expected exit status.

There is no model quality score in the landing decision.

## Merge engine
Repository-level merging handles paths, renames, and crossed histories. File-level merging uses three-way line merging.

Normal behavior: unrelated edits merge, identical edits collapse, overlapping different edits conflict.

A deliberate special case keeps both additions when both sides only add lines at the same location, removing duplicate import lines. This is useful for shared registries.

When the lines conflict, the file is merged again on its syntax tree (Tree-sitter, in the kernel: C, Go, Java, JavaScript, JSON, PHP, Python, Rust, SQL, TOML, TypeScript, and YAML). Declarations are matched by kind and name, imports by module, and object keys by key. This allows two functions added at the same location, distinct methods added to one class, or independent keys added to the end of a dictionary to merge cleanly where a line merge would conflict. Where both sides changed the same declaration, its members are merged one level deeper. The structural merge strictly fails closed: it falls back to standard conflict markers if elements cannot be placed unambiguously, or if the merged result fails to parse.

A successful merge is not proof of correctness, so the merge train verifies the combined result again.

## Stacked changes
A worker can stack a new change on its own submitted one (the `stack` tool) and keep going while the first is in review. The stacked change depends on the one below it: it lands only after it, or right behind it on the same merge train (the train orders a stack bottom first and leaves a change off when the one below is neither landed nor ahead of it). Its claim, scope and documentation checks look at its own edits on top of the change below, not the whole stack.

When a change lower in the stack is amended (`switch_change`, then a push), the engine rebases everything stacked on it: the stacked change's own edits, from the head it was built on to its head, are merged three ways onto the new head and written as one commit whose parent is that head. The commit is published on main's remote at `refs/converge/stacks/<change>/<commit>` (the agent fetches it from there, and check runners check it out from there), recorded as `Restacked`, checked again, and the same happens one level up. A conflict goes to the change's agent like any other.

## Decision selection

### SAT solver
The engine includes a SAT solver for split-mode selection. It chooses a compatible set of ready changes from the compatibility constraints already established by converge.

The solver is not a code-quality judge. Verification establishes whether a change passed its required checks; the SAT step solves the separate problem of which compatible set can move through the merge train together.

## Event log and ASQL

### Event log
The project event log is the authoritative sequence of state transitions. Examples include `TaskCreated`, `IntentClaimed`, `Pushed`, `Submitted`, `Verified`, `Landed`, `MainAdvanced`, `Conflicted`, and `Acted`.

Locally it lives under `~/.converge/local`; on Cloudflare it lives in the project Durable Object.

### ASQL
ASQL holds live queryable state derived from the event log. The event log remains authoritative; ASQL can be rebuilt from it.

This gives the engine a durable state model that can be queried without making the query layer the source of truth.

## Cells and bits

### Cells
Cells are derived database values. converge uses gate cells to track check counts, passed counts, ready, and failed state.

### Bits
Ready and failed state are represented as gate bits used to wake the engine when relevant state changes. A bit is a state signal, not the landing authority: the engine still evaluates the actual landing rule before anything reaches `main`.

Read-only SQL is exposed through the project API, for example:

```
GET /api/projects/<project>/sql?q=SHOW CELLS
```

## Receipts
Landing receipts are Ed25519-signed git notes under `refs/notes/converge`. Each contains the landing facts and the previous receipt hash, forming a verifiable chain, and the agent key whose SSH signature the landed head carries. Every receipt is also a leaf of an RFC 9162 Merkle log (`converge-engine/src/log.cpp`) whose signed tree heads and inclusion and consistency proofs let witnesses hold the engine to an append-only history. Receipts are signed before main moves, by the engine's key or by a key service behind `CONVERGE_RECEIPT_SIGNER`.

The landing protocol (claims, leases, trains, tracks, the combined check and its undo, receipts) is modelled in TLA+ in `converge-engine/spec/` and model-checked with TLC: six safety invariants and two liveness properties, within the bounds its configurations set.

## Merge train
The train takes up to eight ready changes, merges them onto current `main`, verifies the combined result, isolates failures when necessary, and lands the passing set.

Trains in flight form a DAG: each is built on `main`, on the train it needs, or on a merge of the trains it needs. Without tracks configured, trains execute in a single serial queue. With `--tracks` (`auto` or declared path prefixes), independent changes execute on isolated tracks on `main`, verifying and landing in parallel. If a landing encounters a `main` moved by another track, the changes are re-merged and verified. If the combined checks fail, the offending track's changes are rolled back automatically via an undo receipt.

Landed changes with configured release targets (`--targets`) are automatically merged onto each release branch, verified, and sealed in that branch's receipt chain. Speculative train merges execute in memory via `Git::MemoryWrites`; disk I/O occurs only when checked out for testing or landed. Furthermore, if a train touches no files read by the project's tests during a baseline run, those tests are skipped.

## Cloudflare topology

```
Client → Worker
          ├─ Project Durable Object → event log + engine.wasm
          ├─ Artifacts → project and worker forks
          ├─ Queue → push events
          └─ Runner containers → exact-commit checks
```

## Local topology
The engine runs one process per project. Linux checks use Landlock; macOS uses Seatbelt; Windows runs agents at low integrity under converge-jail.

## Repository responsibilities

| Directory | Responsibility |
| --- | --- |
| `kernel/` | Prebuilt runtime binaries per `<os>-<arch>` |
| `worker/` | Cloudflare API, Durable Objects, and WebAssembly engine |
| `runner/` | Check execution |
| `agents/` | CLI, swarm, planner, MCP |
| `scripts/` | Build, deployment, image, and local |
| `test/` | Automated tests |
| `ui/` | Dashboard |
| `sandbox/` | The Worker that runs teams on Cloudflare (one container per run) and the public sandbox |
| `docs/` | Human documentation |

## Useful source locations
- `worker/engine.wasm` — WebAssembly compiled engine running in Durable Objects
- `kernel/` — native binaries for macOS and Linux
- `worker/project.ts` — project Durable Object
- `worker/runner.ts` — runner lifecycle
- `scripts/oci.mjs` — runner image construction
