// The words a tool call goes by in the activity list and on the ring (server/tool-labels.mjs), for every backend.
// Moved from tests/claude-code.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTool } from '../server/tool-labels.mjs';

test('labels say what a tool does', () => {
  assert.equal(describeTool('Bash', { command: 'npm test' }), 'Ran npm test');
  assert.equal(describeTool('Grep', { pattern: 'TODO' }), 'Searched for “TODO”');
  assert.equal(describeTool('mcp__github__list_issues', { repo: 'x' }), 'list issues (github)');
});
