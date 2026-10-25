// What waits in a queue with one session per agent (#228), the conversation’s since wakes go there (#372): every item whose agent is free goes, in order for each
// agent; a restart sends what waited across it; a removed agent gets no wake, and its waker hears why; after a failed
// turn only agents’ wakes go, while the person’s messages wait for them to see the failure.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { held, ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';

/** @alpha and @beta both busy in the conversation, each until released. */
async function bothBusy() {
  const ctx = setup();
  const { rt, adapter, t } = ctx;
  const a = held();
  const b = held();
  adapter.next.push(a.step, b.step);
  rt.sendMessage(t.id, { text: '@alpha @beta both start' });
  await sleep(5);
  return { ...ctx, a, b };
}

test('#228: a wake for an agent that’s free goes, though a message for another, busy agent is ahead of it', async () => {
  const { store, rt, adapter, t, alpha, beta, a, b } = await bothBusy();
  rt.agentWake(beta.id, 'alpha', 'A wake for @alpha first.');
  rt.sendMessage(t.id, { text: '@alpha when you can' });
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  assert.deepEqual(
    store.state.threads[t.id].queue.map((q) => q.kind ?? 'yours'),
    ['wake', 'yours', 'wake'],
  );
  b.release();
  await sleep(30);
  assert.ok(
    adapter.calls.some((x) => x.sessionId === beta.id && x.message.text === 'Which editions?'),
    'the wake for @beta waited behind @alpha’s',
  );
  assert.ok(rt.turns.has(alpha.id));
  a.release();
  await settle(rt);
});

test('#228: after a restart, what waited in the queues goes once Postbox is ready', async () => {
  const { store, rt, t, alpha, beta, a, b } = await bothBusy();
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  assert.equal(store.state.threads[t.id].queue.length, 1);
  // The server stops with it still queued; the new one sends it once it listens (index.mjs calls drainAll).
  const after = new ScriptedAdapter();
  const again = new Runtime({ store, adapters: new AdapterRegistry().register(after), corpus: rt.corpus, config: rt.config });
  again.drainAll();
  await sleep(20);
  assert.deepEqual([after.calls[0].sessionId, after.calls[0].message.text], [beta.id, 'Which editions?']);
  assert.deepEqual(store.state.threads[t.id].queue, []);
  a.release();
  b.release();
  await settle(again);
  await settle(rt);
});

test('#228: removing an agent drops the wakes queued for it, and their agents hear why; none is delivered to it', async () => {
  const { store, rt, adapter, t, alpha, beta, a, b } = await bothBusy();
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  rt.deleteSession(beta.id);
  assert.deepEqual(store.state.threads[t.id].queue, []);
  assert.match(store.state.sessions[alpha.id].context.at(-1), /@beta was removed before it answered your message \(“Which editions\?”\)/);
  a.release();
  b.release();
  await settle(rt);
  assert.equal(
    adapter.calls.some((x) => x.message.text === 'Which editions?'),
    false,
  );
});

test('#228: after a failed turn, a wake waiting for the agent goes, and your message ahead of it waits for you', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const failing = held();
  adapter.next.push(async (c) => {
    await failing.step(c);
    throw new Error('API 500');
  });
  rt.sendMessage(t.id, { text: '@alpha a long job' });
  await sleep(5);
  // In the conversation’s queue: your message for @alpha, then @beta’s wake for it.
  assert.ok(rt.sendMessage(t.id, { text: '@alpha and then this' }).queued);
  rt.agentWake(beta.id, 'alpha', 'A question for you.');
  const answering = held();
  adapter.next.push(answering.step);
  failing.release();
  await sleep(20);
  assert.ok(adapter.calls.some((x) => x.sessionId === alpha.id && x.message.text === 'A question for you.'));
  assert.equal(
    adapter.calls.some((x) => x.message.text === '@alpha and then this'),
    false,
    'your message went after a failure',
  );
  assert.deepEqual(
    store.state.threads[t.id].queue.map((q) => q.text),
    ['@alpha and then this'],
  );
  answering.release();
  await settle(rt);
});

test('#228: Add on a card while the agent’s session here is being removed is refused, so Undo can’t leave two', () => {
  const { store, rt, t, alpha, beta } = setup();
  rt.deleteSession(beta.id);
  rt.agentWake(alpha.id, 'beta', 'Are you there?');
  const card = store.items(t.id).find((i) => i.kind === 'hop' && i.join);
  assert.throws(() => rt.resolveHop(t.id, card.id, true), /@beta is being removed from this conversation/);
  rt.undoDelete(beta.id);
  assert.equal(rt.sessionsIn(t.id).filter((x) => x.handle === 'beta').length, 1);
});
