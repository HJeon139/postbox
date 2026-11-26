// #1713: a host turn interrupted while its agent waited to retry a provider’s failure ends that wait, as any other
// failure does: the earlier reply no longer says Postbox will try again, and the agent needs the person for the
// interrupted turn. Built on the rig in tests/remote-turns-helpers.mjs, as tests/remote-turns-no-backend.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { restarted, rig, settled, startUp, until } from './remote-turns-helpers.mjs';

test('#1713 a host turn interrupted while the agent waited to retry ends the wait and clears its reply’s note', async () => {
  const { store, d } = restarted({ welcome: 'missing' });
  const r = rig({ store, d });
  const threadId = r.se().threadId;
  const waited = r.rt.threads.addItem(threadId, {
    kind: 'agent',
    sessionId: r.se().id,
    handle: r.se().handle,
    text: '',
    status: 'retried',
    note: 'The provider was overloaded (529), so Postbox will try again in 30 s.',
    transient: { status: 529, at: Date.now() + 30_000 },
  });
  r.rt.sessions.update(r.se().id, { autoRetry: { tries: 1, at: Date.now() + 30_000, status: 529, threadId, itemId: waited.id } });
  arrange.withoutAdapters(r.rt);
  startUp(r);
  await until(() => r.se().remoteTurn?.state === 'interrupted', 'Interrupted');
  await settled(r);
  assert.equal(r.se().autoRetry ?? null, null, 'the wait ended');
  const reply = r.store.item(threadId, waited.id);
  assert.equal(reply.note ?? null, null, 'its note no longer says when it would try');
  assert.equal(reply.transient.at, null);
  assert.equal(r.se().needs?.kind, 'failed', 'the interrupted turn needs the person');
});
