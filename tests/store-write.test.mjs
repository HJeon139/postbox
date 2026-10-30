// The store’s optimistic write loop (server/store-write.mjs) on its Redis child: a batch Redis refuses for a reason no
// retry changes is dropped, said in the log and the status, and the store goes on writing (#553’s review, blocker 2).
// A refusal a retry can change (out of memory) keeps the fail-closed retry: tests/store-consistency.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open, raw, tmp } from './store-fixture.mjs';

/** A value nested n levels deep. @param {number} n */
const nested = (n) => {
  let v = /** @type {any} */ (1);
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};

/**
 * Makes the next EVAL carry a document RedisJSON refuses (nested past its limit) in place of its first one: a poison the
 * store’s own check (server/store-check.mjs) can’t see, standing in for a key of the wrong type or a script error.
 * @param {import('../server/store.mjs').Store} s
 */
function poisonNextWrite(s) {
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  let once = true;
  client.call = async (...a) => {
    if (once && a[0] === 'EVAL') {
      once = false;
      const i = a.indexOf('S');
      assert.ok(i > 0, 'the batch sets a document');
      a[i + 2] = JSON.stringify(nested(200));
    }
    return call(...a);
  };
}

test('a batch Redis refuses for good is dropped, with its cause in the log and the status, and the next write goes through', async () => {
  const s = await open(await tmp());
  s.emit('settings', { theme: 'dark' });
  await s.flush();
  const statuses = [];
  s.watchers.add((_w, status) => statuses.push(status));
  const errors = [];
  const { error } = console;
  console.error = (m) => errors.push(String(m));
  try {
    poisonNextWrite(s);
    s.emit('settings', { theme: 'auto' });
    await s.flush();
  } finally {
    console.error = error;
  }
  assert.equal(s.failed, null, 'not a failed state');
  assert.equal(s.writable, true);
  assert.equal(s.lines.length, 0, 'the batch isn’t kept to retry');
  const status = /** @type {any} */ (s.status);
  assert.equal(status.state, 'running');
  assert.equal(status.dropped.events, 1);
  assert.equal(status.dropped.from, 2);
  assert.match(status.dropped.message, /recursion limit/);
  assert.equal(statuses.length, 1, 'watchers heard of it once');
  assert.deepEqual(statuses[0], status);
  assert.match(errors.join('\n'), /dropped it: 1 event\(s\) \(2–2\).*recursion limit/);
  // The store goes on: the next write reaches Redis, after the seq Redis holds.
  s.emit('settings', { theme: 'light' });
  await s.flush();
  const c = await raw(s);
  assert.equal(JSON.parse(await c.call('JSON.GET', 'settings', '$'))[0].d.theme, 'light');
  assert.equal(await c.call('GET', 'seq'), '3');
  assert.deepEqual(
    (await c.call('XRANGE', 'events', '-', '+')).map(([id]) => id),
    ['1-0', '3-0'],
    'the stream skips the dropped event',
  );
  c.close();
  assert.equal(s.status.dropped.from, 2, 'the status keeps saying so');
  // A restart reads back what Redis holds: the dropped change isn’t there, the one after it is.
  const b = await open(/** @type {string} */ (s.dir));
  assert.equal(b.state.settings.theme, 'light');
  assert.equal(b.state.seq, 3);
});
