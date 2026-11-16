// What waits for an agent with one session per conversation (#228, #372): the person’s messages and agents’ mentions,
// each an entry in its inbox (designs/rooms-at-scale.md, “Delivery”). Every agent that’s free gets what waits for it;
// a restart sends what waited across it; a removed agent gets nothing, and its waker hears why; after a failed turn
// nothing starts the agent again until the person acts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import * as arrange from './arrange.mjs';
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
  const { rt, adapter, t, alpha, beta, a, b } = await bothBusy();
  rt.agentWake(beta.id, 'alpha', 'A wake for @alpha first.');
  rt.sendMessage(t.id, { text: '@alpha when you can' });
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  assert.deepEqual(arrange.personWaiting(rt, t.id), ['@alpha when you can'], 'your message waits for @alpha');
  const mentions = (se) => arrange.waitingEntries(rt, se.id).filter((e) => e.source === 'mention').length;
  assert.equal(mentions(alpha) + mentions(beta), 2, 'the two mentions in inboxes');
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
  const { store, rt, alpha, beta, a, b } = await bothBusy();
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  assert.equal(arrange.waitingEntries(rt, beta.id).length, 1);
  // The server stops with it still waiting; the new one sends it once it listens (index.mjs calls drainAll).
  const after = new ScriptedAdapter();
  const again = new Runtime({ store, adapters: new AdapterRegistry().register(after), config: rt.config });
  again.drainAll();
  await sleep(20);
  // The turns the old server ran had no record of ending, so what they took reopens once, as a resend (#466), and
  // goes with what waited.
  const texts = (c) => (c.message.messages ?? [c.message]).map((m) => m.text);
  assert.deepEqual(after.calls.filter((c) => c.sessionId === beta.id).map(texts), [['@alpha @beta both start', 'Which editions?']]);
  assert.deepEqual(arrange.waitingEntries(again, beta.id), []);
  a.release();
  b.release();
  await settle(again);
  await settle(rt);
});

test('#228: removing an agent drops the mentions waiting for it, and their agents hear why; none is delivered to it', async () => {
  const { store, rt, adapter, alpha, beta, a, b } = await bothBusy();
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  rt.deleteSession(beta.id);
  assert.equal(store.state.inbox[beta.id], undefined, 'its entries went with its session');
  assert.match(store.state.sessions[alpha.id].context.at(-1), /@beta was removed before it answered your message \(“Which editions\?”\)/);
  a.release();
  b.release();
  await settle(rt);
  assert.equal(
    adapter.calls.some((x) => x.message.text === 'Which editions?'),
    false,
  );
});

test('after a failed turn, a mention waiting for the agent and your message ahead of it both wait for you to act', async () => {
  // designs/rooms-at-scale.md, “What an entry is”: a failed session starts no turn on its own. #228 sent an agent’s
  // waiting wake after a failure; the inbox waits for the person, as their own queued message always did.
  const { store, rt, adapter, t, alpha, beta } = setup();
  const failing = held();
  adapter.next.push(async (c) => {
    await failing.step(c);
    throw new Error('API 500');
  });
  rt.sendMessage(t.id, { text: '@alpha a long job' });
  await sleep(5);
  assert.ok(rt.sendMessage(t.id, { text: '@alpha and then this' }).queued);
  rt.agentWake(beta.id, 'alpha', 'A question for you.');
  failing.release();
  await sleep(20);
  assert.equal(adapter.calls.filter((x) => x.sessionId === alpha.id).length, 1, 'nothing started alpha after its failure');
  assert.deepEqual(arrange.personWaiting(rt, t.id), ['@alpha and then this']);
  assert.equal(arrange.waitingEntries(rt, alpha.id).filter((e) => e.source === 'mention').length, 1, 'the mention waits in its inbox');
  // The person acts: Retry starts the failed reply again, and once it ends the mention goes.
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  await rt.retry(t.id, failed.id);
  await settle(rt);
  assert.ok(adapter.calls.some((x) => x.sessionId === alpha.id && JSON.stringify(x.message).includes('A question for you.')));
});

test('#1146: after a failed turn, what waited goes in the order it was sent once the person retries, the person’s messages included', async () => {
  // In #1146, a failed turn’s end sent only the agents’ wakes, so the person’s messages went a whole turn behind a wake
  // sent after them. Now nothing starts the failed agent until the person acts, and then everything goes in order.
  const { store, rt, adapter, t, alpha, beta } = setup();
  const failing = held();
  adapter.next.push(async (c) => {
    await failing.step(c);
    throw new Error('API 500');
  });
  rt.sendMessage(t.id, { text: '@beta the long job' });
  await sleep(5);
  rt.sendMessage(t.id, { text: '@beta P1' });
  rt.agentWake(alpha.id, 'beta', 'W1');
  rt.sendMessage(t.id, { text: '@beta P2' });
  failing.release();
  await sleep(20);
  assert.equal(adapter.calls.filter((x) => x.sessionId === beta.id).length, 1, 'nothing went ahead after the failure');
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  await rt.retry(t.id, failed.id);
  await settle(rt);
  const after = adapter.calls.filter((x) => x.sessionId === beta.id).slice(2);
  assert.deepEqual(
    after.flatMap((c) => (c.message.messages ?? [c.message]).map((m) => m.text)),
    ['@beta P1', 'W1', '@beta P2'],
  );
});
