// #1904: when Claude Code can’t reach the model, it writes the error as an assistant line marked is_api_error_message
// before its result, as recorded in #1925’s tests/fixtures/claude-code/connection-failed.jsonl. Taken as reply text, it
// counted as the turn reaching its agent, so the turn never gave back what it took (tools-down.mjs, takenBack). The
// result’s own text is the turn’s error (resultError), so the person loses nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';

/** The line’s shape as recorded: Claude Code’s own message, with the error as its text. */
const API_ERROR = {
  type: 'assistant',
  is_api_error_message: true,
  message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Can’t reach the API server.' }] },
};

test('#1904 Claude Code’s API-error line isn’t reply text, so the turn hasn’t reached its agent', () => {
  let text = '';
  const ctx = new Proxy({ text: (/** @type {string} */ d) => (text += d) }, { get: (o, k) => (k in o ? o[k] : () => {}) });
  const m = createStreamMapper(/** @type {any} */ (ctx), { now: () => 1000 });
  m.push(API_ERROR);
  assert.equal(text, '');
});
