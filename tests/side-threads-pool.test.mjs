// One session per agent per conversation, and no forks (#228). The first two cases replay the manual UAT of 23 October
// 2026, with @alpha as @builder and @beta as @reviewer: a wake from a topic thread reaches the conversation’s own
// session, never a new one or a fork, and answers in that thread (#372); a busy one takes it after its turn. A persona the conversation doesn’t have
// brings a card to the person.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, sessionsOfPersona, settle, setup, sleep } from './side-threads-fixture.mjs';

/** A conversation with a reply from @alpha, and a topic thread on it. */
async function topicOnReply() {
  const ctx = setup();
  const { rt, store, adapter, t } = ctx;
  adapter.next.push(async (c) => c.text('Here is converter.py.'));
  rt.sendMessage(t.id, { text: '@alpha write the converter' });
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.handle === 'alpha');
  const topic = store.state.threads[rt.startTopic(t.id, reply.id).threadId];
  return { ...ctx, topic };
}
const sessions = (store) => Object.values(store.state.sessions);
const noForks = (store) =>
  assert.equal(
    sessions(store).some((x) => x.forkOf),
    false,
    'a session is a fork',
  );

test('#228 UAT 1, #372: an agent answering in a topic thread wakes @beta, and the conversation’s @beta answers there', async () => {
  const { store, rt, adapter, alpha, beta, topic } = await topicOnReply();
  adapter.next.push(async (c) => {
    c.tools.wake_agent({ handle: 'beta', message: 'Your one-sentence opinion on test_converter.py?' });
    c.text('Asked the reviewer.');
  });
  adapter.next.push(async (c) => c.text('It covers the edge cases.'));
  rt.sendMessage(topic.id, { text: '@alpha get the reviewer agent’s one-sentence opinion on test_converter.py' });
  await settle(rt);
  assert.equal(adapter.calls.find((x) => x.message.text?.startsWith('@alpha get')).sessionId, alpha.id);
  const answer = adapter.calls.find((x) => x.message.text === 'Your one-sentence opinion on test_converter.py?');
  assert.deepEqual([answer.sessionId, answer.thread], [beta.id, topic.id]);
  assert.ok(store.items(topic.id).some((x) => x.sessionId === beta.id && x.text === 'It covers the edge cases.'));
  assert.equal(
    adapter.calls.some((x) => x.sessionId === alpha.id && x.message.from === '@beta'),
    false,
    'the answer woke @alpha, which it didn’t mention',
  );
  assert.equal(Object.values(store.state.threads).filter((x) => x.kind === 'side').length, 0);
  assert.equal(sessions(store).length, 2, 'the conversation’s two sessions, and no others');
  noForks(store);
});

test('#228 UAT 2, #372: naming both agents in a topic thread reaches their two sessions, and the wake waits for @beta there', async () => {
  const { store, rt, adapter, beta, topic } = await topicOnReply();
  const reviewing = held();
  /** @type {any} */
  let r = null;
  adapter.next.push(async (c) => {
    r = c.tools.wake_agent({ handle: 'beta', message: 'Please review converter.py.' });
    c.text('Asked the reviewer.');
  });
  adapter.next.push(reviewing.step);
  rt.sendMessage(topic.id, { text: '@alpha please ask @beta to review converter.py' });
  await sleep(20);
  // @beta is busy with your message, so the wake waits for its turn.
  assert.equal(r.message, 'Woke @beta: it’s busy, so it answers when its current turn ends.');
  assert.deepEqual(
    store.state.threads[topic.id].queue.map((q) => [q.kind, q.text]),
    [['wake', 'Please review converter.py.']],
  );
  reviewing.release();
  await settle(rt);
  assert.equal(sessions(store).length, 2, 'two sessions, not six');
  noForks(store);
  const woke = adapter.calls.find((x) => x.message.text === 'Please review converter.py.');
  assert.deepEqual([woke.sessionId, woke.thread], [beta.id, topic.id]);
});

test('#228: waking a persona the conversation doesn’t have asks the person; Allow adds it and delivers the wake', async () => {
  const { store, rt, adapter, t, c, alpha } = setup();
  const r = rt.toolsFor(alpha.id).wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
  assert.equal(r.ok, false);
  assert.match(r.message, /@gamma isn’t in this conversation, so the person was asked to add it/);
  assert.equal(sessionsOfPersona(store, c.id).length, 0, 'no session until the person says so');
  const card = store.items(t.id).find((i) => i.kind === 'hop' && i.join);
  assert.deepEqual([card.from, card.to, card.status], ['alpha', 'gamma', 'open']);
  assert.deepEqual(store.state.sessions[alpha.id].needs, { kind: 'hop', itemId: card.id, text: '@alpha wants to add @gamma' });
  adapter.next.push(async (x) => x.text('The numbers add up.'));
  rt.resolveHop(t.id, card.id, true);
  await settle(rt);
  const [gamma] = sessionsOfPersona(store, c.id);
  assert.deepEqual([gamma.threadId, gamma.joinedBy], [t.id, 'alpha']);
  assert.ok(store.items(t.id).some((i) => i.kind === 'voice' && i.text === 'Added @gamma to this conversation for @alpha'));
  const woke = adapter.calls.find((x) => x.message.text === 'Check the numbers.');
  assert.equal(woke.sessionId, gamma.id);
  assert.match(gamma.brief, /@alpha woke you, and the person added you to this conversation/, 'its guide says why it’s here');
  assert.equal(store.state.sessions[alpha.id].needs, null);
});

test('#228: on Decline the waking agent is told, and nothing joins', async () => {
  const { store, rt, adapter, t, c, alpha } = setup();
  rt.agentWake(alpha.id, 'gamma', 'Check the numbers.');
  const card = store.items(t.id).find((i) => i.kind === 'hop' && i.join);
  rt.resolveHop(t.id, card.id, false);
  await settle(rt);
  assert.equal(sessionsOfPersona(store, c.id).length, 0);
  assert.match(adapter.calls.at(-1).message.text, /The person chose not to add @gamma to this conversation, so it didn’t get your message/);
  assert.equal(adapter.calls.at(-1).sessionId, alpha.id);
  // A persona whose only session here is a retired fork can’t be added again.
  rt.updateSession(rt.sessionsIn(t.id).find((x) => x.handle === 'beta').id, { retiredFork: true });
  assert.match(rt.agentWake(alpha.id, 'beta', 'Hello?').message, /@beta’s session in this conversation was retired/);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'hop').length, 1, 'no second card');
});

/** Fails the test on an unhandled rejection, as one would end the server. */
function noRejections() {
  const seen = [];
  const on = (e) => seen.push(e);
  process.on('unhandledRejection', on);
  return () => {
    process.off('unhandledRejection', on);
    assert.deepEqual(seen.map(String), []);
  };
}

test('#228: a reply to an agent deleted meanwhile goes nowhere, without failing', async () => {
  const done = noRejections();
  const { rt, adapter, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.agentWake(alpha.id, 'beta', 'Look at this.');
  await sleep(5);
  rt.deleteSession(alpha.id);
  h.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((x) => x.sessionId === alpha.id).length, 0, 'the reply went to a deleted session');
  assert.equal(rt.turns.has(beta.id), false);
  done();
});
