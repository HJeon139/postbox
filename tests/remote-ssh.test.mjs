// The SSH transport to a remote host (server/remote/ssh.mjs): ssh’s exact arguments, hello and welcome against the
// fake daemon (tests/fake-daemon.mjs), checks on what Postbox sends, each failure class from ssh’s recorded or
// documented stderr (tests/fixtures/ssh/failures.json), and the reconnect policy on a fake clock. ssh is never run:
// spawn is a fake child whose stdio is wired to the fake daemon.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  BACKOFF,
  backoffDelay,
  classifyExit,
  createReconnector,
  createSshConnection,
  FAILURE_KINDS,
  helloSettings,
  remoteCommand,
  retries,
  SshFailure,
  sshArgs,
} from '../server/remote/ssh.mjs';
import { encode, HOST_ENFORCED, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { checkHostSettings, defaultHostSettings } from '../shared/remote-settings.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/ssh/failures.json', import.meta.url), 'utf8')).failures;
const HOST = 'host.example.com';
const VERSION = '0.10.0';
const COMMAND = '~/.postbox-remote/0.10.0/server/remote/host/host attach';
const flush = () => new Promise((r) => setImmediate(r));

/** @param {object} [patch] */
const settingsWith = (patch) => {
  const r = checkHostSettings(patch);
  assert.ok(r.ok);
  return r.value;
};

/** A fake clock: timers run only when a test fires them. */
function fakeClock() {
  /** @type {{ fn: () => void, ms: number, cleared: boolean }[]} */
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    /** Runs the pending timers, oldest first, and says which waits they had. */
    fire() {
      const due = timers.filter((t) => !t.cleared);
      for (const t of due) t.cleared = true;
      for (const t of due) t.fn();
      return due.map((t) => t.ms);
    },
    pending: () => timers.filter((t) => !t.cleared).map((t) => t.ms),
  };
}

const connection = (o) => createSshConnection({ destination: HOST, settings: defaultHostSettings(), version: VERSION, token: FAKE_TOKEN, ...o });

// ── ssh’s arguments ─────────────────────────────────────────────────────────────────

test('ssh gets the design’s fixed options, --, the destination and the fixed command, by default', () => {
  assert.deepEqual(sshArgs({ destination: HOST, settings: defaultHostSettings(), version: VERSION }), [
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlPath=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-T',
    '--',
    HOST,
    COMMAND,
  ]);
});

test('dedicatedConnection off keeps the person’s ControlPath, and forwardAgent and keepAlive come from settings', () => {
  const args = sshArgs({
    destination: 'user@host.example.com',
    settings: settingsWith({ dedicatedConnection: false, forwardAgent: true, keepAlive: { interval: 30_000, count: 5 } }),
    version: VERSION,
  });
  assert.deepEqual(args, [
    '-o',
    'BatchMode=yes',
    '-o',
    'ForwardAgent=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=5',
    '-T',
    '--',
    'user@host.example.com',
    COMMAND,
  ]);
  assert.ok(!args.some((a) => a.startsWith('ControlPath')));
});

test('a destination ssh could read as an option, or a shell could split, never reaches ssh', () => {
  for (const destination of ['-oProxyCommand=touch /tmp/x', ' -p 2222', '--', 'host.example.com; rm -rf ~', 'host example', '']) {
    assert.throws(() => sshArgs({ destination, settings: defaultHostSettings(), version: VERSION }), TypeError, destination);
    const ssh = fakeSsh();
    assert.throws(() => connection({ destination, spawn: ssh.spawn }), TypeError);
    assert.equal(ssh.calls.length, 0, `${destination} spawned ssh`);
  }
});

test('the remote command is built only from a version Postbox installs', () => {
  assert.equal(remoteCommand('0.10.0'), COMMAND);
  assert.equal(remoteCommand('1.2.3-rc.1'), '~/.postbox-remote/1.2.3-rc.1/server/remote/host/host attach');
  for (const v of ['0.10.0; rm -rf ~', '$(id)', '../0.9.0', '0.10.0 attach', '', '`id`']) assert.throws(() => remoteCommand(v), TypeError, v);
});

