// The host daemon (server/remote/host/daemon.mjs, #120): the idle exit, its socket serving a relayed Postbox or a
// turn’s shim, the `host` program (attach, token) with a fake socket, and findPrograms. Fakes from
// tests/remote-daemon-setup.mjs.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXIT, HOST_ENTRY, main } from '../server/remote/host/daemon.mjs';
import { findPrograms, parseVersion } from '../server/remote/host/programs.mjs';
import { encode, hostPaths, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';
import { attachOnce, fakeClock, hello, makeTurn, setup, TOKEN, VERSION, waitFor } from './remote-daemon-setup.mjs';

test('idle: exits after idleTimeout with nobody attached and no turn running, and not before', async () => {
  const clock = fakeClock();
  let idled = 0;
  const s = setup({ clock, onIdle: () => idled++ });
  try {
    await s.daemon.start();
    makeTurn(s.p, 't1', {});
    s.alive.add('t1');
    const idle = s.daemon.settings.idleTimeout;
    await clock.tick(idle);
    assert.equal(idled, 0, 'a turn is running');
    s.alive.delete('t1');
    writeFileSync(s.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
    // Attached, it never idles.
    const c = await hello(s);
    await clock.tick(idle * 3);
    assert.equal(idled, 0, 'Postbox is attached');
    c.input.end();
    await c.msgs.ended;
    await clock.tick(idle - 1);
    assert.equal(idled, 0);
    await clock.tick(1);
    assert.equal(idled, 1);
  } finally {
    s.done();
  }
});

test('the socket: a relayed Postbox is served, and a shim goes to the broker, which refuses a turn it didn’t start', async () => {
  const s = setup();
  try {
    const pair = () => {
      const toDaemon = new PassThrough();
      const fromDaemon = new PassThrough();
      const sock = Duplex.from({ readable: toDaemon, writable: fromDaemon });
      return { sock, toDaemon, msgs: readMessages(fromDaemon), fromDaemon };
    };
    const a = pair();
    s.daemon.accept(/** @type {any} */ (a.sock));
    a.toDaemon.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token: TOKEN })));
    await a.msgs.next('welcome');
    const b = pair();
    s.daemon.accept(/** @type {any} */ (b.sock));
    const got = [];
    b.fromDaemon.on('data', (d) => got.push(String(d)));
    b.toDaemon.write(`${JSON.stringify({ type: 'hello', token: TOKEN, turn: 't1' })}\n`);
    await new Promise((r) => b.fromDaemon.on('end', r));
    assert.match(got.join(''), /"type":"error","code":"no-turn".*There’s no turn t1/);
  } finally {
    s.done();
  }
});

test('host attach refuses root, with a clear message on stderr and a protocol error on stdout', async () => {
  const stdout = new PassThrough();
  const msgs = readMessages(stdout);
  let err = '';
  const code = await main({ argv: ['attach'], getuid: () => 0, stdout, stderr: { write: (s) => (err += s) }, home: '/home/user' });
  assert.equal(code, EXIT.noperm);
  assert.match(err, /doesn’t run as root/);
  assert.equal((await msgs.next('error')).code, 'root');
  assert.equal(await main({ argv: ['nope'], getuid: () => 1000, stderr: { write: () => {} } }), EXIT.usage);
});

test('host attach on a Node older than 22 says no-node, so Postbox can say what to install, and exits 69', async () => {
  const stdout = new PassThrough();
  const msgs = readMessages(stdout);
  let err = '';
  const code = await main({ argv: ['attach'], getuid: () => 1000, stdout, stderr: { write: (s) => (err += s) }, home: '/home/user', nodeVersion: 'v20.1.0' });
  assert.equal(code, EXIT.unavailable);
  assert.match(err, /needs Node 22 or later, and this host’s node is v20\.1\.0/);
  assert.equal((await msgs.next('error')).code, 'no-node');
});

