// What the permissions view lists about a turn that runs while its persona’s mode changes (#1030), from
// server/permissions-panel.mjs. A turn loads the person’s hooks when it starts and keeps them until it ends, and a
// change to the mode reaches only the next turn, so the view names the running turns that loaded them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('#1030: the panel lists the running turns that loaded the hooks, whatever the mode is now, and none once they end', async () => {
  const f = setup();
  const h = held();
  f.adapter.next.push(h.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha run the tests' });
  await sleep(5);
  f.rt.updatePersona(f.a.id, { permissionMode: 'bypass' });
  const during = await f.rt.permissionsView({ sessionId: f.alpha.id });
  assert.deepEqual([during.running, during.hooksRunning], [['alpha'], ['alpha']], 'Run everything now, and its Auto turn still runs the hooks');
  h.release();
  await settle(f.rt);
  assert.deepEqual((await f.rt.permissionsView({ sessionId: f.alpha.id })).hooksRunning, [], 'none once it ends');
});
