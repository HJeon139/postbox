// #1620 while a commit is held (#1292’s class): a conversation started behind a held commit isn’t in the published
// state yet, so adding an agent to it from the Agents header’s + read it as missing and answered 404.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionRoute } from '../server/session-routes.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';

test('#1620 an agent can be added to a conversation started behind a held commit', async () => {
  const h = await heldStore();
  const { rt } = await setup(async () => {}, h.store);
  const [alpha, beta] = ['alpha', 'beta'].map((handle) => rt.createPersona({ handle, backend: 'claude-code' }));
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync; // the commit is in flight: emits from now on are held behind it
  try {
    const conv = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [alpha.id] });
    assert.equal(h.store.state.threads[conv.id], undefined, 'the conversation is still held');
    const r = await sessionRoute(rt, `/api/threads/${conv.id}/agents`, 'POST', { personaId: beta.id });
    assert.equal(r?.status, 201);
    assert.equal(r.body.handle, 'beta');
  } finally {
    h.release();
    await commit;
    await h.store.flush();
    await h.store.close();
  }
});
