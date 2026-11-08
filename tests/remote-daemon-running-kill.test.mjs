// A host runner hung past the silence ceiling (server/remote/host/daemon-running.mjs and daemon-stop.mjs’s endHung,
// #872): its group and its tool shells’ groups are killed, only while runner.json still names its process, and the
// turn ends once the process is gone, or, if it won’t go, KILL_WAIT_MS later and said to be unkilled. Stop and the
// ceiling never both kill. In-process with fake runners and a fake clock (tests/remote-daemon-running-setup.mjs).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { CEILING_MS, KILL_WAIT_MS, silentSetup, startReading } from './remote-daemon-running-setup.mjs';
import { waitFor } from './remote-daemon-setup.mjs';

const PID = 4001;
const shell = (/** @type {number} */ pgid) => ({ pgid, members: [{ pid: pgid, startTime: 1 }] });

/** t1 started and read, its runner silent from now on. @param {object} [o] silentSetup’s options */
async function silent(o) {
  const s = silentSetup(o);
  const c = await startReading(s);
  s.alive.delete('t1');
  await s.looks(2, c);
  return { s, c };
}

test('#872 a runner silent past the ceiling has its group and tool shells killed, and ends once its process is gone', async () => {
  const { s, c } = await silent({ killable: false });
  try {
    s.state.groups = [[shell(7001), shell(7002)]];
    await s.clock.tick(CEILING_MS);
    await waitFor(() => s.kills.length >= 3);
    assert.deepEqual(s.kills, [
      [-7001, 'SIGKILL'],
      [-7002, 'SIGKILL'],
      [-PID, 'SIGKILL'],
    ]);
    await s.looks(3, c);
    assert.deepEqual(s.ended(c), [], 'not ended while its process is still there');
    s.state.same = false;
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit, null);
    assert.equal(Object.hasOwn(ended, 'unkilled'), false, 'it was killed');
    assert.equal(existsSync(s.p.turn('t1', TURN_FILES.exit)), false, 'no exit.json: the laptop resumes it as interrupted');
    const [found] = await s.daemon.scan();
    assert.deepEqual([found.state, Object.hasOwn(found, 'unkilled')], ['interrupted', false], 'the scan says it was killed too');
    assert.equal(s.kills.length, 3, 'killed once');
  } finally {
    s.done();
  }
});

test('#872 a runner that won’t die at the ceiling’s SIGKILL ends KILL_WAIT_MS later, said to be unkilled', async () => {
  const { s, c } = await silent({ killable: false });
  try {
    await s.clock.tick(CEILING_MS);
    await waitFor(() => s.kills.length >= 1);
    await s.clock.tick(KILL_WAIT_MS - 1);
    await s.looks(3, c);
    assert.deepEqual(s.ended(c), [], 'still waiting for it a millisecond before');
    c.send('stop', { turn: 't1' });
    await s.looks(3, c);
    assert.deepEqual(s.kills, [[-PID, 'SIGKILL']], 'a Stop after the ceiling’s kill signals nothing more');
    await s.clock.tick(1);
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit, null);
    assert.equal(ended.unkilled, true);
    // A laptop that wasn't there for that ended learns it from the scan its welcome lists.
    const [found] = await s.daemon.scan();
    assert.equal(found.state, 'interrupted');
    assert.equal(found.unkilled, true);
  } finally {
    s.done();
  }
});

test('#872 a runner that answers just before the ceiling isn’t killed', async () => {
  const { s, c } = await silent();
  try {
    await s.clock.tick(CEILING_MS - 1);
    s.alive.add('t1');
    await s.looks(2, c);
    await s.clock.tick(1);
    await s.looks(3, c);
    assert.deepEqual(s.kills, []);
    assert.deepEqual(s.ended(c), []);
  } finally {
    s.done();
  }
});

test('#872 a runner whose PID isn’t its process any more by the kill isn’t signaled', async () => {
  // The look at the ceiling finds the process; the kill’s own check, right after it, doesn’t.
  let calls = 0;
  let mono = () => 0;
  const { s, c } = await silent({ sameProcess: async () => mono() < CEILING_MS || ++calls === 1 });
  try {
    mono = s.clock.mono;
    await s.clock.tick(CEILING_MS);
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit, null);
    assert.deepEqual(s.kills, []);
  } finally {
    s.done();
  }
});

test('#872 a Stop during the silence and the ceiling don’t both kill: Stop’s SIGKILL is the only one', async () => {
  const { s, c } = await silent();
  try {
    await s.clock.tick(CEILING_MS - 2000);
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    await s.clock.tick(2000);
    await s.looks(3, c);
    assert.deepEqual(s.kills, [[-PID, 'SIGINT']], 'the ceiling came during Stop’s grace period');
    await s.clock.tick(3000);
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit.signal, 'SIGKILL');
    assert.deepEqual(s.kills, [
      [-PID, 'SIGINT'],
      [-PID, 'SIGKILL'],
    ]);
  } finally {
    s.done();
  }
});
