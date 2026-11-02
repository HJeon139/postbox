// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: through the daemon, a shim on its
// socket. A shim is a pair of functions, Postbox is a list of what the broker sent it, and the turn folders are in a
// temp home (tests/remote-broker-fixtures.mjs). Nothing is spawned; the real daemon, runner and shim are in
// tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { encode, hostPaths, MESSAGE_FILE, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';
import { inProcessDaemon, socketShim } from './remote-broker-daemon-setup.mjs';
import { BLOCK, sleep, TOKEN, until, VERSION } from './remote-broker-fixtures.mjs';

// ── Through the daemon ──

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
    // The turn’s own token, which the daemon wrote at its start.
    shimSend('hello', { token: readFileSync(p.turn('t1', TURN_FILES.shimToken), 'utf8'), turn: 't1' });
    await until(() => got.find((m) => m.type === 'welcome'), 'the welcome');
    assert.equal(got[0].permissionWaitMax, 60_000, 'the setting from Postbox’s hello');
    shimSend('call', { id: 'c1', name: 'read_conversation', args: {} });
    const c1Tool = await msgs.next('tool');
    assert.equal(c1Tool.id, 'c1');
    assert.equal(c1Tool.name, 'read_conversation');
    send('reply', { turn: 't1', id: 'c1', ok: true, text: '[i1] You: hi' });
    assert.equal((await until(() => got.find((m) => m.id === 'c1'), 'c1’s result')).text, '[i1] You: hi');
    shimSend('call', { id: 'c2', name: 'show_block', args: { block: BLOCK } });
    assert.equal((await msgs.next('tool')).id, 'c2');
    send('stop', { turn: 't1' });
    await until(() => got.find((m) => m.type === 'error' && m.code === 'turn-ended'), 'the shim to hear Stop');
    shimSend('call', { id: 'c3', name: 'show_block', args: { block: { ...BLOCK, id: 'other' } } });
    assert.equal((await until(() => got.find((m) => m.id === 'c3'), 'c3’s result')).ok, false);
    await sleep(30);
    assert.equal(msgs.messages.filter((m) => m.type === 'tool').length, 2, 'nothing after Stop reached Postbox');
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
