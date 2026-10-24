// The remote process (#120, L3): spawn’s shape, backed by the host’s daemon. Run against tests/fake-daemon.mjs, which
// replays a recorded Claude Code stream (tests/fixtures/claude-code/permission-allow.jsonl), through a minimal stand-in
// for L1’s connection: hello on each channel, `connected` at each welcome, send() false while there’s none.
// Also process-group.mjs’s remote branch: Stop for a remote child never reaches the local kill or ps.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { signalGroup, stopJobUnder, stopTurn } from '../server/adapters/process-group.mjs';
import { ACK_LINES, attachRemote, RemoteProcess, remoteSpawn } from '../server/remote/process.mjs';
import { createMessageReader, encode, MESSAGE_FILE, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { createFakeDaemon, FAKE_TOKEN, fixtureLines } from './fake-daemon.mjs';

const LINES = fixtureLines();
const FOLDER = '/home/user/postbox-work/ada';
const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/** L1’s connection, as far as the remote process needs it, over the fake daemon’s streams. */
function connectTo(d) {
  const conn = new EventEmitter();
  conn.setMaxListeners(0);
  let ready = false;
  let stdin;
  const wire = ({ stdin: i, stdout }) => {
    stdin = i;
    ready = false;
    const reader = createMessageReader('daemon-to-postbox', {
      onMessage(m) {
        // What a dropped channel had on its way never arrives.
        if (stdin !== i) return;
        if (m.type === 'welcome') {
          ready = true;
          conn.emit('connected');
        } else conn.emit('message', m);
      },
      onError: (e) => assert.fail(`The fake daemon sent a bad line: ${e.message}`),
    });
    // A turn later, as from a real channel: the fake answers within the write that reached it.
    stdout.on('data', (b) => setImmediate(() => reader.push(b)));
    stdout.on('end', () =>
      setImmediate(() => {
        if (stdin === i) ready = false;
      }),
    );
    i.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN })));
  };
  wire({ stdin: d.stdin, stdout: d.stdout });
  return Object.assign(conn, {
    send(msg) {
      if (!ready) return false;
      stdin.write(encode(msg));
      return true;
    },
    /** The SSH session drops: nothing more arrives on it, and sends fail until reconnect(). */
    drop() {
      stdin = null;
      ready = false;
      d.drop();
    },
    reconnect() {
      wire(d.connect());
    },
  });
}

/** Everything a child writes to stdout, as lines through readline, as the adapters read it; and how it ended. */
function watch(child) {
  const out = [];
  let err = '';
  const cuts = [];
  createInterface({ input: child.stdout }).on('line', (l) => out.push(l));
  child.stderr.on('data', (d) => {
    err += d;
  });
  child.on('cut', (c) => cuts.push(c));
  const exit = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const close = new Promise((r) => child.once('close', (code, signal) => r({ code, signal, lines: out.length })));
  return {
    out,
    cuts,
    exit,
    close,
    get err() {
      return err;
    },
  };
}

const sent = (d, type) => d.received.filter((m) => m.type === type);

test('#120: a file stdin is kept until end(), then goes in start as message.jsonl; argv has no program and env only what was given', async () => {
  const d = createFakeDaemon();
  const connection = connectTo(d);
  const spawn = remoteSpawn({
    connection,
    harness: 'claude-code',
    folder: FOLDER,
    stdin: 'file',
    env: { CLAUDE_CONFIG_DIR: '/home/user/.claude' },
    turn: 't1',
  });
  const child = spawn('/usr/local/bin/claude', ['-p', '--output-format', 'stream-json'], { cwd: '/Users/me/work', env: { SECRET: 'laptop' } });
  assert.equal(child.remote, true);
  assert.equal(child.pid, undefined);
  assert.equal(child.turn, 't1');
  const w = watch(child);
  child.stdin.write('{"type":"user",');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent(d, 'start').length, 0, 'start waits for the end of stdin');
  child.stdin.end('"message":{}}\n');
  const closed = await w.close;
  const [start] = sent(d, 'start');
  assert.deepEqual(start, {
    type: 'start',
    turn: 't1',
    harness: 'claude-code',
    folder: FOLDER,
    argv: ['-p', '--output-format', 'stream-json'],
    env: { CLAUDE_CONFIG_DIR: '/home/user/.claude' },
    stdin: 'file',
    files: [{ name: MESSAGE_FILE, text: '{"type":"user","message":{}}\n' }],
  });
  assert.deepEqual(w.out, LINES, 'stdout has every recorded line, exactly');
  assert.equal(closed.lines, LINES.length, 'close comes after the last line is read');
  assert.deepEqual(await w.exit, { code: 0, signal: null });
  assert.equal(child.exitCode, 0);
  assert.equal(child.interrupted, false);
  assert.deepEqual(sent(d, 'read'), [{ type: 'read', turn: 't1', from: 0 }]);
});

