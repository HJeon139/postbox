// The host daemon (server/remote/host/daemon.mjs, #120), driven in-process: Postbox’s side is a pair of PassThrough
// streams speaking shared/remote-protocol.mjs, the home folder is a temp folder, and H1’s runner and process checks
// (launchRunner, askRunner, sameProcess) are fakes, so nothing is spawned or signaled. The fake runner writes the
// runner.json a real one would; a test plays the harness by appending to out.jsonl and writing exit.json.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';
import { LOCK_FRESH_MS } from '../server/remote/host/cleanup.mjs';
import { createDaemon, EXIT, HOST_ENTRY, LOCK_STALE_MS, main, SERVE_START_MS, takeDaemonLock } from '../server/remote/host/daemon.mjs';
import { hostVersion } from '../server/remote/host/paths.mjs';
import { findPrograms, parseVersion } from '../server/remote/host/programs.mjs';
import { createSshConnection } from '../server/remote/ssh.mjs';
import { encode, hostPaths, MESSAGE_FILE, message, PROTOCOL_VERSION, REMOTE_LIMITS, TURN_FILES, validateStartRecord } from '../shared/remote-protocol.mjs';
import { defaultHostSettings } from '../shared/remote-settings.mjs';
import { readMessages } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';

const TOKEN = 'a'.repeat(64);
const BOOT = '0f1e2d3c-4b5a-4968-8776-655443322110';
// This checkout’s version, which main() takes from package.json (paths.mjs), so the tests follow each release.
const VERSION = hostVersion();
const PROGRAMS_FOUND = {
  node: { path: '/usr/bin/node', version: 'v22.12.0' },
  harnesses: [
    { name: 'claude-code', path: '/home/user/.local/bin/claude', version: '2.1.296', looked: ['/home/user/.local/bin/claude'] },
    { name: 'kiro-cli', path: null, version: null, looked: ['/home/user/.local/bin/kiro-cli', '/usr/local/bin/kiro-cli'] },
    { name: 'codex', path: '/home/user/.local/bin/codex', version: '0.50.0', looked: ['/home/user/.local/bin/codex'] },
  ],
  problems: [],
};

/** A fake clock: now() and timers that run only when tick() passes them. */
function fakeClock(t0 = 1_760_000_000_000) {
  let t = t0;
  /** @type {{ at: number, fn: () => any }[]} */
  const queue = [];
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) {
        const h = { at: t + ms, fn };
        queue.push(h);
        return h;
      },
      clearTimeout(h) {
        const i = queue.indexOf(h);
        if (i !== -1) queue.splice(i, 1);
      },
    },
    queue,
    async tick(ms) {
      t += ms;
      for (;;) {
        const due = queue.filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        queue.splice(queue.indexOf(due), 1);
        await due.fn();
      }
    },
  };
}

/**
 * A daemon over a temp home, with fake runners.
 * @param {{ token?: string | null, same?: boolean, clock?: ReturnType<typeof fakeClock>, onIdle?: () => void, settings?: object, uid?: number }} [o]
 */
