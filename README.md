# converge

**Many AI agents can work on one codebase at the same time. converge decides what reaches `main`.**

Agents write code in isolated forks. They do not control the repository, test checks, merges, or landings. A deterministic engine verifies commits against exact tests and claims, speculatively tests merges in memory, and advances `main` with cryptographic receipts.

There is no AI judge.

## Quickstart

Requires Node 22.6+ and git.

```sh
git clone https://github.com/QBCSystems/converge.git
cd converge
npm install
scripts/local.sh            # Platform and dashboard at http://127.0.0.1:8787
```

In the dashboard:
1. On first visit, set your admin credentials on the setup screen.
2. Add a model provider key in Settings (or select a local CLI agent tool).
3. Create a project from a folder, git URL, or template.
4. Submit a task prompt and press Start.

To stop the local engine: `scripts/local.sh stop`. Projects are stored in `~/.converge/local`.

### Cloudflare Deployment

Runs on Workers, Durable Objects, Artifacts, and runner containers:

```sh
npx wrangler login
npm run provision
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for credentials and operational details.

## How it works

```
task
  ↓
agent fork + credentials
  ↓
claim (file or file#Scope) → edit → commit → push
  ↓
pre-receive lease check
  ↓
fetch exact commit
  ↓
re-run tests + done-when checks + scope validation
  ↓
speculative DAG merge tracks (in-memory)
  ↓
verify combined integration
  ↓
atomic CAS landing on main
  ↓
Ed25519-signed receipt → RFC 9162 Merkle log
```

## Guarantees

- **Agents cannot push `main`.** Each worker receives isolated credentials scoped strictly to its fork.
- **The submitted commit is the source of truth.** converge fetches by exact commit SHA, never reading an agent's uncommitted working tree or trusting its report.
- **Checks are re-executed by converge.** Agent claims that "tests passed" are ignored. The runner executes test suites against the exact commit in a clean workspace.
- **Scope is enforced mechanically.** Edits are validated against file or AST unit claims (`file#Scope`). Out-of-scope edits are rejected on push.
- **In-engine merging.** Merges execute inside the engine's built-in git implementation rather than shelling out to host git.
- **Structural AST conflict resolution.** Where line merges conflict, Tree-sitter resolves distinct functions, classes, and imports across 12 languages (C, Go, Java, JavaScript, JSON, PHP, Python, Rust, SQL, TOML, TypeScript, YAML).
- **Parallel speculative DAG trains.** Disjoint changes test and land on parallel tracks in memory. Combined post-landing checks automatically roll back cross-track regressions.
- **Atomic, verifiable landings.** `main` advances via compare-and-swap. Every landing generates an Ed25519-signed receipt appended to an RFC 9162 Merkle transparency log.

## Architecture

| Component | Responsibility |
| --- | --- |
| Owner | Project configuration, tasks, and administrative access |
| Planner | Deconstructs requests into tasks and verifiable done-when checks |
| Worker | Implements changes inside an isolated fork workspace |
| Reviewer | Optional approval gate for sensitive changes |
| Kernel (`aios`) | Runtime sandboxing, capability enforcement, and filesystem isolation |
| Engine | Git operations, AST scope checks, speculative DAG trains, and signed receipts |
| Runner | Executes build and test checks against exact commit hashes |
| Host / Worker | REST API, WebSockets, Git HTTP, and dashboard |

## Verification

A change is evaluated against facts the engine reproduces:

- Project test command
- Task done-when commands
- Rerun of the worker's reported test command
- Evidence for submitted claims
- Changed-file and AST unit lease scopes
- Documentation deletion claims
- Combined cross-track merge-train result
- Landing authorization and receipt-signing availability

Checks run against the exact commit SHA being considered; earlier passes on older commits do not count.

See [docs/SECURITY.md](docs/SECURITY.md) for trust boundaries and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for implementation details.

## Merging

The engine owns merging directly without shelling out to `git`.

It handles renames, crossed histories, and three-way line merges. Non-conflicting additions at the same offset in shared registries or imports merge automatically without false conflicts.

When lines conflict, the engine reconciles on the syntax tree (Tree-sitter: C, Go, Java, JavaScript, JSON, PHP, Python, Rust, SQL, TOML, TypeScript, and YAML). Disjoint functions, methods, imports, and keys merge structurally; unresolvable ambiguities fall back to conflict markers.

Workers can build stacked pull requests (`git stack`). When a base change is amended, converge rebases downstream changes and re-runs checks automatically.

Independent tracks run speculative merges in memory, verifying combined integration before advancing `main`.

## Audit and recovery

Every state transition is recorded in an append-only event log.

Landings carry Ed25519-signed receipts in `refs/notes/converge` and an RFC 9162 Merkle transparency log:

```sh
converge verify --repo <clone> --project <name>
```

Any landing, rewind, or configuration change can be reversed with `POST /v1/undo`. The engine generates a clean three-way reverse merge commit without rewriting history or breaking stacked downstream changes.

## Sandboxing

- **Linux**: Local checks run under Landlock and namespaces.
- **macOS**: Checks run under Seatbelt profiles.
- **Windows**: Checks run under low-integrity `converge-jail`.
- **Cloudflare**: Checks run in container instances with filesystem isolation.

See [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Repository layout

```
agents/       Worker and swarm clients
kernel/       Prebuilt runtime binaries per <os>-<arch>
runner/       Local check runner
scripts/      Local, deployment, and image scripts
test/         Boundary tests: auth, secrets, jail, engine, runner
sandbox/      Cloudflare: container runner and public sandbox
ui/           Dashboard
worker/       Cloudflare Worker and Durable Objects
docs/         Project documentation
```

## License

Apache-2.0. See [LICENSE](LICENSE).
