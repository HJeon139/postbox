// Cleanup on a remote host (server/remote/host/cleanup.mjs, #120): acks kept on disk, logs deleted once a turn has
// ended and Postbox has acked them, folders past logRetention, the size cap, the agent file, version retirement and
// `remove`. Everything runs over a temp home with a fake process check (sameProcess), so nothing is spawned or
// signaled; the daemon’s side drives createDaemon in-process over PassThrough streams, as tests/remote-daemon.test.mjs
// does.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ACK_FILE, AGENT_RECORD, compareVersions, createCleanup, LOCK_FRESH_MS } from '../server/remote/host/cleanup.mjs';
import { createDaemon } from '../server/remote/host/daemon.mjs';
import { encode, hostPaths, MESSAGE_FILE, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';

const VERSION = '0.10.0';
const BOOT = '0f1e2d3c-4b5a-4968-8776-655443322110';
const TOKEN = 'a'.repeat(64);
const DAY = 24 * 3600 * 1000;
const RETENTION = 7 * DAY;

/** A temp home, and cleanup over it whose process check says yes for the PIDs in `alive`. */
function setup({ version = VERSION, logMaxBytes = 1 << 20, clock = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pbc-'));
  const p = hostPaths(home, version);
  mkdirSync(p.turns, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const alive = new Set();
  const stops = [];
  const caps = [];
  const logs = [];
  const time = { skew: clock };
  const cleanup = createCleanup({
    home,
    version,
    paths: p,
    now: () => Date.now() + time.skew,
    log: (l) => logs.push(l),
    settings: () => ({ logRetention: RETENTION, logMaxBytes }),
    sameProcess: (r) => alive.has(r.pid),
    stopTurn: async (turn) => stops.push(turn),
    onCap: (turn, text) => caps.push({ turn, text }),
  });
  return { home, p, alive, stops, caps, logs, time, cleanup, done: () => rmSync(home, { recursive: true, force: true }) };
}

/**
 * A turn folder as the daemon and a runner leave it.
 * @param {{ out?: string, exit?: boolean, pid?: number, version?: string, runner?: boolean, files?: Record<string, string> }} [o]
 */
function makeTurn(p, turn, { out = '{"n":1}\n{"n":2}\n', exit = true, pid = 777, version = VERSION, runner = true, files = {} } = {}) {
  const dir = p.turn(turn);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, TURN_FILES.start),
    JSON.stringify({ turn, harness: 'claude-code', program: '/home/user/.local/bin/claude', argv: [], env: {}, stdin: 'file', folder: '/home/user/work' }),
  );
  if (runner) writeFileSync(join(dir, TURN_FILES.runner), JSON.stringify({ turn, version, pid, bootId: BOOT, startTime: 99 }));
  writeFileSync(join(dir, TURN_FILES.out), out);
  writeFileSync(join(dir, TURN_FILES.err), 'warning\n');
  writeFileSync(join(dir, MESSAGE_FILE), '{"type":"user"}\n');
  writeFileSync(join(dir, TURN_FILES.snapshot), '{}');
  writeFileSync(join(dir, TURN_FILES.tools), '');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  if (exit) writeFileSync(join(dir, TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 5 }));
  return dir;
}
const ls = (dir) => readdirSync(dir).sort();
/** Waits for check() to hold, looking every 10 ms. */
async function until(check, what, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (check()) return;
  throw new Error(`Timed out waiting for ${what}.`);
}

test('acks persist in the turn folder (0600), keep the furthest, and a new cleanup (a restarted daemon) reads them', async () => {
  const s = setup();
  try {
    const dir = makeTurn(s.p, 't1', { exit: false });
    s.alive.add(777);
    assert.equal(await s.cleanup.readAck('t1'), null);
    assert.equal(await s.cleanup.ack('t1', 8), 8);
    assert.equal(await s.cleanup.ack('t1', 4), 8, 'an older ack doesn’t move it back');
    assert.equal(readFileSync(join(dir, ACK_FILE), 'utf8'), '8\n');
    assert.equal(statSync(join(dir, ACK_FILE)).mode & 0o777, 0o600);
    const again = createCleanup({
      home: s.home,
      version: VERSION,
      paths: s.p,
      settings: () => ({ logRetention: RETENTION, logMaxBytes: 1 << 20 }),
      sameProcess: () => true,
    });
    assert.equal(await again.readAck('t1'), 8);
    assert.ok(existsSync(join(dir, TURN_FILES.out)), 'a running turn’s logs stay, acked or not');
  } finally {
    s.done();
  }
});

