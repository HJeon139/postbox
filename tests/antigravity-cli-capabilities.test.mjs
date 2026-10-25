// The Antigravity CLI backend’s capabilities, moved out of tests/antigravity-cli.test.mjs, which is at its length ceiling.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGY_CAPABILITIES, AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';

test('the capabilities: resumes, can’t fork, reads no Claude Code rules, can’t deny tools or isolate', () => {
  assert.deepEqual({ ...AGY_CAPABILITIES }, { resume: true, fork: false, permissions: 'none', tools: 'none', isolation: false, promptTool: false });
  const a = new AntigravityCliAdapter({ workRoot: '/tmp/x', models: ['gemini-3.8-flash-high'] });
  assert.deepEqual(a.capabilities.models, ['gemini-3.8-flash-high']);
  assert.equal(new AntigravityCliAdapter({ workRoot: '/tmp/x' }).capabilities.models, undefined);
  assert.equal(a.capabilities.remote, undefined, 'it can’t run on a remote host yet');
});
