// When the Postbox driving a host goes away (#582, designs/508/582/link.md): a read parked for it is answered from the
// turn's snapshot at once, not when the shim next asks. The same Postbox back (S3a) keeps its reads; a Postbox that
// takes over (S3b) or a socket that ends first (S2b) settles them offline. Each case is the daemon in-process with a
// shim on its socket (tests/remote-broker-daemon-setup.mjs).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { encode, hostPaths, MESSAGE_FILE, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';
import { inProcessDaemon, socketShim } from './remote-broker-daemon-setup.mjs';
import { TOKEN, until, VERSION } from './remote-broker-fixtures.mjs';

const ME = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const OFFLINE = 'Read offline as of this turn';

/** A daemon with turn t1 started and a snapshot sent, and Postbox connections to it. */
async function room() {
  const home = mkdtempSync(join(tmpdir(), 'pblink-'));
  const p = hostPaths(home, VERSION);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const work = join(home, 'work');
  mkdirSync(work);
  const { daemon } = inProcessDaemon(home);
  await daemon.start();
  // Counts the broker's hello resends as they finish, so a check that nothing was sent waits for that, not a sleep.
  let helloes = 0;
  const hello = daemon.broker.hello;
  daemon.broker.hello = async (...a) => {
    await hello?.(...a);
    helloes++;
  };
  // Where each driverLost call came from. It must be inside Conn.close(), in the same tick: a deferred call could run
  // after the new driver's hello has resent the read.
  const lostFrom = [];
  const lost = daemon.broker.driverLost;
  daemon.broker.driverLost = (...a) => {
    lostFrom.push(new Error('driverLost').stack ?? '');
    return lost?.(...a);
  };
  const afterHello = (n) => until(() => helloes >= n, `hello ${n}’s resends`);
  /** A Postbox connection that has said hello, with `instance` and maybe `takeover`. */
  const postbox = async (extra = {}) => {
    const input = new PassThrough();
    const output = new PassThrough();
    daemon.connect({ input, output });
    const msgs = readMessages(output);
    const send = (type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
    send('hello', { version: PROTOCOL_VERSION, token: TOKEN, ...extra });
    return { input, msgs, send };
  };
  const first = await postbox({ instance: ME });
  await first.msgs.next('welcome');
  first.send('snapshot', { turn: 't1', home: 'th', threads: [{ id: 'th', items: [{ id: 'i1', line: 'You: hi', text: 'You: hi' }] }] });
  first.send('start', { turn: 't1', harness: 'claude-code', folder: work, argv: [], env: {}, stdin: 'file', files: [{ name: MESSAGE_FILE, text: '{}\n' }] });
  await first.msgs.next('started');
  const shim = () => {
    const s = socketShim(daemon);
    s.shimSend('hello', { token: readFileSync(p.turn('t1', TURN_FILES.shimToken), 'utf8'), turn: 't1' });
    return s;
  };
  const s1 = shim();
  await until(() => s1.got.find((m) => m.type === 'welcome'), 'the shim’s welcome');
  /** The shim asks for a read, and Postbox (the first connection) hears the tool. */
  const parkRead = async (id = 'c1') => {
    s1.shimSend('call', { id, name: 'read_conversation', args: {} });
    assert.equal((await first.msgs.next('tool')).id, id);
  };
  const results = (id = 'c1') => s1.got.filter((m) => m.type === 'result' && m.id === id);
  const done = () => {
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { first, postbox, s1, shim, parkRead, results, afterHello, lostFrom, done };
}

test('L1: the driver’s socket ends: a parked read is answered from the snapshot at once, with no further call from the shim (T01)', async () => {
  const r = await room();
  try {
    await r.parkRead();
    r.first.input.end();
    const res = await until(() => r.results()[0], 'the read answered offline');
    assert.match(res.text, new RegExp(OFFLINE));
    assert.match(res.text, /You: hi/);
  } finally {
    r.done();
  }
});

test('L2: a shim’s socket ends: the driver’s parked reads are left alone', async () => {
  const r = await room();
  try {
    await r.parkRead();
    const other = r.shim();
    await until(() => other.got.find((m) => m.type === 'welcome'), 'the second shim');
    other.toDaemon.end();
    // The live reply is the signal: an offline claim would have taken the call and dropped it.
    r.first.send('reply', { turn: 't1', id: 'c1', ok: true, text: 'live' });
    assert.equal((await until(() => r.results()[0], 'the live answer')).text, 'live');
  } finally {
    r.done();
  }
});

test('L3: the same Postbox says hello before its old socket ends: the read stays waiting, is sent again, and the live reply answers it (S3a, T03)', async () => {
  const r = await room();
  try {
    await r.parkRead();
    const again = await r.postbox({ instance: ME });
    await again.msgs.next('welcome');
    assert.equal((await again.msgs.next('tool')).id, 'c1', 'sent again to the replacement');
    assert.equal(r.results().length, 0, 'nothing answered offline');
    again.send('reply', { turn: 't1', id: 'c1', ok: true, text: '[i1] You: hi' });
    const res = await until(() => r.results()[0], 'the live answer');
    assert.equal(res.text, '[i1] You: hi');
    assert.equal(r.results().length, 1);
  } finally {
    r.done();
  }
});

test('L4: the old socket ends before the same Postbox’s hello (S2b): one offline answer, and the hello sends the read to nobody', async () => {
  const r = await room();
  try {
    await r.parkRead();
    r.first.input.end();
    await until(() => r.results()[0], 'the offline answer');
    const again = await r.postbox({ instance: ME });
    await again.msgs.next('welcome');
    await r.afterHello(2);
    assert.equal(
      again.msgs.messages.some((m) => m.type === 'tool'),
      false,
      'a settled read is not sent again',
    );
    assert.equal(r.results().length, 1);
  } finally {
    r.done();
  }
});

test('L5: another Postbox takes over: the old driver’s read is answered offline, and the new driver is not sent it (S3b, T04)', async () => {
  const r = await room();
  try {
    await r.parkRead();
    const taker = await r.postbox({ instance: OTHER, takeover: true });
    await taker.msgs.next('welcome');
    const res = await until(() => r.results()[0], 'the offline answer');
    assert.match(res.text, new RegExp(OFFLINE));
    await r.afterHello(2);
    assert.equal(
      taker.msgs.messages.some((m) => m.type === 'tool'),
      false,
    );
    assert.equal(r.results().length, 1);
    assert.equal(r.lostFrom.length, 1, 'driverLost ran once');
    assert.match(r.lostFrom[0], /\bclose\b/, 'and inside Conn.close(), not on a later tick');
  } finally {
    r.done();
  }
});

test('L6: a hello that is refused as busy leaves the driver and its read alone', async () => {
  const r = await room();
  try {
    await r.parkRead();
    const busy = await r.postbox({ instance: OTHER });
    assert.equal((await busy.msgs.next('error')).code, 'busy');
    r.first.send('reply', { turn: 't1', id: 'c1', ok: true, text: 'live' });
    assert.equal((await until(() => r.results()[0], 'the live answer')).text, 'live');
  } finally {
    r.done();
  }
});

test('L7: the driver’s socket closing twice (end, then an error) settles the read once', async () => {
  const r = await room();
  try {
    await r.parkRead();
    r.first.input.end();
    r.first.input.emit('error', new Error('reset'));
    await until(() => r.results()[0], 'the offline answer');
    // A second read, answered offline after the first, is the barrier: a duplicate of c1 would be ahead of it.
    r.s1.shimSend('call', { id: 'c2', name: 'read_conversation', args: {} });
    await until(() => r.results('c2')[0], 'the barrier read');
    assert.equal(r.results().length, 1);
  } finally {
    r.done();
  }
});
