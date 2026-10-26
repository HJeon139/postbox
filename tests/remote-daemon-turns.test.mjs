// The host daemon (server/remote/host/daemon.mjs, #120), in-process with fake runners (tests/remote-daemon-setup.mjs):
// a turn’s start, the runner’s liveness check, read from any offset and following a running turn, scan, and write
// to a held stdin.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MESSAGE_FILE, PROTOCOL_VERSION, REMOTE_LIMITS, TURN_FILES, validateStartRecord } from '../shared/remote-protocol.mjs';
import { hello, linesUntilEnded, makeTurn, setup, startMsg, TOKEN } from './remote-daemon-setup.mjs';

test('start writes the turn folder (0700) and its files (0600), start.json, then launches the runner', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    // A snapshot sent before start is kept for the turn, and lands in its folder.
    c.send('snapshot', { turn: 't1', home: 'th_home', threads: [{ id: 'th_home', items: [] }] });
    c.send('start', startMsg('t1'));
    assert.deepEqual(await c.msgs.next('started'), { type: 'started', turn: 't1' });
    const dir = s.p.turn('t1');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(s.p.turns).mode & 0o777, 0o700);
    for (const f of [MESSAGE_FILE, TURN_FILES.start, TURN_FILES.snapshot]) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
    assert.equal(readFileSync(join(dir, MESSAGE_FILE), 'utf8'), '{"type":"user"}\n');
    const record = JSON.parse(readFileSync(join(dir, TURN_FILES.start), 'utf8'));
    assert.ok(validateStartRecord(record).ok);
    assert.equal(record.program, '/home/user/.local/bin/claude', 'the program the daemon found, not one Postbox names');
    assert.deepEqual(record.argv, startMsg('t1').argv);
    assert.equal(JSON.parse(readFileSync(join(dir, TURN_FILES.snapshot), 'utf8')).home, 'th_home');
    assert.equal(s.launches.length, 1);
    assert.equal(s.launches[0].node, '/usr/bin/node');
    assert.equal(s.launches[0].turn, 't1');
    assert.equal(s.launches[0].scope, 'auto');
    // The same turn again, and a harness the host lacks, are refused.
    c.send('start', startMsg('t1'));
    assert.equal((await c.msgs.next('error')).code, 'turn-exists');
    c.send('start', startMsg('t2', { harness: 'kiro-cli', stdin: 'none', files: [] }));
    const none = await c.msgs.next('error');
    assert.equal(none.code, 'no-harness');
    assert.equal(none.turn, 't2');
    // A project folder that doesn’t exist is refused, not made.
    c.send('start', startMsg('t3', { folder: join(s.home, 'nowhere') }));
    assert.equal((await c.msgs.next('error')).code, 'start-failed');
  } finally {
    s.done();
  }
});

test('start sends started only once the runner answers, and fails with the runner’s reason when it refuses', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    s.state.refuse = 'The work folder /tmp/gone isn’t there.';
    c.send('start', startMsg('t1'));
    const e = await c.msgs.next('error');
    assert.equal(e.code, 'start-failed');
    assert.equal(e.turn, 't1');
    assert.match(e.message, /runner didn’t start: The work folder \/tmp\/gone isn’t there\./);
    assert.equal(c.msgs.messages.filter((m) => m.type === 'started').length, 0);
    s.state.refuse = '';
    c.send('start', startMsg('t2'));
    await c.msgs.next('started');
    assert.ok(
      s.asks.some((a) => a.turn === 't2'),
      'started came after the runner answered who',
    );
  } finally {
    s.done();
  }
});

test('the liveness check asks the runner with the token from the daemon’s own home', async () => {
  const s = setup();
  try {
    makeTurn(s.p, 't1');
    s.alive.add('t1');
    const c = await hello(s);
    assert.equal(c.welcome.turns[0].state, 'running');
    const ask = s.asks.find((a) => a.turn === 't1');
    assert.equal(ask?.token, TOKEN);
    assert.equal(ask?.path, s.p.turn('t1', TURN_FILES.socket));
  } finally {
    s.done();
  }
});

test('read sends lines with exact byte offsets from 0 and from a line in the middle, then ended', async () => {
  const s = setup();
  try {
    // Multi-byte text, so a character count would be wrong; the last line has no \n.
    const lines = ['{"a":"héllo"}', '{"b":"日本"}', '{"c":"😀"}'];
    const out = `${lines[0]}\n${lines[1]}\n${lines[2]}`;
    makeTurn(s.p, 't1', { out, exit: { code: 0, signal: null, at: 1 } });
    const c = await hello(s);
    assert.deepEqual(
      c.welcome.turns.map((t) => [t.turn, t.state]),
      [['t1', 'ended']],
    );
    c.send('read', { turn: 't1', from: 0 });
    const { lines: got, ended } = await linesUntilEnded(c.msgs);
    const b = (t) => Buffer.byteLength(t);
    const o1 = b(lines[0]) + 1;
    const o2 = o1 + b(lines[1]) + 1;
    assert.deepEqual(
      got.map((m) => [m.offset, m.next, m.text]),
      [
        [0, o1, lines[0]],
        [o1, o2, lines[1]],
        [o2, b(out), lines[2]],
      ],
    );
    assert.deepEqual(ended, { type: 'ended', turn: 't1', exit: { code: 0, signal: null, at: 1 }, size: b(out) });

    const d = s.connect();
    d.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, takeover: true });
    await d.msgs.next('welcome');
    d.send('read', { turn: 't1', from: o1 });
    const mid = await linesUntilEnded(d.msgs);
    assert.deepEqual(
      mid.lines.map((m) => m.offset),
      [o1, o2],
    );
    // An offset inside a line, or past the end, is refused.
    d.send('read', { turn: 't1', from: o1 + 1 });
    assert.equal((await d.msgs.next('error')).code, 'bad-offset');
    d.send('read', { turn: 't1', from: b(out) + 5 });
    assert.equal((await d.msgs.next('error')).code, 'bad-offset');
    d.send('read', { turn: 'nope', from: 0 });
    assert.equal((await d.msgs.next('error')).code, 'no-turn');
  } finally {
    s.done();
  }
});

