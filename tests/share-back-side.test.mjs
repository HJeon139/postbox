// Summarize back from a side thread (#225), with a topic thread’s contract (#93): the person starts it, an agent of
// the thread writes it, it’s posted in the conversation marked as from that thread, and it wakes no one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sideOf, sleep } from './side-threads-fixture.mjs';

/** A side thread between alpha, who started it, and beta, who answered. */
async function sideThread() {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('The 1908 edition drops two chapters.'));
  f.adapter.next.push(async (c) => c.text('Noted.'));
  f.rt.agentWake(f.alpha.id, 'beta', 'Which editions differ?');
  await settle(f.rt);
  return { ...f, side: sideOf(f.store, f.t) };
}

test('#225: Summarize back in a side thread: the agent that started it writes it, and it’s posted in the conversation', async () => {
  const { store, rt, adapter, t, side, alpha } = await sideThread();
  adapter.next.push(async (c) => c.text('@beta found that the 1908 edition drops two chapters; nothing is open.'));
  const before = adapter.calls.length;
  const hops = store.state.threads[t.id].hops;
  rt.summarizeBack(side.id);
  assert.ok(store.state.threads[side.id].summaryPending, 'pending while the turn runs');
  assert.throws(() => rt.summarizeBack(side.id), { status: 409 });
  await settle(rt);
  // alpha writes it, in the side thread; its mention of @beta wakes no one, and the wake limit doesn’t move.
  const calls = adapter.calls.slice(before);
  assert.deepEqual(
    calls.map((c) => [c.sessionId, c.thread]),
    [[alpha.id, side.id]],
  );
  assert.match(calls[0].message.text, /^Summarize this side thread for the main conversation/);
  assert.equal(store.state.threads[t.id].hops, hops);
  const shared = store.items(t.id).at(-1);
  assert.deepEqual([shared.kind, shared.summary, shared.fromThreadId, shared.fromTitle, shared.handle], ['shared', true, side.id, '@alpha ↔ @beta', 'alpha']);
  assert.equal(store.state.threads[side.id].summaryPending, null);
  const reply = store.items(side.id).at(-1);
  assert.ok(reply.sharedAt, 'the summary’s reply shows it was sent');
});

test('#225: the person can name the side thread’s other agent to write it, and only one of its two', async () => {
  const { store, rt, adapter, t, side, beta } = await sideThread();
  adapter.next.push(async (c) => c.text('Two chapters differ.'));
  rt.summarizeBack(side.id, { handle: '@Beta' });
  await settle(rt);
  assert.equal(adapter.calls.at(-1).sessionId, beta.id);
  assert.equal(store.items(t.id).at(-1).handle, 'beta');
  assert.throws(() => rt.summarizeBack(side.id, { handle: 'gamma' }), { status: 400, message: /@gamma isn’t in this side thread. Name @alpha or @beta/ });
  assert.throws(() => rt.summarizeBack(side.id, { handle: 3 }), { status: 400 });
  const { threadId: topic } = rt.startTopic(t.id, store.items(t.id).find((x) => x.kind === 'agent').id);
  assert.throws(() => rt.summarizeBack(topic, { handle: 'beta' }), { status: 400 });
  assert.throws(() => rt.summarizeBack(t.id), { status: 409, message: /Only a topic or side thread/ });
});

test('#225: a summary’s wake_agent wakes no one either, and the agent is told why', async () => {
  const { store, rt, adapter, t, side } = await sideThread();
  let said = null;
  adapter.next.push(async (c) => {
    said = c.tools.wake_agent({ handle: 'beta', message: 'Check my summary.' });
    c.text('Two chapters differ.');
  });
  const before = adapter.calls.length;
  const hops = store.state.threads[t.id].hops;
  rt.summarizeBack(side.id);
  await settle(rt);
  assert.equal(said?.ok, false);
  assert.match(said?.message ?? '', /wakes no one/);
  assert.equal(adapter.calls.length, before + 1, 'only the summary’s own turn ran');
  assert.equal(store.state.threads[t.id].hops, hops);
});

/**
 * Asks for the summary while the agent that writes it is busy in the thread, so it waits behind that turn, and returns
 * whether it was still pending once its own turn had started. The person’s message there keeps the agent busy.
 */
async function askWhileBusy({ store, rt, adapter }, threadId, text) {
  const [busy, summary] = [held(), held()];
  adapter.next.push(busy.step, summary.step);
  rt.sendMessage(threadId, { text });
  await sleep(10);
  rt.summarizeBack(threadId);
  busy.release();
  for (let i = 0; i < 200 && !/^Summarize/.test(adapter.calls.at(-1)?.message.text ?? ''); i++) await sleep(5);
  assert.match(adapter.calls.at(-1)?.message.text ?? '', /^Summarize this/, 'the summary’s turn started');
  const pending = !!store.state.threads[threadId].summaryPending;
  summary.release();
  await settle(rt);
  assert.equal(store.state.threads[threadId].summaryPending, null, 'done once the summary is written');
  return pending;
}

test('#225: asked while its agent is busy in the side thread, Summarize back stays pending until the summary is written', async () => {
  const f = await sideThread();
  assert.equal(await askWhileBusy(f, f.side.id, '@alpha one more thing'), true, 'pending while the summary is written');
  assert.equal(f.store.items(f.t.id).at(-1).summary, true);
});

test('#93: so it does in a topic thread', async () => {
  const f = setup();
  f.rt.sendMessage(f.t.id, { text: '@alpha which editions differ?' });
  await settle(f.rt);
  const { threadId: topic } = f.rt.startTopic(f.t.id, f.store.items(f.t.id).find((x) => x.kind === 'agent').id);
  assert.equal(await askWhileBusy(f, topic, 'One more thing'), true, 'pending while the summary is written');
  assert.equal(f.store.items(f.t.id).at(-1).summary, true);
});
