// A deleted agent’s queued messages (#427, #597; design-597-release-1): the queue is untouched at delete, so Undo is
// exact (R1); the drain gives nothing to an agent being deleted; at the purge, a message only for it is posted once,
// waking no one and leaving the conversation’s hops alone (R2), and one for others too goes to them now.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { releaseQueued } from '../server/message-queue.mjs';
import { deletePersona, undoDeletePersona } from '../server/persona-delete.mjs';
import { Runtime } from '../server/runtime.mjs';
import { held, ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';

/** @alpha busy until released, with “@alpha later, please” queued for it. */
async function queuedForBusyAlpha() {
  const ctx = setup();
  const a = held();
  ctx.adapter.next.push(a.step);
  ctx.rt.sendMessage(ctx.t.id, { text: '@alpha a long job' });
  await sleep(5);
  assert.ok(ctx.rt.sendMessage(ctx.t.id, { text: '@alpha later, please' }).queued);
  return { ...ctx, a };
}
const posted = (store, threadId, text) => store.items(threadId).filter((i) => i.kind === 'user' && i.text === text);

test('R1: delete, then Undo: the message is still queued, and not in the transcript (the integrator’s repro)', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  rt.undoDelete(alpha.id);
  assert.deepEqual(
    store.state.threads[t.id].queue.map((q) => q.text),
    ['@alpha later, please'],
  );
  assert.equal(posted(store, t.id, '@alpha later, please').length, 0);
  a.release();
  await settle(rt);
});

test('R1: while the agent is being deleted, a drain delivers nothing to it and posts nothing', async () => {
  const { store, rt, adapter, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.drainQueue(t.id);
  await settle(rt);
  assert.equal(
    adapter.calls.some((x) => x.sessionId === alpha.id && /later, please/.test(x.message.text ?? '')),
    false,
  );
  assert.equal(store.state.threads[t.id].queue.length, 1, 'still queued for the Undo window');
  assert.equal(posted(store, t.id, '@alpha later, please').length, 0);
});

test('at the purge, a message only for that agent is posted once (a guard: it held on 6edad50e too, where the release ran at delete)', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.purgeSession(alpha.id);
  assert.deepEqual(store.state.threads[t.id].queue, []);
  assert.equal(posted(store, t.id, '@alpha later, please').length, 1);
});

test('at the purge, a message for that agent and an idle one goes to the idle one now', async () => {
  const { store, rt, adapter, t, alpha, beta, a } = await queuedForBusyAlpha();
  assert.ok(rt.sendMessage(t.id, { text: '@alpha @beta both of you' }).queued);
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.purgeSession(alpha.id);
  await settle(rt);
  assert.ok(
    adapter.calls.some((x) => x.sessionId === beta.id && /both of you/.test(JSON.stringify(x.message))),
    '@beta got it',
  );
  assert.equal(
    store.state.threads[t.id].queue.some((q) => /both of you/.test(q.text)),
    false,
  );
});

test('a restart inside the Undo window keeps the message queued until the rearmed purge, then posts it once', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  const again = new Runtime({ store, adapters: new AdapterRegistry().register(new ScriptedAdapter()), corpus: rt.corpus, config: rt.config });
  again.rearmDeletions();
  assert.ok(again.timers.has(`del:${alpha.id}`), 'the purge is armed again');
  assert.equal(store.state.threads[t.id].queue.length, 1);
  clearTimeout(again.timers.get(`del:${alpha.id}`));
  again.purgeSession(alpha.id);
  assert.equal(posted(store, t.id, '@alpha later, please').length, 1);
  assert.deepEqual(store.state.threads[t.id].queue, []);
});

test('R2: a release posts the text without a turn’s side effects: the conversation’s hops are not reset', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.putThread({ ...store.state.threads[t.id], hops: 3 });
  releaseQueued(rt, alpha.id);
  assert.equal(posted(store, t.id, '@alpha later, please').length, 1);
  assert.equal(store.state.threads[t.id].hops, 3);
  a.release();
  await settle(rt);
});

test('R1: a message for an agent being deleted and an idle one waits for both in the Undo window (gemini)', async () => {
  const { store, rt, adapter, t, alpha, beta, a } = await queuedForBusyAlpha();
  assert.ok(rt.sendMessage(t.id, { text: '@alpha @beta both of you' }).queued);
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.drainQueue(t.id);
  await settle(rt);
  assert.equal(
    adapter.calls.some((x) => x.sessionId === beta.id && /both of you/.test(JSON.stringify(x.message))),
    false,
    '@beta waits: Undo must find it addressed to both',
  );
  assert.deepEqual(store.state.threads[t.id].queue.find((q) => /both of you/.test(q.text))?.sessionIds, [alpha.id, beta.id], 'held for both');
  rt.undoDelete(alpha.id);
  await settle(rt);
  for (const se of [alpha, beta])
    assert.ok(
      adapter.calls.some((x) => x.sessionId === se.id && /both of you/.test(JSON.stringify(x.message))),
      `after Undo, @${se.handle} got it`,
    );
});

