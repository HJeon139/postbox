// The SSH transport to a remote host (server/remote/ssh.mjs): ssh’s exact arguments, hello and welcome against the
// fake daemon (tests/fake-daemon.mjs), and checks on what Postbox sends. Each failure class from ssh’s recorded or
// documented stderr is in remote-ssh-failures.test.mjs, and the reconnect policy on a fake clock in
// remote-ssh-reconnect.test.mjs. ssh is never run: spawn is a fake child whose stdio is wired to the fake daemon.

import assert from 'node:assert/strict';
import test from 'node:test';
import { helloSettings, remoteCommand, SshFailure, sshArgs } from '../server/remote/ssh.mjs';
import { encode, HOST_ENFORCED, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { checkHostSettings, defaultHostSettings } from '../shared/remote-settings.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { connection, flush, HOST, VERSION } from './remote-ssh-fixtures.mjs';

const COMMAND = '~/.postbox-remote/0.10.0/server/remote/host/host attach';

/** @param {object} [patch] */
const settingsWith = (patch) => {
  const r = checkHostSettings(patch);
  assert.ok(r.ok);
  return r.value;
};

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
  // A process group of its own, so a ProxyCommand ssh starts ends with it.
  assert.deepEqual(ssh.calls[0].options, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
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

test('#120 hello names this Postbox when it has a name, so the host can tell it back from another Postbox', async () => {
  const daemon = createFakeDaemon();
  const ssh = fakeSsh({ daemon });
  const c = connection({ spawn: ssh.spawn, instance: 'f'.repeat(32) });
  await c.connect();
  assert.equal(daemon.received[0].instance, 'f'.repeat(32));
  assert.ok(!ssh.calls[0].args.some((a) => a.includes('f'.repeat(32))), 'on stdin only');
  c.close();
  assert.throws(() => connection({ spawn: ssh.spawn, instance: 'not a name' }), /hello\.instance/);
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
