// Stop and a turn’s end with the reply segment held behind a commit (gpt’s peer read of the Stop fix), and the one
// other reader at a turn’s end still wrong while held, kept as a todo for issue #601.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldStore, replies, setup, sleep, until } from './stop-reply-fixture.mjs';

/** gpt’s peer read: the reply segment is emitted while a commit is held, so store.items() can’t see it when Stop scans. */
test('Stop while the reply segment is held behind a commit marks that segment stopped: nothing is left streaming', async () => {
  const h = await heldStore();
  let go = () => {};
  const proceed = new Promise((r) => {
    go = () => r(undefined);
  });
  const env = await setup(async (c) => {
    await proceed;
    c.text('Held reply');
  }, h.store);
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the turn to start');
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync; // the commit is in flight: emits from now on are held behind it
  go();
  await until(() => !!env.rt.turns.get(env.se.id)?.segment, 'the held reply segment');
  assert.equal(env.rt.stop(env.se.id), true);
  h.release();
  await commit;
  await h.store.flush();
  const items = replies(h.store, env.t, env.se);
  assert.deepEqual(
    items.map((i) => [i.status, i.text]),
    [['stopped', 'Held reply']],
    'the held segment is the stopped reply',
  );
  await h.store.close();
});

test('a turn that ends while its reply segment is held behind a commit marks it done: nothing is left streaming', async () => {
  const h = await heldStore();
  let go = () => {};
  const proceed = new Promise((r) => {
    go = () => r(undefined);
  });
  let finish = () => {};
  const done = new Promise((r) => {
    finish = () => r(undefined);
  });
  const env = await setup(async (c) => {
    await proceed;
    c.text('Held reply');
    await done;
  }, h.store);
  // This step ends on its own: deliver’s wait for Stop is skipped once the turn is finished.
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the turn to start');
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  go();
  await until(() => !!env.rt.turns.get(env.se.id)?.segment, 'the held reply segment');
  finish();
  env.rt.turns.get(env.se.id).abort.abort(); // ends deliver’s wait without Stop’s own marking
  await until(() => !env.rt.turns.size, 'the turn to end');
  h.release();
  await commit;
  await h.store.flush();
  const items = replies(h.store, env.t, env.se);
  assert.ok(
    items.every((i) => i.status !== 'streaming'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
  await h.store.close();
});

/** The two other readers of the visible state at a turn’s end (gpt’s and critic’s reads): their outcome while held. */
async function endWhileHeld(step) {
  const h = await heldStore();
  let go = () => {};
  const proceed = new Promise((r) => {
    go = () => r(undefined);
  });
  const env = await setup(async (c) => {
    await proceed;
    await step(c);
    c.signal.dispatchEvent?.(new Event('abort'));
  }, h.store);
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the turn to start');
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  go();
  await sleep(20);
  env.rt.turns.get(env.se.id)?.abort.abort(); // the turn ends while the commit is still held
  await until(() => !env.rt.turns.size, 'the turn to end');
  await sleep(20);
  h.release();
  await commit;
  await h.store.flush();
  return { ...env, store: h.store, close: () => h.store.close() };
}

// Known defect, kept as a todo so it can’t be forgotten: the empty-reply check reads the visible items, so a turn whose
// only reply is a block held behind a commit ends as a failed empty reply. It needs a store-level answer: issue #601.
test('held reader 1, endedWithoutReply: a turn whose only reply is a block shown while a commit is held does not end as an empty reply', {
  todo: 'issue #601: a store view of held emits',
}, async () => {
  const env = await endWhileHeld(async (c) =>
    c.tools.show_block({ block: { id: 'pick', type: 'choice', version: 1, fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] } }),
  );
  const failed = replies(env.store, env.t, env.se).filter((i) => i.status === 'failed');
  assert.deepEqual(
    failed.map((i) => i.text),
    [],
    'the block was its reply: no empty-reply failure',
  );
  await env.close();
});
