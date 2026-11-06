// #796: the reads that decide a thread write read the thread as it will be once what is held behind a commit is
// released (store.pending.thread), and the sweeps that find what to write go over every pending thread. A read of the
// published thread missed what a held write left: a topic just opened, a wake just queued, a delete just marked
// (designs/508/601-held-view.md, “a read that decides a write reads pending”).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, oldSide, settle, setup, sleep } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** The side-thread room, with @gamma in it too, on a store whose log sync can be held; hold() returns the release. */
async function heldRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
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

/** A topic thread on a reply of @beta's in the conversation. */
function topicOn(f) {
  const root = f.rt.addItem(f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  return f.rt.startTopic(f.t.id, root.id).threadId;
}

const textsTo = (f, handle) => f.adapter.calls.filter((c) => c.handle === handle).map((c) => (c.message.messages ?? [c.message]).map((m) => m.text));

test('a wake queued behind a held commit leaves the queue when its agent is archived meanwhile', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.archive(f.beta.id);
  await release();
  b.release();
  await settle(f.rt);
  assert.deepEqual(
    (f.store.state.threads[f.t.id].queue ?? []).filter((q) => q.kind === 'wake'),
    [],
  );
  await f.store.close();
});

test('an agent that joined behind a held commit stays a member when another agent’s deletion is purged', async () => {
  const f = await heldRoom();
  const d = f.rt.createPersona({ handle: 'delta' });
  f.rt.deleteSession(f.gamma.id);
  await f.store.flush();
  const release = await f.hold();
  const delta = f.rt.ensureSession(f.t.id, d.id);
  f.rt.purgeSession(f.gamma.id);
  await release();
  assert.deepEqual(f.store.state.threads[f.t.id].members, [f.alpha.id, f.beta.id, delta.id]);
  await f.store.close();
});

test('a wake queued in a topic behind a held commit reaches its agent when its turn ends while the commit is still held', async () => {
  const f = await heldRoom();
  const topic = topicOn(f);
  await f.store.flush();
  const b = await busyBeta(f);
  const release = await f.hold();
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'In the topic.', { replyIn: topic }).ok, true);
  b.release();
  for (let i = 0; i < 200 && f.adapter.calls.filter((c) => c.handle === 'beta').length < 2; i++) await sleep(5);
  await release();
  await settle(f.rt);
  assert.deepEqual(textsTo(f, 'beta').slice(1), [['In the topic.']]);
  assert.deepEqual(f.store.state.threads[topic].queue ?? [], []);
  await f.store.close();
});

test('a reply in a topic opened behind a held commit counts unread on the topic, not on its agent', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  const topic = topicOn(f);
  assert.equal(f.rt.agentWake(f.beta.id, 'alpha', 'Which column?', { replyIn: topic }).ok, true);
  for (let i = 0; i < 200 && (!f.adapter.calls.length || f.rt.turns.size); i++) await sleep(5);
  await release();
  await settle(f.rt);
  assert.deepEqual([f.store.state.threads[topic].unread, f.store.state.sessions[f.alpha.id].unread], [1, 0]);
  await f.store.close();
});

test('a turn that ends in a topic opened behind a held commit settles the topic’s summary', async () => {
  const f = await heldRoom();
  /** @type {string[]} */
  const prompts = [];
  f.rt.summarize = async (/** @type {string} */ prompt) => {
    prompts.push(prompt);
    return { text: 'Alpha found the off column.', costUsd: null };
  };
  // The quiet wait is the test's: it ends once the release has come, so the summary reads the topic published.
  /** @type {(() => void)[]} */
  const waits = [];
  f.rt.config.setTimer = (/** @type {() => void} */ fn) => {
    waits.push(fn);
    return {};
  };
  const release = await f.hold();
  const topic = topicOn(f);
  f.rt.agentWake(f.beta.id, 'alpha', 'Which column?', { replyIn: topic });
  for (let i = 0; i < 200 && (!f.adapter.calls.length || f.rt.turns.size); i++) await sleep(5);
  await release();
  assert.equal(waits.length, 1, 'the turn’s end settled the topic');
  waits[0]();
  for (let i = 0; i < 200 && !prompts.length; i++) await sleep(5);
  assert.equal(prompts.length, 1);
  await f.store.close();
});

test('a delivery behind a held commit that deletes its conversation waits for Undo, as your message is refused', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.rt.deleteThread(f.t.id);
  assert.throws(() => f.rt.sendMessage(f.t.id, { text: '@beta still there?' }), { status: 409 });
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@alpha', text: 'Still there?' });
  await release();
  await settle(f.rt);
  assert.deepEqual([f.adapter.calls.length, f.rt.heldForUndo.get(f.beta.id)?.length], [0, 1]);
  f.rt.undoDeleteThread(f.t.id);
  await settle(f.rt);
  assert.deepEqual(textsTo(f, 'beta'), [['Still there?']]);
  await f.store.close();
});

test('archiving one agent leaves its conversation open, and archiving the last archives it', async () => {
  const f = setup();
  f.rt.archive(f.alpha.id);
  assert.equal(f.store.state.threads[f.t.id].archived, false);
  f.rt.archive(f.beta.id);
  assert.equal(f.store.state.threads[f.t.id].archived, true);
});

test('a turn in an old side thread counts unread on its agent, not on the side thread', async () => {
  const f = setup();
  const side = oldSide(f);
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@alpha', text: 'Which editions?' }, { threadId: side.id });
  await settle(f.rt);
  assert.deepEqual([f.store.state.threads[side.id].unread, f.store.state.sessions[f.beta.id].unread], [undefined, 1]);
});
