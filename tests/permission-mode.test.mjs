// A permission mode changed while a turn runs (#371, #381): a backend that can’t change a running turn keeps the mode
// the turn started with until it ends, and setPermissionMode says which agents’ turns did, so the panel can say so.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('#371 a running turn its backend can’t change is listed as keeping its mode; with none running, nothing is', async () => {
  const { rt, adapter, t, a } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.sendMessage(t.id, { text: '@alpha run the tests' });
  await sleep(5);
  assert.deepEqual(await rt.setPermissionMode(a.id, 'bypass'), { ok: true, now: [], later: ['alpha'] });
  assert.equal(rt.persona(a.id).permissionMode, 'bypass', 'the persona changes at once, for its next turns');
  h.release();
  await settle(rt);
  assert.deepEqual(await rt.setPermissionMode(a.id, 'ask'), { ok: true, now: [], later: [] });
});
