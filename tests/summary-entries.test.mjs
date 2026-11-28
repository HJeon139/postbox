// A thread’s summary request is a command entry (#1425; designs/rooms-at-scale.md, “What an entry is”: “the person’s
// request for a thread’s summary is a command”). It waits for a busy agent like any entry, a second request is refused
// while it waits, and its reply is posted in the conversation, which Summaries keeps as the thread’s parent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('#1425 a summary request for a busy agent waits as a command entry, once, and its reply is posted in the conversation', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => c.text('Hi.'));
  rt.sendMessage(t.id, { text: '@alpha start' });
  await settle(rt);
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((x) => x.kind === 'user').id);
  const busy = held();
  adapter.next.push(busy.step, async (c) => c.text('We chose offsets.'));
  rt.sendMessage(t.id, { text: '@alpha keep going' });
  await sleep(5);
  rt.summarizeBack(threadId);
  assert.deepEqual(
    arrange.waitingEntries(rt, alpha.id).map((e) => [e.source, e.threadId]),
    [['command', threadId]],
  );
  assert.throws(() => rt.summarizeBack(threadId), { status: 409, message: /A summary is already on its way/ });
  busy.release();
  await settle(rt);
  const shared = store.items(t.id).filter((x) => x.kind === 'shared');
  assert.equal(shared.length, 1, 'posted once, in the conversation');
  assert.match(shared[0].text, /We chose offsets\./);
});

test('#1425 a Stop that stops a waiting summary request clears the thread’s pending summary', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => c.text('Hi.'));
  rt.sendMessage(t.id, { text: '@alpha start' });
  await settle(rt);
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((x) => x.kind === 'user').id);
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@alpha keep going' });
  await sleep(5);
  rt.summarizeBack(threadId);
  rt.stop(alpha.id, { by: 'you' });
  assert.equal(store.state.threads[threadId].summaryPending ?? null, null, 'the panel’s button isn’t left waiting');
  busy.release();
  await settle(rt);
});
