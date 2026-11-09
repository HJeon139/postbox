// The person’s queue controls while a commit is held (#1007): a turn that ends behind a held commit drains the
// queue into the pending thread, while the published one, which the page shows, still lists the entry.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldStore, setup, until } from './stop-reply-fixture.mjs';

test('Send now on an entry a turn ending behind a held commit already drained doesn’t deliver it a second time (#1007)', async () => {
  const h = await heldStore();
  let turns = 0;
  const env = await setup(async (c) => {
    turns++;
    c.text(`Reply ${turns}`); // a reply, so the turn ends done and drains the queue, not as an empty reply
  }, h.store);
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the first turn to start');
  const { queued } = env.rt.sendMessage(env.t.id, { text: 'second' });
  assert.ok(queued, 'the agent is busy, so the message waits in the queue');
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync; // the commit is in flight: emits from now on are held behind it
  env.rt.turns.get(env.se.id).abort.abort(); // the first turn ends, and its drain takes the queued message
  await until(() => turns === 2, 'the drained message’s turn to start');
  assert.deepEqual(
    h.store.pending.thread(env.t.id).queue.map((q) => q.id),
    [],
    'the drain took it from the pending queue',
  );
  assert.deepEqual(
    env.rt.thread(env.t.id).queue.map((q) => q.id),
    [queued.id],
    'the page still shows it queued',
  );
  let refused = null;
  try {
    env.rt.sendQueuedNow(env.t.id, queued.id);
  } catch (e) {
    refused = e;
  }
  h.release();
  await commit;
  await h.store.flush();
  assert.equal(turns, 2, 'Send now started no turn of its own');
  const posted = h.store.items(env.t.id).filter((i) => i.kind === 'user' && i.text === 'second');
  assert.equal(posted.length, 1, 'the message is posted once');
  assert.equal(refused?.status, 404, 'Send now says the message was already sent');
  env.rt.turns.get(env.se.id)?.abort.abort();
  await until(() => !env.rt.turns.size, 'the last turn to end');
  await h.store.close();
});