test('settings ssh can’t take are refused before anything starts', () => {
  const bad = { ...defaultHostSettings(), keepAlive: { interval: 1500, count: 3 } };
  assert.throws(() => sshArgs({ destination: HOST, settings: bad, version: VERSION }), /whole seconds/);
});

// ── hello, welcome and messages ─────────────────────────────────────────────────────

test('connect starts ssh with pipes, sends hello with the token and the host-enforced settings, and resolves with the welcome', async () => {
  const daemon = createFakeDaemon();
  const ssh = fakeSsh({ daemon });
  const settings = settingsWith({ permissionWaitMax: 60 * 60 * 1000, claudePath: '/opt/claude/bin/claude', forwardAgent: true });
  const c = connection({ spawn: ssh.spawn, settings });
  const welcome = await c.connect();
  assert.equal(c.state, 'open');
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.home, '/home/user');
  assert.equal(ssh.calls.length, 1);
  assert.equal(ssh.calls[0].program, 'ssh');
  assert.deepEqual(ssh.calls[0].args, c.args);
  assert.deepEqual(ssh.calls[0].options, { stdio: ['pipe', 'pipe', 'pipe'] });
  const hello = daemon.received[0];
  assert.equal(hello.type, 'hello');
  assert.equal(hello.version, PROTOCOL_VERSION);
  assert.equal(hello.token, FAKE_TOKEN);
  assert.equal(hello.takeover, undefined);
  assert.deepEqual(Object.keys(hello.settings).sort(), [...HOST_ENFORCED].sort());
  assert.equal(hello.settings.permissionWaitMax, 60 * 60 * 1000);
  assert.equal(hello.settings.claudePath, '/opt/claude/bin/claude');
  assert.deepEqual(helloSettings(settings), hello.settings);
  // The token goes on stdin only.
  assert.ok(!ssh.calls[0].args.some((a) => a.includes(FAKE_TOKEN)));
  c.close();
});

test('messages after the welcome are emitted, validated; send checks each message before it crosses', async () => {
  const daemon = createFakeDaemon();
  daemon.addTurn('turn-1', { lines: ['{"type":"system"}', '{"type":"result"}'], exit: { code: 0, signal: null } });
  const ssh = fakeSsh({ daemon });
  const c = connection({ spawn: ssh.spawn });
  assert.throws(() => c.send({ type: 'read', turn: 'turn-1', from: 0 }), /isn’t open/);
  await c.connect();
  const got = [];
  const ended = new Promise((resolve) =>
    c.on('message', (m) => {
      got.push(m);
      if (m.type === 'ended') resolve(undefined);
    }),
  );
  c.send({ type: 'read', turn: 'turn-1', from: 0 });
  await ended;
  assert.deepEqual(
    got.map((m) => m.type),
    ['line', 'line', 'caught-up', 'ended'],
  );
  assert.deepEqual(
    got.slice(0, 2).map((m) => [m.offset, m.next, m.text]),
    [
      [0, 18, '{"type":"system"}'],
      [18, 36, '{"type":"result"}'],
    ],
  );

  const before = daemon.received.length;
  assert.throws(() => c.send({ type: 'read', turn: 'turn-1' }), TypeError);
  assert.throws(() => c.send({ type: 'read', turn: '../x', from: 0 }), TypeError);
  assert.throws(() => c.send({ type: 'launch', turn: 'turn-1' }), TypeError);
  assert.throws(() => c.send({ type: 'hello', version: PROTOCOL_VERSION, token: FAKE_TOKEN }), /hello itself/);
  await flush();
  assert.equal(daemon.received.length, before, 'a refused message reached the daemon');
  assert.equal(daemon.errors.length, 0);
  c.close();
});

test('a line from the daemon that isn’t a valid message is reported and skipped', async () => {
  const ssh = fakeSsh({
    script(child) {
      child.stdout.write(
        encode(
          message('daemon-to-postbox', 'welcome', {
            version: PROTOCOL_VERSION,
            home: '/home/user',
            node: { path: '/usr/bin/node', version: 'v22.12.0' },
            harnesses: [],
            problems: [],
            turns: [],
          }),
        ),
      );
      child.stdout.write('{"type":"line","turn":"t"}\nnot json\n');
      child.stdout.write(encode(message('daemon-to-postbox', 'started', { turn: 't1' })));
    },
  });
  const c = connection({ spawn: ssh.spawn });
  const bad = [];
  c.on('bad-line', (e) => bad.push(e.code));
  const messages = [];
  const started = new Promise((resolve) =>
    c.on('message', (m) => {
      messages.push(m.type);
      resolve(undefined);
    }),
  );
  await c.connect();
  await started;
  assert.deepEqual(bad, ['bad-message', 'bad-json']);
  assert.deepEqual(messages, ['started']);
  c.close();
});

