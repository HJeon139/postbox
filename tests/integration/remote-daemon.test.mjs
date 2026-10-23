// The host daemon (server/remote/host/daemon.mjs, #120), for real: in-process with its own runner functions driving
// the real runner.mjs on a stand-in harness (tests/fixtures/remote/harness.mjs), and `host serve` as a process, in a
// temp POSTBOX_REMOTE_HOME (tests/integration/host.mjs). The daemon’s protocol, with fake runners, is unit-tested in
// tests/remote-daemon.test.mjs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { test } from 'node:test';
import { HOST_ENTRY } from '../../server/remote/host/daemon.mjs';
import { bootId, startTime } from '../../server/remote/host/proc.mjs';
import { gone, HARNESS, makeHost, NO_UNIX, read, realDaemon, sleep, TURN, until } from './host.mjs';

test('daemon and runner: start, held-stdin writes, the liveness check and Stop, over runner.mjs’s own socket', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const d = realDaemon(h);
  try {
    await d.daemon.start();
    const c = d.connect();
    await c.msgs.next('welcome', 5000);
    c.send('start', { turn: TURN, harness: 'codex', folder: h.work, argv: [HARNESS, 'out:ready', 'stdin', 'out:closed'], env: {}, stdin: 'held', files: [] });
    // Sent straight after start, as the remote process does: the daemon answers start once the runner is up.
    c.send('write', { turn: TURN, line: '{"id":1}' });
    c.send('write', { turn: TURN, line: 'two' });
    assert.deepEqual(await c.msgs.next('started', 10_000), { type: 'started', turn: TURN });
    const written = [await c.msgs.next('written', 10_000), await c.msgs.next('written', 10_000)];
    assert.deepEqual(
      written.map((m) => m.upTo),
      [9, 13],
      'each write reached the runner, which said in.jsonl’s size',
    );
    c.send('read', { turn: TURN, from: 0 });
    const lines = [];
    while (lines.length < 3) lines.push((await c.msgs.next('line', 10_000)).text);
    assert.deepEqual(lines, ['ready', 'got:{"id":1}', 'got:two']);
    const e = d.connect();
    const welcome = await e.msgs.next('welcome', 5000);
    assert.deepEqual(
      welcome.turns.map((t) => [t.turn, t.state]),
      [[TURN, 'running']],
      'the welcome’s scan found the runner alive through askRunner and the token',
    );
    e.send('read', { turn: TURN, from: 0 });
    e.send('stop', { turn: TURN });
    const ended = await e.msgs.next('ended', 15_000);
    assert.equal(ended.exit?.signal, 'SIGINT', 'Stop signaled the runner’s group once sameProcess matched runner.json');
    assert.deepEqual(
      [...c.msgs.messages, ...e.msgs.messages].filter((m) => m.type === 'error' && m.code !== 'taken-over'),
      [],
      'nothing was refused on either side',
    );
    assert.equal(read(h.p.turn(TURN, 'in.jsonl')), '{"id":1}\ntwo\n');
  } finally {
    d.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('stop: a tool shell in a session of its own goes too, when the harness ignores SIGINT', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const d = realDaemon(h, { stopGraceMs: 300 });
  let shell = 0;
  try {
    await d.daemon.start();
    const c = d.connect();
    await c.msgs.next('welcome', 5000);
    const argv = [HARNESS, 'ignore-sigint', 'tool-shell', 'sleep:30000'];
    c.send('start', { turn: TURN, harness: 'claude-code', folder: h.work, argv, env: {}, stdin: 'none', files: [] });
    await c.msgs.next('started', 10_000);
    c.send('read', { turn: TURN, from: 0 });
    shell = Number(/^shell:(\d+)$/.exec((await c.msgs.next('line', 10_000)).text)?.[1]);
    assert.ok(shell > 1 && !gone(shell), 'the tool shell is running');
    c.send('stop', { turn: TURN });
    const ended = await c.msgs.next('ended', 10_000);
    assert.equal(ended.exit?.signal, 'SIGKILL', 'the harness ignored SIGINT, so the grace period ended in SIGKILL');
    await until(() => gone(shell), 'the tool shell to go', 3000);
  } finally {
    d.close();
    if (shell && !gone(shell)) process.kill(-shell, 'SIGKILL');
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('stop: a tool shell the harness leaves behind when SIGINT ends it goes too, after the grace period', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const d = realDaemon(h, { stopGraceMs: 300 });
  let shell = 0;
  try {
    await d.daemon.start();
    const c = d.connect();
    await c.msgs.next('welcome', 5000);
    const argv = [HARNESS, 'tool-shell', 'sleep:30000'];
    c.send('start', { turn: TURN, harness: 'claude-code', folder: h.work, argv, env: {}, stdin: 'none', files: [] });
    await c.msgs.next('started', 10_000);
    c.send('read', { turn: TURN, from: 0 });
    shell = Number(/^shell:(\d+)$/.exec((await c.msgs.next('line', 10_000)).text)?.[1]);
    assert.ok(shell > 1 && !gone(shell), 'the tool shell is running');
    c.send('stop', { turn: TURN });
    const ended = await c.msgs.next('ended', 10_000);
    assert.equal(ended.exit?.signal, 'SIGINT', 'the harness ended on SIGINT, within the grace period');
    await until(() => gone(shell), 'the tool shell it left to go', 3000);
  } finally {
    d.close();
    if (shell && !gone(shell)) process.kill(-shell, 'SIGKILL');
    rmSync(h.home, { recursive: true, force: true });
  }
});

// ── host serve and daemon.pid ──

/** `host serve` as attach starts it, with its stderr kept. */
function serve(h) {
  const child = spawn(process.execPath, [HOST_ENTRY, 'serve'], { env: h.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (b) => (err += b));
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    exited,
    get err() {
      return err;
    },
    /** Its exit code within ms, or `running` (and it’s killed). */
    async within(ms) {
      const t = await Promise.race([exited, sleep(ms).then(() => 'running')]);
      if (t === 'running') child.kill('SIGKILL');
      return t;
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}
const NOT_ROOT = process.getuid?.() === 0 && 'root can connect to a socket whatever its mode';
const lockFile = (h) => `${h.p.code}/daemon.pid`;
/** Whether a daemon answers on the socket. @param {string} path @returns {Promise<boolean>} */
const answers = (path) =>
  new Promise((resolve) => {
    const sock = connect(path);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
/**
 * A host home with the version’s folder made, as the install leaves it (main() makes it too, before serve), so a test
 * can put daemon.pid or a socket there first.
 */
function makeServeHost() {
  const h = makeHost();
  mkdirSync(h.p.code, { recursive: true, mode: 0o700 });
  return h;
}

test('serve: while daemon.pid names a live process, it exits and leaves the socket file alone', { skip: NO_UNIX }, async () => {
  const h = makeServeHost();
  // This test’s own process stands in for a daemon that’s still starting: its lock is taken, its socket not yet bound.
  writeFileSync(lockFile(h), JSON.stringify({ pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) }));
  writeFileSync(h.p.socket, 'not yet a socket');
  const s = serve(h);
  try {
    assert.equal(await s.within(5000), 0, s.err);
    assert.match(s.err, /already serves this version/);
    assert.equal(readFileSync(h.p.socket, 'utf8'), 'not yet a socket', 'the socket file wasn’t removed');
    assert.equal(JSON.parse(readFileSync(lockFile(h), 'utf8')).pid, process.pid, 'nor was the lock');
  } finally {
    s.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('serve: a connection error other than nothing listening isn’t taken for no daemon', { skip: NO_UNIX || NOT_ROOT }, async () => {
  const h = makeServeHost();
  const listener = createServer();
  await new Promise((resolve) => listener.listen(h.p.socket, () => resolve(undefined)));
  chmodSync(h.p.socket, 0); // connecting now fails with EACCES, not ECONNREFUSED
  const s = serve(h);
  try {
    assert.equal(await s.within(5000), 69, s.err);
    assert.match(s.err, /Couldn’t tell whether a daemon serves .*EACCES.*left as it is/);
    assert.ok(lstatSync(h.p.socket).isSocket(), 'the socket is still there');
    assert.equal(existsSync(lockFile(h)), false, 'and serve let go of daemon.pid');
  } finally {
    s.stop();
    await new Promise((resolve) => listener.close(() => resolve(undefined)));
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('serve: a dead daemon’s daemon.pid is replaced; SIGTERM removes it and the socket', { skip: NO_UNIX }, async () => {
  const h = makeServeHost();
  writeFileSync(lockFile(h), JSON.stringify({ pid: 2 ** 22 + 1, bootId: bootId(), startTime: 1 }));
  const s = serve(h);
  try {
    await until(() => answers(h.p.socket), 'the daemon to answer', 5000);
    assert.equal(JSON.parse(readFileSync(lockFile(h), 'utf8')).pid, s.child.pid);
    assert.equal(lstatSync(lockFile(h)).mode & 0o777, 0o600);
    s.child.kill('SIGTERM');
    assert.equal(await s.within(5000), 0, s.err);
    assert.equal(existsSync(lockFile(h)), false);
    assert.equal(existsSync(h.p.socket), false);
  } finally {
    s.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('serve: four started at once make one daemon, and the others exit 0', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const all = [serve(h), serve(h), serve(h), serve(h)];
  try {
    await until(() => answers(h.p.socket), 'a daemon to answer', 5000);
    const codes = await Promise.all(all.map((s) => s.within(1500)));
    assert.deepEqual([...codes].sort(), [0, 0, 0, 'running'], all.map((s) => s.err).join('\n'));
    const left = all[codes.indexOf('running')];
    assert.equal(JSON.parse(readFileSync(lockFile(h), 'utf8')).pid, left.child.pid, 'the one still running holds daemon.pid');
  } finally {
    for (const s of all) s.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
});
