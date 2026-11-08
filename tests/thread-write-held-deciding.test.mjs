// #796: more of the reads that decide a thread write, each read pending (store.pending.thread, or a sweep over every
// pending thread), each pinned by what a published read gets wrong behind a held commit: the queue a purge posts from,
// the queue a turn's end batches from, a chain's count, the header of a topic just opened, and a recording's fields
// (designs/508/601-held-view.md, “a read that decides a write reads pending”).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { deleteRecordings, startRecording, stopRecording } from '../server/telemetry.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/** The side-thread room on a store whose log sync can be held; hold() holds a commit and returns its release. */
async function heldRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  await h.store.flush();
  const hold = async () => {
    h.hold();
    const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    return async () => {
      h.release();
      await commit;
      await h.store.flush();
    };
  };
  return { ...f, h, hold };
}

/** @beta busy in a turn that waits until the returned release(). */
async function busyBeta(f) {
  const b = held();
  f.adapter.next.push(b.step);
  f.rt.sendMessage(f.t.id, { text: '@beta work' });
  for (let i = 0; i < 200 && !f.adapter.calls.length; i++) await sleep(5);
  assert.equal(f.rt.turns.has(f.beta.id), true, '@beta is busy');
  return b;
}

const textsTo = (f, handle) => f.adapter.calls.filter((c) => c.handle === handle).map((c) => (c.message.messages ?? [c.message]).map((m) => m.text));

test('your queued message edited behind a held commit is posted as edited when its agent’s deletion is purged', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const { queued } = f.rt.sendMessage(f.t.id, { text: '@beta After the tests.' });
  f.rt.deleteSession(f.beta.id);
  await f.store.flush();
  const release = await f.hold();
  f.rt.editQueued(f.t.id, queued.id, '@beta After the tests, edited.');
  f.rt.purgeSession(f.beta.id);
  await release();
  b.release();
  await settle(f.rt);
  const posted = f.store.items(f.t.id).filter((i) => i.kind === 'user' && i.text.startsWith('@beta After'));
  assert.deepEqual(
    posted.map((i) => i.text),
    ['@beta After the tests, edited.'],
  );
  assert.deepEqual(f.store.state.threads[f.t.id].queue ?? [], []);
  await f.store.close();
});

test('your message queued behind a held commit joins, in one batch, the message that waited in its agent’s turn', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@alpha', text: 'Waited in the turn.' });
  f.rt.sendMessage(f.t.id, { text: '@beta Queued behind it.' });
  b.release();
  for (let i = 0; i < 200 && textsTo(f, 'beta').length < 2; i++) await sleep(5);
  await release();
  await settle(f.rt);
  assert.deepEqual(textsTo(f, 'beta').slice(1), [['Waited in the turn.', '@beta Queued behind it.']]);
  await f.store.close();
});

test('a chain of wakes that ends behind a held commit starts its count again', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'Check the totals.').ok, true);
  assert.equal(f.store.pending.thread(f.t.id).hops, 1);
  await settle(f.rt);
  await release();
  assert.equal(f.store.state.threads[f.t.id].hops, 0);
  await f.store.close();
});

test('a wake queued behind a held commit keeps its chain’s count when the conversation’s delete stops the turns', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.deleteThread(f.t.id);
  b.release();
  await settle(f.rt);
  await release();
  assert.equal(f.store.state.threads[f.t.id].hops, 1);
  await f.store.close();
});

test('a turn woken in a topic opened behind a held commit is told it answers there', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  const root = f.rt.addItem(f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  f.rt.agentWake(f.beta.id, 'alpha', 'Which column?', { replyIn: topic });
  for (let i = 0; i < 200 && !f.adapter.calls.length; i++) await sleep(5);
  const [call] = f.adapter.calls.filter((c) => c.handle === 'alpha');
  assert.ok(call.message.taskContext.startsWith('[Postbox] You’re answering in the thread “'), call.message.taskContext);
  assert.ok(call.message.taskContext.includes(`(thread ${topic}).`), call.message.taskContext);
  await release();
  await settle(f.rt);
  await f.store.close();
});

test('Stop recording behind a held commit keeps the start that Delete recordings gave the recording behind it', async (t) => {
  const f = await heldRoom();
  f.store.emit('project', { id: 'p1', name: 'P', folder: tempDir('pb-held-rec-project-') });
  f.rt.config.telemetryRoot = join(tempDir('pb-held-rec-data-'), 'telemetry');
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  startRecording(f.rt, f.t.id);
  await f.store.flush();
  const release = await f.hold();
  t.mock.timers.setTime(2_000);
  deleteRecordings(f.rt, f.t.id);
  stopRecording(f.rt, f.t.id);
  await release();
  assert.deepEqual(f.store.state.threads[f.t.id].recording, { on: false, since: 2_000, startedAt: 2_000, stoppedAt: 2_000 });
  await f.store.close();
});