function setup({ token = TOKEN, same = true, clock, onIdle, uid } = {}) {
  // A short folder name: a turn’s socket path must fit Linux’s 108 bytes, and macOS’s tmpdir is long.
  const home = mkdtempSync(join(tmpdir(), 'pbd-'));
  const p = hostPaths(home, VERSION);
  if (token) {
    mkdirSync(p.root, { recursive: true, mode: 0o700 });
    writeFileSync(p.token, token, { mode: 0o600 });
  }
  const alive = new Set();
  const launches = [];
  const kills = [];
  const writes = [];
  let pid = 4000;
  const asks = [];
  /** What the fake launchRunner reports: runner.mjs’s scoped and lingerOff. */
  /**
   * What the fake proc reports: toolGroups’ answers, one per call (null: the processes can’t be listed), and the
   * groups liveGroups finds gone.
   * @type {{ same: boolean, scoped: boolean, lingerOff: boolean, refuse: string, groups: any[][] | null, goneGroups: number[] }}
   */
  const state = { same, scoped: false, lingerOff: false, refuse: '', groups: [], goneGroups: [] };
  const groupLookups = [];
  const daemon = createDaemon({
    home,
    version: VERSION,
    ...(clock ? { now: clock.now, timers: clock.timers } : {}),
    async launchRunner(o) {
      launches.push(o);
      if (state.refuse) {
        // As runner.mjs refuses a turn: the reason in err.log, no runner.json, and it exits.
        writeFileSync(o.paths.turn(o.turn, TURN_FILES.err), `postbox runner: ${state.refuse}\n`, { mode: 0o600 });
        return { pid: ++pid, scoped: false, lingerOff: false };
      }
      const record = { turn: o.turn, version: VERSION, pid: ++pid, bootId: BOOT, startTime: 1234 };
      writeFileSync(o.paths.turn(o.turn, TURN_FILES.runner), JSON.stringify(record), { mode: 0o600 });
      alive.add(o.turn);
      return { pid, scoped: state.scoped, lingerOff: state.lingerOff };
    },
    askRunner: async (path, turn, o) => {
      asks.push({ path, turn, ...o });
      return alive.has(turn);
    },
    proc: {
      sameProcess: async () => state.same,
      toolGroups: (pgid) => {
        groupLookups.push(pgid);
        return state.groups === null ? null : (state.groups.shift() ?? []);
      },
      liveGroups: (groups) => groups.filter((g) => !state.goneGroups.includes(g.pgid)),
    },
    async writeRunner(o) {
      writes.push(o);
      return 42;
    },
    findPrograms: async () => structuredClone(PROGRAMS_FOUND),
    kill: (pid, signal) => kills.push([pid, signal]),
    log: () => {},
    onIdle,
    pollMs: 10,
    stopGraceMs: 5000,
    ...(uid === undefined ? {} : { uid }),
  });
  const connect = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    daemon.connect({ input, output });
    const msgs = readMessages(output);
    const send = (type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
    return { input, output, msgs, send };
  };
  const done = () => {
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { home, p, daemon, alive, launches, kills, writes, asks, connect, done, state, groupLookups };
}

/** A connection that has said hello. */
async function hello(s, extra = {}) {
  const c = s.connect();
  c.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, ...extra });
  const welcome = await c.msgs.next('welcome');
  return { ...c, welcome };
}

/** A turn folder as a runner leaves it. @param {{ out?: string, exit?: object | null, start?: boolean, harness?: string }} [o] */
function makeTurn(p, turn, { out = '', exit = null, start = true, harness = 'claude-code' } = {}) {
  mkdirSync(p.turn(turn), { recursive: true, mode: 0o700 });
  if (start)
    writeFileSync(
      p.turn(turn, TURN_FILES.start),
      JSON.stringify({ turn, harness, program: '/home/user/.local/bin/claude', argv: ['-p'], env: {}, stdin: 'file', folder: '/home/user/work' }),
    );
  writeFileSync(p.turn(turn, TURN_FILES.runner), JSON.stringify({ turn, version: VERSION, pid: 777, bootId: BOOT, startTime: 99 }));
  writeFileSync(p.turn(turn, TURN_FILES.out), out);
  if (exit) writeFileSync(p.turn(turn, TURN_FILES.exit), JSON.stringify(exit));
}

/** Every `line` a connection gets for a turn until its `ended`. */
async function linesUntilEnded(msgs, timeoutMs = 2000) {
  const ended = await msgs.next('ended', timeoutMs);
  return { lines: msgs.messages.filter((m) => m.type === 'line'), ended };
}

const startMsg = (turn, over = {}) => ({
  turn,
  harness: 'claude-code',
  folder: '/tmp',
  argv: ['-p', '--output-format', 'stream-json'],
  env: { CLAUDE_CODE_ENTRYPOINT: 'postbox' },
  stdin: 'file',
  files: [{ name: MESSAGE_FILE, text: '{"type":"user"}\n' }],
  ...over,
});

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