/** Whether the adapter got “later, please” in a turn for that session. */
const gotLater = (adapter, sessionId) => adapter.calls.some((x) => x.sessionId === sessionId && /later, please/.test(JSON.stringify(x.message)));

test('after Undo, the message the drain held back goes to the agent now (critic’s probe)', async () => {
  const { store, rt, adapter, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.undoDelete(alpha.id);
  await settle(rt);
  assert.ok(gotLater(adapter, alpha.id), '@alpha got it');
  assert.deepEqual(store.state.threads[t.id].queue, []);
});

test('after Undo of its persona’s delete, the held message goes to the agent now (the sweep)', async () => {
  const { rt, adapter, t, a: persona, alpha } = setup();
  const work = held();
  adapter.next.push(work.step);
  rt.sendMessage(t.id, { text: '@alpha a long job' });
  await sleep(5);
  assert.ok(rt.sendMessage(t.id, { text: '@alpha later, please' }).queued);
  deletePersona(rt, persona.id);
  work.release();
  await settle(rt);
  undoDeletePersona(rt, persona.id);
  await settle(rt);
  assert.ok(gotLater(adapter, alpha.id));
});

test('after Undo of a conversation’s delete, what its queue held goes now (the sweep)', async () => {
  const { store, rt, adapter, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteThread(t.id);
  a.release();
  await settle(rt);
  rt.undoDeleteThread(t.id);
  await settle(rt);
  assert.ok(gotLater(adapter, alpha.id));
  assert.deepEqual(store.state.threads[t.id].queue, []);
});

/** A persona with its session in the conversation and a retired fork in each of two topics, Topic2 with history. */
function withRetiredForks() {
  const ctx = setup();
  const { rt, store, t, a: persona } = ctx;
  const root = rt.addItem(t.id, { kind: 'user', text: 'Root message' });
  const forks = [1, 2].map((n) => {
    const { threadId } = rt.startTopic(t.id, root.id);
    rt.putThread({ ...store.state.threads[threadId], title: `Topic${n}` });
    const fork = rt.ensureSession(threadId, persona.id);
    rt.updateSession(fork.id, { forkOf: { sessionId: ctx.alpha.id, itemId: null }, archived: true, retiredFork: true });
    return { threadId, fork };
  });
  rt.addItem(forks[1].threadId, { kind: 'user', text: 'History in Topic2' });
  return { ...ctx, forks };
}

test('Undo of a persona delete with retired forks in two topics restores every fork, and no topic is erased (the integrator’s blocker)', async () => {
  const { store, rt, a: persona, forks } = withRetiredForks();
  deletePersona(rt, persona.id);
  assert.doesNotThrow(() => undoDeletePersona(rt, persona.id));
  for (const { fork, threadId } of forks) {
    assert.equal(store.state.sessions[fork.id]?.deleting ?? null, null, `${store.state.threads[threadId].title}’s fork is restored`);
    assert.equal(rt.timers.has(`del:${fork.id}`), false, 'no purge is armed for it');
  }
  assert.ok(store.items(forks[1].threadId).some((i) => i.text === 'History in Topic2'));
  await settle(rt);
});

test('Undo of one retired fork’s session answers without a 409 (the neighboring undo)', async () => {
  const { store, rt, forks } = withRetiredForks();
  const { fork } = forks[0];
  rt.deleteSession(fork.id);
  assert.doesNotThrow(() => rt.undoDelete(fork.id));
  assert.equal(store.state.sessions[fork.id].deleting, null);
  clearTimeout(rt.timers.get(`del:${fork.id}`));
});

test('Send now on a message for an agent being deleted and another delivers only to the other (should-fix 2)', async () => {
  const { store, rt, adapter, t, alpha, beta, a } = await queuedForBusyAlpha();
  assert.ok(rt.sendMessage(t.id, { text: '@alpha @beta both of you' }).queued);
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  const q = store.state.threads[t.id].queue.find((x) => /both of you/.test(x.text));
  rt.sendQueuedNow(t.id, q.id);
  await settle(rt);
  const got = (se) => adapter.calls.some((x) => x.sessionId === se.id && /both of you/.test(JSON.stringify(x.message)));
  assert.equal(got(alpha), false, 'no turn for @alpha, which is being deleted');
  assert.equal(got(beta), true);
});

test('the purge posts in queue order: M1 for @alpha and @beta, then M2 for @alpha alone, read M1 then M2 (nit)', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  store.emit('thread', { ...store.state.threads[t.id], queue: [] });
  assert.ok(rt.sendMessage(t.id, { text: '@alpha @beta M1' }).queued);
  assert.ok(rt.sendMessage(t.id, { text: '@alpha M2' }).queued);
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.purgeSession(alpha.id);
  await settle(rt);
  const order = store
    .items(t.id)
    .filter((i) => i.kind === 'user' && /M[12]$/.test(i.text))
    .map((i) => i.text.slice(-2));
  assert.deepEqual(order, ['M1', 'M2']);
});