test('takeover replaces the other Postbox; without it, a second Postbox is told the host is busy and isn’t retried', async () => {
  const daemon = createFakeDaemon();
  const ssh = fakeSsh({ daemon });
  const first = connection({ spawn: ssh.spawn });
  await first.connect();
  const busy = await connection({ spawn: ssh.spawn })
    .connect()
    .then(
      () => null,
      (e) => e,
    );
  assert.ok(busy instanceof SshFailure);
  assert.equal(busy.kind, 'busy');
  assert.equal(busy.retry, false);
  assert.match(busy.next, /^Take over host\.example\.com/);

  const told = [];
  first.on('message', (m) => told.push(m.code));
  const closed = new Promise((resolve) => first.on('close', resolve));
  const second = connection({ spawn: ssh.spawn, takeover: true });
  await second.connect();
  assert.equal(daemon.received.at(-1).takeover, true);
  assert.deepEqual(told, ['taken-over']);
  const why = await closed;
  assert.equal(why.kind, 'ended');
  second.close();
});

test('a token the daemon refuses, and a daemon of another protocol version, are their own failures', async () => {
  const ssh = fakeSsh({ daemon: createFakeDaemon({ token: 'another-token-0123456789abcdefghijklmn' }) });
  const bad = await connection({ spawn: ssh.spawn })
    .connect()
    .catch((e) => e);
  assert.equal(bad.kind, 'bad-token');
  assert.match(bad.next, /^Reinstall Postbox on host\.example\.com/);
  assert.deepEqual(ssh.children[0].kills, ['SIGTERM']);

  const old = fakeSsh({
    script: (child) =>
      child.stdout.write(encode(message('daemon-to-postbox', 'error', { code: 'version', message: 'This host’s daemon speaks protocol 2.', re: 'hello' }))),
  });
  const v = await connection({ spawn: old.spawn })
    .connect()
    .catch((e) => e);
  assert.equal(v.kind, 'version');
  assert.equal(v.retry, false);
  assert.match(v.message, /protocol 2/);
  assert.match(v.next, /^Install this Postbox’s version on host\.example\.com/);
});

test('a host with no Node 22 or later is its own failure, with what to install, and isn’t retried on its own', async () => {
  // As the `host` launcher (server/remote/host/host) says it: one error line, then exit 69.
  const said = 'Postbox’s host program needs Node 22 or later, and found none on this host. It looked in: PATH (/usr/bin:/bin).';
  const ssh = fakeSsh({
    script(child) {
      child.stdout.write(encode(message('daemon-to-postbox', 'error', { code: 'no-node', message: said })));
      setImmediate(() => child.exit(69));
    },
  });
  const e = await connection({ spawn: ssh.spawn })
    .connect()
    .catch((x) => x);
  assert.ok(e instanceof SshFailure);
  assert.equal(e.kind, 'no-node');
  assert.equal(e.retry, false);
  assert.ok(e.message.includes(said));
  assert.equal(e.next, 'Install Node 22 or later on host.example.com, or set its Node path in Postbox’s host settings, then reconnect.');
});

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

// ── Reconnecting ────────────────────────────────────────────────────────────────────

