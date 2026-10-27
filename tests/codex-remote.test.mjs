// The Codex adapter on a remote host (#120, L4c), against tests/fake-daemon.mjs through a minimal stand-in for the host
// link (server/remote/link.mjs’s contract: hello on each channel, 'connected' at each welcome, send() false while
// there’s none). No recorded remote Codex stream exists yet, so the host’s out.jsonl is built from the local recording
// in tests/fixtures/codex-app-server/turn.jsonl, and the approval request has the shape the local approval tests in
// tests/codex.test.mjs use; both are marked where they’re made.
// The fixtures are in tests/codex-remote-fixture.mjs; a turn picked up after a restart is in
// tests/codex-remote-restart.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter, codexRemoteConfigArgs } from '../server/adapters/codex.mjs';
import { hostPaths, utf8Bytes } from '../shared/remote-protocol.mjs';
import { approval, codexOnHost, context, FOLDER, forbidden, linkTo, RECORDED, ready, sent, until, WAIT } from './codex-remote-fixture.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';

test('#120: remote Codex config names the stdio shim with TOML values, never a URL', () => {
  const args = codexRemoteConfigArgs('/usr/bin/node', ['/home/user/.postbox-remote/0.10.0/server/remote/host/shim.mjs', 'turn-1'], WAIT);
  assert.deepEqual(args, [
    '-c',
    'mcp_servers.postbox.command="/usr/bin/node"',
    '-c',
    'mcp_servers.postbox.args=["/home/user/.postbox-remote/0.10.0/server/remote/host/shim.mjs","turn-1"]',
    '-c',
    'mcp_servers.postbox.enabled=true',
    '-c',
    'mcp_servers.postbox.required=true',
    '-c',
    // The host’s permissionWaitMax (24 h by default) plus an hour, in seconds, over Codex’s 60-second default.
    'mcp_servers.postbox.tool_timeout_sec=90000',
    '-c',
    'mcp_servers.postbox.default_tools_approval_mode="approve"',
  ]);
  assert.ok(!args.some((a) => a.includes('.url=')));
});

test('#120: a remote Codex turn starts on the host with a held stdin, the shim as its server, and ends through the daemon', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const link = linkTo(d);
  await ready(link);
  const host = codexOnHost(d);
  const f = forbidden();
  const adapter = new CodexAdapter({
    kill: f.kill,
    list: f.list,
    spawnImpl: () => assert.fail('a remote turn never spawns locally'),
  });
  const { ctx, calls } = context(link);
  await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
  host.stop();
  const [start] = sent(d, 'start');
  assert.equal(start.harness, 'codex');
  assert.equal(start.stdin, 'held');
  assert.equal(start.folder, FOLDER);
  assert.deepEqual(start.env, {}, 'no variable crosses');
  assert.equal(start.turn, ctx.remote.turn, 'the turn runs as the runtime’s ID, which it persisted to attach after a restart');
  assert.equal(calls.next, 0);
  const shim = hostPaths('/home/user', '0.10.0').shim;
  assert.deepEqual(start.argv, ['app-server', '--listen', 'stdio://', ...codexRemoteConfigArgs('/usr/bin/node', [shim, start.turn], WAIT)]);
  assert.ok(start.argv.includes('mcp_servers.postbox.tool_timeout_sec=90000'), 'Codex waits on the shim past the host’s permissionWaitMax');
  assert.ok(!JSON.stringify(start).includes('127.0.0.1'), 'the laptop’s MCP URL never goes to the host');
  const writes = d.turns.get(start.turn).writes.map((l) => JSON.parse(l));
  assert.deepEqual(
    writes.map((w) => w.method),
    ['initialize', 'initialized', 'mcpServerStatus/list', 'thread/start', 'turn/start'],
  );
  assert.equal(writes[3].params.cwd, FOLDER, 'the thread works in the host’s folder');
  assert.equal(writes[4].params.sandboxPolicy.type, 'readOnly');
  assert.equal(calls.text, 'Hello from Codex.');
  assert.equal(calls.saved.codexThreadId, 'thr_postbox_1');
  assert.deepEqual(d.stops, [start.turn], 'the app-server on the host is stopped as the turn ends');
  assert.deepEqual(f.calls, []);
});

