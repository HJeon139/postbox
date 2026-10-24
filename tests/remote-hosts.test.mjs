// The host manager (server/remote/hosts.mjs, #120): a link per host with the token install.mjs keeps, each host’s
// status and the reasons that keep it connected. Refresh, wake (D2) and renames are in remote-hosts-wake.test.mjs,
// and the sign-in check (G5), install, forget and removing Postbox from a host in remote-hosts-requests.test.mjs.
// ssh is never run:
// tests/fake-ssh.mjs’s spawn wires each session to tests/fake-daemon.mjs, and a scripted ssh plays failures and
// installs. Tokens live in a temp data folder, as install.mjs writes them.

import assert from 'node:assert/strict';
import test from 'node:test';
import { HEARD_EVERY_MS, IDLE_GRACE_MS } from '../server/remote/hosts.mjs';
import { SshFailure } from '../server/remote/ssh.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { SIGN_IN, setup, sleep, until } from './remote-hosts-fixtures.mjs';

test('hosts: one link per host, made with its token; a host without one is not-installed, with the next step', () => {
  const s = setup();
  try {
    const a = s.mgr.link('h1');
    assert.equal(s.mgr.link('h1'), a, 'the same link on every call');
    assert.equal(s.ssh.calls.length, 0, 'made, not connected: nothing needs it yet');
    assert.deepEqual(s.mgr.status('h1'), { state: 'disconnected', failure: null, welcome: null, lastHeard: null });
    assert.throws(
      () => s.mgr.link('h2'),
      (e) => e instanceof SshFailure && e.code === 'not-installed' && e.kind === 'not-installed' && /Install Postbox on other\.example\.com/.test(e.next),
    );
    assert.equal(s.mgr.status('h2').state, 'not-installed');
    assert.throws(
      () => s.mgr.link('nope'),
      (e) => e.code === 'no-host',
    );
  } finally {
    s.done();
  }
});

test('hosts: a bad token file is no token', () => {
  const s = setup({ token: 'short' });
  try {
    assert.throws(
      () => s.mgr.link('h1'),
      (e) => e.code === 'not-installed',
    );
  } finally {
    s.done();
  }
});

test('hosts: status goes connected with the welcome, reconnecting after a drop while needed, and connected again', async () => {
  const s = setup();
  try {
    s.mgr.need('h1', 'turn:t1');
    await until(() => s.mgr.status('h1').state === 'connected', 'connected');
    const st = s.mgr.status('h1');
    assert.equal(st.welcome.home, '/home/user');
    assert.equal(st.failure, null);
    assert.equal(st.lastHeard, s.clock.now(), 'the welcome is a message from the daemon');
    s.daemon.drop();
    await until(() => s.statuses.some((x) => x.state === 'reconnecting'), 'reconnecting');
    await until(() => s.mgr.status('h1').state === 'connected' && s.ssh.calls.length === 2, 'connected again');
    assert.equal(s.mgr.status('h1').welcome.home, '/home/user');
    const states = s.statuses.filter((x) => x.id === 'h1').map((x) => x.state);
    // Made disconnected (it has a token); each status after is a change.
    assert.deepEqual(states, ['disconnected', 'reconnecting', 'connected', 'reconnecting', 'connected']);
  } finally {
    s.done();
  }
});

test('hosts: a sign-in failure is failed, with the link’s failure; ensureWelcome rejects with it, and doesn’t redial', async () => {
  const ssh = fakeSsh({ script: (child) => child.fail(255, SIGN_IN) });
  const s = setup({ spawn: ssh.spawn });
  try {
    await assert.rejects(s.mgr.ensureWelcome('h1'), (e) => e instanceof SshFailure && e.kind === 'sign-in');
    const st = s.mgr.status('h1');
    assert.equal(st.state, 'failed');
    assert.equal(st.failure?.kind, 'sign-in');
    assert.match(st.failure?.next ?? '', /Sign in to host\.example\.com in a terminal/);
    assert.equal(s.statuses.at(-1)?.state, 'failed');
    // Stopped for the person: neither another ensureWelcome nor a wake redials.
    await assert.rejects(s.mgr.ensureWelcome('h1'), (e) => e.kind === 'sign-in');
    s.mgr.wake();
    await sleep(20);
    assert.equal(ssh.calls.length, 1);
  } finally {
    s.done();
  }
});