test('backoff doubles from 1 s to a 60 s cap, and jitter only shortens a wait', () => {
  const none = [0, 1, 2, 3, 4, 5, 6, 7, 20, 1000].map((n) => backoffDelay(n, { random: () => 0 }));
  assert.deepEqual(none, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
  const most = [0, 3, 10].map((n) => backoffDelay(n, { random: () => 1 }));
  assert.deepEqual(most, [500, 4000, 30_000]);
  assert.deepEqual(BACKOFF, { base: 1000, factor: 2, max: 60_000, jitter: 0.5 });
});

/** A reconnector over fake ssh children that a test scripts one by one. */
function reconnectRig({ needed = () => true } = {}) {
  const clock = fakeClock();
  const daemon = createFakeDaemon();
  /** @type {((child: any) => void)[]} what each next ssh does: undefined connects to the daemon */
  const plan = [];
  const spawned = [];
  const spawn = (program, args, options) => {
    const step = plan.shift();
    const ssh = step ? fakeSsh({ script: step }) : fakeSsh({ daemon });
    const child = ssh.spawn(program, args, options);
    spawned.push(child);
    return child;
  };
  const r = createReconnector({
    open: () => connection({ spawn }),
    needed,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    delay: (n) => backoffDelay(n, { random: () => 0 }),
  });
  const states = [];
  r.on('state', (s) => states.push(s));
  const failures = [];
  r.on('failure', (f) => failures.push(f.kind));
  return { r, clock, daemon, plan, spawned, states, failures };
}
const unreachable = (child) => child.fail(255, 'ssh: connect to host host.example.com port 22: Connection refused\r\n');
const signIn = (child) => child.fail(255, 'user@host.example.com: Permission denied (publickey).\r\n');

test('reconnect backs off while needed, resets after it connects, and reconnects after a drop', async () => {
  const { r, clock, daemon, plan, spawned, states } = reconnectRig();
  plan.push(unreachable, unreachable, unreachable);
  r.need();
  await flush();
  await flush();
  assert.equal(r.state, 'waiting');
  assert.deepEqual(clock.fire(), [1000]);
  await flush();
  await flush();
  assert.deepEqual(clock.fire(), [2000]);
  await flush();
  await flush();
  assert.deepEqual(clock.pending(), [4000]);
  assert.equal(r.failure.kind, 'unreachable');
  clock.fire();
  await flush();
  await flush();
  assert.equal(r.state, 'open');
  assert.equal(r.failure, null);
  assert.equal(spawned.length, 4);
  assert.ok(r.connection);
  // A drop starts again from the first step.
  daemon.drop();
  await flush();
  await flush();
  assert.equal(r.state, 'waiting');
  assert.deepEqual(clock.pending(), [1000]);
  assert.deepEqual(states.slice(0, 3), ['connecting', 'waiting', 'connecting']);
  r.dispose();
});

test('reconnect stops when nothing needs the host', async () => {
  let needed = true;
  const { r, clock, plan, spawned } = reconnectRig({ needed: () => needed });
  plan.push(unreachable);
  r.need();
  await flush();
  await flush();
  assert.equal(r.state, 'waiting');
  needed = false;
  clock.fire();
  await flush();
  assert.equal(r.state, 'idle');
  assert.equal(spawned.length, 1);
  assert.deepEqual(clock.pending(), []);
});

test('a sign-in, host-key, install or version failure isn’t retried, not even on wake; retry, when the person asks, is', async () => {
  const { r, clock, plan, spawned, failures } = reconnectRig();
  plan.push(signIn);
  r.need();
  await flush();
  await flush();
  assert.equal(r.state, 'stopped');
  assert.deepEqual(clock.pending(), []);
  assert.deepEqual(failures, ['sign-in']);
  r.wake();
  r.need();
  await flush();
  assert.equal(spawned.length, 1);
  r.retry();
  await flush();
  await flush();
  assert.equal(r.state, 'open');
  assert.equal(spawned.length, 2);
  r.dispose();
});

test('the laptop’s wake reconnects at once and starts the backoff over', async () => {
  const { r, clock, plan, spawned } = reconnectRig();
  plan.push(unreachable, unreachable, unreachable);
  r.need();
  await flush();
  await flush();
  clock.fire();
  await flush();
  await flush();
  assert.deepEqual(clock.pending(), [2000]);
  r.wake();
  await flush();
  await flush();
  assert.equal(spawned.length, 3);
  assert.deepEqual(clock.pending(), [1000]);
  r.wake();
  await flush();
  await flush();
  assert.equal(r.state, 'open');
  r.dispose();
  await flush();
  assert.equal(r.state, 'idle');
  assert.deepEqual(spawned.at(-1).kills, ['SIGTERM']);
});