test('host token makes the token with umask 077 if it’s missing and prints it, and prints the same one after', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pbt-'));
  try {
    const masks = [];
    const run = async () => {
      let out = '';
      const code = await main({
        argv: ['token'],
        getuid: () => process.getuid?.() ?? -1,
        stdout: /** @type {any} */ ({ write: (s) => (out += s) }),
        stderr: { write: () => {} },
        home,
        umask: (m) => masks.push(m),
      });
      return { code, out };
    };
    const first = await run();
    assert.equal(first.code, EXIT.ok);
    assert.match(first.out, /^[0-9a-f]{64}\n$/);
    const p = hostPaths(home, VERSION);
    assert.equal(readFileSync(p.token, 'utf8'), first.out.trim());
    assert.equal(statSync(p.token).mode & 0o777, 0o600);
    assert.equal(statSync(p.root).mode & 0o777, 0o700);
    assert.deepEqual(await run(), first);
    assert.deepEqual(masks, [0o077, 0o077]);
    rmSync(p.token);
    symlinkSync('/etc/hosts', p.token);
    const refused = await run();
    assert.equal(refused.code, EXIT.software);
    const m = JSON.parse(refused.out);
    assert.equal(m.code, 'internal');
    assert.match(m.message, /isn’t a file of this user’s/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host attach starts the daemon when none answers, then relays its stdio to the socket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pba-'));
  try {
    const { code, spawned, toDaemon, out } = await attachOnce(home, async () => {});
    assert.equal(code, EXIT.ok);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, [HOST_ENTRY, 'serve']);
    assert.equal(spawned[0].opts.detached, true);
    assert.deepEqual(toDaemon, ['{"type":"hello"}\n']);
    assert.deepEqual(out, ['{"type":"welcome"}\n']);
    const p = hostPaths(home, VERSION);
    await waitFor(() => !existsSync(p.lock)); // dropped without waiting for it
    assert.equal(statSync(dirname(p.lock)).mode & 0o777, 0o700, 'in a 0700 locks folder');
    assert.equal(statSync(`${p.code}/daemon.log`).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host attach waits while an install holds the start lock, making nothing in the version’s folder until it’s dropped', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pba-'));
  try {
    const p = hostPaths(home, VERSION);
    // The install’s lock, outside the version’s folder, which the install may be renaming.
    mkdirSync(p.lock, { recursive: true, mode: 0o700 });
    let waits = 0;
    const { code, spawned } = await attachOnce(home, async () => {
      waits++;
      assert.equal(existsSync(p.code), false, 'no version folder made without the lock');
      if (waits === 3) rmSync(p.lock, { recursive: true });
    });
    assert.equal(code, EXIT.ok);
    assert.equal(waits, 3, 'it waited for the lock, then took it');
    assert.equal(spawned.length, 1);
    await waitFor(() => !existsSync(p.lock));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('findPrograms: configured paths, then the PATH and install folders; versions from --version; problems named', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pbf-'));
  try {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const claude = join(home, '.local', 'bin', 'claude');
    writeFileSync(claude, '#!/bin/sh\n');
    chmodSync(claude, 0o755);
    const calls = [];
    const execFile = (file, args, _opts, cb) => {
      calls.push([file, args]);
      cb(null, '2.1.296 (Claude Code)\n', '');
    };
    const found = await findPrograms({
      home,
      settings: { codexPath: '/opt/none/codex' },
      env: { PATH: '/nonexistent/bin' },
      execFile,
      execPath: '/usr/bin/node',
      nodeVersion: 'v20.1.0',
    });
    const byName = Object.fromEntries(found.harnesses.map((h) => [h.name, h]));
    assert.equal(byName['claude-code'].path, claude);
    assert.equal(byName['claude-code'].version, '2.1.296');
    assert.deepEqual(byName['claude-code'].looked.slice(0, 2), ['/nonexistent/bin/claude', claude], 'PATH first, then ~/.local/bin');
    assert.deepEqual(calls, [[claude, ['--version']]], 'argv only, and only for what was found');
    assert.equal(byName['kiro-cli'].path, null);
    assert.ok(byName['kiro-cli'].looked.includes(`${home}/.local/bin/kiro-cli`));
    assert.ok(byName['kiro-cli'].looked.includes('/usr/local/bin/kiro-cli'));
    assert.deepEqual(byName.codex.looked, ['/opt/none/codex'], 'a configured path is the only one tried');
    assert.deepEqual(
      found.problems.map((p) => p.code),
      ['old-node', 'not-found'],
    );
    assert.equal(parseVersion('codex-cli 0.50.0\n'), '0.50.0');
    assert.equal(parseVersion('kiro-cli 1.2.3-beta.1'), '1.2.3-beta.1');
    assert.equal(parseVersion(''), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
