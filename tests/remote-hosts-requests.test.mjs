// What the host manager asks of a host (server/remote/hosts.mjs, #120): the sign-in check (G5), install and forget,
// removing Postbox from the host, and close.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CHECK_WAIT_MS, IDLE_GRACE_MS, REMOVE_CONFIRM_MS } from '../server/remote/hosts.mjs';
import { installCommand, tokenCommand } from '../server/remote/install.mjs';
import { SshFailure } from '../server/remote/ssh.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { SIGN_IN, setup, until, VERSION } from './remote-hosts-fixtures.mjs';

test('hosts: signInCheck is null without a check, and nothing connects', async () => {
  const s = setup();
  try {
    assert.equal(await s.mgr.signInCheck('h1'), null);
    assert.equal(s.ssh.calls.length, 0);
    assert.equal(s.daemon.checks.length, 0);
  } finally {
    s.done();
  }
});

test('hosts: signInCheck runs the host’s check through the daemon: ok when it exits 0, failed with its code otherwise', async () => {
  let code = 0;
  const daemon = createFakeDaemon({ autoEnd: false, check: () => ({ code }) });
  const s = setup({ daemon, settings: { signInCheck: ['klist', '-s'] } });
  try {
    const r = await s.mgr.signInCheck('h1');
    assert.deepEqual(r, { ok: true, code: 0, at: 1_760_000_000_000 });
    assert.deepEqual(daemon.checks, [['klist', '-s']], 'the argv hello sent');
    assert.deepEqual(daemon.received.find((m) => m.type === 'hello').settings.signInCheck, ['klist', '-s']);
    assert.deepEqual(
      daemon.received.find((m) => m.type === 'check'),
      { type: 'check' },
      'the check names no program',
    );
    code = 1;
    assert.deepEqual(await s.mgr.signInCheck('h1'), { ok: false, code: 1, at: 1_760_000_000_000 });
    code = null;
    assert.deepEqual(await s.mgr.signInCheck('h1'), { ok: false, code: null, at: 1_760_000_000_000 });
    assert.equal(s.ssh.calls.length, 1, 'one session for all three');
    // Nothing else needs the host, so it idles after the grace.
    s.clock.advance(IDLE_GRACE_MS);
    await until(() => s.mgr.status('h1').state === 'disconnected', 'idle');
  } finally {
    s.done();
  }
});

test('hosts: callers share a sign-in check under way; one the session’s hello didn’t carry gets a new session', async () => {
  /** @type {(v: { code: number }) => void} */
  let answer = () => {};
  const daemon = createFakeDaemon({ autoEnd: false, check: () => new Promise((r) => (answer = r)) });
  const s = setup({ daemon, settings: { signInCheck: ['klist', '-s'] } });
  try {
    const a = s.mgr.signInCheck('h1');
    const b = s.mgr.signInCheck('h1');
    assert.equal(a, b);
    await until(() => daemon.checks.length === 1, 'the check');
    answer({ code: 0 });
    assert.equal((await a).ok, true);
    // The person changes the check: the open session’s hello has the old one, so a new session carries the new one.
    s.hosts.h1.settings = { ...s.hosts.h1.settings, signInCheck: ['/usr/bin/check-sign-in', '--quiet'] };
    const c = s.mgr.signInCheck('h1');
    await until(() => daemon.checks.length === 2, 'the new check');
    answer({ code: 3 });
    assert.deepEqual(await c, { ok: false, code: 3, at: 1_760_000_000_000 });
    assert.deepEqual(daemon.checks[1], ['/usr/bin/check-sign-in', '--quiet']);
    assert.equal(s.ssh.calls.length, 2);
  } finally {
    s.done();
  }
});

test('hosts: a sign-in check rejects when the session drops before the answer, or none comes in time', async () => {
  const daemon = createFakeDaemon({ autoEnd: false, check: () => new Promise(() => {}) });
  const s = setup({ daemon, settings: { signInCheck: ['klist', '-s'] } });
  try {
    const a = s.mgr.signInCheck('h1');
    await until(() => daemon.checks.length === 1, 'the check');
    daemon.drop();
    await assert.rejects(a, (e) => e instanceof SshFailure);
    const b = s.mgr.signInCheck('h1');
    await until(() => daemon.checks.length === 2, 'the second check');
    s.clock.advance(CHECK_WAIT_MS);
    await assert.rejects(b, /didn’t answer the sign-in check within 60 seconds/);
  } finally {
    s.done();
  }
});

