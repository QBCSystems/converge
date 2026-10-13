// Tiny JSON-RPC client for the worker's /mcp/:project endpoint (engine tools: diff, ship, context...).

let rpcId = 0;

/**
 * @returns {Promise<{ok: boolean, data: object, error: string}>}
 * The engine spreads a tool's fields onto `result` and also serialises them into content[0].text;
 * `data` is the former, falling back to parsing the latter.
 */
export async function mcpCall({ project, key, tool, args = {}, signal }) {
  let res;
  try {
    res = await fetch(`/mcp/${encodeURIComponent(project)}`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { ok: false, data: {}, error: 'Network error: could not reach the server' };
  }

  if (res.status === 401) return { ok: false, data: {}, error: 'The reviewer key was rejected' };
  if (res.status === 204) return { ok: false, data: {}, error: 'The engine returned an empty reply' };

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, data: {}, error: `Unexpected response (HTTP ${res.status})` };
  }
  if (body.error) return { ok: false, data: {}, error: body.error.message || 'Request failed' };

  const result = body.result || {};
  const { content, isError, ...fields } = result;
  const text = content?.[0]?.text || '';
  let data = fields;
  if (!Object.keys(fields).length || (fields.error && Object.keys(fields).length === 1)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch { /* plain-text error message */ }
  }
  if (isError) return { ok: false, data, error: result.error || (typeof text === 'string' && !text.startsWith('{') ? text : '') || 'The tool reported an error' };
  return { ok: true, data, error: '' };
}
