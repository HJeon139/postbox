// A host runner’s silence across a daemon restart (server/remote/host/daemon-running.mjs, #872): kept in the turn
// folder, so a daemon restarted again and again within the ceiling still reaches it. A new daemon on the same boot,
// with runner.json naming the same process, goes on from where the silence began; on another boot it starts over.
// In-process with fake runners and fake clocks (tests/remote-daemon-running-setup.mjs).

import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { test } from 'node:test';
import { CEILING_MS, silentSetup } from './remote-daemon-running-setup.mjs';
import { fakeClock, hello, startMsg } from './remote-daemon-setup.mjs';

const PID = 4001;

/** A daemon whose t1 has been silent for `ms` by its scan, then a new one over its home, its clocks going on. */
async function restartedAfter(ms) {
  const old = silentSetup();
  const c = await hello(old);
  c.send('start', startMsg('t1'));
  await c.msgs.next('started');
  old.alive.delete('t1');
  assert.equal((await old.daemon.scan())[0].state, 'running');
  await old.clock.tick(ms);
  // The new daemon’s home has the old one’s turn folders, as a restart over the same home leaves them.
  const s = silentSetup({ clock: fakeClock(old.clock.now()) });
  cpSync(old.p.turns, s.p.turns, { recursive: true });
  await old.done();
  return s;
}

test('#872 a daemon restarted mid-silence on the same boot kills the runner at 60 s of silence in all', async () => {
  const s = await restartedAfter(30_000);
  try {
    assert.equal((await s.daemon.scan())[0].state, 'running');
    await s.clock.tick(CEILING_MS - 30_000 - 1);
    assert.equal((await s.daemon.scan())[0].state, 'running');
    assert.deepEqual(s.kills, [], 'a millisecond before');
    await s.clock.tick(1);
    await s.daemon.scan();
    assert.deepEqual(s.kills, [[-PID, 'SIGKILL']], 'at 60 s since the silence began, under the old daemon');
  } finally {
    await s.done();
  }
});

test('#872 a daemon on another boot starts a silence over, whatever the turn folder kept', async () => {
  const s = await restartedAfter(30_000);
  try {
    s.state.boot = 'another-boot';
    assert.equal((await s.daemon.scan())[0].state, 'running');
    await s.clock.tick(CEILING_MS - 1);
    await s.daemon.scan();
    assert.deepEqual(s.kills, [], 'its own 60 s, not the old boot’s');
    await s.clock.tick(1);
    await s.daemon.scan();
    assert.deepEqual(s.kills, [[-PID, 'SIGKILL']]);
  } finally {
    await s.done();
  }
});
