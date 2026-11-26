// A thread’s glossary as written (#1819): a term define_term adds while a commit is held is pending, not published,
// and the turn that defined it uses it in the same reply, whose end checks its terms (server/turn-checks.mjs). So the
// check reads store.pending.glossary (server/store-held-glossary.mjs), and the published glossary stays as released.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTurn } from '../server/turn-checks.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';

const ZORBLAX = { key: 'zorblax', term: 'Zorblax', definition: 'A made-up ranking.', source: '', by: 'researcher', at: 1 };

/** A room on a store whose commit is held in its fsync: emits from now on are held. */
async function roomWhileHeld() {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  const close = async () => {
    h.release();
    await commit;
    await h.store.flush();
    await h.store.close();
  };
  return { ...env, store: h.store, close };
}

test('store.pending.glossary sees a term defined behind a held commit, and the published glossary doesn’t', async () => {
  const env = await roomWhileHeld();
  env.store.emit('glossary', { threadId: env.t.id, entry: ZORBLAX });
  assert.equal(env.store.pending.glossary(env.t.id).zorblax?.term, 'Zorblax', 'the held term is pending');
  assert.equal(env.store.state.glossary[env.t.id]?.zorblax, undefined, 'and not published');
  env.store.emit('remove', { kind: 'thread', id: env.t.id });
  assert.equal(env.store.pending.glossary(env.t.id).zorblax, undefined, 'a held removal of its thread takes it away');
  await env.close();
});

test('a reply that uses a term its turn defined while a commit is held has no term problem (#1819, checkTurn’s glossary)', async () => {
  const env = await roomWhileHeld();
  const out = await env.rt.toolsFor(env.se.id).define_term({ term: 'Zorblax', definition: 'A made-up ranking.' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(env.store.state.glossary[env.t.id]?.zorblax, undefined, 'the definition is held, not published');
  const turn = { id: 'tu_x', threadId: env.t.id, said: 'We rank these with [Zorblax](term:zorblax).' };
  const problems = checkTurn(env.rt.checks, turn, env.se).filter((p) => p.scope?.kind === 'term');
  assert.deepEqual(problems, [], 'the term the turn defined is known');
  await env.close();
});

test('a term published before the hold stays in the pending glossary beside one defined behind it', async () => {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  h.store.emit('glossary', { threadId: env.t.id, entry: { ...ZORBLAX, key: 'quux', term: 'Quux' } });
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  h.store.emit('glossary', { threadId: env.t.id, entry: ZORBLAX });
  assert.deepEqual(Object.keys(h.store.pending.glossary(env.t.id)).sort(), ['quux', 'zorblax'], 'the published term and the held one');
  h.release();
  await commit;
  await h.store.flush();
  await h.store.close();
});

test('define_term in a topic opened while a commit is held says so when the conversation’s definition is held too (#1819, define_term’s note)', async () => {
  const env = await roomWhileHeld();
  const root = env.rt.threads.addItem(env.t.id, { kind: 'agent', sessionId: env.se.id, handle: 'researcher', text: 'The numbers.', status: 'done' });
  await env.rt.toolsFor(env.se.id).open_topic({ itemId: root.id, message: 'A closer look.' });
  const topicId = Object.values(env.store.pending.threads()).find((x) => x.kind === 'topic')?.id;
  assert.equal(env.store.state.threads[topicId], undefined, 'the topic is held, not published');
  env.store.emit('glossary', { threadId: env.t.id, entry: ZORBLAX });
  const out = await env.rt.toolsFor(env.se.id, { id: 'tu_x', threadId: topicId }).define_term({ term: 'Zorblax', definition: 'Here, a stricter ranking.' });
  assert.match(out.message, /over the conversation’s definition/, JSON.stringify(out));
  await env.close();
});
