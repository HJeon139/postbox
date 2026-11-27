// What tests/uat/e2e/scenarios/hostwakes.md relies on in the real wake logic (server/side-threads.mjs): a message from
// the person clears the count of wakes in a row, so a hand-off right after it goes, though the chain before it stopped
// at the cap. Since #492 there is no pair limit, and since #1623 the cap stops a chain with no card, so a hand-off
// between two agents after the person’s message goes too.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOP_LIMIT } from '../shared/limits.mjs';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** The fixture's room with @gamma, whose chain stopped at the cap when @alpha woke @beta (phase 1). */
async function chainStopped() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.handle === 'gamma');
  const wake = async (from, to) => {
    const r = f.rt.agentWake(from.id, to, `${from.handle} to ${to}`);
    await settle(f.rt);
    return r;
  };
  arrange.setThread(f.rt, f.t.id, { hops: HOP_LIMIT });
  assert.equal((await wake(f.alpha, 'beta')).ok, false, 'the wake past the cap didn’t go');
  return { ...f, gamma, wake };
}

test('a message from the person clears the count, so a hand-off right after it goes through though the chain had stopped', async () => {
  const { rt, t, gamma, wake } = await chainStopped();
  rt.sendMessage(t.id, { text: 'hand @alpha the line count' });
  await settle(rt);
  assert.equal((await wake(gamma, 'alpha')).ok, true, 'the first wake since the message goes');
});

test('#492 a pair’s third wake since the person’s message goes too: there’s no pair limit', async () => {
  const { rt, store, t, alpha, gamma, wake } = await chainStopped();
  rt.sendMessage(t.id, { text: '@gamma ask @alpha, then hand it the line count' });
  await settle(rt);
  assert.equal((await wake(gamma, 'alpha')).ok, true);
  // Alpha’s answer named no one, so it went back to gamma (#1518): the pair’s second wake, which went too.
  const back = store.items(t.id).findLast((x) => x.kind === 'agent' && x.handle === 'alpha');
  assert.deepEqual([back.hop, back.wentBack], [2, ['gamma']]);
  assert.equal((await wake(alpha, 'gamma')).ok, true, 'the pair’s third wake');
});
