// One session per agent per conversation, and no forks (#228). The first two cases replay the manual UAT of 23 October
// 2026, with @alpha as @builder and @beta as @reviewer: a wake from a topic thread reaches the conversation’s own
// session, never a new one or a fork, and a busy one takes it after its turn. A persona the conversation doesn’t have
// brings a card to the person, and forks from before are archived once, at startup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { held, ScriptedAdapter, sessionsOfPersona, settle, setup, sideOf, sleep } from './side-threads-fixture.mjs';

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

test('#228 UAT 1: an agent answering in a topic thread wakes @beta, and the conversation’s @beta answers', async () => {
  const { store, rt, adapter, t, alpha, beta, topic } = await topicOnReply();
  adapter.next.push(async (c) => {
    c.tools.wake_agent({ handle: 'beta', message: 'Your one-sentence opinion on test_converter.py?' });
    c.text('Asked the reviewer.');
  });
  adapter.next.push(async (c) => c.text('It covers the edge cases.'));
  rt.sendMessage(topic.id, { text: '@alpha get the reviewer agent’s one-sentence opinion on test_converter.py' });
  await settle(rt);
  assert.equal(adapter.calls.find((x) => x.message.text?.startsWith('@alpha get')).sessionId, alpha.id);
  const answer = adapter.calls.find((x) => x.message.text === 'Your one-sentence opinion on test_converter.py?');
  assert.deepEqual([answer.sessionId, answer.thread], [beta.id, sideOf(store, t).id]);
  assert.ok(
    adapter.calls.some((x) => x.sessionId === alpha.id && x.message.from === '@beta'),
    'the answer went back to @alpha',
  );
  assert.equal(sessions(store).length, 2, 'the conversation’s two sessions, and no others');
  noForks(store);
});

test('#228 UAT 2: naming both agents in a topic thread reaches their two sessions, and the wake waits for @beta', async () => {
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
  assert.equal(Object.values(store.state.threads).find((x) => x.kind === 'side').queue.length, 1);
  reviewing.release();
  await settle(rt);
  assert.equal(sessions(store).length, 2, 'two sessions, not six');
  noForks(store);
  assert.equal(adapter.calls.find((x) => x.message.text === 'Please review converter.py.').sessionId, beta.id);
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
  // A persona whose session here is archived needs restoring, not adding.
  rt.archive(rt.sessionsIn(t.id).find((x) => x.handle === 'beta').id);
  assert.match(rt.agentWake(alpha.id, 'beta', 'Hello?').message, /@beta’s session in this conversation is archived/);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'hop').length, 1, 'no second card');
});

test('#228: forks from before are retired once at startup; their thread keeps its messages, and a message there goes to the conversation', async () => {
  const { store, rt, adapter, t, alpha } = await topicOnReply();
  const topic = Object.values(store.state.threads).find((x) => x.kind === 'topic');
  // A fork as Postbox made them before #228, with a reply in its thread, and the flag from a store that predates it.
  const fork = rt.ensureSession(topic.id, alpha.personaId);
  rt.updateSession(fork.id, { forkOf: { sessionId: alpha.id, itemId: null } });
  rt.addItem(topic.id, { kind: 'agent', sessionId: fork.id, personaId: alpha.personaId, handle: 'alpha', text: 'From the fork.', status: 'done' });
  store.emit('settings', { forksArchived: false });
  new Runtime({ store, adapters: new AdapterRegistry().register(adapter), corpus: rt.corpus, config: rt.config });
  assert.deepEqual([store.state.sessions[fork.id].archived, store.state.sessions[fork.id].retiredFork], [true, true]);
  assert.equal(store.state.settings.forksArchived, true);
  assert.equal(store.state.threads[topic.id].archived, false);
  assert.ok(store.items(topic.id).some((i) => i.text === 'From the fork.'));
  // It runs once: a session that is a fork later (none should be) isn’t touched by the next start.
  const later = rt.ensureSession(topic.id, rt.sessionsIn(t.id).find((x) => x.handle === 'beta').personaId);
  rt.updateSession(later.id, { forkOf: { sessionId: alpha.id, itemId: null } });
  new Runtime({ store, adapters: new AdapterRegistry().register(new ScriptedAdapter()), corpus: rt.corpus, config: rt.config });
  assert.equal(store.state.sessions[later.id].archived, false);
  rt.archive(later.id);
  // A message in its thread goes to the conversation’s @alpha, there.
  rt.sendMessage(topic.id, { text: '@alpha carry on' });
  await settle(rt);
  assert.deepEqual([adapter.calls.at(-1).sessionId, adapter.calls.at(-1).thread], [alpha.id, topic.id]);
  // Archived and restored with its conversation, the retired fork stays retired, and can’t be restored on its own.
  rt.archiveThread(t.id);
  rt.restoreThread(t.id);
  assert.ok(rt.sessionsIn(t.id).every((x) => !x.archived));
  assert.equal(store.state.sessions[fork.id].archived, true);
  assert.throws(() => rt.restore(fork.id), /can’t come back/);
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

test('#228: the migration takes a fork’s queued messages and open wake card with it, so nothing is delivered to it later', async () => {
  const done = noRejections();
  const { store, rt, adapter, alpha, topic } = await topicOnReply();
  const fork = rt.ensureSession(topic.id, alpha.personaId);
  rt.updateSession(fork.id, { forkOf: { sessionId: alpha.id, itemId: null } });
  rt.putThread({ ...store.state.threads[topic.id], queue: [{ id: 'q1', text: 'Saved before a restart', attachments: [], sessionIds: [fork.id], at: 1 }] });
  const card = rt.addItem(topic.id, { kind: 'hop', fromSessionId: fork.id, from: 'alpha', to: 'beta', text: 'Wake?', status: 'open', n: 4 });
  store.emit('settings', { forksArchived: false });
  new Runtime({ store, adapters: new AdapterRegistry().register(adapter), corpus: rt.corpus, config: rt.config });
  assert.deepEqual(store.state.threads[topic.id].queue, []);
  assert.equal(store.item(topic.id, card.id).status, 'declined');
  // The conversation’s @alpha answers there now; its turn ending drains the thread’s queue, which has nothing for the fork.
  rt.sendMessage(topic.id, { text: '@alpha go on' });
  await settle(rt);
  assert.equal(adapter.calls.filter((x) => x.sessionId === fork.id).length, 0);
  done();
});

test('#228: an archived agent can’t wake anyone, and a reply to one that was archived meanwhile goes nowhere, without failing', async () => {
  const done = noRejections();
  const { rt, adapter, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.agentWake(alpha.id, 'beta', 'Look at this.');
  await sleep(5);
  rt.archive(alpha.id);
  h.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((x) => x.sessionId === alpha.id).length, 0, 'the reply went to an archived session');
  assert.match(rt.agentWake(alpha.id, 'beta', 'Again?').message, /Your session is archived/);
  assert.equal(rt.turns.has(beta.id), false);
  done();
});
