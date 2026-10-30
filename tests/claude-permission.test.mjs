// Permission summaries keep the whitespace normalization from their extraction out of claude-stream.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePermission } from '../server/adapters/claude-permission.mjs';

test('#503 extracted permission summaries collapse whitespace exactly as before', () => {
  assert.equal(describePermission('Bash', { description: '  Clean\n  the build  ', command: 'rm -rf build' }).summary, 'run a command: Clean the build');
  assert.equal(describePermission('WebSearch', { query: '  release\n status  ' }).summary, 'search the web for “release status”');
  assert.equal(describePermission('WebFetch', { url: 'https://example.com/a\n b' }).summary, 'fetch example.com/a b');
});
