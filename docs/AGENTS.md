# Agents and MCP

## Worker modes

### Kernel-run
converge starts the model. The model emits requests; the kernel checks and performs them.

### External MCP
You run the model client yourself and connect through MCP. It is not kernel-run, but its repository and converge credentials remain scoped and its commits still require normal verification and landing.

## Join a task

```sh
export CONVERGE_API_URL=http://127.0.0.1:8787
npm run converge -- join --project myapp --task <task-id>
```

The command prints MCP connection details for supported clients.

Worker tools include:

```
status claim release peers submit stack switch_change diff contenders context git_credentials signing_key
```

Reviewer tools include:

```
status peers contenders diff pick ship context
```

## Recommended worker loop

```
status → read → claim → write → test → commit → push → submit
                                      ↑                 │
                                      └── fix if refused┘
```

The authoritative test result is the verification converge performs after submission, not the worker's first local run.

## Claims
Claim the narrowest useful scope before editing:

```
src/logic/palindrome.js
src/logic/palindrome.js:40-80
src/models/user.cpp#class:User::update_preferences
src/user.php#UserService.find
src/tools/
```

Claims are visible to peers and can overlap-check. With unit leases (`file#Scope`), multiple agents can claim different functions or classes within the same file simultaneously without colliding.

## Evidence
Good evidence is reproducible:

- exact expected text in a file
- command output containing expected text
- command exit status

Weak evidence is a model statement such as "I checked it" or "this is unused."

## Test reports
If reporting test counts, include the command. converge reruns it and compares the result.

```
command: node --test test/palindrome.test.mjs
reported: 4 passed, 0 failed
```

## Shared work
Workers do not need model-to-model chat. Use:

- `peers` for claims
- `contenders` for parallel attempts
- `diff` for another change
- `context` for landing notes

## Conflicts
On conflict:

1. update/rebase against current `main`
2. resolve
3. run checks
4. commit
5. push
6. submit again

Do not force a conflicting commit into `main`.

## Stacks
A submitted change does not have to land before the next one starts. Call `stack`, keep committing on top of the submitted head, and push: that push is a new change stacked on the first. It lands only after it, and its claim and diff are its own edits on top of it.

To fix a change lower in the stack (a check sent it back), call `switch_change` with its id, reset the branch to its head, commit and force-push. converge rebases everything stacked on it onto what you pushed and checks it again; before working on a stacked change again, `switch_change` back to it and fetch the rebased head that `status` names (`git fetch main refs/converge/stacks/<change>/<commit> && git reset --hard FETCH_HEAD`).

## Takeover
A stalled worker can be replaced from its committed state. The replacement continues the work instead of starting over; the old credentials are revoked.

## Swarm

```sh
node agents/swarm.mjs --project myapp --tasks tasks.json --budget 2
```

Use split for independently mergeable work. Use compete when several workers are solving the same task and a reviewer should choose.

## Planning
`agents/plan.mjs` can turn a natural-language request into tasks. It does not grant landing authority. Done-when checks are still executed by converge.

## Contract

> **The worker proposes. converge reproduces. The engine decides.**
