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
    let page;
    try {
      page = await request('mcpServerStatus/list', { cursor, limit: 100, detail: 'toolsAndAuthOnly' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex couldn’t list its MCP servers, so Ask me can’t make them ask first: ${reason}`, { cause: error });
    }
    for (const server of page?.data ?? []) {
      const name = typeof server?.name === 'string' ? server.name : '';
      if (!name || name === POSTBOX_SERVER) continue;
      if (name.includes('.')) throw new Error(`Codex MCP server “${name}” has a dot in its name, so Ask me can’t make its tools ask first.`);
      config[`mcp_servers.${name}.default_tools_approval_mode`] = 'prompt';
    }
    cursor = typeof page?.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor) ? page.nextCursor : null;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return Object.keys(config).length ? config : undefined;
}
