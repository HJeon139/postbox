// The host manager (server/remote/hosts.mjs, #120) after a change: refresh after the settings change, wake (D2), and
// a host renamed while nothing needs it or while a turn still runs on the old one.

import assert from 'node:assert/strict';
import test from 'node:test';
import { IDLE_GRACE_MS } from '../server/remote/hosts.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { SIGN_IN, setup, sleep, until } from './remote-hosts-fixtures.mjs';

test('hosts: refresh gives a connected host a fresh hello with its settings now, and leaves one that isn’t alone', async () => {
  const s = setup();
  try {
    assert.equal(await s.mgr.refresh('h1'), false, 'no link yet');
    await s.mgr.ensureWelcome('h1');
    s.hosts.h1.settings = { ...s.hosts.h1.settings, permissionWaitMax: 2 * 3_600_000 };
    assert.equal(await s.mgr.refresh('h1'), true);
    const hellos = s.daemon.received.filter((m) => m.type === 'hello');
    assert.equal(hellos.length, 2);
    assert.equal(hellos[1].settings.permissionWaitMax, 2 * 3_600_000);
    assert.equal(s.mgr.status('h1').state, 'connected');
    // Idle, it isn’t dialed: its next session sends them.
    s.mgr.link('h1').idle();
    await until(() => s.mgr.status('h1').state !== 'connected', 'the session to close');
    const calls = s.ssh.calls.length;
    assert.equal(await s.mgr.refresh('h1'), false);
    assert.equal(s.ssh.calls.length, calls);
  } finally {
    s.done();
  }
});

test('hosts: wake reconnects at once, without waiting out the backoff, and refreshes an idle host’s welcome', async () => {
  const daemon = createFakeDaemon({ autoEnd: false });
  // A minute’s backoff, held by the test clock: only a wake reconnects within the test.
  const s = setup({ daemon, delay: 60_000 });
  try {
    s.mgr.need('h1', 'turn:t1');
    await until(() => s.mgr.status('h1').state === 'connected', 'connected');
    const l = s.mgr.link('h1');
    daemon.drop();
    await until(() => l.state === 'waiting', 'waiting out the backoff');
    await sleep(20);
    assert.equal(s.ssh.calls.length, 1);
    assert.equal(s.mgr.status('h1').state, 'reconnecting');
    s.mgr.wake();
    await until(() => s.ssh.calls.length === 2 && l.connected, 'reconnected on wake');
    // Idle with nothing needed, then a wake: D2, it reconnects on its own, and idles again after the grace.
    s.mgr.release('h1', 'turn:t1');
    s.clock.advance(IDLE_GRACE_MS);
    await until(() => !l.connected, 'idle');
    s.mgr.wake();
    await until(() => s.ssh.calls.length === 3 && l.connected, 'a fresh welcome');
    s.clock.advance(IDLE_GRACE_MS);
    await until(() => !l.connected, 'idle again');
  } finally {
    s.done();
  }
});

test('hosts: wake contacts every configured host with a token, even one not used since Postbox started; one without a token isn’t', async () => {
  // h2 has no token; 'gone' was removed as the list was read.
  const s = setup({ hostIds: () => ['h1', 'h2', 'gone'] });
  try {
    assert.equal(s.ssh.calls.length, 0);
    s.mgr.wake();
    await until(() => s.mgr.status('h1').state === 'connected', 'h1 connected on wake');
    assert.equal(s.ssh.calls.length, 1);
    assert.equal(s.ssh.calls.filter((c) => c.args.some((a) => a === 'other.example.com')).length, 0, 'h2 isn’t installed, so it isn’t dialed');
    assert.equal(s.mgr.status('h2').state, 'not-installed');
    // Nothing needs it: it idles again after the grace.
    s.clock.advance(IDLE_GRACE_MS);
    await until(() => s.mgr.status('h1').state === 'disconnected', 'idle again');
  } finally {
    s.done();
  }
});

test('hosts: a configured host a wake finds signed out stays stopped at the next wake', async () => {
  const ssh = fakeSsh({ script: (child) => child.fail(255, SIGN_IN) });
  const s = setup({ spawn: ssh.spawn, hostIds: () => ['h1', 'h2'] });
  try {
    s.mgr.wake();
    await until(() => s.mgr.status('h1').state === 'failed', 'failed on wake');
    assert.equal(s.mgr.status('h1').failure?.kind, 'sign-in');
    assert.equal(ssh.calls.length, 1);
    s.mgr.wake();
    await sleep(20);
    assert.equal(ssh.calls.length, 1, 'stopped for the person: a wake doesn’t redial');
    assert.equal(s.mgr.status('h1').state, 'failed');
  } finally {
    s.done();
  }
});

test('hosts: a host renamed while nothing needs it drops its old link at once; the next use dials the new destination', async () => {
  const s = setup();
  try {
    await s.mgr.ensureWelcome('h1');
    const old = s.mgr.link('h1');
    s.hosts.h1.name = 'renamed.example.com';
    assert.equal(await s.mgr.refresh('h1'), false, 'no new session to the old destination');
    assert.equal(old.state, 'closed', 'closed at once');
    assert.equal(s.mgr.destinationOf('h1'), null);
    assert.equal(s.ssh.calls.length, 1);
    // The fake daemon is one host for both names: let it hear the old session end, or it answers busy.
    await sleep(20);
    const l = s.mgr.link('h1');
    assert.notEqual(l, old);
    await s.mgr.ensureWelcome('h1');
    assert.equal(s.ssh.calls.length, 2);
    assert.ok(
      s.ssh.calls[1].args.some((a) => a === 'renamed.example.com'),
      'the new destination',
    );
    assert.ok(!s.ssh.calls[1].args.some((a) => a === 'host.example.com'));
    assert.equal(s.mgr.destinationOf('h1'), 'renamed.example.com');
  } finally {
    s.done();
  }
});

test('hosts: a host renamed while needed refuses new sends with host-renamed-busy, keeps the old link for its turn, and drops it once released', async () => {
  const s = setup();
  try {
    s.mgr.need('h1', 'turn:t1');
    await until(() => s.mgr.status('h1').state === 'connected', 'connected');
    const old = s.mgr.link('h1');
    s.hosts.h1.name = 'renamed.example.com';
    assert.throws(
      () => s.mgr.link('h1'),
      (e) => e.code === 'host-renamed-busy' && /renamed\.example\.com/.test(e.message),
    );
    await assert.rejects(s.mgr.ensureWelcome('h1'), (e) => e.code === 'host-renamed-busy');
    assert.equal(await s.mgr.refresh('h1'), false);
    assert.equal(old.connected, true, 'the running turn goes on over the old link');
    assert.equal(s.mgr.destinationOf('h1'), 'host.example.com');
    assert.equal(s.ssh.calls.length, 1);
    s.mgr.release('h1', 'turn:t1');
    assert.equal(old.state, 'closed', 'dropped once nothing needs it, without waiting out the grace');
    await sleep(20); // as above: one fake daemon for both names
    await s.mgr.ensureWelcome('h1');
    assert.equal(s.ssh.calls.length, 2);
    assert.ok(s.ssh.calls[1].args.some((a) => a === 'renamed.example.com'));
  } finally {
    s.done();
  }
});
