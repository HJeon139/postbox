// Whether a host turn is still running (server/remote/host/daemon-running.mjs, #738): a runner that stops answering
// `who` while runner.json still names its live process stays running until the silence ceiling, for the follower and
// the scan alike, and a runner that’s gone ends as before. In-process with fake runners (tests/remote-daemon-setup.mjs),
// and, for a zombie, a reused PID and a reboot, proc.mjs’s own sameProcess over fake /proc facts
// (tests/remote-daemon-running-setup.mjs).

import assert from 'node:assert/strict';
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { CEILING_MS, silentSetup, startOnHost, startReading } from './remote-daemon-running-setup.mjs';
import { hello, makeTurn, startMsg } from './remote-daemon-setup.mjs';

test('#738 row 1: a live runner that misses `who` for a while is not reported ended', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(5, c);
    s.alive.add('t1');
    await s.looks(2, c);
    assert.deepEqual(s.ended(c), [], 'no ended while the runner process is alive');
    assert.deepEqual(s.kills, []);
  } finally {
    s.done();
  }
});

test('#738 row 1: an answer clears the silence, so a second stall counts from its own start', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(2, c);
    await s.clock.tick(50_000);
    s.alive.add('t1');
    await s.looks(2, c);
    s.alive.delete('t1');
    await s.looks(2, c);
    await s.clock.tick(50_000);
    await s.looks(3, c);
    assert.deepEqual(s.ended(c), [], '50 s of silence, twice, is under the ceiling each time');
  } finally {
    s.done();
  }
});

test('#738 row 2: scan during a short stall reads the turn as running, not interrupted', async () => {
  const s = silentSetup();
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    s.alive.delete('t1');
    assert.equal((await s.daemon.scan()).find((t) => t.turn === 't1')?.state, 'running');
  } finally {
    s.done();
  }
});

test('#738 row 3: a live runner silent for the ceiling is killed then and ends, exit null, and not a millisecond before', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(2, c);
    await s.clock.tick(CEILING_MS - 1);
    await s.looks(3, c);
    assert.deepEqual(s.ended(c), [], 'still running a millisecond before the ceiling');
    assert.equal((await s.daemon.scan())[0].state, 'running');
    await s.clock.tick(1);
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit, null);
    assert.equal((await s.daemon.scan())[0].state, 'interrupted', 'the scan agrees once the ceiling is reached');
    assert.equal(s.logs.filter((l) => /t1.*didn’t answer as its runner/.test(l)).length, 1, 'the silence’s start, logged once');
    assert.equal(s.logs.filter((l) => /t1.*hasn’t answered as its runner for 60 s/.test(l)).length, 1, 'the ceiling, logged once');
    assert.deepEqual(s.kills, [[-4001, 'SIGKILL']], 'killed at the ceiling (#872)');
  } finally {
    s.done();
  }
});

test('#738 row 4: a runner hung for good with a tool call open ends at the ceiling, with the open line sent', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(2, c);
    await appendFile(s.p.turn('t1', TURN_FILES.out), '{"type":"tool_use"}');
    await s.looks(3, c);
    assert.deepEqual(s.ended(c), []);
    await s.clock.tick(CEILING_MS);
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit, null);
    assert.ok(c.msgs.messages.some((m) => m.type === 'line' && m.text === '{"type":"tool_use"}'));
  } finally {
    s.done();
  }
});

test('#738 row 5: a runner that died without exit.json ends with exit null', async () => {
  const s = silentSetup({ same: false });
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    assert.equal((await c.msgs.next('ended')).exit, null);
    assert.equal((await s.daemon.scan())[0].state, 'interrupted');
  } finally {
    s.done();
  }
});

test('#738 row 6: a runner that’s a zombie ends: sameProcess is false for it', async () => {
  const { s, c, host, pid } = await startOnHost();
  try {
    s.alive.delete('t1');
    await s.looks(2, c);
    assert.deepEqual(s.ended(c), [], 'running while its process is up');
    host.procs.set(pid, { state: 'Z', start: 1234 });
    assert.equal((await c.msgs.next('ended')).exit, null);
  } finally {
    s.done();
  }
});

test('#738 row 7: a runner whose PID another process now has ends', async () => {
  const { s, c, host, pid } = await startOnHost();
  try {
    host.procs.set(pid, { state: 'S', start: 5678 });
    s.alive.delete('t1');
    assert.equal((await c.msgs.next('ended')).exit, null);
  } finally {
    s.done();
  }
});