test('takeDaemonLock: daemon.pid is taken once; a live holder’s is kept, and a dead one’s or a garbled one is replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbl-'));
  try {
    const file = join(dir, 'daemon.pid');
    const live = new Set();
    const proc = { bootId: () => BOOT, startTime: () => 55, sameProcess: (r) => live.has(r.pid) };
    const a = takeDaemonLock(dir, proc);
    assert.equal(a.held, true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { pid: process.pid, bootId: BOOT, startTime: 55 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    live.add(process.pid);
    const b = takeDaemonLock(dir, proc);
    assert.equal(b.held, false);
    assert.equal(b.held === false && b.code, EXIT.ok);
    assert.match(b.held === false ? b.why : '', /already serves this version/);
    if (a.held) a.release();
    assert.throws(() => statSync(file), /ENOENT/, 'release removes it');

    for (const stale of [JSON.stringify({ pid: 999_999, bootId: BOOT, startTime: 1 }), '{"pid":']) {
      writeFileSync(file, stale);
      const c = takeDaemonLock(dir, proc);
      assert.equal(c.held, true, stale);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
      // Another serve’s by the time this one releases: it stays.
      writeFileSync(file, stale);
      if (c.held) c.release();
      assert.equal(readFileSync(file, 'utf8'), stale);
    }
    assert.deepEqual(readdirSync(dir), ['daemon.pid'], 'no temporary file or break lock is left');
    assert.equal(takeDaemonLock(dir, { ...proc, startTime: () => null }).held, false, 'no start time, no lock it could check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test('start writes the turn folder (0700) and its files (0600), start.json, then launches the runner', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    // A snapshot sent before start is kept for the turn, and lands in its folder.
    c.send('snapshot', { turn: 't1', home: 'th_home', threads: [{ id: 'th_home', items: [] }] });
    c.send('start', startMsg('t1'));
    assert.deepEqual(await c.msgs.next('started'), { type: 'started', turn: 't1' });
    const dir = s.p.turn('t1');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(s.p.turns).mode & 0o777, 0o700);
    for (const f of [MESSAGE_FILE, TURN_FILES.start, TURN_FILES.snapshot]) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
    assert.equal(readFileSync(join(dir, MESSAGE_FILE), 'utf8'), '{"type":"user"}\n');
    const record = JSON.parse(readFileSync(join(dir, TURN_FILES.start), 'utf8'));
    assert.ok(validateStartRecord(record).ok);
    assert.equal(record.program, '/home/user/.local/bin/claude', 'the program the daemon found, not one Postbox names');
    assert.deepEqual(record.argv, startMsg('t1').argv);
    assert.equal(JSON.parse(readFileSync(join(dir, TURN_FILES.snapshot), 'utf8')).home, 'th_home');
    assert.equal(s.launches.length, 1);
    assert.equal(s.launches[0].node, '/usr/bin/node');
    assert.equal(s.launches[0].turn, 't1');
    assert.equal(s.launches[0].scope, 'auto');
    // The same turn again, and a harness the host lacks, are refused.
    c.send('start', startMsg('t1'));
    assert.equal((await c.msgs.next('error')).code, 'turn-exists');
    c.send('start', startMsg('t2', { harness: 'kiro-cli', stdin: 'none', files: [] }));
    const none = await c.msgs.next('error');
    assert.equal(none.code, 'no-harness');
    assert.equal(none.turn, 't2');
    // A project folder that doesn’t exist is refused, not made.
    c.send('start', startMsg('t3', { folder: join(s.home, 'nowhere') }));
    assert.equal((await c.msgs.next('error')).code, 'start-failed');
  } finally {
    s.done();
  }
});

test('start warns that turns end at logout only when the runner is scoped and lingering is off', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    const problems = async () => (await hello(s, { takeover: true })).welcome.problems.map((p) => p.code);
    // Not scoped (KillUserProcesses off, or detach setsid): turns survive a logout whatever lingering says.
    s.state.lingerOff = true;
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    assert.deepEqual(await problems(), []);
    // Scoped, with lingering on: the scope outlives the last logout.
    s.state.scoped = true;
    s.state.lingerOff = false;
    const d = await hello(s, { takeover: true });
    d.send('start', startMsg('t2'));
    await d.msgs.next('started');
    assert.deepEqual(await problems(), []);
    // Scoped, with lingering off: the scope ends at the last logout, so the welcome says so.
    s.state.lingerOff = true;
    const e = await hello(s, { takeover: true });
    e.send('start', startMsg('t3'));
    await e.msgs.next('started');
    assert.deepEqual(await problems(), ['no-linger']);
  } finally {
    s.done();
  }
});