test('an ended turn: its files go at once, its logs only once out.jsonl is acked whole, and what welcome needs stays', async () => {
  const s = setup();
  try {
    const dir = makeTurn(s.p, 't1', { files: { 'mcp.json': '{}', 'in.jsonl': 'x\n' } });
    await s.cleanup.turnEnded('t1');
    assert.deepEqual(
      ls(dir),
      [TURN_FILES.err, TURN_FILES.exit, TURN_FILES.in, TURN_FILES.out, TURN_FILES.runner, TURN_FILES.start, TURN_FILES.tools].sort(),
      'the message, snapshot and other sent files went; logs and the queue stayed',
    );
    await s.cleanup.ack('t1', 8);
    assert.ok(existsSync(join(dir, TURN_FILES.out)), 'half acked: the logs stay');
    assert.equal(await s.cleanup.deletedSize('t1'), null);
    await s.cleanup.ack('t1', 16);
    assert.deepEqual(ls(dir), [ACK_FILE, TURN_FILES.exit, TURN_FILES.runner, TURN_FILES.start, TURN_FILES.tools].sort(), 'acked whole: out, in and err went');
    assert.equal(await s.cleanup.deletedSize('t1'), 16, 'the acked size stands in for out.jsonl’s');
  } finally {
    s.done();
  }
});

test('a running or starting turn keeps everything; an interrupted one keeps its logs until logRetention', async () => {
  const s = setup();
  try {
    const running = makeTurn(s.p, 'run', { exit: false, pid: 801 });
    const starting = makeTurn(s.p, 'starting', { exit: false, runner: false });
    const interrupted = makeTurn(s.p, 'gone', { exit: false, pid: 802 });
    s.alive.add(801);
    const before = [ls(running), ls(starting), ls(interrupted)];
    const swept = await s.cleanup.sweep();
    assert.deepEqual([ls(running), ls(starting), ls(interrupted)], before);
    assert.deepEqual(swept.folders, []);
    // Eight days on, the interrupted and starting folders go (nothing in them changed), the running one stays.
    s.time.skew = 8 * DAY;
    const later = await s.cleanup.sweep();
    assert.deepEqual(later.folders.sort(), ['gone', 'starting']);
    assert.ok(existsSync(running));
  } finally {
    s.done();
  }
});

test('logRetention deletes an ended folder whole, acked or not; a younger one stays', async () => {
  const s = setup();
  try {
    makeTurn(s.p, 'old');
    s.time.skew = 6 * DAY;
    assert.deepEqual((await s.cleanup.sweep()).folders, []);
    s.time.skew = RETENTION + 1000;
    assert.deepEqual((await s.cleanup.sweep()).folders, ['old']);
    assert.ok(!existsSync(s.p.turn('old')));
  } finally {
    s.done();
  }
});

test('the cap: a running turn whose out.jsonl passes logMaxBytes is stopped once and Postbox told; err.log is emptied', async () => {
  const s = setup({ logMaxBytes: 64 });
  try {
    const dir = makeTurn(s.p, 't1', { exit: false, out: `${'x'.repeat(100)}\n` });
    writeFileSync(join(dir, TURN_FILES.err), 'e'.repeat(200));
    s.alive.add(777);
    const swept = await s.cleanup.sweep();
    assert.deepEqual(s.stops, ['t1']);
    assert.deepEqual(swept.capped, ['t1']);
    assert.match(s.caps[0].text, /out\.jsonl is 101 bytes, over this host’s logMaxBytes \(64 bytes\)/);
    assert.equal(readFileSync(join(dir, TURN_FILES.out), 'utf8').length, 101, 'out.jsonl isn’t cut under a running turn');
    const err = readFileSync(join(dir, TURN_FILES.err), 'utf8');
    assert.match(err, /^postbox daemon: err\.log passed logMaxBytes \(64 bytes\) at 200 bytes and was emptied\.\n/);
    assert.match(err, /was stopped/);
    await s.cleanup.sweep();
    assert.deepEqual(s.stops, ['t1'], 'stopped once');
  } finally {
    s.done();
  }
});

