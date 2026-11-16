// A host agent’s call to a tool that’s gone (GONE_TOOLS, shared/mcp-tools.mjs) gets what to do instead, as the laptop’s
// MCP server answers it, not “There’s no tool called …”. The host’s shim answers it itself: nothing goes to the daemon,
// so nothing is posted or woken (designs/rooms-at-scale.md, “After `wake_agent` goes”).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolCall } from '../server/remote/host/shim-calls.mjs';
import { shimState } from '../server/remote/host/shim-state.mjs';
import { GONE_TOOLS } from '../shared/mcp-tools.mjs';

test('a host agent’s call to wake_agent gets the refusal that says to @-mention, and sends nothing to the daemon', (t) => {
  /** @type {string[]} */
  const out = [];
  t.mock.method(process.stdout, 'write', (/** @type {string} */ s) => {
    out.push(s);
    return true;
  });
  const sh = shimState('t1', /** @type {any} */ ({}));
  toolCall(sh, 7, { name: 'wake_agent', arguments: { handle: 'beta', message: 'Check it.' } });
  t.mock.restoreAll();
  const [answer] = out.map((s) => JSON.parse(s));
  assert.equal(answer.id, 7);
  assert.equal(answer.error, undefined, 'not “no such tool”');
  assert.equal(answer.result.isError, true);
  assert.equal(answer.result.content[0].text, GONE_TOOLS.wake_agent);
  assert.equal(sh.pending.size, 0, 'nothing sent to the daemon');
});
