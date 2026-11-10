// #796: a thread write starts from the thread as it will be once what is held behind a commit is released
// (store.pending.thread), never from the published one. Built from the published thread, a write overwrites a write of
// the same thread still held: a queued wake was lost, and the wake limit stopped counting (designs/508/601-held-view.md).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { updateThread } from '../server/thread-write.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/**
 * The side-thread room on a store whose log sync can be held, with @gamma in it too. hold() holds a commit behind its
 * sync, so every emit after it waits in store.pending, and returns the release, which settles the commit and the store
 * and answers how the commit ended.
 */
async function heldRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  await h.store.flush();
  const hold = async (events = [{ type: 'settings', data: { theme: 'system' } }]) => {
    h.hold();
    const commit = h.store.commit(events);
    await h.atSync;
    return async () => {
      h.release();
      // A failed commit releases what it held too (store-retry.mjs): the release says which it was.
      const outcome = await commit.then(
        () => 'committed',
        (e) => e.code,
      );
      await h.store.flush();
      return outcome;
    };
  };
  return { ...f, h, gamma, hold };
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

const queueOf = (f, id = f.t.id) => f.store.pending.thread(id).queue ?? [];
const texts = (message) => (message.messages ?? [message]).map((m) => m.text);

test('two wakes queued for a busy agent behind a held commit both reach it after the release', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'First.').ok, true);
  assert.equal(f.rt.agentWake(f.gamma.id, 'beta', 'Second.').ok, true);
  await release();
  b.release();
  await settle(f.rt);
  const toBeta = f.adapter.calls.filter((c) => c.handle === 'beta');
  assert.deepEqual(texts(toBeta[1].message), ['First.', 'Second.']);
  await f.store.close();
});

test('a room’s limit set behind a held commit holds: its sixth wake in a row raises the wake-limit card (#1035)', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  updateThread(f.rt, f.t.id, { chainLimit: 5 });
  const answers = [];
  for (let i = 0; i <= 5; i++) answers.push(f.rt.agentWake(f.alpha.id, 'beta', `Hand-off ${i + 1}.`));
  assert.equal(answers.filter((r) => r.ok).length, 5);
  assert.equal(answers.at(-1).waiting, true, 'the wake past the limit waits for the person');
  assert.equal(f.store.pending.items(f.t.id).filter((x) => x.kind === 'hop' && x.status === 'open').length, 1);
  await release();
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'hop' && x.status === 'open').length, 1);
  b.release();
  await settle(f.rt);
  await f.store.close();
});

test('a wake queued behind a held commit keeps the hop count it raised', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.agentWake(f.gamma.id, 'beta', 'Second.');
  assert.equal(f.store.pending.thread(f.t.id).hops, 2);
  await release();
  assert.equal(f.store.state.threads[f.t.id].hops, 2);
  b.release();
  await settle(f.rt);
  await f.store.close();
});

test('open_topic with a mention behind a held commit posts once, in the topic, and its agent answers there', async () => {
  const f = await heldRoom();
  f.adapter.next.push(async (c) => c.text('The totals are off by one.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha check the totals' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((i) => i.kind === 'agent');
  const ASK = 'Beta, check the totals here.';
  let out;
  let release;
  f.adapter.next.push(async (c) => {
    release = await f.hold();
    out = c.tools.open_topic({ itemId: reply.id, message: ASK, mentions: ['beta'] });
    c.text('Opened.');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha open a topic' });
  for (let i = 0; i < 200 && !out; i++) await sleep(5);
  assert.equal(out?.ok, true, JSON.stringify(out));
  await release();
  await settle(f.rt);
  const inConv = f.store.items(f.t.id).filter((i) => i.text === ASK).length;
  const inTopic = f.store.items(out.threadId).filter((i) => i.text === ASK).length;
  const call = f.adapter.calls.find((c) => c.handle === 'beta');
  assert.deepEqual([inConv, inTopic, call?.thread], [0, 1, out.threadId]);
  await f.store.close();
});

test('a reply in a topic opened behind a held commit counts on its message', async () => {
  const f = await heldRoom();
  const root = f.rt.addItem(f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  await f.store.flush();
  const release = await f.hold();
  const { threadId: topic } = f.rt.startTopic(f.t.id, root.id);
  f.rt.addItem(topic, { kind: 'agent', sessionId: f.alpha.id, personaId: f.alpha.personaId, handle: 'alpha', text: 'Which column?', status: 'done' });
  await release();
  assert.equal(f.store.item(f.t.id, root.id).replies, 1);
  await f.store.close();
});

test('two wakes queued behind a held commit both reach their agent when its turn ends while the commit is still held', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.agentWake(f.gamma.id, 'beta', 'Second.');
  const calls = f.adapter.calls.length;
  b.release();
  for (let i = 0; i < 200 && f.adapter.calls.length === calls; i++) await sleep(5);
  await release();
  await settle(f.rt);
  const toBeta = f.adapter.calls.filter((c) => c.handle === 'beta');
  assert.deepEqual(texts(toBeta[1]?.message ?? {}), ['First.', 'Second.']);
  await f.store.close();
});

test('your message to a busy agent and a wake for it behind a held commit both wait in the queue', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  f.rt.sendMessage(f.t.id, { text: '@beta and this' });
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  assert.equal(queueOf(f).length, 2);
  await release();
  assert.equal(f.store.state.threads[f.t.id].queue.length, 2);
  b.release();
  await settle(f.rt);
  await f.store.close();
});

test('Edit of a queued message behind a held commit keeps a wake queued meanwhile', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const { queued } = f.rt.sendMessage(f.t.id, { text: '@beta and this' });
  await f.store.flush();
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.editQueued(f.t.id, queued.id, '@beta and this, edited');
  assert.deepEqual(
    queueOf(f).map((q) => [q.kind ?? 'user', q.text]),
    [
      ['user', '@beta and this, edited'],
      ['wake', 'First.'],
    ],
  );
  await release();
  b.release();
  await settle(f.rt);
  await f.store.close();
});

test('Cancel of a queued wake behind a held commit keeps the other queued wake', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  f.rt.agentWake(f.gamma.id, 'beta', 'From gamma.');
  await f.store.flush();
  const [mine] = f.store.state.threads[f.t.id].queue;
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'From alpha.');
  f.rt.cancelQueued(f.t.id, mine.id);
  assert.deepEqual(
    queueOf(f).map((q) => q.text),
    ['From alpha.'],
  );
  await release();
  b.release();
  await settle(f.rt);
  await f.store.close();
});

