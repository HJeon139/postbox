// The host shim’s state (server/remote/host/shim-state.mjs): the ids it gives its calls and prompts. Any client with a
// turn’s token can connect to the daemon, and the daemon keeps a call or prompt by (turn, id), so an id another
// client could guess is one it could claim first, and get the real one refused (#908).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { shimState } from '../server/remote/host/shim-state.mjs';
import { ID_RE } from '../shared/remote-protocol-checks.mjs';

// Each id is randomUUID()’s, so none can come from the clock or the pid. A substring check can’t show that: a pid of
// a few base-36 characters, such as 1371’s “123”, turns up in a random id now and then, which failed CI.
test('#908 two shims started in the same millisecond give their calls and prompts different ids, each a random UUID', (t) => {
  const at = Date.now();
  t.mock.method(Date, 'now', () => at);
  t.mock.property(process, 'pid', 1371);
  const made = [];
  const real = crypto.randomUUID.bind(crypto);
  // Ids that hold the pid’s base-36 form, “123”, as a random one sometimes does.
  t.mock.method(crypto, 'randomUUID', () => {
    const id = `${real().slice(0, 33)}123`;
    made.push(id);
    return id;
  });
  syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  const P = /** @type {any} */ ({});
  const a = shimState('t1', P);
  const b = shimState('t1', P);
  const ids = [a.nextId(), b.nextId(), a.nextId(), b.nextId(), a.promptId(), b.promptId()];
  assert.equal(new Set(ids).size, 6, 'every id differs');
  assert.deepEqual(ids, made, 'each is a fresh randomUUID(), in order');
  for (const id of ids) {
    assert.match(id, ID_RE, 'each is an id the protocol takes');
    assert.ok(!id.includes(at.toString(36)), `${id} says nothing of the clock`);
  }
});
