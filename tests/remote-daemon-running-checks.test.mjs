// How often a silent host runner’s process is checked (server/remote/host/daemon-running.mjs, #872): a silence keeps
// its last process check for PROCESS_CHECK_MS, since on macOS each check runs sysctl and ps and holds up the daemon,
// and the ceiling’s decision always takes a fresh one. In-process with fake runners and a fake clock
// (tests/remote-daemon-running-setup.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silentSetup, startReading } from './remote-daemon-running-setup.mjs';

test('#872 a runner silent for 10 s has its process checked about every 5 s, not at each look', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(2, c);
    for (let i = 0; i < 10; i++) {
      await s.clock.tick(1000);
      await s.looks(3, c);
    }
    assert.deepEqual(s.ended(c), []);
    assert.ok(s.sameCalls.n <= 3, `${s.sameCalls.n} process checks over 32 looks in 10 s`);
  } finally {
    await s.done();
  }
});
