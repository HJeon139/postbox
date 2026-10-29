// What tests/uat/e2e/scenarios/hostwakes.md relies on in the real wake logic (server/side-threads.mjs): a message from
// the person clears the count of wakes in a row, so a hand-off right after it goes though a card waits. Since #492 there
// is no pair limit, so a card comes only from the chain limit (HOP_LIMIT), and a hand-off between two agents after the
// person’s message goes too: the scenario’s phases, built on the pair card, need reworking for that (#492).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOP_LIMIT } from '../shared/limits.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** The fixture's room with @gamma, and a card from @alpha's wake of @beta past the chain limit, left open (phase 1). */
async function cardOpen() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  const wake = async (from, to) => {
    const r = f.rt.agentWake(from.id, to, `${from.handle} to ${to}`);
    await settle(f.rt);
    return r;
  };
  for (let i = 0; i < HOP_LIMIT; i++) await (i % 2 ? wake(f.beta, 'alpha') : wake(f.alpha, 'beta'));
  assert.equal((await wake(f.alpha, 'beta')).waiting, true, 'the wake past the chain limit raised the card');
  return { ...f, gamma, wake };
}

test('a message from the person clears the counts, so a hand-off right after it goes through though a card waits', async () => {
  const { rt, t, gamma, wake } = await cardOpen();
  rt.sendMessage(t.id, { text: 'hand @alpha the line count' });
  await settle(rt);
  assert.equal((await wake(gamma, 'alpha')).ok, true, 'the first wake since the message never reaches the card check');
});

test('#492 a pair’s third wake since the person’s message goes too, though a card waits: there’s no pair limit', async () => {
  const { rt, t, alpha, gamma, wake } = await cardOpen();
  rt.sendMessage(t.id, { text: '@gamma ask @alpha, then hand it the line count' });
  await settle(rt);
  assert.equal((await wake(gamma, 'alpha')).ok, true);
  assert.equal((await wake(alpha, 'gamma')).ok, true);
  assert.equal((await wake(gamma, 'alpha')).ok, true);
});