test('#120: a bad argv or env throws where spawn is called, as a local spawn does', () => {
  const connection = connectTo(createFakeDaemon());
  assert.throws(
    () => remoteSpawn({ connection, harness: 'claude-code', folder: FOLDER, stdin: 'none', env: { 'bad name': 'x' } })('claude', []),
    /variable name/,
  );
  assert.throws(() => remoteSpawn({ connection, harness: 'claude-code', folder: 'relative', stdin: 'none' })('claude', []), TypeError);
});

test('#120: an agentFile goes in start as it is, is checked where spawn is called, and is left out when not given', async () => {
  const d = createFakeDaemon();
  const connection = connectTo(d);
  // Its name and text only: the daemon picks the folder, from the Kiro home the runner will use.
  const agentFile = { name: 'postbox-kiro-1.json', text: '{"name":"postbox-kiro-1"}' };
  const child = remoteSpawn({ connection, harness: 'kiro-cli', folder: FOLDER, stdin: 'none', agentFile, turn: 'k1' })('kiro-cli', ['chat']);
  await watch(child).close;
  assert.deepEqual(sent(d, 'start')[0].agentFile, agentFile);
  const plain = remoteSpawn({ connection, harness: 'kiro-cli', folder: FOLDER, stdin: 'none', turn: 'k2' })('kiro-cli', ['chat']);
  await watch(plain).close;
  assert.ok(!('agentFile' in sent(d, 'start')[1]));
  assert.throws(
    () => remoteSpawn({ connection, harness: 'kiro-cli', folder: FOLDER, stdin: 'none', agentFile: { ...agentFile, name: '../x.json' } })('kiro-cli', []),
    /agentFile\.name/,
  );
});

test('#120: a held stdin sends each complete line as a write, in order, one after the daemon says written', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const connection = connectTo(d);
  const order = [];
  const real = connection.send.bind(connection);
  connection.send = (msg) => {
    const ok = real(msg);
    if (ok && msg.type === 'write') order.push('write');
    return ok;
  };
  connection.on('message', (m) => m.type === 'written' && order.push('written'));
  const child = remoteSpawn({ connection, harness: 'codex', folder: FOLDER, stdin: 'held', turn: 't2' })('codex', ['app-server', '--listen', 'stdio://']);
  const w = watch(child);
  child.stdin.write('{"id":1,"method":"initialize"}\n{"method":"initia');
  child.stdin.write('lized"}\n');
  child.stdin.write('{"id":2,"method":"thread/start"}\n');
  await until(() => d.turns.get('t2')?.writes.length === 3, 'three writes');
  assert.deepEqual(d.turns.get('t2').writes, ['{"id":1,"method":"initialize"}', '{"method":"initialized"}', '{"id":2,"method":"thread/start"}']);
  await until(() => order.length === 6, 'the last written');
  assert.deepEqual(order, ['write', 'written', 'write', 'written', 'write', 'written'], 'one write in flight at a time');
  assert.equal(sent(d, 'start')[0].stdin, 'held');
  assert.deepEqual(sent(d, 'start')[0].files, []);
  d.end('t2');
  assert.deepEqual(await w.exit, { code: 0, signal: null });
});

test('#120: a held stdin reads in.jsonl too, and emits each of its lines once as stdin-line, across a reconnect', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const connection = connectTo(d);
  const child = remoteSpawn({ connection, harness: 'codex', folder: FOLDER, stdin: 'held', turn: 'tin' })('codex', []);
  const w = watch(child);
  const seen = [];
  child.on('stdin-line', (l) => seen.push(l));
  child.stdin.write('{"id":1,"method":"initialize"}\n');
  await until(() => seen.length === 1, 'the line back from in.jsonl');
  assert.deepEqual(
    sent(d, 'read').find((m) => m.log === 'in'),
    { type: 'read', turn: 'tin', from: 0, log: 'in' },
  );
  connection.drop();
  connection.reconnect();
  child.stdin.write('{"id":2,"method":"thread/start"}\n');
  await until(() => seen.length === 2, 'the second line');
  assert.deepEqual(
    seen.map((l) => [l.offset, l.text]),
    [
      [0, '{"id":1,"method":"initialize"}'],
      [31, '{"id":2,"method":"thread/start"}'],
    ],
  );
  d.end('tin');
  await w.close;
});

