// The fallback reads what is held behind a commit (#366, #601's rule: a read that decides a write reads pending): an app
// card shown while a commit waits for its sync is the agent's next need when the card before it is answered.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldStore, setup } from './stop-reply-fixture.mjs';

test('an app card held behind a commit becomes the need when the card before it is answered', async () => {
  const h = await heldStore();
  const { rt, t, se } = await setup(async () => {}, h.store);
  const card = () => rt.addItem(t.id, { kind: 'appsend', sessionId: se.id, appId: 'app1', title: 'App', events: [{ action: 'x' }], status: 'open' });
  const first = card();
  rt.updateSession(se.id, { needs: { kind: 'appsend', itemId: first.id, text: 'App' }, state: 'needs' });
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  const second = card(); // held behind the commit: not in items() yet
  assert.equal(
    h.store.items(t.id).some((x) => x.id === second.id),
    false,
    'the second card is held',
  );
  rt.resolveAppSend(t.id, first.id, 'deny');
  h.release();
  await commit;
  await h.store.flush();
  assert.equal(rt.s.sessions[se.id].needs?.itemId, second.id, 'the held card is the need');
  await h.store.close();
});
