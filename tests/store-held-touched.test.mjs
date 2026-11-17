// A pending read of a list or collection that nothing held touches is the published one, with no view built
// (server/store-held.mjs, HeldLog): a busy room reads every agent’s inbox while a snapshot or a commit holds its writes,
// and most inboxes have nothing held. One that a held event touches still sees it, and the count follows each release.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldStore } from './stop-reply-fixture.mjs';

test('while writes are held, an untouched list reads as the published one, and a touched one sees what’s held', async () => {
  const h = await heldStore();
  const { store } = h;
  store.emit('session', { id: 'se_a', threadId: 't1' });
  store.emit('session', { id: 'se_b', threadId: 't1' });
  store.emit('entry.add', { sessionId: 'se_a', entry: { id: 'en_1', threadId: 't1', source: 'mention', itemId: 'it_1', state: 'waiting' } });
  store.emit('entry.add', { sessionId: 'se_b', entry: { id: 'en_2', threadId: 't1', source: 'mention', itemId: 'it_2', state: 'waiting' } });
  await store.flush();
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  store.emit('entry.patch', { sessionId: 'se_a', id: 'en_1', patch: { state: 'taken' } }); // held, on se_a’s inbox only
  assert.ok(store.held > 0);
  assert.equal(store.pending.inbox('se_b'), store.state.inbox.se_b, 'nothing held touches it: the published array itself');
  assert.equal(store.pending.inbox('se_a')[0].state, 'taken', 'the held patch shows on the one it touches');
  assert.equal(store.pending.session('se_b'), store.state.sessions.se_b, 'no held session write: the published session');
  store.emit('session.patch', { id: 'se_b', patch: { glimpse: 'Looking' } });
  assert.equal(store.pending.session('se_b').glimpse, 'Looking', 'a held session write shows');
  h.release();
  await commit;
  await store.flush();
  assert.equal(store.held, 0);
  assert.deepEqual([.../** @type {any} */ (store.heldLog).touched.keys()], [], 'every count taken back at its release');
  assert.equal(store.pending.inbox('se_a')[0].state, 'taken');
  await store.close();
});
