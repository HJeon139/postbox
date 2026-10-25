// How Codex’s approval requests become Postbox permission asks (server/adapters/codex-approval.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexApproval } from '../server/adapters/codex-approval.mjs';

test('Codex command approvals become Postbox permission cards without unsupported Always allow rules', async () => {
  let requested;
  const allowed = await codexApproval(
    {
      askPermission: async (req) => {
        requested = req;
        return { allow: true };
      },
    },
    { method: 'item/commandExecution/requestApproval', params: { itemId: 'cmd_1', command: 'touch ../outside.txt', cwd: '/work' } },
  );
  assert.deepEqual(allowed, { decision: 'accept' });
  assert.deepEqual(requested, {
    tool: 'Bash',
    summary: 'run a command',
    detail: 'touch ../outside.txt\n\nWorking directory: /work',
    toolUseId: 'cmd_1',
    suppressAlways: true,
    sandbox: { command: 'touch ../outside.txt' },
  });
  const denied = await codexApproval(
    { askPermission: async () => ({ allow: false }) },
    { method: 'item/fileChange/requestApproval', params: { itemId: 'file_1', grantRoot: '/workspace' } },
  );
  assert.deepEqual(denied, { decision: 'decline' });
});
