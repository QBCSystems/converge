# Operations

## Local requirements

- Node 22.6+
- git
- nothing to build: converge ships its kernel prebuilt in `kernel/<os>-<arch>/` for `linux-x64`, `darwin-arm64` and `win32-x64` (the engine, `converge-jail`, `aios-agent-control`, aios's agent runtime, `git` and `aios-sh`), and the universal agent in `agents/universal`. `kernel/<os>-<arch>/VERSION` names the commits they were built from

## Start

```sh
npm install
scripts/local.sh
scripts/local.sh status
scripts/local.sh logs
scripts/local.sh stop
```

The local service is normally at `http://127.0.0.1:8787`. Project state lives under `~/.converge/local`.

## Environment switches

- `CONVERGE_CLONE=http` — agents clone the fork over HTTP instead of copying the platform's on-disk store (see `cloneFromDisk` in `agents/common.mjs`). The copy is used whenever the store is on the same machine as the agent; over HTTP is the fallback for agents elsewhere.
- `CONVERGE_GIT=host` — use the machine's `git` instead of the kernel's `aios-git` (see `kernelOnPath` in `agents/common.mjs`).

## Fences

- **Linux:** agents' commands run under bubblewrap, checks under Landlock (`converge-jail`, Linux 6.7+). Without them runs refuse to start; nothing runs unfenced.
- **macOS:** agents and checks run under Seatbelt (`/usr/bin/sandbox-exec`, built in).
- **Windows:** agents run at low integrity under `converge-jail`, with `aios-sh` as their shell.

## Accounts and sign-in (local platform)

The local ASQL port follows `CONVERGE_PORT` (3307 on the default 8787, otherwise 20000 + the port modulo 10000) unless `AIOS_MYSQL_PORT` is set.

People sign in with an account stored in ASQL (the aios SQL engine, MySQL wire on `127.0.0.1:3307`; point at another with `AIOS_MYSQL_HOST`, `AIOS_MYSQL_PORT`, `AIOS_MYSQL_USER`, `AIOS_MYSQL_PASS_FILE`). The server creates the auth tables on boot. Create the first account (it becomes owner of the whole platform) with:

```sh
node scripts/auth-user.mjs you@example.com --name you      # prompts for the password
node scripts/auth-user.mjs dev@example.com --project app    # member of one project
```

`GET /api/setup` (no sign-in needed) answers `{"needsSetup": true}` until the first account exists, then `{"needsSetup": false}`.

On a fresh install with no accounts, an unauthenticated `POST /api/setup` with `{name, email, password}` creates the first account as an admin and signs it in; once any account exists it answers 409.

A session is a random token; ASQL keeps only its hash. Owners and admins of `*` may administer; other members see only their own projects. Passwords are scrypt hashes. Provider API keys and the Cloudflare token are encrypted in ASQL with a key in `~/.converge-local/secret.key` (0600; `CONVERGE_SECRET_KEY_FILE` moves it). Back that file up with the data: without it the stored credentials cannot be read. The agents get their model providers from ASQL too: converge reads them and hands them to the universal agent (`agents/universal`) in `CONVERGE_PROVIDERS_JSON`, so no run reads a key from a file. The shared agent service reads them when it starts: restart it after adding a key. `ADMIN_KEY` / `VIEW_KEY` remain for agents, CI and the deployed Worker, which cannot reach a local ASQL.

## Checks

```sh
npm run check
```

## Cloudflare topology

The deployment uses Workers, Durable Objects, Artifacts, Queues, runner containers, and engine WebAssembly.

The Worker handles API/MCP/git/dashboard traffic. A project Durable Object owns the event log and engine. Artifacts hold repositories and forks. Runner containers execute checks.

## Deploy

```sh
npx wrangler login
npm run provision
```

Both container images are built from this repository alone, by `scripts/oci.mjs` (Docker is not required): the check runner (`scripts/runner-image.sh`: `runner/runner.mjs` and the static `converge-jail` from `kernel/linux-x64`) and the sandbox (`sandbox/scripts/sandbox-image.sh`). `sandbox/scripts/sandbox-image.sh --rootfs DIR` writes the sandbox image out as a root filesystem instead of pushing it.

## Runs on Cloudflare (the sandbox Worker)

A run started from the dashboard on Cloudflare goes to the `converge-sandbox` Worker (`sandbox/`), which starts one container for it. Inside, `sandbox/image/entry.mjs` plans the request with `agents/plan.mjs`, tries every check on `main` with the swarm's preflight, and runs `agents/swarm.mjs --in-aios`: the same steps as a local run, each agent an aios entity on the kernel in `kernel/linux-x64`. The model is a Workers AI model behind the Worker's AI proxy, which meters every call against the run's budget. The container holds a token for its one project, never the admin key.

The same Worker serves the public sandbox when `SANDBOX_ENABLED` is `1`: a visitor picks a demo (`SANDBOX_TEMPLATES`), gets a throwaway `sandbox-<id>` project forked from it and a token that administers only that project for an hour, and lands on converge's own dashboard for it. Runs they start there are held to the session's caps: one at a time, at most 3 agents, `SESSION_AI_USD` in all, `DAILY_AI_USD` across every session.

Treat the generated environment file as secret material because it contains receipt-signing credentials.

## Cloudflare runner boundary

Runner containers are separate unprivileged execution environments with filesystem fencing.

**Their network is not fenced.**

This differs from the local Linux Landlock path.

## Runner lifecycle

Runner containers are billed while running. The watchdog stops idle containers after 12 minutes; the Wrangler cron runs the watchdog every five minutes.

The swarm and dashboard budget controls stop agents as the configured budget is approached. Free Workers AI also has provider limits.

## Keys

- **Admin:** project and recovery administration.
- **View:** read-only dashboard, diffs, and SQL.
- **Worker:** fork git token and worker-scoped MCP credential.
- **Receipt:** Ed25519 signing key required for landing.

No signing key means no landing.

## Audit

Clone and verify:

```sh
npm run converge -- verify --repo /tmp/myapp --project myapp
```

Receipts are git notes under `refs/notes/converge`.

## Replay and rewind

```sh
npm run converge -- replay --project myapp --agent <agent-id>
npm run converge -- rewind --project myapp --agent <agent-id> --cycle 3
npm run converge -- state --project myapp --at 120
npm run converge -- rewind --project myapp --to <commit>
npm run converge -- oplog --project myapp
npm run converge -- undo --project myapp [--seq <n>]
npm run converge -- redo --project myapp
```

Rewinding main goes back to an earlier commit and drops what landed after it. `undo` takes back one operation and keeps the rest: a landing, a rewind of main, or an earlier undo is reversed by a new commit on main (its own effect merged backwards onto main as it is now; refused, naming the files, when that conflicts with what landed since), landed with a signed receipt like any landing. A configuration change is reversed by restoring the configuration before it. `oplog` lists what can be taken back; `undo` with no `--seq` takes back the latest operation not already undone, and repeated undos walk further back; `redo` takes back the latest undo. The routes are `POST /api/projects/:p/undo {seq}` (admin) on both platforms.

A main rewind creates a new commit with old content; history is not erased.

## SQL inspection

Read-only project SQL examples:

```
GET /api/projects/<project>/sql?q=SELECT type, COUNT(*) FROM converge.events GROUP BY type
GET /api/projects/<project>/sql?q=SHOW CELLS
```

## Failure handling

- Failed check → worker fixes and resubmits.
- Conflict → rebase, resolve, test, push, resubmit.
- Stalled worker → takeover from committed state.
- Interrupted run → continue from worker fork.
- Engine restart → rebuild state from the event log.
- Open project deleted (the dashboard gets a 404) → it stops polling and reconnecting, shows "This project no longer exists." and returns to the projects list.

## GitHub

The Cloudflare deployment can connect a GitHub App and send landed work as pull requests on new branches. It does not directly overwrite the GitHub repository's `main`.

## Useful source locations

- `scripts/local.sh` — local lifecycle
- `scripts/provision.sh` — deployment
- `scripts/oci.mjs` — container images
- `sandbox/` — the sandbox Worker and the run container's entry script
- `scripts/check-jail.sh` — jail checks
- `worker/index.ts` — Worker entry
- `worker/project.ts` — project Durable Object
- `worker/runner.ts` — runner lifecycle
- `worker/watch.ts` — watchdog