test('start sends started only once the runner answers, and fails with the runner’s reason when it refuses', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    s.state.refuse = 'The work folder /tmp/gone isn’t there.';
    c.send('start', startMsg('t1'));
    const e = await c.msgs.next('error');
    assert.equal(e.code, 'start-failed');
    assert.equal(e.turn, 't1');
    assert.match(e.message, /runner didn’t start: The work folder \/tmp\/gone isn’t there\./);
    assert.equal(c.msgs.messages.filter((m) => m.type === 'started').length, 0);
    s.state.refuse = '';
    c.send('start', startMsg('t2'));
    await c.msgs.next('started');
    assert.ok(
      s.asks.some((a) => a.turn === 't2'),
      'started came after the runner answered who',
    );
  } finally {
    s.done();
  }
});

test('the liveness check asks the runner with the token from the daemon’s own home', async () => {
  const s = setup();
  try {
    makeTurn(s.p, 't1');
    s.alive.add('t1');
    const c = await hello(s);
    assert.equal(c.welcome.turns[0].state, 'running');
    const ask = s.asks.find((a) => a.turn === 't1');
    assert.equal(ask?.token, TOKEN);
    assert.equal(ask?.path, s.p.turn('t1', TURN_FILES.socket));
  } finally {
    s.done();
  }
});

test('read sends lines with exact byte offsets from 0 and from a line in the middle, then ended', async () => {
  const s = setup();
  try {
    // Multi-byte text, so a character count would be wrong; the last line has no \n.
    const lines = ['{"a":"héllo"}', '{"b":"日本"}', '{"c":"😀"}'];
    const out = `${lines[0]}\n${lines[1]}\n${lines[2]}`;
    makeTurn(s.p, 't1', { out, exit: { code: 0, signal: null, at: 1 } });
    const c = await hello(s);
    assert.deepEqual(
      c.welcome.turns.map((t) => [t.turn, t.state]),
      [['t1', 'ended']],
    );
    c.send('read', { turn: 't1', from: 0 });
    const { lines: got, ended } = await linesUntilEnded(c.msgs);
    const b = (t) => Buffer.byteLength(t);
    const o1 = b(lines[0]) + 1;
    const o2 = o1 + b(lines[1]) + 1;
    assert.deepEqual(
      got.map((m) => [m.offset, m.next, m.text]),
      [
        [0, o1, lines[0]],
        [o1, o2, lines[1]],
        [o2, b(out), lines[2]],
      ],
    );
    assert.deepEqual(ended, { type: 'ended', turn: 't1', exit: { code: 0, signal: null, at: 1 }, size: b(out) });

    const d = s.connect();
    d.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, takeover: true });
    await d.msgs.next('welcome');
    d.send('read', { turn: 't1', from: o1 });
    const mid = await linesUntilEnded(d.msgs);
    assert.deepEqual(
      mid.lines.map((m) => m.offset),
      [o1, o2],
    );
    // An offset inside a line, or past the end, is refused.
    d.send('read', { turn: 't1', from: o1 + 1 });
    assert.equal((await d.msgs.next('error')).code, 'bad-offset');
    d.send('read', { turn: 't1', from: b(out) + 5 });
    assert.equal((await d.msgs.next('error')).code, 'bad-offset');
    d.send('read', { turn: 'nope', from: 0 });
    assert.equal((await d.msgs.next('error')).code, 'no-turn');
  } finally {
    s.done();
  }
});

