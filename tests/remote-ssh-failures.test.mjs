// How a connection to a host fails (server/remote/ssh-failures.mjs, through ssh.mjs): each recorded or documented
// ssh failure classified and worded, which ones Postbox retries, and how a dropped, late or closed connection ends.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { classifyExit, FAILURE_KINDS, retries, SshFailure } from '../server/remote/ssh.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { connection, fakeClock, HOST } from './remote-ssh-fixtures.mjs';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/ssh/failures.json', import.meta.url), 'utf8')).failures;

// ── Failures ────────────────────────────────────────────────────────────────────────

test('each recorded or documented ssh failure is classified, and says what the person can do next', async () => {
  for (const f of FIXTURES) {
    const direct = classifyExit({ destination: HOST, code: f.code, signal: null, stderr: f.stderr });
    assert.equal(direct.kind, f.kind, f.name);
    assert.equal(Boolean(direct.detail.changed), Boolean(f.changed), `${f.name}: changed`);
    // The same through a connection: ssh writes stderr and exits before any welcome.
    const ssh = fakeSsh({ script: (child) => child.fail(f.code, f.stderr) });
    const e = await connection({ spawn: ssh.spawn })
      .connect()
      .catch((x) => x);
    assert.ok(e instanceof SshFailure, f.name);
    assert.equal(e.kind, f.kind, f.name);
    assert.equal(e.retry, FAILURE_KINDS[f.kind].retry, f.name);
    assert.ok(e.message.includes(HOST) && e.next.includes(HOST), f.name);
  }
});

test('the failure classes’ words for the UI', () => {
  const by = (name) => {
    const f = FIXTURES.find((x) => x.name === name);
    return classifyExit({ destination: HOST, code: f.code, signal: null, stderr: f.stderr });
  };
  assert.equal(by('sign-in').next, 'Sign in to host.example.com in a terminal (run `ssh host.example.com`), then reconnect.');
  assert.match(by('host-key-unknown').next, /^Connect once in a terminal with `ssh host\.example\.com`, check that the fingerprint/);
  const changed = by('host-key-changed');
  assert.match(changed.message, /host key has changed/);
  assert.match(changed.next, /`ssh-keygen -R host\.example\.com` \(ssh found it at \/Users\/user\/\.ssh\/known_hosts, line 3\)/);
  assert.equal(by('keepalive-drop').message, 'Postbox couldn’t reach host.example.com. ssh said: “Timeout, server host.example.com not responding.”');
  assert.equal(by('refused').message, 'Postbox couldn’t reach host.example.com. ssh said: “ssh: connect to host host.example.com port 22: Connection refused”');
  assert.match(by('not-installed').next, /^Install Postbox on host\.example\.com/);
  assert.match(by('other').message, /\(ssh exited with 255\)\. ssh said: “\/Users\/user\/\.ssh\/config: terminating, 1 bad configuration options”/);
  // ssh-keygen -R takes the host, not user@host.
  const f = FIXTURES.find((x) => x.name === 'host-key-changed');
  assert.match(classifyExit({ destination: 'user@host.example.com', code: 255, signal: null, stderr: f.stderr }).next, /`ssh-keygen -R host\.example\.com`/);
});

test('only what Postbox can’t fix by waiting stops the retries', () => {
  for (const kind of ['sign-in', 'host-key', 'not-installed', 'version', 'bad-token', 'busy', 'no-node']) assert.equal(retries(kind), false, kind);
  for (const kind of ['unreachable', 'ended', 'failed']) assert.equal(retries(kind), true, kind);
});

test('ssh that isn’t installed fails the connection with what to do, not a crash', async () => {
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const e = await connection({ spawn })
    .connect()
    .catch((x) => x);
  assert.equal(e.kind, 'failed');
  assert.match(e.message, /ssh isn’t installed or isn’t on PATH/);
});

test('a dropped connection says why: the keepalive timeout is unreachable, and a daemon that left is ended', async () => {
  const daemon = createFakeDaemon();
  const ssh = fakeSsh({ daemon });
  const c = connection({ spawn: ssh.spawn });
  await c.connect();
  const closed = new Promise((resolve) => c.on('close', resolve));
  const f = FIXTURES.find((x) => x.name === 'keepalive-drop');
  ssh.children[0].fail(f.code, f.stderr);
  const why = await closed;
  assert.equal(why.kind, 'unreachable');
  assert.equal(why.retry, true);
  assert.equal(c.state, 'closed');

  const d = connection({ spawn: ssh.spawn });
  await d.connect();
  const gone = new Promise((resolve) => d.on('close', resolve));
  daemon.drop();
  assert.equal((await gone).kind, 'ended');
});

test('no welcome in time gives up as unreachable and stops ssh', async () => {
  const clock = fakeClock();
  const ssh = fakeSsh({ script: () => {} });
  const c = connection({ spawn: ssh.spawn, setTimer: clock.setTimer, clearTimer: clock.clearTimer, welcomeTimeout: 30_000 });
  const p = c.connect().catch((e) => e);
  assert.deepEqual(clock.pending(), [30_000]);
  clock.fire();
  const e = await p;
  assert.equal(e.kind, 'unreachable');
  assert.match(e.message, /No answer from the host within 30 seconds/);
  assert.deepEqual(ssh.children[0].kills, ['SIGTERM']);
});

test('close ends ssh’s stdin and kills it, SIGKILL after a grace period, and reports no failure', async () => {
  const daemon = createFakeDaemon();
  const clock = fakeClock();
  const ssh = fakeSsh({ daemon, ignoreTerm: true });
  const c = connection({ spawn: ssh.spawn, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const p = c.connect();
  await p;
  const closed = new Promise((resolve) => c.on('close', resolve));
  const child = ssh.children[0];
  c.close();
  assert.ok(child.stdin.writableEnded);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.deepEqual(clock.pending(), [5000]);
  clock.fire();
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(await closed, null);
  assert.equal(c.state, 'closed');
  assert.throws(() => c.send({ type: 'stop', turn: 'turn-1' }), /isn’t open/);
});

test('close while connecting rejects the connect and kills ssh', async () => {
  const ssh = fakeSsh({ script: () => {} });
  const c = connection({ spawn: ssh.spawn });
  const p = c.connect().catch((e) => e);
  c.close();
  assert.equal((await p).kind, 'failed');
  assert.deepEqual(ssh.children[0].kills, ['SIGTERM']);
});
