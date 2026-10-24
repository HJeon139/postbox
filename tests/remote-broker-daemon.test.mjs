// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: through the daemon, a shim on its
// socket. A shim is a pair of functions, Postbox is a list of what the broker sent it, and the turn folders are in a
// temp home (tests/remote-broker-fixtures.mjs). Nothing is spawned; the real daemon, runner and shim are in
// tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createDaemon } from '../server/remote/host/daemon.mjs';
import { encode, hostPaths, MESSAGE_FILE, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';
import { BLOCK, BOOT, sleep, TOKEN, until, VERSION } from './remote-broker-fixtures.mjs';

// ── Through the daemon ──

/** The daemon in-process, with fake runners: a held stdin’s writes are kept in `writes`. @param {string} home */
function inProcessDaemon(home) {
  const alive = new Set();
  const writes = [];
  let pid = 4000;
  const daemon = createDaemon({
    home,
    version: VERSION,
    // logind’s facts, which the daemon asks at each hello (the lingering warning): none, as on a host without systemd.
    logind: () => ({ killUserProcesses: null, linger: null }),
    async launchRunner(o) {
      writeFileSync(o.paths.turn(o.turn, TURN_FILES.runner), JSON.stringify({ turn: o.turn, version: VERSION, pid: ++pid, bootId: BOOT, startTime: 1 }), {
        mode: 0o600,
      });
      alive.add(o.turn);
      return { pid, scoped: false, lingerOff: false };
    },
    askRunner: async (_path, turn) => alive.has(turn),
    proc: { sameProcess: async () => true, toolGroups: () => [], liveGroups: () => [] },
    async writeRunner(o) {
      writes.push(o.line);
      return 10;
    },
    findPrograms: async () => ({
      node: { path: '/usr/bin/node', version: 'v22.12.0' },
      harnesses: [
        { name: 'claude-code', path: '/usr/bin/claude', version: '2.1.300', looked: [] },
        { name: 'codex', path: '/usr/bin/codex', version: '0.50.0', looked: [] },
      ],
      problems: [],
    }),
    kill: () => {},
    log: () => {},
    pollMs: 10,
    stopGraceMs: 60_000,
  });
  return { daemon, writes };
}

/** A shim, over a socket-shaped pair, as accept() sees one: what it got, and a function that sends. @param {any} daemon */
function socketShim(daemon) {
  const toDaemon = new PassThrough();
  const fromDaemon = new PassThrough();
  daemon.accept(/** @type {any} */ (Duplex.from({ readable: toDaemon, writable: fromDaemon })));
  const got = [];
  let buf = '';
  fromDaemon.on('data', (d) => {
    buf += d;
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      got.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  const shimSend = (type, body) => toDaemon.write(encode(message('shim-to-daemon', type, body)));
  return { got, shimSend };
}

test('the daemon: a shim on its socket reaches the broker, Stop refuses the turn’s calls, and a held-stdin write still goes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pbbd-'));
  const p = hostPaths(home, VERSION);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const work = join(home, 'work');
  mkdirSync(work);
  const { daemon, writes } = inProcessDaemon(home);
  try {
    await daemon.start();
    const input = new PassThrough();
    const output = new PassThrough();
    daemon.connect({ input, output });
    const msgs = readMessages(output);
    const send = (type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
    send('hello', { version: PROTOCOL_VERSION, token: TOKEN, settings: { permissionWaitMax: 60_000 } });
    await msgs.next('welcome');
    send('snapshot', { turn: 't1', home: 'th', threads: [{ id: 'th', items: [{ id: 'i1', line: 'You: hi', text: 'You: hi' }] }] });
    send('start', { turn: 't1', harness: 'claude-code', folder: work, argv: [], env: {}, stdin: 'file', files: [{ name: MESSAGE_FILE, text: '{}\n' }] });
    await msgs.next('started');
    const { got, shimSend } = socketShim(daemon);
    shimSend('hello', { token: TOKEN, turn: 't1' });
    await until(() => got.find((m) => m.type === 'welcome'), 'the welcome');
    assert.equal(got[0].permissionWaitMax, 60_000, 'the setting from Postbox’s hello');
    shimSend('call', { id: 'c1', name: 'read_conversation', args: {} });
    assert.equal((await until(() => got.find((m) => m.id === 'c1'), 'c1’s result')).text, 'You: hi', 'the snapshot sent before start');
    shimSend('call', { id: 'c2', name: 'show_block', args: { block: BLOCK } });
    assert.equal((await msgs.next('tool')).id, 'c2');
    send('stop', { turn: 't1' });
    await until(() => got.find((m) => m.type === 'error' && m.code === 'turn-ended'), 'the shim to hear Stop');
    shimSend('call', { id: 'c3', name: 'show_block', args: { block: { ...BLOCK, id: 'other' } } });
    assert.equal((await until(() => got.find((m) => m.id === 'c3'), 'c3’s result')).ok, false);
    await sleep(30);
    assert.equal(msgs.messages.filter((m) => m.type === 'tool').length, 1, 'nothing after Stop reached Postbox');
    // A held Codex turn’s write passes the broker’s check (a declined request’s answer is refused: the Codex test).
    send('start', { turn: 'cx', harness: 'codex', folder: work, argv: [], env: {}, stdin: 'held', files: [] });
    await msgs.next('started');
    send('write', { turn: 'cx', line: '{"id":1,"result":{"decision":"accept"}}' });
    assert.equal((await msgs.next('written')).upTo, 10);
    assert.deepEqual(writes, ['{"id":1,"result":{"decision":"accept"}}']);
  } finally {
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
