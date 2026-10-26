// MCP tool approval settings that are separate from Codex’s command approval policy (#421).

import { POSTBOX_SERVER } from './setup.mjs';

/** Codex CLI overrides that keep Postbox’s own UI tools out of its approval flow. */
export const postboxMcpApprovalArgs = () => ['-c', `mcp_servers.${POSTBOX_SERVER}.default_tools_approval_mode="approve"`];

/**
 * Apply MCP tool approval independently from command approval. Ask me and Accept edits prompt; Auto approves every
 * enabled server. Run everything keeps Codex’s own policy. Raw, plugin, and hosted-app servers have separate paths.
 * @param {(method: string, params?: any) => Promise<any>} request @param {string} mode
 */
export async function codexMcpApprovalConfig(request, mode) {
  const approval = mode === 'auto' ? 'approve' : mode === 'ask' || mode === 'acceptEdits' ? 'prompt' : null;
  if (!approval) return undefined;
  const config = {};
  const cursors = new Set();
  let cursor = null;
  do {
    let page;
    try {
      page = await request('mcpServerStatus/list', { cursor, limit: 100, detail: 'toolsAndAuthOnly' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex couldn’t list its MCP servers, so Postbox can’t apply this permission mode to them: ${reason}`, { cause: error });
    }
    for (const server of page?.data ?? []) {
      const name = typeof server?.name === 'string' ? server.name : '';
      if (!name || name === POSTBOX_SERVER) continue;
      const plugin = typeof server?.pluginId === 'string' ? server.pluginId : '';
      if ([name, plugin].some((part) => part.includes('.')))
        throw new Error(`Codex MCP server “${name}” has a dot in its name or plugin ID, so Postbox can’t apply this permission mode to its tools.`);
      const key =
        name === 'codex_apps'
          ? 'apps._default.default_tools_approval_mode'
          : plugin
            ? `plugins.${plugin}.mcp_servers.${name}.default_tools_approval_mode`
            : `mcp_servers.${name}.default_tools_approval_mode`;
      config[key] = approval;
    }
    cursor = typeof page?.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor) ? page.nextCursor : null;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return Object.keys(config).length ? config : undefined;
}
