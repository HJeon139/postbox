// #283 while a commit is held (#796’s class, from lead-loop’s review): a conversation, and a topic of it, made behind a
// held commit aren’t in the published state yet. deletedFrom found the conversation through the published threads, so
// it found none there, and said an agent deleted from it hadn’t been: threadPersona would then bring it back. Both
// read the conversation as written.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deletedFrom, threadPersona } from '../server/side-threads.mjs';
import * as arrange from './arrange.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';

test('an agent deleted from a conversation made behind a held commit reads as deleted, and isn’t chosen to answer', async () => {
  const h = await heldStore();
  const { rt } = await setup(async () => {}, h.store);
  const [alpha, beta] = ['alpha', 'beta'].map((handle) => rt.createPersona({ handle, backend: 'claude-code' }));
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync; // the commit is in flight: emits from now on are held behind it
  try {
    const conv = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [alpha.id, beta.id] });
    const a = rt.sessions.pendingIn(conv.id).find((x) => x.personaId === alpha.id);
    const topic = arrange.putThread(rt, { id: 'th_heldtopic', projectId: 'p1', title: 'Thread', kind: 'topic', parentId: conv.id, woke: 'alpha', members: [] });
    rt.deleteSession(a.id);
    assert.equal(h.store.state.threads[conv.id], undefined, 'the conversation is still held');
    assert.equal(deletedFrom(rt, topic, 'alpha'), true, 'alpha reads as deleted');
    assert.equal(deletedFrom(rt, topic, 'beta'), false, 'beta is still here');
    assert.equal(threadPersona(rt, topic)?.handle, 'beta', 'beta answers, not alpha brought back');
  } finally {
    h.release();
    await commit;
    await h.store.flush();
    await h.store.close();
  }
});
