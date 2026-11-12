// How a host runner’s silence is timed and kept (server/remote/host/daemon-running.mjs, #738): on the daemon’s
// monotonic clock, so setting the wall clock neither stretches the ceiling nor cuts it short; forgotten each way it
// ends; and how many looks end a turn in the follower (daemon-follow.mjs). In-process with fake runners and a fake
// clock (tests/remote-daemon-running-setup.mjs).

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { followerEnds } from '../server/remote/host/daemon-running.mjs';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { CEILING_MS, PROCESS_CHECK_MS, silentSetup, startReading } from './remote-daemon-running-setup.mjs';
import { hello, startMsg } from './remote-daemon-setup.mjs';

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
    await s.done();
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
    await s.done();
  }
});

test('#738 one dropped `who` doesn’t end a turn whose runner.json is invalid: the follower ends it at two in a row', async () => {
  let drops = 0;
  const s = silentSetup({
    answer: (turn) => {
      if (drops === 0) return s.alive.has(turn);
      drops--;
      return false;
    },
  });
  try {
    const c = await startReading(s);
    await writeFile(s.p.turn('t1', TURN_FILES.runner), '{"turn":');
    await s.looks(2, c);
    drops = 1;
    await s.looks(4, c);
    assert.equal(drops, 0, 'the one answer was dropped');
    assert.deepEqual(s.ended(c), [], 'one miss, then an answer');
  } finally {
    await s.done();
  }
});

test('#738 a turn found dead ends at the follower’s next look, not one later', async () => {
  // A poll far longer than the test: after the stop’s poke, the follower looks again only if it’s poked again.
  const s = silentSetup({ pollMs: 600_000 });
  try {
    const c = await startReading(s);
    await c.msgs.next('caught-up');
    s.state.same = false;
    c.send('stop', { turn: 't1' });
    assert.equal((await c.msgs.next('ended')).exit, null);
  } finally {
    await s.done();
  }
});

/** A daemon whose t1 has a silence under way, begun by its follower (read) or by a scan, with no follower. */
async function silenced(how) {
  const s = silentSetup();
  let c;
  if (how === 'read') {
    c = await startReading(s);
  } else {
    c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
  }
  s.alive.delete('t1');
  if (how === 'read') await s.looks(2, c);
  else assert.equal((await s.daemon.scan())[0].state, 'running');
  assert.ok(s.daemon.silentSince.has('t1'), 'a silence is under way');
  return { s, c };
}

test('#738 a silence is forgotten each way it ends: an answer, the process gone, found dead, or exit.json', async () => {
  const exit = JSON.stringify({ code: 0, signal: null, at: 9 });
  const ways = {
    async answer({ s, c }) {
      s.alive.add('t1');
      await s.looks(2, c);
    },
    async processGone({ s, c }) {
      s.state.same = false;
      await s.clock.tick(PROCESS_CHECK_MS);
      await c.msgs.next('ended');
    },
    async foundDead({ s, c }) {
      s.state.same = false;
      c.send('stop', { turn: 't1' });
      await c.msgs.next('ended');
    },
    async exitByFollower({ s, c }) {
      await writeFile(s.p.turn('t1', TURN_FILES.exit), exit);
      await c.msgs.next('ended');
    },
    async exitByScan({ s }) {
      await writeFile(s.p.turn('t1', TURN_FILES.exit), exit);
      assert.equal((await s.daemon.scan())[0].state, 'ended');
    },
  };
  // Found dead: the scan begins the silence, and the follower the stop starts comes after d.dead has the turn, so
  // every look it takes ends at the d.dead check, never at a look at the process.
  const byScan = new Set(['foundDead', 'exitByScan']);
  for (const [name, end] of Object.entries(ways)) {
    const t = await silenced(byScan.has(name) ? 'scan' : 'read');
    try {
      await end(t);
      assert.deepEqual([...t.s.daemon.silentSince.keys()], [], `forgotten after: ${name}`);
    } finally {
      await t.s.done();
    }
  }
});

test('#738 the follower ends a turn Stop found dead on that look, and any other at its second miss in a row, not before or after', () => {
  assert.equal(followerEnds({ dead: true, misses: 1 }), true, 'found dead: this look, not the next');
  assert.equal(followerEnds({ dead: false, misses: 1 }), false, 'one miss');
  assert.equal(followerEnds({ dead: false, misses: 2 }), true, 'two in a row');
  assert.equal(followerEnds({ dead: false, misses: 0 }), false, 'running');
});

test('#738 two dropped `who` in a row end a turn whose runner.json is invalid', async () => {
  let drops = 0;
  const s = silentSetup({
    answer: (turn) => {
      if (drops === 0) return s.alive.has(turn);
      drops--;
      return false;
    },
  });
  try {
    const c = await startReading(s);
    await writeFile(s.p.turn('t1', TURN_FILES.runner), '{"turn":');
    await s.looks(2, c);
    drops = 2;
    await s.looks(4, c);
    assert.equal(s.ended(c).length, 1, 'ended at the second miss');
    assert.equal(s.ended(c)[0].exit, null);
  } finally {
    await s.done();
  }
});