test('Send now on a queued wake behind a held commit keeps the other queued wake', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  f.rt.agentWake(f.gamma.id, 'beta', 'From gamma.');
  await f.store.flush();
  const [mine] = f.store.state.threads[f.t.id].queue;
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'From alpha.');
  f.rt.sendQueuedNow(f.t.id, mine.id);
  assert.deepEqual(
    queueOf(f).map((q) => q.text),
    ['From alpha.'],
  );
  await release();
  b.release();
  await settle(f.rt);
  await f.store.close();
});

test('a topic’s unread count behind a held commit counts each reply', async () => {
  const f = await heldRoom();
  f.adapter.next.push(async (c) => c.text('The totals are off by one.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha check the totals' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((i) => i.kind === 'agent');
  const { threadId: topic } = f.rt.startTopic(f.t.id, reply.id);
  await f.store.flush();
  const a = held();
  const g = held();
  f.adapter.next.push(a.step, g.step);
  f.rt.sendMessage(topic, { text: '@alpha @beta both of you' });
  for (let i = 0; i < 200 && f.adapter.calls.length < 3; i++) await sleep(5);
  const release = await f.hold();
  a.release();
  g.release();
  for (let i = 0; i < 200 && f.rt.turns.size; i++) await sleep(5);
  await release();
  await settle(f.rt);
  assert.equal(f.store.state.threads[topic].unread, 2);
  await f.store.close();
});

test('your messages re-queued as Postbox shuts down behind a held commit all wait in the queue', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  f.rt.stop(f.beta.id);
  f.rt.sendMessage(f.t.id, { text: '@beta one' });
  f.rt.sendMessage(f.t.id, { text: '@beta two' });
  const release = await f.hold();
  f.rt.closing = true;
  b.release();
  for (let i = 0; i < 200 && f.rt.exiting.size; i++) await sleep(5);
  assert.deepEqual(
    queueOf(f).map((q) => q.text),
    ['@beta one', '@beta two'],
  );
  await release();
  await f.store.close();
});

test('held queue writes survive a failed commit, as its release applies them in order', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold([{ type: 'nonsense', data: {} }]);
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.agentWake(f.gamma.id, 'beta', 'Second.');
  assert.equal(await release(), 'EREJECTED', 'the commit failed');
  assert.deepEqual(
    f.store.state.threads[f.t.id].queue.map((q) => q.text),
    ['First.', 'Second.'],
  );
  b.release();
  await settle(f.rt);
  await f.store.close();
});

test('after a release and a restart, the log holds both queued wakes and the exact hop count', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.agentWake(f.gamma.id, 'beta', 'Second.');
  await release();
  const dir = f.store.dir;
  await f.store.close();
  const again = await new Store(dir).load();
  const t = again.state.threads[f.t.id];
  assert.deepEqual([t.queue.map((q) => q.text), t.hops], [['First.', 'Second.'], 2]);
  await again.close();
  b.release();
});
