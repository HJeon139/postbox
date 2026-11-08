// #324: a Codex persona in Auto that may fetch the web runs with network access in its sandbox, so Codex’s own
// sandbox and reviewer judge a networked command instead of it stopping at the sandbox (the person’s decision of
// 25 October 2026). Every other persona and mode keeps today’s sandbox.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexPermissions } from '../server/adapters/codex.mjs';
import { modeHelp, PERMISSIONS } from '../shared/agent-facts.mjs';

const net = (persona) => codexPermissions(persona, '/work').sandboxPolicy.networkAccess;

test('#324 a Codex persona in Auto with web.fetch has network access in its sandbox', () => {
  assert.deepEqual(codexPermissions({ permissionMode: 'auto', tools: ['shell', 'web.fetch'] }, '/work'), {
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work'], networkAccess: true },
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
  });
  // Auto is the default mode.
  assert.equal(net({ tools: ['web.fetch'] }), true);
});

test('#324 without web.fetch, or in Accept edits, the sandbox stays offline', () => {
  assert.equal(net({ permissionMode: 'auto', tools: ['shell'] }), false);
  assert.equal(net({ permissionMode: 'auto' }), false, 'no tools listed');
  assert.equal(net({ permissionMode: 'acceptEdits', tools: ['web.fetch'] }), false);
  assert.equal(codexPermissions({ permissionMode: 'ask', tools: ['web.fetch'] }, '/work').sandboxPolicy.type, 'readOnly');
});

test('#324 the persona sheet says Codex’s Auto has network access when the agent may fetch the web', () => {
  const auto = modeHelp(
    'codex',
    PERMISSIONS.find(([id]) => id === 'auto'),
  );
  assert.match(auto, /network access on if the agent may fetch the web, and off if it may not/);
  assert.match(auto, /this isn’t Run everything/);
});
