// #466, from the integrator’s re-review of #522 at cc950c7: at a restart, a running scheduled wake is left to a host
// turn only when that host turn is the wake’s own. One queued behind another turn on the host never started, so it’s
// due again.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fireScheduledWake, rearmWakes } from '../server/scheduled-wakes.mjs';
import { Store } from '../server/store.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { rig, running, starts, until } from './remote-turns-helpers.mjs';

const fire = (rt, sc) => {
  clearTimeout(rt.timers.get(sc.id));
  fireScheduledWake(rt, sc);
};
/** Postbox stops with its turn still on the host (close() leaves host turns running), and starts again on the same store. */
const restart = (first) => {
  first.rt.remote.close();
  const again = rig({ store: first.store, d: first.d });
  rearmWakes(again.rt);
  return again;
};

test('#466 a scheduled wake queued behind the person’s turn on a host is due again after a restart, not finished as done', async () => {
  const first = rig({ store: new Store(null), d: createFakeDaemon({ autoEnd: false }) });
  await running(first, 'Work on it.');
  const sc = first.rt.schedule(first.se().id, { inMs: 60_000, note: 'Check later.' });
  fire(first.rt, sc);
  assert.equal(first.rt.turns.get(first.se().id).pending.length, 1, 'the wake waits behind the person’s turn');
  assert.equal(first.se().remoteTurn.state, 'running');
  const r = restart(first);
  assert.ok(r.store.state.schedules[sc.id], 'the wake is still saved');
  assert.equal(r.rt.timers.has(sc.id), true, 'and armed, since its own turn never started');
  assert.notEqual(r.store.item(sc.threadId, sc.itemId).status, 'done');
  clearTimeout(r.rt.timers.get(sc.id));
});

test('#466 a scheduled wake whose own turn still runs on a host at a restart is left to that host turn', async () => {
  const first = rig({ store: new Store(null), d: createFakeDaemon({ autoEnd: false }) });
  const sc = first.rt.schedule(first.se().id, { inMs: 60_000, note: 'Check the host.' });
  fire(first.rt, sc);
  await until(() => starts(first.d).length === 1, 'the wake’s turn to start on the host');
  assert.equal(first.store.state.schedules[sc.id].turnId, first.se().remoteTurn.rtTurn, 'the schedule names its own turn');
  const r = restart(first);
  assert.equal(r.rt.timers.has(sc.id), false, 'no second turn is armed');
  assert.equal(r.store.state.schedules[sc.id], undefined);
});
