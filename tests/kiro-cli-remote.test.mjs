// The Kiro CLI adapter on a remote host (#120, L4b): a turn with ctx.remote set goes through the host’s daemon
// (server/remote/process.mjs’s remoteSpawn), here tests/fake-daemon.mjs over a minimal stand-in for the host link. No
// stream has been recorded from a remote Kiro turn yet, so the fake replays the local recordings in
// tests/fixtures/kiro-cli/ (kiro-cli 2.33.1, engine v3), which are what the daemon’s out.jsonl would hold: the runner
// appends the CLI’s stdout as it is. The fixtures are in tests/kiro-cli-remote-fixture.mjs.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { KIRO_CAPABILITIES, KiroCliAdapter, kiroRemoteEnv } from '../server/adapters/kiro-cli.mjs';
import { MESSAGE_FILE } from '../shared/remote-protocol.mjs';
import { FOLDER, fixtureLines, HOME, play, SHIM, setup, startOf, until } from './kiro-cli-remote-fixture.mjs';

test('#120: a remote Isolated turn starts on the host with its agent file in Postbox’s own Kiro home there, and the shim as its server', async () => {
  const { root, d, adapter, ctx, calls } = await setup();
  const turn = adapter.deliver({}, { kind: 'user', text: 'Remember heron.' }, ctx);
  const start = await startOf(d);
  play(d, start, 'first');
  await turn;
  const kiroHome = `${HOME}/.postbox-remote/kiro-home/kiro`;
  assert.equal(start.harness, 'kiro-cli');
  assert.equal(start.folder, FOLDER);
  assert.equal(start.stdin, 'file');
  assert.deepEqual(start.env, { KIRO_HOME: kiroHome }, 'only KIRO_HOME crosses, never the laptop’s variables');
  assert.equal(start.argv[0], 'chat', 'no program: the daemon runs the kiro-cli it found');
  assert.ok(start.argv.includes('--no-interactive'));
  assert.ok(!start.argv.includes('Remember heron.'), 'the message isn’t in the process arguments');
  assert.equal(start.files.find((f) => f.name === MESSAGE_FILE)?.text, 'Remember heron.');
  const agent = start.argv[start.argv.indexOf('--agent') + 1];
  assert.deepEqual(Object.keys(start.agentFile), ['name', 'text'], 'the daemon picks the folder, from KIRO_HOME');
  assert.equal(start.agentFile.name, `${agent}.json`);
  const file = JSON.parse(start.agentFile.text);
  assert.deepEqual(file.mcpServers.postbox, { command: '/usr/bin/node', args: [SHIM, start.turn] });
  assert.ok(!start.agentFile.text.includes('127.0.0.1'), 'the laptop’s MCP URL never crosses');
  // The host folder is the only one named; the project’s folder and the extra ones are the laptop’s.
  assert.deepEqual(file.permissions.rules.find((r) => r.capability === 'fs_read').match, [FOLDER]);
  assert.ok(!start.agentFile.text.includes('/Users/me'));
  assert.equal(calls.spawn, 0);
  assert.ok(!existsSync(join(root, 'home')), 'nothing is written to the laptop’s Kiro home');
  assert.ok(!existsSync(join(root, 'work')), 'no laptop folder is made');
  assert.equal(calls.text, 'OK');
  assert.match(calls.saved.kiroSessionId, /^sess_/);
});

test('#120: a remote Kiro turn runs as the runtime’s ctx.remote.turn, and refuses before anything starts without it or the version', async () => {
  const { d, adapter, ctx, calls } = await setup();
  const turn = adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  const start = await startOf(d);
  play(d, start, 'first');
  await turn;
  assert.equal(start.turn, ctx.remote.turn);
  assert.deepEqual(calls.turns, [start.turn], 'no other turn was asked for');
  for (const missing of ['turn', 'version']) {
    const t = await setup({ remote: { [missing]: undefined } });
    await assert.rejects(t.adapter.deliver({}, { kind: 'user', text: 'hi' }, t.ctx), new RegExp(`ctx\\.remote\\.${missing}`));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.d.received.filter((m) => m.type === 'start').length, 0, missing);
  }
});