test('#738 row 8: a runner from another boot ends', async () => {
  const { s, c, host } = await startOnHost();
  try {
    host.boot = '11111111-2222-4333-8444-555555555555';
    s.alive.delete('t1');
    assert.equal((await c.msgs.next('ended')).exit, null);
  } finally {
    s.done();
  }
});

test('#738 row 9: a silent runner with no valid runner.json ends after two misses', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    await writeFile(s.p.turn('t1', TURN_FILES.runner), '{"turn":');
    s.alive.delete('t1');
    assert.equal((await c.msgs.next('ended')).exit, null);
    await rm(s.p.turn('t1', TURN_FILES.runner));
    assert.equal((await s.daemon.scan())[0].state, 'interrupted');
  } finally {
    s.done();
  }
});

test('#738 row 10: exit.json written during a silence ends the turn with its exit', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(3, c);
    const exit = { code: 0, signal: null, at: 9 };
    await writeFile(s.p.turn('t1', TURN_FILES.exit), JSON.stringify(exit));
    assert.deepEqual((await c.msgs.next('ended')).exit, exit);
    assert.equal(s.ended(c).length, 1);
  } finally {
    s.done();
  }
});

test('#738 row 11: a stop that finds runner.json’s process gone ends the turn, whatever the socket says', async () => {
  const s = silentSetup({ same: false });
  try {
    const c = await startReading(s);
    c.send('stop', { turn: 't1' });
    assert.equal((await c.msgs.next('ended')).exit, null);
    assert.ok(s.alive.has('t1'), 'its socket still answers');
    assert.equal((await s.daemon.scan())[0].state, 'interrupted');
  } finally {
    s.done();
  }
});

test('#738 row 12: after a daemon restart, a stall counts from the new daemon’s first miss', async () => {
  const s = silentSetup();
  try {
    makeTurn(s.p, 't1', { out: '{"n":1}\n' });
    assert.equal((await s.daemon.scan())[0].state, 'running');
    await s.clock.tick(CEILING_MS - 1);
    assert.equal((await s.daemon.scan())[0].state, 'running');
    await s.clock.tick(1);
    assert.equal((await s.daemon.scan())[0].state, 'running', 'killed at the ceiling, and running until it’s gone (#872)');
    assert.deepEqual(s.kills, [[-777, 'SIGKILL']]);
    assert.equal((await s.daemon.scan())[0].state, 'interrupted');
  } finally {
    s.done();
  }
});

test('#738 row 13: a runner that doesn’t answer as its runner is a miss, the process decides, and it’s logged once', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    // The daemon can’t tell no answer from one for another turn or a refused token: runner-client.mjs’s askRunner is
    // false for each (tests/integration/remote-runner.test.mjs), as the fake one is here.
    s.alive.delete('t1');
    await s.looks(6, c);
    await s.daemon.scan();
    assert.deepEqual(s.ended(c), []);
    assert.equal(s.logs.filter((l) => /t1.*didn’t answer as its runner/.test(l)).length, 1, 'one line for the silence, not one per look');
  } finally {
    s.done();
  }
});

test('#738 the follower and the scan share a turn’s silence: one the scan began counts for a later reader', async () => {
  const s = silentSetup();
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    s.alive.delete('t1');
    assert.equal((await s.daemon.scan())[0].state, 'running');
    await s.clock.tick(CEILING_MS);
    c.send('read', { turn: 't1', from: 0 });
    assert.equal((await c.msgs.next('ended')).exit, null);
  } finally {
    s.done();
  }
});

test('#738 a silence’s end is logged: answered again with its length, or the process gone', async () => {
  const s = silentSetup();
  try {
    const c = await startReading(s);
    s.alive.delete('t1');
    await s.looks(2, c);
    await s.clock.tick(3000);
    s.alive.add('t1');
    await s.looks(2, c);
    assert.equal(s.logs.filter((l) => /t1.*answered again after 3 s/.test(l)).length, 1);
    s.alive.delete('t1');
    await s.looks(2, c);
    s.state.same = false;
    assert.equal((await c.msgs.next('ended')).exit, null);
    assert.equal(s.logs.filter((l) => /t1.*is gone/.test(l)).length, 1);
  } finally {
    s.done();
  }
});
