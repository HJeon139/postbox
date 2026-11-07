// The Codex backend’s capabilities, moved out of tests/codex.test.mjs, which is at its length ceiling.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_CAPABILITIES } from '../server/adapters/codex.mjs';

test('Codex reports the capabilities its app-server implements', () => {
  assert.deepEqual(CODEX_CAPABILITIES, {
    resume: true,
    fork: true,
    permissions: 'none',
    tools: 'none',
    isolation: false,
    promptTool: false,
    remote: { stdin: 'held', env: [], server: 'codex-config', work: 'model-checks', signInError: null },
  });
});
