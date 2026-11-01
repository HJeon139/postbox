// Cleanup on a remote host (server/remote/host/cleanup.mjs, #120), through the daemon: createDaemon in-process over
// PassThrough streams with fake runners (tests/remote-cleanup-setup.mjs), for acks across a restart, the Kiro agent
// file a start writes, and `remove`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MESSAGE_FILE, TURN_FILES } from '../shared/remote-protocol.mjs';
import { daemonSetup, startMsg, until } from './remote-cleanup-setup.mjs';

test('daemon: an ack survives a restart; once the turn has ended and is acked whole its logs go, and welcome and read still answer', async () => {
  const s = daemonSetup();
  try {
    const c = await s.connect();
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    writeFileSync(s.p.turn('t1', TURN_FILES.out), '{"n":1}\n{"n":2}\n');
    c.send('ack', { turn: 't1', upTo: 8 });
    // Until the ack is on disk, not a fixed 30 ms: under load the daemon hadn’t written it yet (gpt’s gate run).
    for (let i = 0; i < 200 && (await s.daemon.cleanup.readAck('t1')) !== 8; i++) await new Promise((r) => setTimeout(r, 10));
    s.daemon.close();
    // A new daemon over the same home: the ack is on disk.
    const t = daemonSetup({ home: s.home });
    for (const x of s.alive) t.alive.add(x);
    try {
      assert.equal(await t.daemon.cleanup.readAck('t1'), 8);
      const d = await t.connect();
      writeFileSync(t.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 5 }));
      t.alive.clear();
      d.send('read', { turn: 't1', from: 8 });
      await d.msgs.next('ended');
      await until(() => !existsSync(t.p.turn('t1', MESSAGE_FILE)), 'the message to go when the turn ended');
      assert.ok(existsSync(t.p.turn('t1', TURN_FILES.out)), 'the logs wait for the ack');
      d.send('ack', { turn: 't1', upTo: 16 });
      d.send('read', { turn: 't1', from: 16 });
      const ended = await d.msgs.next('ended');
      assert.equal(ended.size, 16);
      assert.ok(!existsSync(t.p.turn('t1', TURN_FILES.out)));
      const e = await t.connect();
      assert.deepEqual(
        e.welcome.turns.map((x) => [x.turn, x.state, x.size]),
        [['t1', 'ended', 16]],
        'welcome gives the acked size for a turn whose log went',
      );
    } finally {
      t.daemon.close();
    }
  } finally {
    s.done();
  }
});