test('read follows a running turn: appended lines arrive, a last line without \\n waits for the end, then ended', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    const out = s.p.turn('t1', TURN_FILES.out);
    await writeFile(out, '{"n":1}\n');
    c.send('read', { turn: 't1', from: 0 });
    assert.deepEqual(await c.msgs.next('line'), { type: 'line', turn: 't1', offset: 0, next: 8, text: '{"n":1}' });
    await appendFile(out, '{"n":2}\n{"n"');
    assert.deepEqual(await c.msgs.next('line'), { type: 'line', turn: 't1', offset: 8, next: 16, text: '{"n":2}' });
    await appendFile(out, ':3}');
    await writeFile(s.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 5 }));
    assert.deepEqual(await c.msgs.next('line'), { type: 'line', turn: 't1', offset: 16, next: 23, text: '{"n":3}' });
    assert.deepEqual(await c.msgs.next('ended'), { type: 'ended', turn: 't1', exit: { code: 0, signal: null, at: 5 }, size: 23 });
    // Acks up to the end are recorded; past it they’re refused.
    c.send('ack', { turn: 't1', upTo: 16 });
    c.send('ack', { turn: 't1', upTo: 99 });
    assert.equal((await c.msgs.next('error')).code, 'bad-offset');
    assert.equal(s.daemon.acked.get('t1'), 16);
  } finally {
    s.done();
  }
});

test('a line over the stream limit is sent cut, with its offsets, and the stream moves on', async () => {
  const s = setup();
  try {
    const long = 'x'.repeat(REMOTE_LIMITS.streamLineBytes + 1);
    makeTurn(s.p, 't1', { out: `${long}\n{"ok":1}\n`, exit: { code: 0, signal: null, at: 1 } });
    const c = await hello(s);
    c.send('read', { turn: 't1', from: 0 });
    const { lines } = await linesUntilEnded(c.msgs, 5000);
    assert.deepEqual(
      lines.map((m) => [m.offset, m.next, m.text, m.cut]),
      [
        [0, long.length + 1, '', true],
        [long.length + 1, long.length + 10, '{"ok":1}', undefined],
      ],
    );
  } finally {
    s.done();
  }
});

test('a turn with no exit.json and no live runner reads as interrupted: ended with exit null', async () => {
  const s = setup();
  try {
    makeTurn(s.p, 't1', { out: '{"n":1}\n' });
    const c = await hello(s);
    assert.equal(c.welcome.turns[0].state, 'interrupted');
    c.send('read', { turn: 't1', from: 0 });
    const { lines, ended } = await linesUntilEnded(c.msgs);
    assert.equal(lines.length, 1);
    assert.deepEqual(ended, { type: 'ended', turn: 't1', exit: null, size: 8 });
  } finally {
    s.done();
  }
});

test('stop: SIGINT to the group, then SIGKILL after the grace period, while runner.json still matches', async () => {
  const clock = fakeClock();
  const s = setup({ clock });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    const pid = JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.runner), 'utf8')).pid;
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    assert.deepEqual(s.kills, [[-pid, 'SIGINT']]);
    // The harness ignores it: at the grace period, SIGKILL, and the daemon records how it ended.
    s.alive.delete('t1');
    await clock.tick(5000);
    assert.deepEqual(s.kills, [
      [-pid, 'SIGINT'],
      [-pid, 'SIGKILL'],
    ]);
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit.signal, 'SIGKILL');
  } finally {
    s.done();
  }
});

test('stop: no SIGKILL once the harness has exited after SIGINT', async () => {
  const clock = fakeClock();
  const s = setup({ clock });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    c.send('read', { turn: 't1', from: 0 });
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    await writeFile(s.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: null, signal: 'SIGINT', at: 9 }));
    const ended = await c.msgs.next('ended');
    assert.deepEqual(ended.exit, { code: null, signal: 'SIGINT', at: 9 });
    await clock.tick(5000);
    assert.equal(s.kills.length, 1);
    assert.equal(c.msgs.messages.filter((m) => m.type === 'ended').length, 1, 'ended once per read');
  } finally {
    s.done();
  }
});

test('stop never signals when runner.json no longer names the runner: the turn is interrupted', async () => {
  const clock = fakeClock();
  const s = setup({ clock, same: false });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    c.send('stop', { turn: 't1' });
    const ended = await c.msgs.next('ended');
    assert.equal(ended.exit, null);
    await clock.tick(60_000);
    assert.deepEqual(s.kills, []);
  } finally {
    s.done();
  }
});

