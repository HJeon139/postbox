// #623: on the wake path, reads of a conversation and its sessions that decide a write read what is held behind a
// commit too (designs/508/601-held-view.md). An agent that joined while a commit was held wasn’t found by another
// agent’s wake, which asked the person to add it though it was there; and the person’s message in a topic opened in
// that window didn’t start the chain’s count again, since the topic’s conversation was looked up in the published state.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordAgentMessage } from '../server/side-threads.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';

/** A runtime on a store whose next commit is held, with fn run while it is (conversations-held.test.mjs). */
async function whileHeld(fn, before = () => {}) {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  await before(env);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  let result;
  try {
    result = await fn(env);
  } finally {
    h.release();
    await commit;
    await h.store.flush();
  }
  return { env, result, store: h.store };
}

test('#623: an agent that joined behind a held commit is woken by another agent, not offered to be added', async () => {
  const { result, store } = await whileHeld(
    ({ rt, t, se }) => {
      rt.sendMessage(t.id, { text: '@critic join us' });
      return { woke: rt.agentWake(se.id, 'critic', '@critic check the table'), t };
    },
    ({ rt }) => rt.createPersona({ handle: 'critic', backend: 'claude-code' }),
  );
  assert.equal(result.woke.ok, true, result.woke.message);
  assert.ok(!store.items(result.t.id).some((i) => i.kind === 'add' || i.variant === 'add'), 'no card asks to add it');
  await store.close();
});

test('#623: the person’s message in a topic opened behind a held commit starts the chain’s count again', async () => {
  const { result, store } = await whileHeld(
    ({ rt, t }) => {
      const item = rt.threads.addItem(t.id, { kind: 'user', text: 'The table', status: 'done' });
      const topic = rt.startTopic(t.id, item.id);
      rt.sendMessage(topic.threadId, { text: '@researcher is row 3 right?' });
      return { t };
    },
    ({ rt, t }) => rt.threads.patch(t.id, { hops: 5 }),
  );
  assert.equal(store.state.threads[result.t.id].hops, 0);
  await store.close();
});

test('#623: two agent messages recorded in one held window are both kept', async () => {
  const { result, store } = await whileHeld(({ rt, se }) => {
    recordAgentMessage(rt, se.id, 'to', 'critic', 'first');
    recordAgentMessage(rt, se.id, 'to', 'alpha', 'second');
    return { se };
  });
  assert.deepEqual(
    store.state.sessions[result.se.id].agentMessages.slice(0, 2).map((m) => m.text),
    ['second', 'first'],
  );
  await store.close();
});
