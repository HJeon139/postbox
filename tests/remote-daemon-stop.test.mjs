// The host daemon (server/remote/host/daemon.mjs, #120), in-process with fake runners and process checks
// (tests/remote-daemon-setup.mjs): Stop’s SIGINT and SIGKILL, its tool shells’ groups, and a stop that comes before or
// during a start (G10).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { fakeClock, hello, setup, startMsg, waitFor } from './remote-daemon-setup.mjs';

test('stop: SIGINT to the group, then SIGKILL after the grace period, while runner.json still matches', async () => {
  const clock = fakeClock();
  const s = setup({ clock });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    const pid = JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.runner), 'utf8')).pid;
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    assert.deepEqual(s.kills, [[-pid, 'SIGINT']]);
    // The harness ignores it: at the grace period, SIGKILL, and the daemon records how it ended.
    s.alive.delete('t1');
    await clock.tick(5000);
    assert.deepEqual(s.kills, [
      [-pid, 'SIGINT'],
      [-pid, 'SIGKILL'],
    ]);
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit.signal, 'SIGKILL');
  } finally {
    s.done();
  }
});

test('stop: no SIGKILL once the harness has exited after SIGINT', async () => {
  const clock = fakeClock();
  const s = setup({ clock });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    c.send('read', { turn: 't1', from: 0 });
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    await writeFile(s.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: null, signal: 'SIGINT', at: 9 }));
    const ended = await c.msgs.next('ended');
    assert.deepEqual(ended.exit, { code: null, signal: 'SIGINT', at: 9 });
    await clock.tick(5000);
    assert.equal(s.kills.length, 1);
    assert.equal(c.msgs.messages.filter((m) => m.type === 'ended').length, 1, 'ended once per read');
  } finally {
    s.done();
  }
});

test('stop never signals when runner.json no longer names the runner: the turn is interrupted', async () => {
  const clock = fakeClock();
  const s = setup({ clock, same: false });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    c.send('stop', { turn: 't1' });
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit, null);
    await clock.tick(60_000);
    assert.deepEqual(s.kills, []);
  } finally {
    s.done();
  }
});

test('stop: the SIGKILL also goes to each tool shell’s group recorded at SIGINT or at SIGKILL, while it’s still there', async () => {
  const clock = fakeClock();
  const s = setup({ clock });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    const pid = JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.runner), 'utf8')).pid;
    // At SIGINT, one tool shell; at SIGKILL, it and two more, one of which has gone by the time it would be signaled.
    const shell = (pgid) => ({ pgid, members: [{ pid: pgid, startTime: 1 }] });
    s.state.groups = [[shell(7001)], [shell(7001), shell(7002), shell(7003)]];
    s.state.goneGroups = [7003];
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    assert.deepEqual(s.groupLookups, [pid], 'the groups were recorded before the SIGINT, while their parent was alive');
    assert.deepEqual(s.kills, [[-pid, 'SIGINT']], 'SIGINT goes to the turn’s group only: Claude Code stops its own shells');
    s.alive.delete('t1');
    await clock.tick(5000);
    assert.deepEqual(s.groupLookups, [pid, pid]);
    assert.deepEqual(s.kills, [
      [-pid, 'SIGINT'],
      [-7001, 'SIGKILL'],
      [-7002, 'SIGKILL'],
      [-pid, 'SIGKILL'],
    ]);
    assert.equal((await c.msgs.next('ended')).exit.signal, 'SIGKILL');
  } finally {
    s.done();
  }
});

test('stop: when the host’s processes can’t be listed, the SIGKILL still reaches the turn’s group', async () => {
  const clock = fakeClock();
  const s = setup({ clock });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    const pid = JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.runner), 'utf8')).pid;
    s.state.groups = null;
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    s.alive.delete('t1');
    await clock.tick(5000);
    assert.deepEqual(s.kills, [
      [-pid, 'SIGINT'],
      [-pid, 'SIGKILL'],
    ]);
  } finally {
    s.done();
  }
});

/** A promise and the function that settles it. */
function gate() {
  /** @type {() => void} */
  let open = () => {};
  const shut = new Promise((resolve) => {
    open = () => resolve(undefined);
  });
  return { shut, open };
}

test('#120 G10: a stop for a turn the daemon doesn’t have refuses its start from then on, on any connection: nothing runs, no folder', async () => {
  const s = setup();
  try {
    const b = await hello(s);
    b.send('stop', { turn: 't1' });
    const e = await b.msgs.next('error');
    assert.deepEqual([e.code, e.re, e.turn], ['no-turn', 'stop', 't1']);
    // Its start was on its way over a channel that dropped, and arrives after, on another connection.
    const c = await hello(s, { takeover: true });
    c.send('start', startMsg('t1'));
    const refused = await c.msgs.next('error');
    assert.deepEqual([refused.code, refused.re, refused.turn], ['turn-stopped', 'start', 't1']);
    assert.equal(s.launches.length, 0, 'no runner');
    assert.equal(existsSync(s.p.turn('t1')), false, 'no turn folder');
    // Asked again, the stop still finds no turn; other turns start as ever.
    c.send('stop', { turn: 't1' });
    assert.equal((await c.msgs.next('error')).code, 'no-turn');
    c.send('start', startMsg('t2'));
    await c.msgs.next('started');
  } finally {
    s.done();
  }
});

test('#120 G10: a stop that comes, on another connection, while a start is under way before its runner launches: nothing runs, and the stop finds no turn', async () => {
  const g = gate();
  const s = setup({ broker: { starting: () => g.shut } });
  try {
    const a = await hello(s);
    a.send('start', startMsg('t1'));
    await waitFor(() => existsSync(s.p.turn('t1')));
    // A’s channel dropped with the start under way; Postbox connects again and stops the turn.
    const b = await hello(s, { takeover: true });
    b.send('stop', { turn: 't1' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.msgs.messages.filter((m) => m.type === 'error').length, 0, 'the stop waits for the start');
    g.open();
    const e = await b.msgs.next('error');
    assert.deepEqual([e.code, e.re, e.turn], ['no-turn', 'stop', 't1']);
    assert.equal(s.launches.length, 0, 'no runner');
    assert.equal(existsSync(s.p.turn('t1')), false, 'no turn folder');
  } finally {
    s.done();
  }
});

test('#120 G10: a stop that comes, on another connection, while a launched runner comes up waits for it, then stops it', async () => {
  const g = gate();
  const s = setup();
  s.state.launching = g.shut;
  try {
    const a = await hello(s);
    a.send('start', startMsg('t1'));
    await waitFor(() => s.launches.length === 1);
    const b = await hello(s, { takeover: true });
    b.send('stop', { turn: 't1' });
    await new Promise((r) => setTimeout(r, 20));
    g.open();
    await waitFor(() => s.kills.length === 1);
    const pid = JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.runner), 'utf8')).pid;
    assert.deepEqual(s.kills, [[-pid, 'SIGINT']]);
    assert.equal(b.msgs.messages.filter((m) => m.type === 'error').length, 0);
  } finally {
    s.done();
  }
});
