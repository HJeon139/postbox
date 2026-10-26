// The host daemon (server/remote/host/daemon.mjs, #120), driven in-process: Postbox’s side is a pair of PassThrough
// streams speaking shared/remote-protocol.mjs, the home folder is a temp folder, and H1’s runner and process checks
// (launchRunner, askRunner, sameProcess) are fakes, so nothing is spawned or signaled. The fake runner writes the
// runner.json a real one would; a test plays the harness by appending to out.jsonl and writing exit.json.
//
// This file is the handshake, the token, one writer and the lingering warning. The rest are by concern, with what they
// share in tests/remote-daemon-setup.mjs: -turns (start, read, scan and write), -stop, -locks (the start lock and
// daemon.pid), -host (idle, the socket, the `host` program and findPrograms) and -check (the sign-in check).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createSshConnection } from '../server/remote/ssh.mjs';
import { encode, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { defaultHostSettings } from '../shared/remote-settings.mjs';
import { readMessages } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { hello, PROGRAMS_FOUND, setup, startMsg, TOKEN, VERSION } from './remote-daemon-setup.mjs';

test('hello: a wrong version or token is refused, nothing is served before hello, and a good one is welcomed', async () => {
  const s = setup();
  try {
    const c = s.connect();
    c.send('read', { turn: 't1', from: 0 });
    const notReady = await c.msgs.next('error');
    assert.equal(notReady.code, 'not-ready');
    c.send('hello', { version: PROTOCOL_VERSION + 1, token: TOKEN });
    assert.equal((await c.msgs.next('error')).code, 'version');
    c.send('hello', { version: PROTOCOL_VERSION, token: 'b'.repeat(64) });
    const bad = await c.msgs.next('error');
    assert.equal(bad.code, 'bad-token');
    assert.equal(bad.re, 'hello');
    // A token of another length is refused too (the comparison pads nothing).
    c.send('hello', { version: PROTOCOL_VERSION, token: TOKEN.slice(0, 40) });
    assert.equal((await c.msgs.next('error')).code, 'bad-token');
    c.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, settings: { idleTimeout: 120_000 } });
    const w = await c.msgs.next('welcome');
    assert.equal(w.home, s.home);
    assert.deepEqual(
      w.harnesses.map((h) => [h.name, h.path, h.version]),
      PROGRAMS_FOUND.harnesses.map((h) => [h.name, h.path, h.version]),
    );
    assert.deepEqual(w.node, PROGRAMS_FOUND.node);
    assert.deepEqual(w.turns, []);
    assert.equal(s.daemon.settings.idleTimeout, 120_000, 'a setting hello sends applies');
    assert.equal(s.daemon.settings.logRetention, 7 * 24 * 3600 * 1000, 'one it doesn’t send is HOST_DEFAULTS’');
    // A line that isn’t a message is refused, and the channel carries on.
    c.input.write('{"type":"nope"}\n');
    assert.equal((await c.msgs.next('error')).code, 'bad-message');
  } finally {
    s.done();
  }
});

test('handshake: a version 1 Postbox’s hello is refused with `version` before any turn starts, and ssh.mjs calls it kind version', async () => {
  const s = setup();
  try {
    let daemonSaid;
    // ssh.mjs’s own connection, through a fake ssh to this daemon, with its hello changed to the version a wave 2
    // Postbox sends, and a start straight after it, as a peer that took the hello for granted would.
    const bridge = {
      connect() {
        const stdin = new PassThrough();
        const input = new PassThrough();
        const stdout = new PassThrough();
        stdout.on('error', () => {});
        // The daemon’s own output, read here and passed on to ssh.mjs: the fake ssh ends its stdout once ssh.mjs
        // kills it on the refusal, and what the daemon says after that should still be seen.
        const output = new PassThrough();
        output.pipe(stdout);
        s.daemon.connect({ input, output });
        daemonSaid = readMessages(output);
        stdin.once('data', (b) => {
          const hello = JSON.parse(String(b));
          assert.equal(hello.version, PROTOCOL_VERSION);
          input.write(`${JSON.stringify({ ...hello, version: 1 })}\n`);
          input.write(encode(message('postbox-to-daemon', 'start', startMsg('t1'))));
        });
        return { stdin, stdout };
      },
    };
    const conn = createSshConnection({
      destination: 'host.example.com',
      settings: defaultHostSettings(),
      version: VERSION,
      token: TOKEN,
      spawn: fakeSsh({ daemon: /** @type {any} */ (bridge) }).spawn,
    });
    const f = await conn.connect().then(
      () => assert.fail('a version 1 hello was welcomed'),
      (e) => e,
    );
    assert.equal(f.kind, 'version');
    assert.equal(f.retry, false);
    assert.match(f.message, new RegExp(`speaks protocol ${PROTOCOL_VERSION}, and Postbox sent 1`));
    const refused = await daemonSaid.next('error');
    assert.deepEqual([refused.code, refused.re], ['version', 'hello']);
    assert.equal((await daemonSaid.next('error')).code, 'not-ready', 'the start after it is refused');
    assert.ok(!daemonSaid.messages.some((m) => m.type === 'welcome' || m.type === 'started'));
    assert.deepEqual(s.launches, [], 'no runner was launched');
    assert.ok(!existsSync(s.p.turn('t1')), 'no turn folder was made');
  } finally {
    s.done();
  }
});

