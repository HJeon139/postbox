// The environment Antigravity’s PreToolUse hook reads (agy-hook.mjs), for each turn of the Antigravity adapter
// (antigravity-cli.mjs). Moved out of antigravity-cli.mjs.

import { setupOf } from './setup.mjs';

/**
 * What the hook reads from its environment: its MCP server, the mode, the folders it may work in, and the persona’s
 * tools and publishing (#416). Not the folders it may only read (#338): the hook asks Postbox about a read there, which
 * answers from the session as it is now, where this is the turn’s start (#1074). And, in reads, the files attached to
 * the turn’s message (attached-files.mjs, #1307), and for an agent in its own worktree the project’s folder, which it
 * could read and edit through --add-dir before it had one, and which doesn’t change during a turn (#1709).
 * @param {{ mcpUrl: string, persona: any, cwd: string, addDirs: string[], reads?: string[] }} o
 */
export function agyHookVars({ mcpUrl, persona, cwd, addDirs, reads = [] }) {
  return {
    POSTBOX_MCP_URL: mcpUrl,
    POSTBOX_AGY_MODE: persona?.permissionMode ?? 'auto',
    POSTBOX_AGY_FOLDERS: JSON.stringify([cwd, ...addDirs]),
    POSTBOX_AGY_READS: JSON.stringify(reads),
    POSTBOX_AGY_TOOLS: JSON.stringify(Array.isArray(persona?.tools) ? persona.tools : []),
    POSTBOX_AGY_PUBLISH: setupOf(persona).canPublish ? '1' : '',
  };
}
