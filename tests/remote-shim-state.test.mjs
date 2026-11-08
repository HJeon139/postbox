// The host shim’s state (server/remote/host/shim-state.mjs): the ids it gives its calls and prompts. Any client with a
// turn’s token can connect to the daemon, and the daemon keeps a call or prompt by (turn, id), so an id another
// client could guess is one it could claim first, and get the real one refused (#908).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shimState } from '../server/remote/host/shim-state.mjs';
import { ID_RE } from '../shared/remote-protocol-checks.mjs';

test('#908 two shims started in the same millisecond give their calls and prompts different ids, none from the clock or pid', (t) => {
  const at = Date.now();
  t.mock.method(Date, 'now', () => at);
  const P = /** @type {any} */ ({});
  const a = shimState('t1', P);
  const b = shimState('t1', P);
  const calls = [a.nextId(), b.nextId(), a.nextId(), b.nextId()];
  const prompts = [a.promptId(), b.promptId()];
  assert.equal(new Set([...calls, ...prompts]).size, 6, 'every id differs');
  for (const id of [...calls, ...prompts]) {
    assert.match(id, ID_RE, 'each is an id the protocol takes');
    assert.ok(!id.includes(at.toString(36)) && !id.includes(process.pid.toString(36)), `${id} says nothing of the clock or the pid`);
  }
});
