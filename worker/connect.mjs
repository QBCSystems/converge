// The ready-to-paste lines that connect an MCP client to one agent's place on converge. One copy for both callers:
// the API returns them with every agent it creates (worker/index.ts) and the CLI prints them (agents/converge.mjs).

/**
 * @param {string} agentId
 * @param {string} mcpUrl
 * @param {string} mcpKey
 * @returns {{ claude_code: string, gemini: string }}
 */
export function connectLines(agentId, mcpUrl, mcpKey) {
  const name = `converge-${agentId}`;
  return {
    claude_code: `claude mcp add --transport http ${name} ${mcpUrl} --header "Authorization: Bearer ${mcpKey}"`,
    gemini: `"mcpServers": {"${name}": {"httpUrl": "${mcpUrl}", "headers": {"Authorization": "Bearer ${mcpKey}"}}}`,
  };
}

/**
 * A clone of an agent's fork that works as printed: the agent's own fork token (never the admin key) as a Basic
 * auth header for the clone, then kept in the clone's config (for that remote only) so its pushes carry it too.
 * Without a token (a fork that needs none), a plain clone.
 * @param {string} remote
 * @param {string} token
 * @param {string} dir
 * @returns {string}
 */
export function cloneCommand(remote, token, dir) {
  if (!token) return `git clone ${remote} ${dir}`;
  const header = `Authorization: Basic ${btoa(`x:${token}`)}`;
  return `git -c http.extraHeader="${header}" clone ${remote} ${dir} && git -C ${dir} config http.${remote}.extraHeader "${header}"`;
}