test('daemon: start writes start.agentFile into the Kiro home the runner will use: start.env’s, else the host’s own, else ~/.kiro', async () => {
  const s = daemonSetup();
  const t = daemonSetup({ env: {} });
  try {
    const kiro = (turn, agentFile, env = {}) => startMsg(turn, { harness: 'kiro-cli', stdin: 'none', files: [], env, agentFile });
    // No KIRO_HOME anywhere: ~/.kiro/agents, made 0700, the file 0600.
    const c = await t.connect();
    c.send('start', kiro('t1', { name: 'pb-1.json', text: '{"a":1}' }));
    await c.msgs.next('started');
    const plain = join(t.home, '.kiro', 'agents');
    assert.equal(readFileSync(join(plain, 'pb-1.json'), 'utf8'), '{"a":1}');
    assert.equal(statSync(plain).mode & 0o777, 0o700);
    assert.equal(statSync(join(plain, 'pb-1.json')).mode & 0o777, 0o600);
    // The daemon’s own KIRO_HOME, which the runner inherits.
    const own = join(s.home, 'kiro-own');
    s.env.KIRO_HOME = own;
    const d = await s.connect();
    d.send('start', kiro('t1', { name: 'pb-1.json', text: '{}' }));
    await d.msgs.next('started');
    assert.ok(existsSync(join(own, 'agents', 'pb-1.json')));
    // An Isolated persona’s, in start.env, under ~/.postbox-remote.
    const isolated = `${s.p.root}/kiro-home/coder`;
    d.send('start', kiro('t2', { name: 'pb-2.json', text: '{}' }, { KIRO_HOME: isolated }));
    await d.msgs.next('started');
    assert.equal(statSync(join(isolated, 'agents', 'pb-2.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(isolated, 'agents')).mode & 0o777, 0o700);
    assert.ok(!existsSync(join(own, 'agents', 'pb-2.json')));
  } finally {
    s.done();
    t.done();
  }
});

test('daemon: an agent file never replaces one that’s there, and start.env’s KIRO_HOME must resolve under ~/.postbox-remote', async () => {
  const s = daemonSetup();
  const outside = mkdtempSync(join(tmpdir(), 'pb-outside-'));
  try {
    const kiro = (turn, agentFile, env = {}) => startMsg(turn, { harness: 'kiro-cli', stdin: 'none', files: [], env, agentFile });
    const c = await s.connect();
    const agents = join(s.home, '.kiro', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'other.json'), 'theirs');
    // The same name, even with the same text: the start fails, and the file and the folder stay as they were.
    for (const text of ['{}', 'theirs']) {
      c.send('start', kiro('t2', { name: 'other.json', text }));
      const err = await c.msgs.next('error');
      assert.equal(err.code, 'start-failed');
      assert.match(err.message, /already a file at .*other\.json/);
      assert.equal(readFileSync(join(agents, 'other.json'), 'utf8'), 'theirs');
      assert.ok(!existsSync(s.p.turn('t2')));
    }
    // KIRO_HOME outside ~/.postbox-remote: by its path, through a link inside it, the folder itself, or not absolute.
    symlinkSync(outside, join(s.p.root, 'elsewhere'));
    const refused = [join(s.home, '.kiro'), outside, join(s.p.root, 'elsewhere', 'kiro'), s.p.root, 'kiro-home/coder', `${s.p.root}/../kiro`];
    for (const [i, home] of refused.entries()) {
      const turn = `t${i + 3}`;
      c.send('start', kiro(turn, { name: 'pb.json', text: '{}' }, { KIRO_HOME: home }));
      const err = await c.msgs.next('error');
      assert.equal(err.code, 'start-failed', home);
      assert.match(err.message, /KIRO_HOME .* isn’t under .*\.postbox-remote/, home);
      assert.ok(!existsSync(s.p.turn(turn)), 'no turn folder');
    }
    assert.deepEqual(readdirSync(outside), [], 'nothing was written outside');
    assert.ok(!existsSync(join(s.home, '.kiro', 'agents', 'pb.json')));
  } finally {
    s.done();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('daemon: remove stops the running turns, waits for them, deletes ~/.postbox-remote, says removed and exits', async () => {
  let removed = false;
  const s = daemonSetup({ onRemoved: () => (removed = true) });
  try {
    writeFileSync(join(s.home, 'keep.txt'), 'mine');
    const c = await s.connect();
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    c.send('remove', {});
    await c.msgs.next('removed', 5000);
    assert.deepEqual(s.kills[0], [-4001, 'SIGINT'], 'the turn was stopped as Stop does');
    assert.ok(!existsSync(s.p.root));
    assert.ok(existsSync(join(s.home, 'keep.txt')));
    await until(() => removed, 'the daemon to exit');
  } finally {
    s.done();
  }
});

test('daemon: remove refuses while a runner is still alive after Stop: no removed, the root and token stay, and a later remove succeeds', async () => {
  let removed = false;
  const stuck = new Set(['t1']);
  const s = daemonSetup({ onRemoved: () => (removed = true), stuck });
  try {
    const c = await s.connect();
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    c.send('remove', {});
    const err = await c.msgs.next('error', 5000);
    assert.equal(err.re, 'remove');
    assert.match(err.message, /Turn t1 was still running .* after Stop, so nothing was removed/);
    assert.ok(existsSync(s.p.root), 'nothing was removed');
    assert.ok(existsSync(s.p.token), 'the token stays, so Postbox can still reach the host');
    assert.ok(existsSync(s.p.turn('t1', TURN_FILES.runner)), 'the turn’s records stay');
    assert.equal(removed, false);
    assert.ok(!c.msgs.messages.some((m) => m.type === 'removed'), 'no removed was said');
    // Once the runner has gone, removing again works.
    stuck.delete('t1');
    s.alive.delete('t1');
    writeFileSync(s.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: null, signal: 'SIGKILL', at: 10 }));
    c.send('remove', {});
    await c.msgs.next('removed', 5000);
    assert.ok(!existsSync(s.p.root));
    await until(() => removed, 'the daemon to exit');
  } finally {
    s.done();
  }
});

test('daemon: remove waits for a start under way on another connection, then stops its turn and removes everything', async () => {
  let removed = false;
  /** @type {() => void} */
  let open = () => {};
  const launching = new Promise((resolve) => (open = () => resolve(undefined)));
  const s = daemonSetup({ onRemoved: () => (removed = true), launching });
  try {
    const a = await s.connect();
    a.send('start', startMsg('t1'));
    await until(() => existsSync(s.p.turn('t1', TURN_FILES.start)), 'the start to be under way');
    const b = await s.connect();
    b.send('remove', {});
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(s.p.root), 'nothing is removed while the start is under way');
    assert.ok(!b.msgs.messages.some((m) => m.type === 'removed'));
    open();
    await b.msgs.next('removed', 5000);
    assert.ok(
      s.kills.some(([target, signal]) => target < 0 && signal === 'SIGINT'),
      'the turn the start launched was stopped as Stop does',
    );
    assert.equal(s.alive.size, 0, 'no runner is left');
    assert.ok(!existsSync(s.p.root), '~/.postbox-remote is gone');
    await until(() => removed, 'the daemon to exit');
  } finally {
    s.done();
  }
});

test('daemon: remove refuses a ~/.postbox-remote that resolves outside the home folder, and deletes nothing', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'pbo-'));
  const home = mkdtempSync(join(tmpdir(), 'pbd-'));
  try {
    symlinkSync(outside, join(home, '.postbox-remote'));
    const s = daemonSetup({ home });
    const c = await s.connect();
    c.send('remove', {});
    const err = await c.msgs.next('error');
    assert.equal(err.re, 'remove');
    assert.match(err.message, /won’t delete/);
    assert.ok(existsSync(join(outside, 'token')));
    s.daemon.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
