// #975’s first gap: the ceiling’s kill waits out Stop’s grace (server/remote/host/daemon-running.mjs, killTimers). With
// production’s grace, 10 s and so longer than KILL_WAIT_MS, a Stop pressed just before the ceiling must not end the
// turn unkilled before Stop’s own SIGKILL. The other kill cases run a 5 s grace, which ends inside KILL_WAIT_MS, so
// removing that wait passed them all. In-process with fake runners and a fake clock.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STOP_GRACE_MS } from '../server/remote/host/daemon-constants.mjs';
import { CEILING_MS, KILL_WAIT_MS, silentSetup, startReading } from './remote-daemon-running-setup.mjs';
import { waitFor } from './remote-daemon-setup.mjs';

const PID = 4001;

test('#975 a Stop 2 s before the ceiling, with a grace longer than KILL_WAIT_MS, ends on Stop’s SIGKILL, not unkilled', async () => {
  assert.ok(STOP_GRACE_MS > KILL_WAIT_MS + 2000, 'production’s grace outlasts the ceiling’s wait here');
  const s = silentSetup({ stopGraceMs: STOP_GRACE_MS });
  const c = await startReading(s);
  try {
    s.alive.delete('t1');
    await s.looks(2, c);
    await s.clock.tick(CEILING_MS - 2000);
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    // The ceiling comes 2 s into the grace, and KILL_WAIT_MS passes with the grace still running.
    await s.clock.tick(2000);
    await s.looks(3, c);
    await s.clock.tick(KILL_WAIT_MS + 1000);
    await s.looks(3, c);
    assert.deepEqual(s.ended(c), [], 'the turn waits for Stop’s grace, not ended unkilled before its SIGKILL');
    assert.deepEqual(s.kills, [[-PID, 'SIGINT']]);
    await s.clock.tick(STOP_GRACE_MS);
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit.signal, 'SIGKILL');
    assert.notEqual(ended.unkilled, true);
    assert.deepEqual(s.kills, [
      [-PID, 'SIGINT'],
      [-PID, 'SIGKILL'],
    ]);
  } finally {
    await s.done();
  }
});
