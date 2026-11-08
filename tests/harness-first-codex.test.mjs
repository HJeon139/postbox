// Harness first for Codex (lead-sweep’s case): Postbox already sent no approval of its own in Auto (#415,
// codex-mcp-policy.mjs), so Codex’s own auto_review decides, and that must stay so; Ask me and Accept edits still
// prompt. Kiro has no ask effect at all (kiro-cli-agent.mjs), and Antigravity’s permission system is Postbox’s own hook
// (agy-auto.mjs), so neither has an Auto/Ask pair here; the Claude Code side is tests/harness-first.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexMcpApprovalConfig } from '../server/adapters/codex-mcp-policy.mjs';

test('Codex: in Auto Postbox sends no approval of its own, as before; Ask me and Accept edits still prompt', async () => {
  // Passes on main by design: Codex was already harness first in Auto (#415), and must stay so.
  const calls = [];
  const request = async (method, params) => {
    calls.push(method);
    return { data: [{ name: 'github' }], nextCursor: null, params };
  };
  assert.equal(await codexMcpApprovalConfig(request, 'auto'), undefined);
  assert.equal(await codexMcpApprovalConfig(request, 'bypass'), undefined);
  assert.equal(calls.length, 0, 'Auto and Run everything don’t even list the servers');
  for (const mode of ['ask', 'acceptEdits']) {
    const config = await codexMcpApprovalConfig(request, mode);
    assert.equal(config?.['mcp_servers.github.default_tools_approval_mode'], 'prompt', mode);
  }
});