test('the agent file: written 0600 outside the turn folder, never over a file already there, removed at the turn’s end if unchanged', async () => {
  const s = setup();
  try {
    const agents = join(s.home, '.kiro', 'agents');
    const file = { dir: agents, name: 'postbox.json', text: '{"name":"postbox"}' };
    makeTurn(s.p, 't1', { exit: false, pid: 801 });
    s.alive.add(801);
    await s.cleanup.writeAgentFile('t1', file);
    const path = join(agents, 'postbox.json');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(s.p.turn('t1', AGENT_RECORD), 'utf8')).path, path);
    // A file already there is never replaced or shared, even with the same text, and the refused turn’s record goes.
    makeTurn(s.p, 't2', { exit: false, pid: 802 });
    await assert.rejects(s.cleanup.writeAgentFile('t2', file), /already a file at .*postbox\.json/);
    assert.ok(!existsSync(s.p.turn('t2', AGENT_RECORD)));
    writeFileSync(path, 'theirs');
    await assert.rejects(s.cleanup.writeAgentFile('t2', { ...file, text: 'theirs' }), /already a file/);
    assert.equal(readFileSync(path, 'utf8'), 'theirs');
    writeFileSync(path, file.text);
    writeFileSync(s.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 5 }));
    await s.cleanup.turnEnded('t1');
    assert.ok(!existsSync(path), 'gone with the turn that wrote it');
    assert.ok(!existsSync(s.p.turn('t1', AGENT_RECORD)));
    // One the person changed since is kept.
    makeTurn(s.p, 't4', { exit: false, pid: 804 });
    s.alive.add(804);
    await s.cleanup.writeAgentFile('t4', file);
    writeFileSync(path, '{"mine":true}');
    writeFileSync(s.p.turn('t4', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 7 }));
    await s.cleanup.turnEnded('t4');
    assert.equal(readFileSync(path, 'utf8'), '{"mine":true}');
  } finally {
    s.done();
  }
});

test('retirement: the newest daemon deletes an old version’s folder unless a turn, its daemon or an attach still uses it', async () => {
  const s = setup();
  try {
    for (const v of ['0.6.0', '0.7.0', '0.8.0', '0.9.0', VERSION]) mkdirSync(join(s.p.root, v, 'server'), { recursive: true });
    mkdirSync(hostPaths(s.home, '0.6.0').lock, { recursive: true });
    writeFileSync(join(s.p.root, '0.7.0', 'daemon.pid'), JSON.stringify({ pid: 901, bootId: BOOT, startTime: 1 }));
    s.alive.add(901);
    makeTurn(s.p, 'old', { exit: false, pid: 902, version: '0.8.0' });
    s.alive.add(902);
    mkdirSync(join(s.p.root, 'not-a-version'));
    const swept = await s.cleanup.sweep();
    assert.deepEqual(swept.retired, ['0.9.0']);
    assert.deepEqual(swept.skipped.sort(), ['0.6.0', '0.7.0', '0.8.0']);
    assert.deepEqual(ls(s.p.root), ['0.6.0', '0.7.0', '0.8.0', VERSION, 'locks', 'not-a-version', 'token', 'turns'].sort());
    // Once the turn and the daemon are gone and the lock is stale, they go too.
    s.alive.clear();
    s.time.skew = 60_000;
    assert.deepEqual((await s.cleanup.sweep()).retired.sort(), ['0.6.0', '0.7.0', '0.8.0']);
    // An older daemon never retires a newer version, or anything.
    mkdirSync(join(s.p.root, '0.11.0'));
    mkdirSync(join(s.p.root, '0.9.0'));
    assert.deepEqual((await s.cleanup.sweep()).retired, []);
    assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  } finally {
    s.done();
  }
});