test('#120: the shim’s path is under the Postbox version the runtime passes in ctx.remote.version', async () => {
  const { d, adapter, ctx } = await setup({ remote: { version: '0.99.1' } });
  const turn = adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  const start = await startOf(d);
  play(d, start, 'first');
  await turn;
  assert.deepEqual(JSON.parse(start.agentFile.text).mcpServers.postbox.args, [`${HOME}/.postbox-remote/0.99.1/server/remote/host/shim.mjs`, start.turn]);
  assert.ok(!('version' in adapter), 'the adapter keeps no version of its own');
});

test('#120: a remote turn with your setup puts its agent file in your Kiro home on the host, and sets no KIRO_HOME', async () => {
  const { d, adapter, ctx } = await setup({ persona: { usesHostSetup: true } });
  const turn = adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  const start = await startOf(d);
  play(d, start, 'first');
  await turn;
  assert.deepEqual(Object.keys(start.agentFile), ['name', 'text']);
  assert.deepEqual(start.env, {}, 'the daemon uses the host’s own KIRO_HOME, else ~/.kiro');
  assert.equal(JSON.parse(start.agentFile.text).includeMcpJson, true);
});

test('#120: the Kiro home on a host: yours (no variable: the daemon finds it), or one per handle under ~/.postbox-remote', () => {
  assert.deepEqual(kiroRemoteEnv({ usesHostSetup: true }, '/'), {});
  assert.deepEqual(kiroRemoteEnv({ handle: 'a.b/c', usesHostSetup: false }, HOME), { KIRO_HOME: `${HOME}/.postbox-remote/kiro-home/abc` });
  assert.deepEqual(kiroRemoteEnv({ handle: 'x', usesHostSetup: false }, '/'), { KIRO_HOME: '/.postbox-remote/kiro-home/x' });
});

test('#436: a remote Kiro turn and its fresh retry send each prompt through stdin', async () => {
  const { d, adapter, ctx, calls } = await setup({ state: { kiroSessionId: 'sess_gone' } });
  const turn = adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  const first = await startOf(d, 0);
  play(d, first, 'missing-session', 1);
  const second = await startOf(d, 1);
  play(d, second, 'first');
  await turn;
  assert.ok(first.argv.includes('--resume-id'));
  assert.ok(!second.argv.includes('--resume-id'));
  assert.equal(first.turn, ctx.remote.turn);
  assert.deepEqual(calls.turns, [first.turn, second.turn], 'the fresh start is a second host turn, from nextTurn');
  assert.deepEqual(calls.startsAtNext, [1], 'nextTurn came before its start');
  assert.equal(first.files.find((f) => f.name === MESSAGE_FILE)?.text, 'hi');
  assert.match(second.files.find((f) => f.name === MESSAGE_FILE)?.text ?? '', /fresh start/);
  assert.ok(!second.argv.some((arg) => /fresh start/.test(arg)));
  assert.deepEqual(JSON.parse(second.agentFile.text).mcpServers.postbox.args, [SHIM, second.turn]);
  assert.notEqual(calls.saved.kiroSessionId, 'sess_gone');
});

test('#120: Stop on a remote Kiro turn sends the daemon’s stop and never calls the local kill or ps', async () => {
  const { d, adapter, ctx, calls, abort } = await setup();
  const turn = adapter.deliver({}, { kind: 'user', text: 'Run a long command.' }, ctx);
  const start = await startOf(d);
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === start.turn), 'the read');
  d.append(start.turn, fixtureLines('first')[0]);
  abort.abort();
  await turn;
  assert.deepEqual(d.stops, [start.turn]);
  assert.deepEqual(calls.kill, [], 'no local signal, in particular not to a negative process ID');
  assert.equal(calls.list, 0);
});

test('Kiro says how it runs on a remote host: stdin file, only KIRO_HOME, its agent file, an open tool call as work', () => {
  assert.deepEqual(KIRO_CAPABILITIES.remote, {
    stdin: 'file',
    env: ['KIRO_HOME'],
    server: 'agent-file',
    work: 'open-tool-call',
    signInError: null,
  });
  const a = new KiroCliAdapter({ workRoot: '/nowhere', isolatedHome: '/nowhere/kiro', models: ['gpt-5.6-terra'] });
  assert.equal(a.capabilities.remote, KIRO_CAPABILITIES.remote, 'the models don’t replace it');
  assert.deepEqual(JSON.parse(JSON.stringify(a.capabilities)).remote, KIRO_CAPABILITIES.remote);
});
