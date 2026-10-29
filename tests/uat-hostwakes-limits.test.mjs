// What tests/uat/e2e/scenarios/hostwakes.md relies on in the real wake logic (server/side-threads.mjs): a message from
// the person clears the counts of wakes in a row, so only a pair’s third wake since it reaches the open card’s check.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

/** The fixture's room with @gamma, and a pair card from @alpha's third wake of @beta in a row, left open (phase 1). */
async function cardOpen() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  const wake = async (from, to) => {
    const r = f.rt.agentWake(from.id, to, `${from.handle} to ${to}`);
    await settle(f.rt);
    return r;
  };
  await wake(f.alpha, 'beta');
  await wake(f.beta, 'alpha');
  assert.equal((await wake(f.alpha, 'beta')).waiting, true, 'the third wake in a row raised the card');
  return { ...f, gamma, wake };
}

test('a message from the person clears the counts, so a hand-off right after it goes through though a card waits', async () => {
  const { rt, t, gamma, wake } = await cardOpen();
  rt.sendMessage(t.id, { text: 'hand @alpha the line count' });
  await settle(rt);
  assert.equal((await wake(gamma, 'alpha')).ok, true, 'the first wake since the message never reaches the card check');
});

test('as phase 2 plays it, a hand-off that is a pair’s third wake since the person’s message is held on the waiting card (#439)', async () => {
  // Each hand-off follows one message from the person: a request, its answer, then the hand-off, all between two agents.
  const { rt, t, alpha, gamma, wake } = await cardOpen();
  rt.sendMessage(t.id, { text: '@gamma ask @alpha, then hand it the line count' });
  await settle(rt);
  assert.equal((await wake(gamma, 'alpha')).ok, true);
  assert.equal((await wake(alpha, 'gamma')).ok, true);
  assert.match((await wake(gamma, 'alpha')).message, /^Postbox is holding your message to @alpha: .* is waiting for the person/);
});