test('retirement: a start lock keeps an old version while its owner is live, however old, or while it’s new with no record', async () => {
  const s = setup();
  try {
    for (const v of ['0.6.0', '0.7.0', '0.8.0', '0.9.0', VERSION]) mkdirSync(join(s.p.root, v, 'server'), { recursive: true });
    /** @param {string} v @param {string | null} owner  its owner record’s text, or none */
    const lock = (v, owner) => {
      const l = hostPaths(s.home, v).lock;
      mkdirSync(l, { recursive: true });
      if (owner !== null) writeFileSync(join(l, 'owner'), owner);
    };
    lock('0.6.0', JSON.stringify({ pid: 911, bootId: BOOT, startTime: 1 }));
    s.alive.add(911);
    lock('0.7.0', JSON.stringify({ pid: 912, bootId: BOOT, startTime: 1 }));
    lock('0.8.0', null);
    lock('0.9.0', '{"pid":');
    const first = await s.cleanup.sweep();
    assert.deepEqual(first.retired.sort(), ['0.7.0', '0.9.0'], 'a dead owner’s lock, or a garbled one, holds nothing');
    assert.deepEqual(first.skipped.sort(), ['0.6.0', '0.8.0']);
    // Long after: the one with no record is stale; the live owner’s still holds.
    s.time.skew = 10 * LOCK_FRESH_MS;
    const later = await s.cleanup.sweep();
    assert.deepEqual(later.retired, ['0.8.0']);
    assert.deepEqual(later.skipped, ['0.6.0']);
    s.alive.clear();
    assert.deepEqual((await s.cleanup.sweep()).retired, ['0.6.0']);
  } finally {
    s.done();
  }
});

test('removeAll deletes ~/.postbox-remote and the turns’ agent files, and signals other versions’ daemons; nothing else in home', async () => {
  const s = setup();
  try {
    writeFileSync(join(s.home, 'keep.txt'), 'mine');
    makeTurn(s.p, 't1');
    const agents = join(s.home, '.kiro', 'agents');
    await s.cleanup.writeAgentFile('t1', { dir: agents, name: 'p.json', text: '{}' });
    mkdirSync(join(s.p.root, '0.9.0'), { recursive: true });
    writeFileSync(join(s.p.root, '0.9.0', 'daemon.pid'), JSON.stringify({ pid: 901, bootId: BOOT, startTime: 1 }));
    s.alive.add(901);
    const signaled = [];
    await s.cleanup.removeAll((pid) => signaled.push(pid));
    assert.deepEqual(signaled, [901]);
    assert.ok(!existsSync(s.p.root));
    assert.ok(!existsSync(join(agents, 'p.json')));
    assert.deepEqual(ls(s.home), ['.kiro', 'keep.txt']);
  } finally {
    s.done();
  }
});

test('a ~/.postbox-remote that’s a link is refused: removeAll and the sweep delete nothing, inside or outside it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pbc-'));
  try {
    const elsewhere = join(home, 'elsewhere');
    const p = hostPaths(home, VERSION);
    mkdirSync(join(elsewhere, 'turns'), { recursive: true });
    writeFileSync(join(elsewhere, 'precious'), 'x');
    symlinkSync(elsewhere, p.root);
    makeTurn(p, 't1');
    const logs = [];
    const cleanup = createCleanup({
      home,
      version: VERSION,
      paths: p,
      log: (l) => logs.push(l),
      settings: () => ({ logRetention: 1, logMaxBytes: 1 }),
      sameProcess: () => false,
    });
    await assert.rejects(
      cleanup.removeAll(() => {}),
      /isn’t a folder \(it’s a link or a file\)/,
    );
    assert.deepEqual((await cleanup.sweep()).folders, []);
    await cleanup.turnEnded('t1');
    assert.ok(existsSync(join(elsewhere, 'precious')));
    assert.ok(existsSync(join(elsewhere, 'turns', 't1', MESSAGE_FILE)), 'nothing in the linked folder was touched');
    assert.match(logs.join('\n'), /won’t delete anything/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a turn folder that’s a link is skipped: nothing it points at is deleted', async () => {
  const s = setup();
  try {
    const target = join(s.home, 'work');
    mkdirSync(target);
    writeFileSync(join(target, TURN_FILES.out), 'mine\n');
    writeFileSync(join(target, TURN_FILES.exit), '{"code":0,"signal":null,"at":1}');
    writeFileSync(join(target, MESSAGE_FILE), 'mine');
    symlinkSync(target, s.p.turn('t1'));
    s.time.skew = 30 * DAY;
    await s.cleanup.sweep();
    await s.cleanup.ack('t1', 5);
    assert.deepEqual(ls(target), [TURN_FILES.exit, MESSAGE_FILE, TURN_FILES.out].sort());
  } finally {
    s.done();
  }
});

