// How a host runner’s silence is timed and kept (server/remote/host/daemon-running.mjs, #738): on the daemon’s
// monotonic clock, so setting the wall clock neither stretches the ceiling nor cuts it short. In-process with fake
// runners and a fake clock (tests/remote-daemon-running-setup.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CEILING_MS, silentSetup, startReading } from './remote-daemon-running-setup.mjs';

const HOUR = 3_600_000;

test('#738 a wall clock set an hour ahead during a silence doesn’t end a live runner before the ceiling', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(2, c);
    s.clock.stepWall(HOUR);
    await s.looks(3, c);
    await s.clock.tick(CEILING_MS - 1);
    await s.looks(3, c);
    assert.deepEqual(s.ended(c), [], 'still running a millisecond before 60 s of monotonic time');
    assert.equal((await s.daemon.scan())[0].state, 'running');
    await s.clock.tick(1);
    assert.equal((await c.msgs.next('ended')).exit, null);
  } finally {
    s.done();
  }
});

test('#738 a wall clock set an hour back during a silence doesn’t keep a live runner past the ceiling', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(2, c);
    s.clock.stepWall(-HOUR);
    await s.clock.tick(CEILING_MS - 1);
    await s.looks(3, c);
    assert.deepEqual(s.ended(c), [], 'still running a millisecond before 60 s of monotonic time');
    await s.clock.tick(1);
    assert.equal((await c.msgs.next('ended')).exit, null, 'ended at 60 s of monotonic time');
    assert.equal((await s.daemon.scan())[0].state, 'interrupted');
  } finally {
    s.done();
  }
});
