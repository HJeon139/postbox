// Summarize back from a side thread (#225), with a topic thread’s contract (#93): the person starts it, an agent of
// the thread writes it, it’s posted in the conversation marked as from that thread, and it wakes no one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { held, ScriptedAdapter, settle, setup, sideOf, sleep } from './side-threads-fixture.mjs';

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
  assert.equal(rt.turns.size, 1, 'its agent is busy');
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

/** A topic thread on alpha’s first reply in the conversation (#93). */
async function topicThread() {
  const f = setup();
  f.rt.sendMessage(f.t.id, { text: '@alpha which editions differ?' });
  await settle(f.rt);
  return { ...f, topic: f.rt.startTopic(f.t.id, f.store.items(f.t.id).find((x) => x.kind === 'agent').id).threadId };
}

/**
 * The agent that writes the summary is stopped in the thread, and its process is slow to exit (its step ignores the
 * abort), so the summary asked meanwhile waits for it (#126). Returns the step, to let the process exit.
 */
function askWhileExiting({ rt, adapter }, threadId, text, sessionId) {
  const lingering = held();
  adapter.next.push(lingering.step);
  rt.sendMessage(threadId, { text });
  rt.stop(sessionId);
  rt.summarizeBack(threadId);
  assert.ok(
    rt.exiting.get(sessionId)?.held.some((h) => h.summarizeTo),
    'it waits for the stopped process',
  );
  return lingering;
}

for (const [where, make, text] of [
  ['side', sideThread, '@alpha one more thing'],
  ['topic', topicThread, 'One more thing'],
]) {
  test(`#225: in a ${where} thread, a summary waiting for a stopped turn’s process is pending until it’s written`, async () => {
    const f = await make();
    const threadId = f.side?.id ?? f.topic;
    const lingering = askWhileExiting(f, threadId, text, f.alpha.id);
    assert.ok(f.store.state.threads[threadId].summaryPending, 'pending while it waits, which a reloaded page reads');
    assert.throws(() => f.rt.summarizeBack(threadId), { status: 409 });
    lingering.release();
    await settle(f.rt);
    assert.equal(f.store.state.threads[threadId].summaryPending, null, 'done once the summary is written');
    assert.equal(f.store.items(f.t.id).at(-1).summary, true);
  });

  test(`#225: in a ${where} thread, one that waited is no longer pending when its agent is archived before the process exits`, async () => {
    const f = await make();
    const threadId = f.side?.id ?? f.topic;
    const lingering = askWhileExiting(f, threadId, text, f.alpha.id);
    f.rt.archive(f.alpha.id);
    lingering.release();
    await settle(f.rt);
    assert.equal(f.store.state.threads[threadId].summaryPending, null, 'the summary isn’t coming');
  });
}

test('#93: a restart clears a pending summary, since its turn doesn’t survive one', async () => {
  const f = await topicThread();
  const summary = held();
  f.adapter.next.push(summary.step);
  f.rt.summarizeBack(f.topic);
  assert.ok(f.store.state.threads[f.topic].summaryPending);
  // Postbox starts again on the same saved state.
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  new Runtime({ store: f.store, adapters: new AdapterRegistry().register(new ScriptedAdapter()), corpus, config: { origin: 'http://127.0.0.1:1' } });
  assert.equal(f.store.state.threads[f.topic].summaryPending, null);
  summary.release();
  await settle(f.rt);
});

test('#93: Retry on a failed summary is pending again until it’s written', async () => {
  const f = await topicThread();
  f.adapter.next.push(async () => {
    throw new Error('The model is overloaded.');
  });
  f.rt.summarizeBack(f.topic);
  await settle(f.rt);
  const failed = f.store.items(f.topic).find((x) => x.status === 'failed');
  const summary = held();
  f.adapter.next.push(summary.step);
  f.rt.retry(f.topic, failed.id);
  assert.ok(f.store.state.threads[f.topic].summaryPending, 'pending while it’s written again');
  summary.release();
  await settle(f.rt);
  assert.equal(f.store.state.threads[f.topic].summaryPending, null);
  assert.equal(f.store.items(f.t.id).at(-1).summary, true);
});
