// MCP tool approval settings that are separate from Codex’s command approval policy (#421).

import { POSTBOX_SERVER } from './setup.mjs';

/** Codex CLI overrides that keep Postbox’s own UI tools out of its approval flow. */
export const postboxMcpApprovalArgs = () => ['-c', `mcp_servers.${POSTBOX_SERVER}.default_tools_approval_mode="approve"`];

/**
 * In Ask me, make every configured third-party MCP tool prompt. Codex has no wildcard policy for raw MCP servers,
 * so enumerate the app-server’s inventory and apply one thread override per server. Other modes retain Codex’s Auto.
 * @param {(method: string, params?: any) => Promise<any>} request @param {boolean} ask
 */
export async function codexMcpPromptConfig(request, ask) {
  if (!ask) return undefined;
  const config = {};
  const cursors = new Set();
  let cursor = null;
  do {
    const page = await request('mcpServerStatus/list', { cursor, limit: 100, detail: 'toolsAndAuthOnly' });
    for (const server of page?.data ?? []) {
      const name = typeof server?.name === 'string' ? server.name : '';
      if (name && name !== POSTBOX_SERVER) config[`mcp_servers.${JSON.stringify(name)}.default_tools_approval_mode`] = 'prompt';
    }
    cursor = typeof page?.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor) ? page.nextCursor : null;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return Object.keys(config).length ? config : undefined;
}