test('start() makes a missing token: 32 random bytes as hex, 0600, in a 0700 folder', async () => {
  const s = setup({ token: null });
  try {
    await s.daemon.start();
    const token = readFileSync(s.p.token, 'utf8');
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(s.p.token).mode & 0o777, 0o600);
    assert.equal(statSync(s.p.root).mode & 0o777, 0o700);
    // It isn’t replaced on the next start.
    await s.daemon.start();
    assert.equal(readFileSync(s.p.token, 'utf8'), token);
    const c = s.connect();
    c.send('hello', { version: PROTOCOL_VERSION, token });
    await c.msgs.next('welcome');
  } finally {
    s.done();
  }
});

test('start() sets an existing token that others can read back to 0600, and keeps it', async () => {
  const s = setup();
  try {
    chmodSync(s.p.token, 0o644);
    await s.daemon.start();
    assert.equal(statSync(s.p.token).mode & 0o777, 0o600);
    assert.equal(readFileSync(s.p.token, 'utf8'), TOKEN);
  } finally {
    s.done();
  }
});

test('start() refuses a token that isn’t a regular file of this user’s, and says how to fix it', async () => {
  const other = setup({ uid: (process.getuid?.() ?? 0) + 1 });
  try {
    await assert.rejects(other.daemon.start(), /token isn’t a file of this user’s \(it’s owned by user \d+\).*Remove it and reinstall Postbox/);
    assert.equal(statSync(other.p.token).mode & 0o777, 0o600, 'nothing was changed');
  } finally {
    other.done();
  }
  const link = setup();
  try {
    const real = join(link.home, 'elsewhere');
    writeFileSync(real, TOKEN, { mode: 0o600 });
    rmSync(link.p.token);
    symlinkSync(real, link.p.token);
    await assert.rejects(link.daemon.start(), /it isn’t a regular file\).*Remove it and reinstall Postbox/);
  } finally {
    link.done();
  }
});

test('one writer: a second Postbox is busy unless it takes over, and the one it replaces is told and closed', async () => {
  const s = setup();
  try {
    const a = await hello(s);
    const b = s.connect();
    b.send('hello', { version: PROTOCOL_VERSION, token: TOKEN });
    assert.equal((await b.msgs.next('error')).code, 'busy');
    b.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, takeover: true });
    await b.msgs.next('welcome');
    assert.equal((await a.msgs.next('error')).code, 'taken-over');
    await a.msgs.ended;
    // The new driver is served; a third connection is busy again.
    const c = s.connect();
    c.send('hello', { version: PROTOCOL_VERSION, token: TOKEN });
    assert.equal((await c.msgs.next('error')).code, 'busy');
  } finally {
    s.done();
  }
});

test('#120 the same Postbox back after its ssh died replaces its own connection without takeover; another is still busy', async () => {
  const s = setup();
  try {
    const ME = 'a'.repeat(32);
    // Its old connection is still open here: the host hasn’t noticed the ssh behind it died.
    const old = await hello(s, { instance: ME });
    for (const extra of [{ instance: 'b'.repeat(32) }, {}]) {
      const other = s.connect();
      other.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, ...extra });
      assert.equal((await other.msgs.next('error')).code, 'busy', `busy for ${JSON.stringify(extra)}`);
    }
    await hello(s, { instance: ME });
    await old.msgs.ended;
    assert.ok(!old.msgs.messages.some((m) => m.type === 'error'), 'the old connection isn’t told it was taken over');
    // The new one drives now: another Postbox is still busy.
    const third = s.connect();
    third.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, instance: 'c'.repeat(32) });
    assert.equal((await third.msgs.next('error')).code, 'busy');
  } finally {
    s.done();
  }
});

test('the first welcome warns that turns end at logout where logind kills them and lingering is off', async () => {
  const s = setup();
  try {
    // KillUserProcesses on and lingering off: a turn’s scope would end at the last logout, so the first welcome says
    // so, before any turn has run.
    s.state.logind = { killUserProcesses: true, linger: false };
    const first = await hello(s);
    assert.deepEqual(
      first.welcome.problems.map((p) => p.code),
      ['no-linger'],
    );
    assert.equal(s.launches.length, 0);
    // Lingering turned on: the next hello asks again, and the warning goes.
    s.state.logind = { killUserProcesses: true, linger: true };
    assert.deepEqual((await hello(s, { takeover: true })).welcome.problems, []);
  } finally {
    s.done();
  }
});

test('no lingering warning where logind leaves processes at logout, says nothing, or detach is setsid', async () => {
  const s = setup();
  try {
    const problems = async (extra = {}) => (await hello(s, { takeover: true, ...extra })).welcome.problems.map((p) => p.code);
    // KillUserProcesses off: runners aren’t scoped, and a probe saw turns survive a logout with lingering off.
    s.state.logind = { killUserProcesses: false, linger: false };
    assert.deepEqual(await problems(), []);
    // logind doesn’t say (no systemd, a command that failed).
    s.state.logind = { killUserProcesses: null, linger: false };
    assert.deepEqual(await problems(), []);
    // detach setsid never uses a scope, so logind isn’t asked.
    s.state.logind = { killUserProcesses: true, linger: false };
    const asks = s.state.logindAsks;
    assert.deepEqual(await problems({ settings: { detach: 'setsid' } }), []);
    assert.equal(s.state.logindAsks, asks);
  } finally {
    s.done();
  }
});