test('hosts: install keeps the token, so the host links and connects; forget closes the link and removes the token', async () => {
  const daemon = createFakeDaemon({ autoEnd: false });
  const attach = fakeSsh({ daemon });
  const scripted = fakeSsh({
    script: (child) => {
      child.stdout.write(child.answer);
      child.exit(0);
    },
  });
  /** @type {import('../server/remote/ssh.mjs').SpawnLike} */
  const spawn = (program, args, options) => {
    const last = args.at(-1);
    if (last !== installCommand(VERSION) && last !== tokenCommand(VERSION)) return attach.spawn(program, args, options);
    const child = scripted.spawn(program, args, options);
    child.answer = last === installCommand(VERSION) ? `installed ${VERSION}\n` : `${FAKE_TOKEN}\n`;
    return child;
  };
  const s = setup({ daemon, spawn, token: '' });
  try {
    assert.equal(s.mgr.status('h1').state, 'not-installed');
    const what = s.mgr.describeInstall('h1');
    assert.equal(what.destination, 'host.example.com');
    assert.match(what.text, /Install Postbox’s host program on host\.example\.com\?/);
    const r = await s.mgr.install('h1');
    assert.deepEqual(r, { token: FAKE_TOKEN, installed: true, version: VERSION });
    assert.equal(s.statuses.at(-1)?.state, 'disconnected', 'installed, and nothing needs it yet');
    const welcome = await s.mgr.ensureWelcome('h1');
    assert.equal(welcome.home, '/home/user');
    const l = s.mgr.link('h1');
    assert.equal(await s.mgr.forget('h1'), true);
    assert.equal(l.state, 'closed');
    assert.equal(existsSync(join(s.dataDir, 'remote-tokens', 'h1')), false);
    assert.equal(s.mgr.status('h1').state, 'not-installed');
    assert.throws(
      () => s.mgr.link('h1'),
      (e) => e.code === 'not-installed',
    );
  } finally {
    s.done();
  }
});

test('hosts: removeFromHost connects, sends remove once and resolves at removed; the token stays until forget', async () => {
  const s = setup();
  try {
    assert.equal(s.mgr.status('h1').state, 'disconnected');
    const a = s.mgr.removeFromHost('h1');
    assert.equal(s.mgr.removeFromHost('h1'), a, 'a second click shares the removal under way');
    await a;
    assert.equal(s.daemon.removes, 1);
    assert.equal(s.daemon.sent.at(-1)?.type, 'removed', 'it resolved on the daemon’s removed');
    assert.equal(existsSync(join(s.dataDir, 'remote-tokens', 'h1')), true, 'removing there leaves the token to forget');
    assert.equal(await s.mgr.forget('h1'), true);
    assert.equal(existsSync(join(s.dataDir, 'remote-tokens', 'h1')), false);
  } finally {
    s.done();
  }
});

test('hosts: removeFromHost rejects, keeping the token, when the daemon refuses, the connection ends first, or no removed comes in time', async () => {
  const token = (s) => existsSync(join(s.dataDir, 'remote-tokens', 'h1'));
  const refuse = setup({ daemon: createFakeDaemon({ autoEnd: false, remove: 'refuse' }) });
  try {
    await assert.rejects(
      refuse.mgr.removeFromHost('h1'),
      (e) =>
        e instanceof SshFailure &&
        /^host\.example\.com didn’t remove Postbox: .*isn’t a folder/.test(e.message) &&
        e.next === 'Fix that on host.example.com, then remove it again.',
    );
    assert.equal(token(refuse), true);
  } finally {
    refuse.done();
  }
  const drop = setup({ daemon: createFakeDaemon({ autoEnd: false, remove: 'drop' }) });
  try {
    await assert.rejects(
      drop.mgr.removeFromHost('h1'),
      (e) =>
        e instanceof SshFailure &&
        e.message === 'The connection to host.example.com closed before it confirmed that Postbox was removed.' &&
        e.next === 'Remove it again once host.example.com is back.',
    );
    assert.equal(token(drop), true);
  } finally {
    drop.done();
  }
  const silent = setup({ daemon: createFakeDaemon({ autoEnd: false, remove: 'silent' }) });
  try {
    const p = silent.mgr.removeFromHost('h1');
    await until(() => silent.daemon.removes === 1, 'the remove');
    silent.clock.advance(REMOVE_CONFIRM_MS);
    await assert.rejects(p, (e) => e instanceof SshFailure && e.message === 'host.example.com didn’t confirm within 45 seconds that Postbox was removed.');
    assert.equal(token(silent), true);
  } finally {
    silent.done();
  }
});

test('hosts: removeFromHost says what to do when the host can’t be reached, and rejects as link() does for one with no token here', async () => {
  const ssh = fakeSsh({ script: (child) => child.fail(255, SIGN_IN) });
  const s = setup({ spawn: ssh.spawn });
  try {
    await assert.rejects(
      s.mgr.removeFromHost('h1'),
      (e) => e instanceof SshFailure && e.kind === 'sign-in' && /^Sign in to host\.example\.com in a terminal.* Then remove it again\.$/.test(e.next),
    );
    await assert.rejects(s.mgr.removeFromHost('h2'), (e) => e.code === 'not-installed');
    assert.equal(ssh.calls.length, 1, 'nothing dialed the host with no token');
    await assert.rejects(s.mgr.removeFromHost('nope'), (e) => e.code === 'no-host');
  } finally {
    s.done();
  }
});

test('hosts: close closes every link; turns go on on the host', async () => {
  const s = setup();
  try {
    await s.mgr.ensureWelcome('h1');
    const l = s.mgr.link('h1');
    s.mgr.close();
    assert.equal(l.state, 'closed');
    assert.throws(() => s.mgr.link('h1'), /closed/);
    assert.deepEqual(s.daemon.stops, [], 'no Stop was sent');
  } finally {
    s.done();
  }
});
