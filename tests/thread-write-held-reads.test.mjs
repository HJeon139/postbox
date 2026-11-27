// #796: the reads that decide a thread write read the thread as it will be once what is held behind a commit is
// released (store.pending.thread), and the sweeps that find what to write go over every pending thread. A read of the
// published thread missed what a held write left: a topic just opened, a message just queued, a delete just marked
// (designs/508/601-held-view.md, “a read that decides a write reads pending”).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, oldSide, settle, setup, sleep } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** The side-thread room, with @gamma in it too, on a store whose log sync can be held; hold() returns the release. */
async function heldRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.handle === 'gamma');
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
  const root = arrange.post(f.rt, f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  return f.rt.startTopic(f.t.id, root.id).threadId;
}

const textsTo = (f, handle) => f.adapter.calls.filter((c) => c.handle === handle).map((c) => c.parts.map((m) => m.text));

test('a mention held behind a commit leaves with its agent’s inbox when the agent is deleted meanwhile', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  assert.equal(arrange.waitingEntries(f.rt, f.beta.id).length, 1, 'held, it waits in beta’s inbox');
  f.rt.deleteSession(f.beta.id);
  await release();
  b.release();
  await settle(f.rt);
  assert.equal(f.store.state.inbox[f.beta.id], undefined, 'the entry went with the session');
  assert.equal(
    f.adapter.calls.some((c) => c.sessionId === f.beta.id && JSON.stringify(c.message).includes('First.')),
    false,
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
  arrange.withSummarizer(f.rt, async (/** @type {string} */ prompt) => {
    prompts.push(prompt);
    return { text: 'Alpha found the off column.', costUsd: null };
  });
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
  // alpha’s answer names no one, so it goes back to beta in the topic (#1518); its conversation is read as written,
  // so a topic opened behind the held commit no longer loses that reply (#623). Each turn’s end settles the topic.
  const answer = f.store.items(topic).find((i) => i.kind === 'agent' && i.sessionId === f.alpha.id);
  assert.deepEqual(answer?.wentBack, ['beta'], 'alpha’s answer went back to beta');
  assert.equal(waits.length, 2, 'each turn’s end settled the topic');
  waits[0]();
  for (let i = 0; i < 200 && !prompts.length; i++) await sleep(5);
  assert.equal(prompts.length, 1);
  await f.store.close();
});

test('#623: when the turns in a topic opened behind a held commit end, the chain’s count starts again', async () => {
  const f = await heldRoom();
  f.rt.threads.patch(f.t.id, { hops: 3 });
  const release = await f.hold();
  const topic = topicOn(f);
  f.rt.agentWake(f.beta.id, 'alpha', 'Which column?', { replyIn: topic });
  for (let i = 0; i < 200 && (!f.adapter.calls.length || f.rt.turns.size); i++) await sleep(5);
  await release();
  for (let i = 0; i < 200 && f.rt.turns.size; i++) await sleep(5);
  assert.equal(f.store.state.threads[f.t.id].hops, 0);
  await f.store.close();
});

test('a sweep over every pending thread sees each held write of a thread, read after read', async () => {
  const f = await heldRoom();
  const b = await busyBeta(f);
  const release = await f.hold();
  const title = () => f.store.pending.threads()[f.t.id].title;
  arrange.setThread(f.rt, f.t.id, { title: 'Third' });
  assert.equal(title(), 'Third');
  arrange.setThread(f.rt, f.t.id, { title: 'Fourth' });
  assert.equal(title(), 'Fourth');
  await release();
  b.release();
  await settle(f.rt);
  await f.store.close();
});

test('a turn in an old side thread counts unread on its agent, not on the side thread', async () => {
  const f = setup();
  const side = oldSide(f);
  f.rt.turnService.run(f.beta.id, { kind: 'agent', from: '@alpha', text: 'Which editions?' }, { threadId: side.id });
  await settle(f.rt);
  assert.deepEqual([f.store.state.threads[side.id].unread, f.store.state.sessions[f.beta.id].unread], [undefined, 1]);
});
