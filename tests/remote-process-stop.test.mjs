// Stopping a remote turn, and how one ends (server/remote/process.mjs): kill sends the daemon’s stop once, a start
// that may or may not have reached the host is stopped again, a cut line, a connection that gives up, and two turns
// on one connection.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { remoteSpawn } from '../server/remote/process.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { connectTo, FOLDER, LINES, sent, until, watch } from './remote-process-fixtures.mjs';

test('#120: kill sends the daemon’s stop once, whatever the signal, and exit comes from ended', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const child = remoteSpawn({ connection: connectTo(d), harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 't8' })('claude', []);
  const w = watch(child);
  await until(() => sent(d, 'read').length === 1, 'the read');
  assert.equal(child.kill('SIGINT'), true);
  assert.equal(child.kill('SIGKILL'), true);
  child.kill();
  assert.deepEqual(await w.exit, { code: null, signal: 'SIGINT' });
  assert.deepEqual(d.stops, ['t8']);
  assert.equal(sent(d, 'stop').length, 1);
  assert.equal(child.kill('SIGINT'), false, 'nothing to stop once it has ended');
});

test('#120: a file stdin killed before it ends starts nothing on the host', async () => {
  const d = createFakeDaemon();
  const child = remoteSpawn({ connection: connectTo(d), harness: 'claude-code', folder: FOLDER, stdin: 'file' })('claude', []);
  const w = watch(child);
  child.kill('SIGINT');
  child.stdin.end('late');
  await w.close;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent(d, 'start').length, 0);
  assert.equal(sent(d, 'stop').length, 0);
});

for (const arrived of [true, false]) {
  test(`#120: a turn killed before started, across a drop, is stopped at the reconnect and never started again (start ${arrived ? 'reached' : 'lost before'} the host)`, async () => {
    const d = createFakeDaemon({ autoEnd: false, lines: [] });
    const connection = connectTo(d);
    // After the welcome, so the start goes on a channel (one handed over before it never left the laptop).
    await new Promise((r) => connection.once('connected', r));
    const real = connection.send.bind(connection);
    // The channel drops with the start: after the daemon has it (its started is lost), or before (the start is).
    connection.send = (msg) => {
      if (msg.type !== 'start') return real(msg);
      const ok = arrived ? real(msg) : true;
      connection.drop();
      return ok;
    };
    const child = remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: arrived ? 'tk1' : 'tk2' })('claude', []);
    const w = watch(child);
    await until(() => child.startSent, 'the start');
    connection.send = real;
    assert.equal(child.kill('SIGINT'), true);
    const before = d.received.length;
    connection.reconnect();
    await until(() => d.received.slice(before).some((m) => m.type === 'stop'), 'the stop at the welcome');
    await new Promise((r) => setTimeout(r, 20));
    const after = d.received.slice(before);
    assert.deepEqual(
      after.filter((m) => m.type === 'start'),
      [],
      'no start after the kill',
    );
    assert.deepEqual(
      after.filter((m) => m.type === 'stop'),
      [{ type: 'stop', turn: child.turn }],
    );
    assert.deepEqual(d.stops, arrived ? [child.turn] : []);
    assert.equal(d.turns.has(child.turn), arrived, 'a lost start never reaches the host');
    // Its end: the stopped turn’s `ended`, or the no-turn answer to the stop when nothing reached the host.
    await until(() => child.ended, 'the exit');
    assert.deepEqual(await w.exit, { code: null, signal: 'SIGINT' });
    await w.close;
  });
}

for (const answer of ['started', 'turn-exists']) {
  test(`#120: a ${answer} that comes after kill() is followed by a stop`, async () => {
    const sends = [];
    const connection = new (class extends EventEmitter {
      send(msg) {
        sends.push(msg);
        return true;
      }
    })();
    const child = remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 'tk3' })('claude', []);
    await new Promise((r) => process.nextTick(r));
    // turn-exists counts as started only for a start sent again at a welcome.
    if (answer === 'turn-exists') connection.emit('connected');
    assert.equal(sends.filter((m) => m.type === 'start').length, answer === 'turn-exists' ? 2 : 1);
    child.kill('SIGINT');
    const at = sends.length;
    connection.emit(
      'message',
      answer === 'started'
        ? { type: 'started', turn: 'tk3' }
        : { type: 'error', code: 'turn-exists', message: 'There’s already a turn.', re: 'start', turn: 'tk3' },
    );
    assert.ok(
      sends.slice(at).some((m) => m.type === 'stop'),
      `a stop after the ${answer}: ${JSON.stringify(sends.slice(at))}`,
    );
    assert.equal(sends.filter((m) => m.type === 'start').length, answer === 'turn-exists' ? 2 : 1, 'no start after the kill');
    child.finish({ code: null, signal: 'SIGINT' });
  });
}

test('#120: a cut line puts nothing on stdout, emits cut with its offset, and notes it on stderr', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const connection = connectTo(d);
  const child = remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 't9' })('claude', []);
  const w = watch(child);
  await until(() => sent(d, 'read').length === 1, 'the read');
  connection.emit('message', { type: 'line', turn: 't9', offset: 0, next: 9_000_000, text: '', cut: true });
  connection.emit('message', { type: 'line', turn: 't9', offset: 9_000_000, next: 9_000_003, text: '{}' });
  connection.emit('message', { type: 'ended', turn: 't9', exit: { code: 0, signal: null, at: 1 }, size: 9_000_003 });
  await w.close;
  assert.deepEqual(w.out, ['{}']);
  assert.deepEqual(w.cuts, [{ offset: 0, next: 9_000_000 }]);
  assert.match(w.err, /at byte 0 was too long/);
});

test('#120: a connection that gives up is the child’s error, then its exit; a daemon error for start is too', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const connection = connectTo(d);
  const child = remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 't10' })('claude', []);
  const w = watch(child);
  const error = new Promise((r) => child.once('error', r));
  await until(() => sent(d, 'read').length === 1, 'the read');
  connection.emit('error', new Error('The host can’t be reached.'));
  assert.match((await error).message, /can’t be reached/);
  assert.deepEqual(await w.exit, { code: null, signal: null });
  assert.equal(child.interrupted, false);
  assert.equal(connection.listenerCount('message'), 0, 'an ended child stops listening');

  const d2 = createFakeDaemon({ harnesses: ['claude-code'] });
  const c2 = remoteSpawn({ connection: connectTo(d2), harness: 'codex', folder: FOLDER, stdin: 'held' })('codex', []);
  const e2 = new Promise((r) => c2.once('error', r));
  assert.equal((await e2).code, 'no-harness');
});

test('#120: two turns on one connection each get only their own lines', async () => {
  const d = createFakeDaemon({ lines: LINES.slice(0, 2) });
  const connection = connectTo(d);
  const a = watch(remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 'ta' })('claude', []));
  const b = watch(remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 'tb' })('claude', []));
  await Promise.all([a.close, b.close]);
  assert.deepEqual(a.out, LINES.slice(0, 2));
  assert.deepEqual(b.out, LINES.slice(0, 2));
});
