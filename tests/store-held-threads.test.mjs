// Reads of a thread that decide a write read it as written (#623): a topic open_topic opened while a commit is held
// is pending, not published, so a reader of the published threads doesn’t find it, and the write it decides lands in
// the wrong place. Each test opens the topic behind a held commit, then makes the write that reads it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bringToConversation } from '../server/bring.mjs';
import { nextNeed } from '../server/card-needs.mjs';
import { newId } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { heldStore, setup, until } from './stop-reply-fixture.mjs';

/** A room whose agent opens a topic once a commit is held; `release` lets the commit, and what it held, through. */
async function topicWhileHeld(step = async () => {}, before = (/** @type {any} */ _env) => {}) {
  const h = await heldStore();
  const env = await setup(step, h.store);
  before(env);
  const root = arrange.post(env.rt, env.t.id, { kind: 'agent', sessionId: env.se.id, handle: 'researcher', text: 'The numbers.', status: 'done' });
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  const opened = await env.rt.toolsFor(env.se.id).open_topic({ itemId: root.id, message: 'A closer look.' });
  const topicId = Object.values(h.store.pending.threads()).find((x) => x.kind === 'topic')?.id;
  assert.ok(topicId, `the topic is opened: ${JSON.stringify(opened)}`);
  assert.equal(h.store.state.threads[topicId], undefined, 'the topic is held, not published');
  const release = async () => {
    h.release();
    await commit;
    await h.store.flush();
  };
  return { ...env, store: h.store, topicId, release, close: () => h.store.close() };
}

test('a card in a topic opened while a commit is held is the agent’s need (#623, card-needs threadsOf)', async () => {
  const env = await topicWhileHeld();
  const card = arrange.post(env.rt, env.topicId, { kind: 'hop', fromSessionId: env.se.id, to: 'critic', status: 'open', text: 'Wake @critic?' });
  assert.equal(nextNeed(env.rt, env.se)?.itemId, card.id, 'the held topic’s card is found');
  await env.release();
  await env.close();
});

test('write_asset in a topic opened while a commit is held files the asset in the conversation’s room (#623, asset-tools room)', async () => {
  const env = await topicWhileHeld();
  // Its commit is sequenced behind the held one, so it settles once that is released.
  const writing = env.rt.assets.tools(env.se.id, { threadId: env.topicId }).write_asset({ name: 'notes.md', text: 'Hello' });
  await env.release();
  const out = await writing;
  assert.notEqual(out.ok, false, JSON.stringify(out));
  const rooms = Object.values(env.store.state.assets ?? {}).map((a) => a.room);
  assert.deepEqual(rooms, [env.t.id], 'the room is the conversation, not the topic');
  await env.close();
});

test('a turn in a topic opened while a commit is held records its work in the conversation’s list (#623, ledger convOf)', async () => {
  let ran = false;
  const env = await topicWhileHeld(async () => {
    ran = true;
  });
  arrange.deliver(env.rt, env.se.id, { kind: 'user', text: 'Go on.' }, { threadId: env.topicId });
  await until(() => ran, 'the turn in the topic');
  env.rt.stop(env.se.id);
  await env.release();
  const work = env.store.state.work ?? {};
  assert.equal(work[env.topicId], undefined, 'nothing filed under the topic');
  assert.ok(
    (work[env.t.id] ?? []).some((e) => e.kind === 'turn'),
    'the turn’s entry is in the conversation’s list',
  );
  await env.close();
});

test('bring_to_conversation in a topic opened while a commit is held posts in the conversation (#623, bring)', async () => {
  const env = await topicWhileHeld();
  const out = bringToConversation(env.rt, env.se.id, { kind: 'user', threadId: env.topicId }, { text: 'The short version.' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(env.store.pending.items(env.t.id).some((x) => x.kind === 'shared' && x.text === 'The short version.'));
  await env.release();
  await env.close();
});

test('a post shared from a topic opened while a commit is held carries the topic’s title (#623, share-back shareText)', async () => {
  const env = await topicWhileHeld();
  const it = arrange.shareText(env.rt, env.t.id, { fromThreadId: env.topicId, handle: 'researcher', text: 'Found it.' });
  assert.equal(it.fromTitle, env.store.pending.thread(env.topicId)?.title);
  assert.notEqual(it.fromTitle, '');
  await env.release();
  await env.close();
});

test('open_topic on a message in a topic opened while a commit is held finds that topic (#623, topic-open conversationOf)', async () => {
  const env = await topicWhileHeld();
  const inTopic = env.store.pending.items(env.topicId).find((x) => x.text === 'A closer look.');
  const out = await env.rt.toolsFor(env.se.id).open_topic({ itemId: inTopic.id, message: 'Deeper still.' });
  // Its topic is found, so the refusal names it, not a message that isn’t there.
  assert.equal(out.ok, false);
  assert.match(out.message, /A topic thread can’t start another one/);
  await env.release();
  await env.close();
});

test('a side thread opened while a commit is held counts its first message on its line (#623, side-threads bumpSideLink)', async () => {
  const env = await topicWhileHeld();
  const side = arrange.putThread(env.rt, {
    id: newId('th'),
    projectId: env.t.projectId,
    title: 'Side',
    kind: 'side',
    parentId: env.t.id,
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
  });
  arrange.post(env.rt, env.t.id, { kind: 'sidelink', sideThreadId: side.id, from: 'you', to: 'researcher', count: 0 });
  arrange.post(env.rt, side.id, { kind: 'user', text: 'A question in the side thread' });
  await env.release();
  assert.equal(env.store.items(env.t.id).find((i) => i.kind === 'sidelink')?.count, 1);
  await env.close();
});

test('a reply in a topic opened while a commit is held knows its conversation’s terms (#623, checkTurn’s glossary)', async () => {
  const { checkTurn } = await import('../server/turn-checks.mjs');
  // The conversation defined the term before the commit was held, so it’s published; the topic isn’t.
  const env = await topicWhileHeld(undefined, (e) =>
    e.store.emit('glossary', {
      threadId: e.t.id,
      entry: { key: 'zorblax', term: 'Zorblax', definition: 'A made-up ranking.', source: '', by: 'researcher', at: Date.now() },
    }),
  );
  const turn = { id: 'tu_x', threadId: env.topicId, said: 'We rank these with [Zorblax](term:zorblax).' };
  const problems = checkTurn(env.rt.checks, turn, env.se).filter((p) => p.scope?.kind === 'term');
  assert.deepEqual(problems, [], 'the conversation’s term is known in its held topic');
  await env.release();
  await env.close();
});
