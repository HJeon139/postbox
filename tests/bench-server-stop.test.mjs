// The server bench’s stop (#508, tools/bench-server.mjs): every size runs in order until a signal, which waits for
// the size in progress before it exits. Split from
// tests/bench-server.test.mjs, which was at its size cap.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureAll, stopper } from '../tools/bench-server.mjs';

test('measureAll measures every size, in the order given', async () => {
  const seen = [];
  const results = await measureAll({ sizes: [30, 10, 20] }, async (items) => {
    seen.push(items);
    return { items };
  });
  assert.deepEqual(seen, [30, 10, 20]);
  assert.deepEqual(
    results.map((r) => r.items),
    [30, 10, 20],
  );
});

/** A size that stays in progress until finish() is called, and the order things happened in. */
function sizeInProgress() {
  const order = [];
  let finish = () => {};
  const size = new Promise((ok) => {
    finish = () => {
      order.push('size finished');
      ok({ items: 10 });
    };
  });
  return { size, order, finish: () => finish() };
}

test('a SIGTERM waits for the size in progress to finish, then exits 143', async () => {
  const { size, order, finish } = sizeInProgress();
  const live = { size, stopping: false };
  const stop = stopper(live, (code) => order.push(`exit ${code}`));
  const stopped = stop('SIGTERM');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [], 'it doesn’t exit while the size’s cleanup is still to run');
  assert.equal(live.stopping, true);
  finish();
  await stopped;
  assert.deepEqual(order, ['size finished', 'exit 143']);
});

test('a SIGINT exits 130 once the size in progress fails, and a second signal doesn’t exit again', async () => {
  const exits = [];
  const live = { size: Promise.reject(new Error('stopped')), stopping: false };
  const stop = stopper(live, (code) => exits.push(code));
  await Promise.all([stop('SIGINT'), stop('SIGTERM')]);
  assert.deepEqual(exits, [130]);
});

test('measureAll starts no further size once the bench is stopping', async () => {
  const live = { size: null, stopping: false };
  const seen = [];
  const results = await measureAll(
    { sizes: [10, 20, 30] },
    async (items) => {
      seen.push(items);
      live.stopping = true;
      return { items };
    },
    live,
  );
  assert.deepEqual(seen, [10]);
  assert.deepEqual(results, [{ items: 10 }]);
});

test('measureAll keeps the size in progress where a stop can wait for it', async () => {
  const live = { size: null, stopping: false };
  await measureAll({ sizes: [10] }, async (items) => ({ items }), live);
  assert.deepEqual(await live.size, { items: 10 });
});