test('stop: the SIGKILL also goes to each tool shell’s group recorded at SIGINT or at SIGKILL, while it’s still there', async () => {
  const clock = fakeClock();
  const s = setup({ clock });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    const pid = JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.runner), 'utf8')).pid;
    // At SIGINT, one tool shell; at SIGKILL, it and two more, one of which has gone by the time it would be signaled.
    const shell = (pgid) => ({ pgid, members: [{ pid: pgid, startTime: 1 }] });
    s.state.groups = [[shell(7001)], [shell(7001), shell(7002), shell(7003)]];
    s.state.goneGroups = [7003];
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    assert.deepEqual(s.groupLookups, [pid], 'the groups were recorded before the SIGINT, while their parent was alive');
    assert.deepEqual(s.kills, [[-pid, 'SIGINT']], 'SIGINT goes to the turn’s group only: Claude Code stops its own shells');
    s.alive.delete('t1');
    await clock.tick(5000);
    assert.deepEqual(s.groupLookups, [pid, pid]);
    assert.deepEqual(s.kills, [
      [-pid, 'SIGINT'],
      [-7001, 'SIGKILL'],
      [-7002, 'SIGKILL'],
      [-pid, 'SIGKILL'],
    ]);
    assert.equal((await c.msgs.next('ended')).exit.signal, 'SIGKILL');
  } finally {
    s.done();
  }
});

test('stop: when the host’s processes can’t be listed, the SIGKILL still reaches the turn’s group', async () => {
  const clock = fakeClock();
  const s = setup({ clock });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    const pid = JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.runner), 'utf8')).pid;
    s.state.groups = null;
    c.send('stop', { turn: 't1' });
    await waitFor(() => s.kills.length === 1);
    s.alive.delete('t1');
    await clock.tick(5000);
    assert.deepEqual(s.kills, [
      [-pid, 'SIGINT'],
      [-pid, 'SIGKILL'],
    ]);
  } finally {
    s.done();
  }
});

test('scan classifies turn folders: a live runner is running, exit.json is ended, neither is interrupted', async () => {
  const s = setup();
  try {
    makeTurn(s.p, 'run', { out: '{"a":1}\n' });
    makeTurn(s.p, 'done', { out: '{"a":1}\n{"b":2}\n', exit: { code: 1, signal: null, at: 3 }, harness: 'codex' });
    makeTurn(s.p, 'lost', {});
    makeTurn(s.p, 'stray', { start: false });
    s.alive.add('run');
    const turns = (await s.daemon.scan()).sort((a, b) => a.turn.localeCompare(b.turn));
    assert.deepEqual(turns, [
      { turn: 'done', harness: 'codex', state: 'ended', size: 16, exit: { code: 1, signal: null, at: 3 } },
      { turn: 'lost', harness: 'claude-code', state: 'interrupted', size: 0, exit: null },
      { turn: 'run', harness: 'claude-code', state: 'running', size: 8, exit: null },
    ]);
    // The welcome carries the same.
    const c = await hello(s);
    assert.equal(c.welcome.turns.length, 3);
  } finally {
    s.done();
  }
});

test('write forwards a line to a held stdin’s runner, and refuses a turn whose stdin isn’t held', async () => {
  const s = setup();
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1', { harness: 'codex', stdin: 'held', files: [] }));
    await c.msgs.next('started');
    c.send('write', { turn: 't1', line: '{"id":1}' });
    assert.deepEqual(await c.msgs.next('written'), { type: 'written', turn: 't1', upTo: 42 });
    assert.equal(s.writes[0].line, '{"id":1}');
    assert.equal(s.writes[0].token, TOKEN);
    assert.equal(s.writes[0].socketPath, s.p.turn('t1', TURN_FILES.socket));
    c.send('start', startMsg('t2'));
    await c.msgs.next('started');
    c.send('write', { turn: 't2', line: 'x' });
    assert.equal((await c.msgs.next('error')).code, 'not-held');
  } finally {
    s.done();
  }
});

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

/**
 * Runs `host attach` with a fake socket that answers once something is spawned, through one hello and welcome.
 * @param {string} home @param {(ms: number) => Promise<void>} sleep @param {object} [opts]  more of main’s options
 */
