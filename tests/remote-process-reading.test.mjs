// Reading a remote turn (server/remote/process.mjs, “Reading and acking” and “Replay”): acks, reading on from the
// last offset after a reconnect, a start lost in a drop, replay after a restart, and an interrupted turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACK_LINES, attachRemote, remoteSpawn } from '../server/remote/process.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { connectTo, FOLDER, LINES, sent, until, watch } from './remote-process-fixtures.mjs';

test('#120: acks advance with what was applied, batched, and the last one at ended is the log’s size', async () => {
  const many = Array.from({ length: ACK_LINES * 2 + 5 }, (_, i) => JSON.stringify({ type: 'n', i }));
  const d = createFakeDaemon({ lines: many });
  const child = remoteSpawn({ connection: connectTo(d), harness: 'kiro-cli', folder: FOLDER, stdin: 'none', turn: 't3' })('kiro-cli', ['chat']);
  const w = watch(child);
  await w.close;
  assert.deepEqual(w.out, many);
  const acks = sent(d, 'ack').map((m) => m.upTo);
  const size = d.turns.get('t3').out.at(-1).next;
  assert.equal(acks.at(-1), size);
  assert.equal(d.turns.get('t3').acked, size);
  assert.ok(acks.length <= 3 && acks.length >= 2, `acked in batches, not per line: ${acks.join(', ')}`);
  assert.deepEqual(
    acks,
    [...acks].sort((a, b) => a - b),
    'acks only move forward',
  );
});

test('#120: after a reconnect it reads from the last offset it applied, and no line is applied twice', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: LINES.slice(0, 3) });
  const connection = connectTo(d);
  const child = remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 't4' })('claude', []);
  const w = watch(child);
  await until(() => w.out.length === 3, 'the first lines');
  const applied = d.turns.get('t4').out[2].next;
  connection.drop();
  d.append('t4', LINES[3]); // written on the host while the laptop slept
  connection.reconnect();
  await until(() => sent(d, 'read').length === 2, 'a second read');
  assert.deepEqual(sent(d, 'read')[1], { type: 'read', turn: 't4', from: applied });
  await until(() => w.out.length === 4, 'the line written during the drop');
  // A line read again (a daemon replaying from earlier) is dropped by its offset.
  const repeat = d.turns.get('t4').out[1];
  connection.emit('message', { type: 'line', turn: 't4', offset: repeat.offset, next: repeat.next, text: repeat.text });
  d.append('t4', LINES[4]);
  d.end('t4');
  await w.close;
  assert.deepEqual(w.out, LINES.slice(0, 5));
});

test('#120: a start lost in a drop is sent again, and turn-exists then means the first one arrived', async () => {
  const d = createFakeDaemon({ lines: LINES.slice(0, 2) });
  const connection = connectTo(d);
  // The channel drops after the daemon has the start, before its started reaches Postbox.
  const real = connection.send.bind(connection);
  connection.send = (msg) => {
    const ok = real(msg);
    if (ok && msg.type === 'start') connection.drop();
    return ok;
  };
  const child = remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 't5' })('claude', []);
  const w = watch(child);
  await until(() => sent(d, 'start').length === 1, 'the start');
  connection.send = real;
  connection.reconnect();
  await w.close;
  assert.equal(sent(d, 'start').length, 2);
  assert.equal(d.sent.filter((m) => m.type === 'error' && m.code === 'turn-exists').length, 1);
  assert.deepEqual(w.out, LINES.slice(0, 2));
});

test('#120: replay after a restart attaches to the turn, sends no start, and reads it all from offset 0', async () => {
  const d = createFakeDaemon();
  d.addTurn('t6', { exit: { code: 0, signal: null } });
  const child = attachRemote(connectTo(d), { turn: 't6' });
  const w = watch(child);
  await w.close;
  assert.equal(sent(d, 'start').length, 0);
  assert.deepEqual(sent(d, 'read'), [{ type: 'read', turn: 't6', from: 0 }]);
  assert.deepEqual(w.out, LINES);
  assert.deepEqual(await w.exit, { code: 0, signal: null });
  // The same through spawnImpl, as an adapter would take it.
  const d2 = createFakeDaemon();
  d2.addTurn('t6b', { exit: { code: 3, signal: null } });
  const again = remoteSpawn({ connection: connectTo(d2), harness: 'claude-code', folder: FOLDER, stdin: 'file', turn: 't6b', attach: {} })('claude', []);
  const w2 = watch(again);
  again.stdin.end('ignored: the turn already has its message');
  assert.deepEqual(await w2.exit, { code: 3, signal: null });
  assert.equal(sent(d2, 'start').length, 0);
});

test('#120: an interrupted turn exits with code and signal null, and says it was interrupted', async () => {
  const d = createFakeDaemon();
  d.addTurn('t7', { interrupted: true, lines: LINES.slice(0, 1) });
  const child = attachRemote(connectTo(d), { turn: 't7' });
  const w = watch(child);
  assert.deepEqual(await w.exit, { code: null, signal: null });
  await w.close;
  assert.equal(child.interrupted, true);
  assert.deepEqual(w.out, LINES.slice(0, 1));
});
