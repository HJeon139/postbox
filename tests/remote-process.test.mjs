// The remote process (#120, L3): spawn’s shape, backed by the host’s daemon. Run against tests/fake-daemon.mjs, which
// replays a recorded Claude Code stream (tests/fixtures/claude-code/permission-allow.jsonl), through a minimal stand-in
// for L1’s connection: hello on each channel, `connected` at each welcome, send() false while there’s none.
// Here: start, argv, env, agentFile and each kind of stdin. Reading and replay are in remote-process-reading.test.mjs,
// stopping and how a turn ends in remote-process-stop.test.mjs, and process-group.mjs’s remote branch in
// remote-process-group.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteSpawn } from '../server/remote/process.mjs';
import { MESSAGE_FILE } from '../shared/remote-protocol.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { connectTo, FOLDER, LINES, sent, until, watch } from './remote-process-fixtures.mjs';

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