async function attachOnce(home, sleep, opts = {}) {
  let served = false;
  const spawned = [];
  const toDaemon = [];
  const fromDaemon = new PassThrough();
  const connect = () => {
    const sock = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        toDaemon.push(String(chunk));
        cb();
      },
    });
    process.nextTick(() => {
      if (!served) return sock.emit('error', Object.assign(new Error('no socket'), { code: 'ENOENT' }));
      fromDaemon.on('data', (d) => sock.push(d));
      fromDaemon.on('end', () => {
        sock.push(null);
        sock.destroy();
      });
      sock.emit('connect');
    });
    return /** @type {any} */ (sock);
  };
  const spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    served = true;
    return { on() {}, unref() {} };
  };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out = [];
  stdout.on('data', (d) => out.push(String(d)));
  const running = main({ argv: ['attach'], getuid: () => 1000, stdin, stdout, stderr: { write: () => {} }, home, connect, spawn, sleep, ...opts });
  stdin.write('{"type":"hello"}\n');
  await waitFor(() => toDaemon.length > 0);
  fromDaemon.write('{"type":"welcome"}\n');
  await waitFor(() => out.length > 0);
  fromDaemon.end();
  return { code: await running, spawned, toDaemon, out };
}

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

test('host attach judges the start lock by its owner: a live one is waited for however old, a dead or garbled one or one long without a record is broken', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pba-'));
  try {
    const p = hostPaths(home, VERSION);
    // Every lock looks long past LOCK_STALE_MS to this clock; only PID 4242 is alive, as its record says.
    let clock = Date.now() + 10 * LOCK_STALE_MS;
    const proc = { bootId: () => BOOT, startTime: () => 5, sameProcess: (r) => r.pid === 4242 && r.bootId === BOOT && r.startTime === 5 };
    /** A lock with `text` as its owner record, or none. @param {string | null} text */
    const held = (text) => {
      mkdirSync(p.lock, { recursive: true, mode: 0o700 });
      if (text !== null) writeFileSync(`${p.lock}/owner`, text);
    };
    /** An attach over that lock: how often it waited before it took it. */
    const run = async (/** @type {number} */ until) => {
      let waits = 0;
      const { code, spawned } = await attachOnce(
        home,
        async () => {
          waits++;
          assert.equal(existsSync(p.code), false, 'no version folder made without the lock');
          if (waits === until) rmSync(p.lock, { recursive: true });
        },
        { proc, now: () => clock },
      );
      assert.equal(code, EXIT.ok);
      assert.equal(spawned.length, 1);
      await waitFor(() => !existsSync(p.lock));
      rmSync(p.code, { recursive: true });
      return waits;
    };
    held(JSON.stringify({ pid: 4242, bootId: BOOT, startTime: 5 }));
    assert.equal(await run(3), 3, 'a live owner’s lock is waited for until it’s dropped, however old');
    for (const text of [
      JSON.stringify({ pid: 4242, bootId: BOOT, startTime: 6 }),
      JSON.stringify({ pid: 4243, bootId: BOOT, startTime: 5 }),
      '{"pid":',
      null,
    ]) {
      held(text);
      assert.equal(await run(-1), 0, `broken at once: ${text}`);
      assert.deepEqual(readdirSync(dirname(p.lock)), [], 'nothing set aside is left');
    }
    // One with no record yet, as one just made, is waited for while it’s fresh.
    clock = Date.now();
    held(null);
    assert.equal(await run(2), 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the start lock goes stale before an install’s minute-granular test would take it, and cleanup agrees', () => {
  assert.ok(LOCK_STALE_MS > SERVE_START_MS, 'an attach holds it for up to SERVE_START_MS');
  assert.ok(LOCK_STALE_MS <= 60_000, 'install.mjs’s script takes a lock for stale after find -mmin +1, a minute');
  assert.equal(LOCK_FRESH_MS, LOCK_STALE_MS);
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

/** Waits for a condition the daemon reaches asynchronously, without sleeping a fixed time. */
async function waitFor(cond, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('Timed out waiting.');
    await new Promise((r) => setTimeout(r, 5));
  }
}
