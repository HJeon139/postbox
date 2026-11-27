// #1904: a host turn whose link gave up runs on there, and is attached again once the host is back, so its agent has
// what the turn took: nothing goes back to the session (turn-finish.mjs, neverRan). From the integrator’s review of
// #1935.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { messageOf, rig, running, settled, starts } from './remote-turns-helpers.mjs';

test('#1904 a host turn whose link gave up keeps the notice it took, since it runs on there', async () => {
  const r = rig();
  arrange.setSession(r.rt, r.se().id, { context: ['[Postbox] Your message to @critic was delivered.'] });
  const turn = await running(r);
  assert.match(messageOf(starts(r.d).at(-1)), /was delivered/, 'the host has it');
  r.link.giveUp();
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'lost');
  assert.equal(r.d.turns.get(turn).exit, null, 'the turn runs on there');
  assert.deepEqual(r.se().context ?? [], []);
});

test('#1904 a later turn that never reached its agent gives back its notice, though an earlier host turn’s link gave up', async () => {
  const r = rig();
  await running(r);
  r.link.giveUp();
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'lost', 'the earlier turn waits to be attached again');
  // Send now starts a new turn while the earlier one waits; it takes the notice, then is stopped before any output.
  arrange.setSession(r.rt, r.se().id, { context: ['[Postbox] A later notice.'] });
  r.rt.sendMessage(r.t.id, { text: 'Now, please.', sendNow: true });
  await settled(r);
  r.rt.stop(r.se().id);
  await settled(r);
  assert.deepEqual(r.se().context ?? [], ['[Postbox] A later notice.']);
});