// ── Through the daemon ──

function daemonSetup({ home = mkdtempSync(join(tmpdir(), 'pbd-')), onRemoved = () => {}, env = {} } = {}) {
  const p = hostPaths(home, VERSION);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const alive = new Set();
  const kills = [];
  let pid = 4000;
  const daemon = createDaemon({
    home,
    version: VERSION,
    // The daemon’s own environment, which the runner inherits: KIRO_HOME, for the Kiro home an agent file goes in.
    env,
    async launchRunner(o) {
      writeFileSync(o.paths.turn(o.turn, TURN_FILES.runner), JSON.stringify({ turn: o.turn, version: VERSION, pid: ++pid, bootId: BOOT, startTime: 1 }));
      alive.add(o.turn);
      return { pid, scoped: false, lingerOff: false };
    },
    askRunner: async (_path, turn) => alive.has(turn),
    proc: {
      sameProcess: async (r) => alive.has(r.turn ?? ''),
      toolGroups: () => [],
      liveGroups: (g) => g,
    },
    findPrograms: async () => ({
      node: { path: '/usr/bin/node', version: 'v22.12.0' },
      harnesses: [
        { name: 'claude-code', path: '/home/user/.local/bin/claude', version: '2.1.296', looked: [] },
        { name: 'kiro-cli', path: '/home/user/.local/bin/kiro-cli', version: '1.0.0', looked: [] },
      ],
      problems: [],
    }),
    // A harness that ends on SIGINT: the runner records it.
    kill(target, signal) {
      kills.push([target, signal]);
      for (const turn of [...alive]) {
        const r = JSON.parse(readFileSync(p.turn(turn, TURN_FILES.runner), 'utf8'));
        if (-target === r.pid) {
          writeFileSync(p.turn(turn, TURN_FILES.exit), JSON.stringify({ code: null, signal, at: 9 }));
          alive.delete(turn);
        }
      }
    },
    log: () => {},
    onRemoved,
    pollMs: 10,
    stopGraceMs: 50,
  });
  const connect = async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    daemon.connect({ input, output });
    const msgs = readMessages(output);
    const send = (type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
    send('hello', { version: PROTOCOL_VERSION, token: TOKEN, takeover: true });
    const welcome = await msgs.next('welcome');
    return { msgs, send, welcome, output };
  };
  const done = () => {
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { home, p, alive, kills, daemon, connect, done, env };
}

const startMsg = (turn, over = {}) => ({
  turn,
  harness: 'claude-code',
  folder: '/tmp',
  argv: ['-p'],
  env: {},
  stdin: 'file',
  files: [{ name: MESSAGE_FILE, text: '{"type":"user"}\n' }],
  ...over,
});

test('daemon: an ack survives a restart; once the turn has ended and is acked whole its logs go, and welcome and read still answer', async () => {
  const s = daemonSetup();
  try {
    const c = await s.connect();
    c.send('start', startMsg('t1'));
    await c.msgs.next('started');
    writeFileSync(s.p.turn('t1', TURN_FILES.out), '{"n":1}\n{"n":2}\n');
    c.send('ack', { turn: 't1', upTo: 8 });
    await new Promise((r) => setTimeout(r, 30));
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
