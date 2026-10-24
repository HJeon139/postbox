// The host manager (server/remote/hosts.mjs, #120): a link per host with the token install.mjs keeps, each host’s
// status, the reasons that keep it connected, reconnecting on wake (D2) and the sign-in check (G5). ssh is never run:
// tests/fake-ssh.mjs’s spawn wires each session to tests/fake-daemon.mjs, and a scripted ssh plays failures and
// installs. Tokens live in a temp data folder, as install.mjs writes them.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CHECK_WAIT_MS, createHostManager, HEARD_EVERY_MS, IDLE_GRACE_MS } from '../server/remote/hosts.mjs';
import { installCommand, tokenCommand } from '../server/remote/install.mjs';
import { SshFailure } from '../server/remote/ssh.mjs';
import { defaultHostSettings } from '../shared/remote-settings.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';

const VERSION = '0.10.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}.`);
    await sleep(2);
  }
}

/**
 * A clock for the manager: now() is the test’s, and timers of a second or more (the idle grace, the status throttle,
 * the check’s wait, ssh’s welcome timeout) wait for advance(); shorter ones (the 5 ms backoff) run for real.
 */
function testClock() {
  let t = 1_760_000_000_000;
  /** @type {{ at: number, fn: () => void, real?: any }[]} */
  const held = [];
  return {
    now: () => t,
    setTimer(fn, ms) {
      if (ms < 1000) return { real: setTimeout(fn, ms) };
      const h = { at: t + ms, fn };
      held.push(h);
      return h;
    },
    clearTimer(h) {
      if (h?.real) return clearTimeout(h.real);
      const i = held.indexOf(h);
      if (i !== -1) held.splice(i, 1);
    },
    held,
    advance(ms) {
      t += ms;
      for (;;) {
        const due = held.filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        held.splice(held.indexOf(due), 1);
        due.fn();
      }
    },
  };
}

/**
 * A manager over a temp data folder, with hosts h1 (installed: its token is written) and h2 (not), and a fake ssh to
 * a fake daemon. o.settings: h1’s settings over the defaults; o.spawn replaces the fake ssh; o.delay is the backoff;
 * o.hostIds lists the configured hosts (none by default).
 */
function setup({ daemon = createFakeDaemon({ autoEnd: false }), settings = {}, spawn = undefined, token = FAKE_TOKEN, delay = 5, hostIds = undefined } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pbh-'));
  const hosts = {
    h1: { id: 'h1', name: 'host.example.com', settings: { ...defaultHostSettings(), ...settings }, createdAt: 1 },
    h2: { id: 'h2', name: 'other.example.com', settings: defaultHostSettings(), createdAt: 1 },
  };
  if (token) {
    mkdirSync(join(dataDir, 'remote-tokens'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'remote-tokens', 'h1'), `${token}\n`, { mode: 0o600 });
  }
  const ssh = fakeSsh({ daemon });
  const clock = testClock();
  const mgr = createHostManager({
    getHost: (id) => hosts[id] ?? null,
    dataDir,
    version: VERSION,
    spawn: spawn ?? ssh.spawn,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    delay: () => delay,
    ...(hostIds ? { hostIds } : {}),
  });
  /** @type {{ id: string, state: string, lastHeard: number | null }[]} */
  const statuses = [];
  mgr.on('status', (id, s) => statuses.push({ id, state: s.state, lastHeard: s.lastHeard }));
  const done = () => {
    mgr.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { mgr, hosts, dataDir, daemon, ssh, clock, statuses, done };
}

const SIGN_IN = 'user@host.example.com: Permission denied (publickey).\r\n'; // tests/fixtures/ssh/failures.json

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
    assert.equal(s.ssh.calls.filter((c) => c.args.includes('other.example.com')).length, 0, 'h2 isn’t installed, so it isn’t dialed');
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
    assert.ok(s.ssh.calls[1].args.includes('renamed.example.com'), 'the new destination');
    assert.ok(!s.ssh.calls[1].args.includes('host.example.com'));
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
    assert.ok(s.ssh.calls[1].args.includes('renamed.example.com'));
  } finally {
    s.done();
  }
});

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
