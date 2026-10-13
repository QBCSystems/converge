# The universal agent

The provider-agnostic multi-step agent converge runs its agents with: one process, a sequential tool loop, and a
validation gate that checks the model's "done" against real command output. `universal-agent.cjs` is the agent;
`providers.cjs` is its model layer (OpenAI-compatible hosts, Anthropic, Gemini, Ollama, command-line agents);
`bridge.cjs` lets a converge agent think through the same providers. It needs only Node, no npm packages.

How converge uses it:

- **Providers come from ASQL.** converge reads the providers (keys, models, accounts, hosts) from ASQL and passes
  them in `CONVERGE_PROVIDERS_JSON`. The agent and the bridge use that and read no file. Run on their own they still
  read `~/.converge/config.json` (or `$CONVERGE_CONFIG`).
- **No SQLite.** The optional storage bridge that mirrored task state into a SQLite-compatible store was removed;
  task state is plain files under the agent's state directory.

Start it directly with `node universal-agent.cjs --help`.
