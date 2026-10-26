// How the UAT runner judges a host’s recovery from a fault (#120; tools/uat/hosts-recovery.mjs): by Postbox’s host
// status events as each arrived, as well as by reads of the state. In the third live run a kill-ssh on host2 read
// Connected at every read, and counted as recovered though nothing showed it was ever cut off. No processes: the
// state, the events and the clock are fakes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recovery, says } from '../tools/uat/hosts-recovery.mjs';

const AT = 1_000_000;
/** A run with host2, whose state reads always say `state`, and the events Postbox sent, on a fake clock. */
function run(state, events = []) {
  let t = AT + 80;
  const hr = /** @type {any} */ ({
    placement: { critic: 'host2' },
    api: async () => ({ state: { hostStatus: { ho_2: { state } }, sessions: {} } }),
    hostStates: () => events,
  });
  return { hr, h: /** @type {any} */ ({ id: 'ho_2', label: 'host2' }), o: { now: () => t, wait: async (ms) => (t += ms) } };
}

test('#120 a fault’s recovery: a drop and reconnect between two reads still shows, from the events', async () => {
  const { hr, h, o } = run('connected', [
    { at: AT + 40, id: 'ho_2', state: 'reconnecting' },
    { at: AT + 70, id: 'ho_1', state: 'reconnecting' },
    { at: AT + 75, id: 'ho_2', state: 'connected' },
  ]);
  const r = await recovery(hr, h, AT, o);
  assert.equal(r.recovered, true);
  assert.deepEqual(
    r.states.map((s) => [s.state, s.ms]),
    [
      ['reconnecting', 40],
      ['connected', 75],
    ],
  );
});

test('#120 a fault’s recovery: a host that read Connected throughout wasn’t cut off, so it isn’t recovered', async () => {
  const { hr, h, o } = run('connected');
  const r = await recovery(hr, h, AT, o);
  assert.deepEqual([r.recovered, r.unseen], [null, true]);
  assert.match(says('host2', r, []), /^host2 read connected at 0\.1 s; it never read anything but Connected, so the fault didn’t cut it off/);
});

test('#120 a fault’s recovery: a read that failed, then Connected, isn’t a drop', async () => {
  const { hr, h, o } = run('connected');
  let reads = 0;
  hr.api = async () => {
    if (reads++ === 0) throw new Error('fetch failed');
    return { state: { hostStatus: { ho_2: { state: 'connected' } }, sessions: {} } };
  };
  const r = await recovery(hr, h, AT, o);
  assert.deepEqual([r.recovered, r.unseen], [null, true]);
  assert.equal(r.states[0].state, 'unknown');
  // With a status event that shows the drop, the same reads are a recovery.
  const seen = run('connected', [{ at: AT + 30, id: 'ho_2', state: 'reconnecting' }]);
  reads = 0;
  seen.hr.api = hr.api;
  assert.equal((await recovery(seen.hr, seen.h, AT, seen.o)).recovered, true);
});
