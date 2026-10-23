// The host link (server/remote/link.mjs, #120): one long-lived connection over ssh.mjs’s sessions and reconnector, in
// the shape server/remote/process.mjs takes. ssh is never run: tests/fake-ssh.mjs’s spawn wires each session to
// tests/fake-daemon.mjs, which replays a recorded Claude Code stream (tests/fixtures/claude-code/permission-allow.jsonl).
// The last test runs remoteSpawn over a real link, through a drop.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostLink } from '../server/remote/link.mjs';
import { remoteSpawn } from '../server/remote/process.mjs';
import { SshFailure } from '../server/remote/ssh.mjs';
import { MESSAGE_FILE, message } from '../shared/remote-protocol.mjs';
import { defaultHostSettings } from '../shared/remote-settings.mjs';
import { createFakeDaemon, FAKE_TOKEN, fixtureLines } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';

const HOST = { name: 'host.example.com', settings: defaultHostSettings() };
const VERSION = '0.10.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The next `event` from an emitter, or a rejection naming it. */
function next(emitter, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`No ${event} within ${ms} ms.`)), ms);
    emitter.once(event, (...args) => {
      clearTimeout(t);
      resolve(args[0]);
    });
  });
}

async function until(fn, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}.`);
    await sleep(2);
  }
}

/** A link to a fake daemon over a fake ssh, retrying after 5 ms. */
function linkTo(daemon, o = {}) {
  const ssh = fakeSsh({ daemon });
  const link = createHostLink({ host: HOST, version: VERSION, token: FAKE_TOKEN, spawn: ssh.spawn, delay: () => 5, ...o });
  return { link, ssh };
}

const read = (turn, from = 0) => message('postbox-to-daemon', 'read', { turn, from });

test('host link: connects when a send finds no session, says connected with the welcome, then sends', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const { link, ssh } = linkTo(d);
  try {
    assert.equal(link.getMaxListeners(), 0, 'every turn’s child listens');
    const got = [];
    link.on('message', (m) => got.push(m));
    assert.equal(link.state, 'idle');
    assert.equal(link.welcome, null);
    const connected = next(link, 'connected');
    assert.equal(link.send(read('t1')), false, 'no session yet');
    const welcome = await connected;
    assert.equal(ssh.calls.length, 1, 'the failed send asked for a session');
    assert.equal(welcome.home, '/home/user');
    assert.equal(link.welcome, welcome);
    assert.equal(link.connected, true);
    assert.equal(link.state, 'open');
    assert.equal(link.failure, null);
    // It was false, so nothing crossed; now it does, and the daemon’s answer comes as a message.
    assert.equal(d.received.filter((m) => m.type === 'read').length, 0);
    assert.equal(link.send(read('t1')), true);
    await until(() => got.some((m) => m.type === 'error'), 'the daemon’s answer');
    assert.equal(got.find((m) => m.type === 'error').code, 'no-turn');
    // Never throws: hello is the session’s own, and a message the daemon would refuse is false.
    assert.equal(link.send({ type: 'hello', version: 1, token: FAKE_TOKEN }), false);
    assert.equal(link.send({ type: 'read', turn: '../x', from: 0 }), false);
    assert.equal(link.send(/** @type {any} */ (null)), false);
  } finally {
    link.close();
  }
});

test('host link: messages the daemon sends straight after its welcome are passed on, after connected', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  // Queued while nobody was connected, so the daemon resends them right after the next welcome, in the same breath.
  d.tool('t1', 'show_block', { block: { id: 'b1' } });
  d.prompt('t1');
  const { link } = linkTo(d);
  try {
    const order = [];
    link.on('connected', () => order.push('connected'));
    link.on('message', (m) => order.push(m.type));
    link.need();
    await until(() => order.length >= 3, 'the resent tool and prompt');
    assert.deepEqual(order, ['connected', 'tool', 'prompt']);
  } finally {
    link.close();
  }
});

test('host link: a drop is a failure with a next step; it reconnects, says connected again, and sends on the new session', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const { link, ssh } = linkTo(d);
  try {
    link.on('message', () => {});
    const failures = [];
    link.on('failure', (f) => failures.push(f));
    link.need();
    await next(link, 'connected');
    const again = next(link, 'connected');
    d.drop(); // the daemon’s side ends, so the fake ssh exits 0, as a real one does with the remote command
    await until(() => failures.length === 1, 'the drop');
    assert.ok(failures[0] instanceof SshFailure);
    assert.equal(failures[0].kind, 'ended');
    assert.match(failures[0].next, /tries again on its own/);
    assert.equal(link.connected, false);
    assert.equal(link.failure, failures[0], 'the failure stays until a session opens');
    assert.equal(link.send(read('t1')), false, 'between a drop and the next welcome');
    await again;
    assert.equal(ssh.calls.length, 2);
    assert.equal(link.failure, null);
    assert.equal(link.send(read('t1')), true);
    await until(() => d.received.filter((m) => m.type === 'read').length === 1, 'the read on the new session');
  } finally {
    link.close();
  }
});

test('host link: a failure only the person can fix gives up with error, until retry', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const { link, ssh } = linkTo(d, { token: 'not-the-token-0123456789abcdefghijklmn' });
  try {
    link.on('message', () => {});
    const gaveUp = next(link, 'error');
    link.need();
    const f = await gaveUp;
    assert.ok(f instanceof SshFailure);
    assert.equal(f.kind, 'bad-token');
    assert.equal(f.retry, false);
    assert.match(f.next, /Reinstall Postbox on host\.example\.com/);
    assert.equal(link.state, 'stopped');
    assert.equal(link.failure, f);
    // It doesn’t redial on its own, on a send or on a wake.
    assert.equal(link.send(read('t1')), false);
    link.wake();
    await sleep(30);
    assert.equal(ssh.calls.length, 1);
    // The person asks: it tries again (and is refused again, since the token is still wrong).
    const again = next(link, 'error');
    link.retry();
    assert.equal((await again).kind, 'bad-token');
    assert.equal(ssh.calls.length, 2);
  } finally {
    link.close();
  }
});

test('host link: busy gives up; retry with takeover replaces the other Postbox', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const a = linkTo(d);
  const b = linkTo(d);
  try {
    const aGot = [];
    a.link.on('message', (m) => aGot.push(m));
    a.link.need();
    await next(a.link, 'connected');
    b.link.on('message', () => {});
    const busy = next(b.link, 'error');
    b.link.need();
    assert.equal((await busy).kind, 'busy');
    const connected = next(b.link, 'connected');
    b.link.retry({ takeover: true });
    await connected;
    assert.equal(d.received.filter((m) => m.type === 'hello').at(-1).takeover, true);
    await until(() => aGot.some((m) => m.type === 'error' && m.code === 'taken-over'), 'the other Postbox to hear it was taken over');
    a.link.close(); // else it redials, and is told busy
    // takeover is for that session only.
    const again = next(b.link, 'connected');
    d.drop();
    await again;
    assert.equal(d.received.filter((m) => m.type === 'hello').at(-1).takeover, undefined);
  } finally {
    a.link.close();
    b.link.close();
  }
});

test('host link: a host nobody needs isn’t redialed after a drop, and need() dials it again', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  let wanted = true;
  const { link, ssh } = linkTo(d, { needed: () => wanted });
  try {
    link.need();
    await next(link, 'connected');
    wanted = false;
    d.drop();
    await until(() => link.state === 'idle', 'idle');
    await sleep(30);
    assert.equal(ssh.calls.length, 1);
    wanted = true;
    const connected = next(link, 'connected');
    link.need();
    await connected;
    assert.equal(ssh.calls.length, 2);
  } finally {
    link.close();
  }
});

test('host link: close ends the session, tells error listeners, and sends nothing after', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const { link, ssh } = linkTo(d);
  link.on('message', () => {});
  link.need();
  await next(link, 'connected');
  const closed = next(link, 'error');
  link.close();
  const f = await closed;
  assert.equal(f.kind, 'failed');
  assert.equal(link.state, 'closed');
  assert.equal(link.connected, false);
  assert.equal(link.send(read('t1')), false);
  await until(() => ssh.children[0].exited, 'ssh to exit');
  link.need();
  link.retry();
  await sleep(20);
  assert.equal(ssh.calls.length, 1);
  // A link nobody listens to for errors closes without throwing.
  const quiet = linkTo(d).link;
  quiet.close();
});

test('remoteSpawn over a host link: a file-stdin turn starts, streams, survives a drop with no repeated line, and ends', async () => {
  const all = fixtureLines();
  const before = 5;
  const d = createFakeDaemon({ autoEnd: false, lines: all.slice(0, before) });
  const { link, ssh } = linkTo(d);
  try {
    const spawn = remoteSpawn({ connection: link, harness: 'claude-code', folder: '/home/user/postbox-work/ada', stdin: 'file', turn: 't1' });
    const child = spawn('claude', ['-p', '--output-format', 'stream-json']);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => (out += s));
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.stdin.end('{"type":"user","message":{"role":"user","content":"hi"}}\n');

    await until(() => out.split('\n').length - 1 === before, 'the first lines');
    assert.equal(ssh.calls.length, 1, 'the start asked for a session');
    const t = d.turns.get('t1');
    assert.equal(t?.start?.files.find((f) => f.name === MESSAGE_FILE)?.text, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

    // The ssh child exits; the turn goes on on the host, writing lines nobody is reading.
    const reconnected = next(link, 'connected');
    d.drop();
    for (const line of all.slice(before)) d.append('t1', line);
    await reconnected;
    assert.equal(ssh.calls.length, 2);
    await until(() => out.split('\n').length - 1 === all.length, 'the rest of the lines');
    d.end('t1');
    assert.deepEqual(await exited, { code: 0, signal: null });
    await closed;

    assert.equal(out, `${all.join('\n')}\n`, 'every line once, in order');
    const reads = d.received.filter((m) => m.type === 'read').map((m) => m.from);
    assert.equal(reads.length, 2);
    assert.equal(reads[0], 0);
    assert.equal(reads[1], t?.out[before].offset, 'reading resumed from just past the last line applied');
    assert.equal(d.received.filter((m) => m.type === 'start').length, 1, 'the start that found no session went at the welcome');
    assert.equal(child.interrupted, false);
    await until(() => t?.acked === t?.out.at(-1)?.next, 'the last ack');
  } finally {
    link.close();
  }
});
