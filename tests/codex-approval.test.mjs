// How Codex’s approval requests become Postbox permission asks (server/adapters/codex-approval.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexApproval } from '../server/adapters/codex-approval.mjs';

test('#371 an MCP server asking the person for input is marked as such, so Run everything doesn’t answer it', async () => {
  /** @type {any} */
  let asked = null;
  const answer = await codexApproval(
    {
      askPermission: async (/** @type {any} */ req) => {
        asked = req;
        return { allow: false };
      },
    },
    { id: 48, method: 'mcpServer/elicitation/request', params: { serverName: 'github', message: 'Pick a repository' } },
  );
  assert.deepEqual([asked.tool, asked.kind, asked.detail], ['mcp__github__elicitation', 'input', 'Pick a repository']);
  assert.deepEqual(answer, { action: 'decline' });
});
