# Tests

These are tests of boundaries that a person cannot easily see break: sign-in and secrets, the jail's rules, the
engine's HTTP framing and wasm interface, the runner's timeouts, when a stopped agent is resumed, what a check is
allowed to say. Each one runs the real code (a real ASQL, a real git, the real engine and jail binaries where there is
one) and asserts on what comes out.

Run them with Node 22.6 or newer:

```sh
npm test
```

A test here must say what the code is *for*, not repeat what it does. It is not proof that converge works: that is
running converge and looking at what happened. Do not add a test that mirrors an implementation (a string, a field
mapping, a mocked call count), and do not accept a green run from an agent as evidence.