test('read follows a running turn: appended lines arrive, a last line without \\n waits for the end, then ended', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    const out = s.p.turn('t1', TURN_FILES.out);
    await writeFile(out, '{"n":1}\n');
    c.send('read', { turn: 't1', from: 0 });
    assert.deepEqual(await c.msgs.next('line'), { type: 'line', turn: 't1', offset: 0, next: 8, text: '{"n":1}' });
    await appendFile(out, '{"n":2}\n{"n"');
    assert.deepEqual(await c.msgs.next('line'), { type: 'line', turn: 't1', offset: 8, next: 16, text: '{"n":2}' });
    await appendFile(out, ':3}');
    await writeFile(s.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 5 }));
    assert.deepEqual(await c.msgs.next('line'), { type: 'line', turn: 't1', offset: 16, next: 23, text: '{"n":3}' });
    assert.deepEqual(await c.msgs.next('ended'), { type: 'ended', turn: 't1', exit: { code: 0, signal: null, at: 5 }, size: 23 });
    // Acks up to the end are recorded; past it they’re refused.
    c.send('ack', { turn: 't1', upTo: 16 });
    c.send('ack', { turn: 't1', upTo: 99 });
    assert.equal((await c.msgs.next('error')).code, 'bad-offset');
    assert.equal(s.daemon.acked.get('t1'), 16);
  } finally {
    s.done();
  }
});

test('a line over the stream limit is sent cut, with its offsets, and the stream moves on', async () => {
  const s = setup();
  try {
    const long = 'x'.repeat(REMOTE_LIMITS.streamLineBytes + 1);
    makeTurn(s.p, 't1', { out: `${long}\n{"ok":1}\n`, exit: { code: 0, signal: null, at: 1 } });
    const c = await hello(s);
    c.send('read', { turn: 't1', from: 0 });
    const { lines } = await linesUntilEnded(c.msgs, 5000);
    assert.deepEqual(
      lines.map((m) => [m.offset, m.next, m.text, m.cut]),
      [
        [0, long.length + 1, '', true],
        [long.length + 1, long.length + 10, '{"ok":1}', undefined],
      ],
    );
  } finally {
    s.done();
  }
});

test('a turn with no exit.json and no live runner reads as interrupted: ended with exit null', async () => {
  const s = setup();
  try {
    makeTurn(s.p, 't1', { out: '{"n":1}\n' });
    const c = await hello(s);
    assert.equal(c.welcome.turns[0].state, 'interrupted');
    c.send('read', { turn: 't1', from: 0 });
    const { lines, ended } = await linesUntilEnded(c.msgs);
    assert.equal(lines.length, 1);
    assert.deepEqual(ended, { type: 'ended', turn: 't1', exit: null, size: 8 });
  } finally {
    s.done();
  }
});

test('scan classifies turn folders: a live runner is running, exit.json is ended, neither is interrupted', async () => {
  const s = setup();
  try {
    makeTurn(s.p, 'run', { out: '{"a":1}\n' });
    makeTurn(s.p, 'done', { out: '{"a":1}\n{"b":2}\n', exit: { code: 1, signal: null, at: 3 }, harness: 'codex' });
    makeTurn(s.p, 'lost', {});
    makeTurn(s.p, 'stray', { start: false });
    s.alive.add('run');
    const turns = (await s.daemon.scan()).sort((a, b) => a.turn.localeCompare(b.turn));
    assert.deepEqual(turns, [
      { turn: 'done', harness: 'codex', state: 'ended', size: 16, exit: { code: 1, signal: null, at: 3 } },
      { turn: 'lost', harness: 'claude-code', state: 'interrupted', size: 0, exit: null },
      { turn: 'run', harness: 'claude-code', state: 'running', size: 8, exit: null },
    ]);
    // The welcome carries the same.
    const c = await hello(s);
    assert.equal(c.welcome.turns.length, 3);
  } finally {
    s.done();
  }
});

test('write forwards a line to a held stdin’s runner, and refuses a turn whose stdin isn’t held', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1', { harness: 'codex', stdin: 'held', files: [] }));
    await c.msgs.next('started');
    c.send('write', { turn: 't1', line: '{"id":1}' });
    assert.deepEqual(await c.msgs.next('written'), { type: 'written', turn: 't1', upTo: 42 });
    assert.equal(s.writes[0].line, '{"id":1}');
    assert.equal(s.writes[0].token, TOKEN);
    assert.equal(s.writes[0].socketPath, s.p.turn('t1', TURN_FILES.socket));
    c.send('start', startMsg('t2'));
    await c.msgs.next('started');
    c.send('write', { turn: 't2', line: 'x' });
    assert.equal((await c.msgs.next('error')).code, 'not-held');
  } finally {
    s.done();
  }
});