test('hosts: lastHeard moves with every daemon message; a change to it alone is emitted at most every HEARD_EVERY_MS', async () => {
  const s = setup();
  try {
    s.daemon.addTurn('t1');
    const l = s.mgr.link('h1');
    const got = [];
    l.on('message', (m) => got.push(m));
    await s.mgr.ensureWelcome('h1');
    const first = s.mgr.status('h1').lastHeard;
    const emitted = s.statuses.length;
    s.clock.advance(1000);
    l.send({ type: 'read', turn: 't1', from: 0 });
    await until(() => got.some((m) => m.type === 'caught-up'), 'the read');
    assert.equal(s.mgr.status('h1').lastHeard, first + 1000, 'status() is always current');
    assert.equal(s.statuses.length, emitted, 'held back: the last status went less than HEARD_EVERY_MS ago');
    s.clock.advance(HEARD_EVERY_MS);
    assert.equal(s.statuses.length, emitted + 1, 'then it goes');
    assert.equal(s.statuses.at(-1)?.lastHeard, first + 1000);
    assert.equal(s.statuses.at(-1)?.state, 'connected');
  } finally {
    s.done();
  }
});

test('hosts: need and release keep the host connected, counted per reason; with none left its session idles after the grace', async () => {
  const s = setup();
  try {
    s.mgr.need('h1', 'turn:t1');
    s.mgr.need('h1', 'turn:t1');
    s.mgr.need('h1', 'prompt:p1');
    await until(() => s.mgr.status('h1').state === 'connected', 'connected');
    s.mgr.release('h1', 'turn:t1');
    s.mgr.release('h1', 'prompt:p1');
    s.mgr.release('h1', 'nothing'); // a release with no need is ignored
    s.daemon.drop();
    await until(() => s.ssh.calls.length === 2 && s.mgr.status('h1').state === 'connected', 'a reconnect: turn:t1 is still needed once');
    s.mgr.release('h1', 'turn:t1');
    s.clock.advance(IDLE_GRACE_MS - 1);
    assert.equal(s.mgr.status('h1').state, 'connected', 'within the grace');
    s.clock.advance(1);
    await until(() => s.mgr.status('h1').state === 'disconnected', 'the session closed');
    assert.equal(s.mgr.status('h1').failure, null, 'idle is no failure');
    assert.equal(s.mgr.status('h1').welcome.home, '/home/user', 'the welcome is kept');
    await sleep(20);
    assert.equal(s.ssh.calls.length, 2, 'nothing needs it, so it isn’t redialed');
    // A need opens a new session on the same link.
    const l = s.mgr.link('h1');
    s.mgr.need('h1', 'turn:t2');
    await until(() => s.ssh.calls.length === 3 && l.connected, 'a new session');
    assert.equal(s.mgr.link('h1'), l);
  } finally {
    s.done();
  }
});

test('hosts: a turn’s child listening for the link’s messages keeps it needed, as link.mjs’s default does', async () => {
  const s = setup();
  try {
    const l = s.mgr.link('h1');
    const child = () => {};
    l.on('message', child);
    await until(() => l.connected, 'connected for the listener');
    s.clock.advance(IDLE_GRACE_MS);
    assert.equal(l.connected, true, 'still needed');
    l.off('message', child);
    await sleep(0);
    s.clock.advance(IDLE_GRACE_MS);
    await until(() => !l.connected, 'idle once it stopped listening');
  } finally {
    s.done();
  }
});
