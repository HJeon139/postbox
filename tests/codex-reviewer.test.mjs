// A Codex turn’s sandbox and approvals for each permission mode. In auto, Codex’s own reviewer (auto_review) decides
// what it asks, as Claude Code’s classifier does; Codex keeps a reviewer for later turns, so every other mode names the
// person. Apart from tests/codex.test.mjs, which is at its length ceiling.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexPermissions } from '../server/adapters/codex.mjs';
import { modeHelp, PERMISSIONS } from '../shared/agent-facts.mjs';

test('each permission mode’s sandbox and approvals, with Codex’s reviewer only in auto', () => {
  assert.deepEqual(codexPermissions({ permissionMode: 'auto' }, '/work'), {
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work'], networkAccess: false },
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
  });
  assert.deepEqual(codexPermissions({ permissionMode: 'ask' }, '/work'), {
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  });
  assert.deepEqual(codexPermissions({ permissionMode: 'acceptEdits' }, '/work'), {
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work'], networkAccess: false },
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  });
  assert.deepEqual(codexPermissions({ permissionMode: 'bypass' }, '/work'), {
    sandboxPolicy: { type: 'dangerFullAccess' },
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
  });
  // A persona with no mode is in auto, Postbox’s default.
  assert.equal(codexPermissions({}, '/work').approvalsReviewer, 'auto_review');
});

test('the persona sheet says Auto on Codex is Codex’s reviewer, writes outside Postbox included, and not Run everything', () => {
  const auto = modeHelp(
    'codex',
    PERMISSIONS.find(([id]) => id === 'auto'),
  );
  assert.match(auto, /^Codex’s Auto: Codex’s own reviewer approves or denies what its sandbox stops, including writes through MCP tools and gh/);
  assert.match(auto, /this isn’t Run everything/);
  assert.notEqual(
    auto,
    modeHelp(
      'codex',
      PERMISSIONS.find(([id]) => id === 'acceptEdits'),
    ),
  );
});
