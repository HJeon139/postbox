// The fallback reads what is held behind a commit (#366, #601's rule: a read that decides a write reads pending): a wake
// request raised while a commit waits for its sync is the agent's next need when the card before it is answered.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';

test('a wake request held behind a commit becomes the need when the card before it is answered', async () => {
  const h = await heldStore();
  const { rt, t, se } = await setup(async () => {}, h.store);
  const card = () => arrange.post(rt, t.id, { kind: 'hop', fromSessionId: se.id, from: se.handle, to: 'beta', status: 'open', text: 'please' });
  const first = card();
  arrange.setSession(rt, se.id, { needs: { kind: 'hop', itemId: first.id, text: 'hop' }, state: 'needs' });
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
  rt.resolveHop(t.id, first.id, false);
  h.release();
  await commit;
  await h.store.flush();
  assert.equal(rt.s.sessions[se.id].needs?.itemId, second.id, 'the held card is the need');
  await h.store.close();
});