test('#120: a remote Codex turn’s tool timeout follows the host’s own permissionWaitMax', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const link = linkTo(d);
  await ready(link);
  const host = codexOnHost(d);
  const f = forbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list });
  // 30 minutes, plus the hour’s margin: 5400 seconds.
  const { ctx } = context(link, { remote: { settings: { permissionWaitMax: 30 * 60 * 1000 } } });
  await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
  host.stop();
  const [start] = sent(d, 'start');
  assert.equal(start.argv.filter((a) => a.includes('tool_timeout_sec')).join(), 'mcp_servers.postbox.tool_timeout_sec=5400');
});

test('#120: a remote Codex turn needs the runtime’s ctx.remote.turn and version; its shim is under that version; an attach reuses its own turn', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const link = linkTo(d);
  await ready(link);
  const host = codexOnHost(d);
  const f = forbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list });
  for (const missing of ['turn', 'version'])
    await assert.rejects(
      adapter.deliver({}, { kind: 'user', text: 'x' }, context(link, { remote: { [missing]: undefined } }).ctx),
      new RegExp(`ctx\\.remote\\.${missing}`),
    );
  assert.equal(sent(d, 'start').length, 0, 'nothing started on the host');
  const { ctx } = context(link, { remote: { version: '0.99.1' } });
  await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
  host.stop();
  const [start] = sent(d, 'start');
  assert.equal(start.turn, ctx.remote.turn);
  assert.deepEqual(
    start.argv.slice(3),
    codexRemoteConfigArgs('/usr/bin/node', ['/home/user/.postbox-remote/0.99.1/server/remote/host/shim.mjs', start.turn], WAIT),
  );
  assert.ok(!('version' in adapter), 'the adapter keeps no version of its own');
});

test('#120: Stop on a remote Codex turn sends turn/interrupt first, then the daemon’s stop, never the local kill', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const link = linkTo(d);
  await ready(link);
  // A turn that keeps working: started, and no turn/completed.
  const host = codexOnHost(d, { turnLines: [RECORDED[3]] });
  const f = forbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list });
  const { ctx, abort } = context(link);
  const turn = adapter.deliver({}, { kind: 'user', text: 'Work for a while.' }, ctx);
  await until(() => d.received.some((m) => m.type === 'write' && m.line.includes('turn/start')), 'turn/start');
  await new Promise((r) => setTimeout(r, 20));
  abort.abort();
  await turn;
  host.stop();
  const i = d.received.findIndex((m) => m.type === 'write' && JSON.parse(m.line).method === 'turn/interrupt');
  const s = d.received.findIndex((m) => m.type === 'stop');
  assert.ok(i >= 0, 'Stop interrupts the Codex turn');
  assert.deepEqual(JSON.parse(d.received[i].line), { id: 5, method: 'turn/interrupt', params: { threadId: 'thr_postbox_1', turnId: 'turn_postbox_1' } });
  assert.ok(s > i, 'then the daemon stops the app-server');
  assert.deepEqual(f.calls, []);
});

test('#120: an approval the host answered (expired) while its card was open gets no second answer from Postbox', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const link = linkTo(d);
  await ready(link);
  const host = codexOnHost(d, { turnLines: [RECORDED[3], approval(0, 'cmd_x', 'make deploy')] });
  /** @type {(a: any) => void} */
  let decide = () => {};
  const adapter = new CodexAdapter();
  const { ctx, abort, calls } = context(link);
  ctx.askPermission = (req) => {
    calls.asked.push(req);
    return new Promise((r) => {
      decide = r;
    });
  };
  const turn = adapter.deliver({}, { kind: 'user', text: 'Deploy.' }, ctx);
  await until(() => calls.asked.length === 1, 'the card');
  const t = [...d.turns.values()][0];
  // The daemon declines it at permissionWaitMax through the held stdin (H4): a line in in.jsonl Postbox didn’t write.
  const text = '{"id":0,"result":{"decision":"decline"}}';
  const offset = t.in.at(-1).next;
  t.in.push({ offset, next: offset + utf8Bytes(text) + 1, text });
  link.emit('message', { type: 'line', turn: t.turn, log: 'in', offset, next: offset + utf8Bytes(text) + 1, text });
  decide({ allow: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.writes.filter((l) => JSON.parse(l).id === 0).length, 0, 'no answer after the host’s');
  abort.abort();
  await turn;
  host.stop();
});