for (const arrived of [true, false]) {
  test(`#120: a held-stdin line lost in a drop is ${arrived ? 'not sent again when in.jsonl has it' : 'sent again when in.jsonl doesn’t have it'}`, async () => {
    const d = createFakeDaemon({ autoEnd: false, lines: [] });
    const connection = connectTo(d);
    const real = connection.send.bind(connection);
    let lose = false;
    connection.send = (msg) => {
      if (lose && msg.type === 'write') {
        lose = false;
        // Arrived: the daemon has it and the drop takes its written. Not arrived: the drop takes the write itself.
        const ok = arrived ? real(msg) : true;
        connection.drop();
        return ok;
      }
      return real(msg);
    };
    const child = remoteSpawn({ connection, harness: 'codex', folder: FOLDER, stdin: 'held', turn: arrived ? 'tl1' : 'tl2' })('codex', []);
    const w = watch(child);
    const t = () => d.turns.get(child.turn);
    child.stdin.write('{"id":1,"method":"initialize"}\n');
    await until(() => child.inUpTo > 0, 'the first written');
    lose = true;
    child.stdin.write('{"method":"initialized"}\n{"id":2,"method":"thread/start"}\n');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t().writes.length, arrived ? 2 : 1, 'the third line waits behind the lost one');
    connection.reconnect();
    await until(() => t().writes.length === 3, 'the line after it');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      t().writes,
      ['{"id":1,"method":"initialize"}', '{"method":"initialized"}', '{"id":2,"method":"thread/start"}'],
      'each line reached the harness once',
    );
    assert.equal(/sent again/.test(w.err), !arrived);
    d.end(child.turn);
    await w.close;
  });
}

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

// ── process-group.mjs’s remote branch ─────────────────────────────────────────────────

/** A local kill and ps that fail the test if they’re ever called, and record it: above all kill(-pid, …). */
function forbidden() {
  const calls = [];
  return {
    calls,
    kill: (pid, sig) => {
      calls.push(['kill', pid, sig]);
      throw new Error(`The local kill was called with ${pid}, ${sig}${pid < 0 ? ', a process group on the laptop' : ''}.`);
    },
    list: async () => {
      calls.push(['list']);
      throw new Error('The local ps was read for a remote turn.');
    },
  };
}

test('#120: stopTurn on a remote child sends the daemon’s stop, resolves gone at ended, and never calls the local kill or ps', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const child = remoteSpawn({ connection: connectTo(d), harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 'ts' })('claude', []);
  const w = watch(child);
  await until(() => sent(d, 'read').length === 1, 'the read');
  const f = forbidden();
  const exited = new Promise((r) => child.once('exit', r));
  const { kept, gone } = await stopTurn(child, { keep: [{ id: 'job1', command: 'sleep 100' }], exited, kill: f.kill, list: f.list, graceMs: 5, pollMs: 1 });
  assert.deepEqual(kept, [], 'no job is kept for a remote turn');
  await gone;
  await w.close;
  await new Promise((r) => setTimeout(r, 20)); // past the grace period a local stop would use
  assert.deepEqual(f.calls, []);
  assert.deepEqual(d.stops, ['ts']);
  assert.equal(child.signalCode, 'SIGINT');
  // A turn already ended: gone at once, and still nothing local.
  assert.deepEqual(f.calls, []);
  await (await stopTurn(child, { exited, kill: f.kill, list: f.list })).gone;
  assert.equal(sent(d, 'stop').length, 1);
  assert.deepEqual(f.calls, []);
});

test('#120: signalGroup and stopJobUnder on a remote child: the daemon’s stop, and a job’s own Stop isn’t offered', async () => {
  const f = forbidden();
  const child = new RemoteProcess(
    new (class extends EventEmitter {
      send() {
        return true;
      }
    })(),
    { turn: 'tj', from: 0 },
  );
  // A host process ID, were one ever set, must still never reach the local kill.
  Object.defineProperty(child, 'pid', { value: 4242 });
  assert.equal(signalGroup(child, 'SIGKILL', f.kill), true);
  assert.equal(child.killed, true);
  assert.equal(await stopJobUnder(child, { command: 'sleep 100' }, { kill: f.kill, list: f.list }), false);
  const { gone } = await stopTurn(child, { exited: new Promise(() => {}), kill: f.kill, list: f.list, graceMs: 1, pollMs: 1 });
  child.finish({ code: null, signal: 'SIGINT' });
  await gone;
  assert.deepEqual(f.calls, []);
});
