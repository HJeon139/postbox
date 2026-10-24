// The Codex adapter on a remote host (#120, L4c), against tests/fake-daemon.mjs through a minimal stand-in for the host
// link (server/remote/link.mjs’s contract: hello on each channel, 'connected' at each welcome, send() false while
// there’s none). No recorded remote Codex stream exists yet, so the host’s out.jsonl is built from the local recording
// in tests/fixtures/codex-app-server/turn.jsonl, and the approval request has the shape the local approval tests in
// tests/codex.test.mjs use; both are marked where they’re made.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CodexAdapter, codexRemoteConfigArgs, createCodexRebuild } from '../server/adapters/codex.mjs';
import { createMessageReader, encode, hostPaths, message, PROTOCOL_VERSION, utf8Bytes } from '../shared/remote-protocol.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';

const FOLDER = '/home/user/postbox-work/critic';
/** The host’s permissionWaitMax by default (shared/remote-settings.mjs), which the context’s empty settings leave. */
const WAIT = 24 * 60 * 60 * 1000;
/** The recorded local turn: responses to requests 1 to 3, then turn/started, a message, a command, turn/completed. */
const RECORDED = readFileSync(new URL('fixtures/codex-app-server/turn.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean);
const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), `Timed out waiting for ${label}`);
};
const sent = (d, type) => d.received.filter((m) => m.type === type);

/** The host link, as far as the adapter needs it, over the fake daemon’s streams; `welcome` is the latest. */
function linkTo(d, { delayIn = 0 } = {}) {
  const link = new EventEmitter();
  link.setMaxListeners(0);
  let ready = false;
  let stdin;
  const wire = ({ stdin: i, stdout }) => {
    stdin = i;
    ready = false;
    const reader = createMessageReader('daemon-to-postbox', {
      onMessage(m) {
        if (stdin !== i) return;
        if (m.type === 'welcome') {
          ready = true;
          link.welcome = m;
          link.emit('connected', m);
        } else if ((m.type === 'line' || m.type === 'caught-up') && m.log === 'in' && delayIn) setTimeout(() => link.emit('message', m), delayIn);
        else link.emit('message', m);
      },
      onError: (e) => assert.fail(`The fake daemon sent a bad line: ${e.message}`),
    });
    stdout.on('data', (b) => setImmediate(() => reader.push(b)));
    i.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN })));
  };
  wire({ stdin: d.stdin, stdout: d.stdout });
  return Object.assign(link, {
    /** @type {any} */
    welcome: null,
    send(msg) {
      if (!ready) return false;
      stdin.write(encode(msg));
      return true;
    },
  });
}

/**
 * Codex on the host: answers each line Postbox writes to the held stdin as the app-server does, appending to the
 * turn’s out.jsonl. `turnLines` go out after turn/start’s response (the recorded turn by default).
 */
function codexOnHost(d, { turnLines = RECORDED.slice(3), threadId = 'thr_postbox_1', turnId = 'turn_postbox_1' } = {}) {
  const timer = setInterval(() => {
    for (const t of d.turns.values()) {
      if (t.harness !== 'codex') continue;
      for (; (t.seen ?? 0) < t.writes.length; t.seen = (t.seen ?? 0) + 1) {
        const req = JSON.parse(t.writes[t.seen ?? 0]);
        if (req.method === 'initialize') d.append(t.turn, JSON.stringify({ id: req.id, result: { userAgent: 'codex/0' } }));
        else if (req.method === 'thread/start' || req.method === 'thread/resume')
          d.append(t.turn, JSON.stringify({ id: req.id, result: { thread: { id: threadId } } }));
        else if (req.method === 'turn/start') {
          d.append(t.turn, JSON.stringify({ id: req.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } }));
          for (const l of turnLines) d.append(t.turn, l);
        } else if (req.method === 'turn/interrupt') d.append(t.turn, JSON.stringify({ id: req.id, result: {} }));
      }
    }
  }, 2);
  return { stop: () => clearInterval(timer) };
}

/** Injected local kill and ps that fail the test if a remote turn ever reaches them. */
function forbidden() {
  const calls = [];
  return {
    calls,
    kill: (pid, sig) => {
      calls.push(['kill', pid, sig]);
      throw new Error('a remote turn reached the local kill');
    },
    list: async () => {
      calls.push(['list']);
      throw new Error('a remote turn reached the local ps');
    },
  };
}

/** Turn IDs as the runtime allocates them: unique, persisted before deliver. */
let turnIds = 0;

function context(link, { attach, abort = new AbortController(), state = {}, asked = [], answers = [], remote = {} } = {}) {
  const turn = `cx-turn-${++turnIds}`;
  const calls = { text: '', saved: {}, asked, turns: [], next: 0 };
  return {
    calls,
    abort,
    ctx: {
      persona: { handle: 'critic', model: 'gpt-5.6-terra', effort: 'medium', permissionMode: 'ask' },
      project: { folder: '/Users/me/laptop-only' },
      handles: ['critic'],
      state,
      signal: abort.signal,
      mcpUrl: 'http://127.0.0.1:1/mcp?session=never-used',
      remote: {
        link,
        welcome: link.welcome,
        settings: {},
        folder: FOLDER,
        version: '0.10.0',
        turn,
        // One Codex deliver is one host turn: it never asks for a second.
        nextTurn: async () => {
          calls.next += 1;
          return `cx-extra-${calls.next}`;
        },
        ...(attach ? { attach } : {}),
        ...remote,
      },
      text: (text) => {
        calls.text += text;
      },
      activity: () => {},
      status: () => {},
      saveState: (s) => Object.assign(calls.saved, s),
      checkpoint: () => {},
      reported: () => {},
      pathOf: () => null,
      askPermission: async (req) => {
        asked.push(req);
        return answers.shift() ?? new Promise(() => {});
      },
    },
  };
}

const ready = async (link) => until(() => link.welcome, 'the welcome');

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
    ['initialize', 'initialized', 'thread/start', 'turn/start'],
  );
  assert.equal(writes[2].params.cwd, FOLDER, 'the thread works in the host’s folder');
  assert.equal(writes[3].params.sandboxPolicy.type, 'readOnly');
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
  assert.deepEqual(JSON.parse(d.received[i].line), { id: 4, method: 'turn/interrupt', params: { threadId: 'thr_postbox_1', turnId: 'turn_postbox_1' } });
  assert.ok(s > i, 'then the daemon stops the app-server');
  assert.deepEqual(f.calls, []);
});

/** A turn already on the host, as a Postbox before the restart left it: out.jsonl and in.jsonl. */
function leftOnHost(d, turn, { out, inLines }) {
  const t = d.addTurn(turn, { harness: 'codex', stdin: 'held', lines: out });
  for (const text of inLines) {
    const offset = t.in.at(-1)?.next ?? 0;
    t.in.push({ offset, next: offset + utf8Bytes(text) + 1, text });
  }
  return t;
}

// The shape of the local approval tests’ request (tests/codex.test.mjs); no recorded one exists yet.
const approval = (id, itemId, command) => JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: { itemId, command, cwd: FOLDER } });
const SENT_BEFORE = [
  '{"id":1,"method":"initialize","params":{}}',
  '{"method":"initialized","params":{}}',
  '{"id":2,"method":"thread/start","params":{}}',
  '{"id":3,"method":"turn/start","params":{}}',
];

test('#120: after a Postbox restart, a remote Codex turn is replayed and rebuilt: IDs, and only the approval nobody answered', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  // Recorded lines up to the message, then two approvals: the first answered before the restart, the second not.
  leftOnHost(d, 'tr1', {
    out: [...RECORDED.slice(0, 7), approval(0, 'cmd_a', 'ls'), approval(1, 'cmd_b', 'rm -rf build')],
    inLines: [...SENT_BEFORE, '{"id":0,"result":{"decision":"accept"}}'],
  });
  // in.jsonl’s lines come after all of out.jsonl’s, as they may from the real daemon, whose two readers race.
  const link = linkTo(d, { delayIn: 40 });
  await ready(link);
  const f = forbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list });
  const { ctx, calls, abort } = context(link, { attach: { turn: 'tr1' }, answers: [{ allow: false }] });
  const turn = adapter.deliver({}, { kind: 'user', text: 'not sent again' }, ctx);
  await until(() => d.turns.get('tr1').writes.length === 1, 'the answer to the open approval');
  assert.equal(sent(d, 'start').length, 0, 'an attach starts nothing');
  assert.deepEqual(
    sent(d, 'read').map((m) => [m.from, m.log ?? 'out']),
    [
      [0, 'in'],
      [0, 'out'],
    ],
  );
  assert.equal(calls.text, 'Hello from Codex.', 'the reply is rebuilt from the replay');
  assert.deepEqual(
    calls.asked.map((a) => a.detail),
    [`rm -rf build\n\nWorking directory: ${FOLDER}`],
    'only the unanswered approval asks again',
  );
  assert.deepEqual(JSON.parse(d.turns.get('tr1').writes[0]), { id: 1, result: { decision: 'decline' } }, 'answered through the held stdin');
  assert.equal(calls.saved.codexThreadId, 'thr_postbox_1');
  abort.abort();
  await turn;
  assert.deepEqual(
    JSON.parse(d.turns.get('tr1').writes[1]),
    { id: 4, method: 'turn/interrupt', params: { threadId: 'thr_postbox_1', turnId: 'turn_postbox_1' } },
    'the next request ID follows the ones in.jsonl shows',
  );
  assert.deepEqual(d.stops, ['tr1']);
  assert.deepEqual(f.calls, []);
});

test('#120: a rebuilt Codex turn waits for caught-up on both logs: an in.jsonl answer that comes late still means no second answer', async () => {
  // The daemon’s in.jsonl reader is slow: out.jsonl is replayed and caught up, and in.jsonl’s answer comes well after.
  const d = createFakeDaemon({ autoEnd: false, lines: [], holdCaughtUp: ['in'] });
  leftOnHost(d, 'tr3', { out: [...RECORDED.slice(0, 7), approval(0, 'cmd_a', 'ls')], inLines: SENT_BEFORE });
  const link = linkTo(d);
  await ready(link);
  const f = forbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list });
  const { ctx, calls, abort } = context(link, { attach: { turn: 'tr3' }, answers: [{ allow: true }] });
  const turn = adapter.deliver({}, { kind: 'user', text: 'not sent again' }, ctx);
  await until(() => d.sent.some((m) => m.type === 'caught-up' && m.turn === 'tr3' && m.log === 'out'), 'out.jsonl caught up');
  // Longer than any quiet time a heuristic would wait.
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(calls.asked, [], 'nothing is asked before in.jsonl has caught up');
  // The answer Postbox gave before the restart, then in.jsonl’s caught-up.
  d.appendIn('tr3', '{"id":0,"result":{"decision":"accept"}}');
  d.caughtUp('tr3', 'in');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls.asked, [], 'answered before the restart: not asked again');
  assert.deepEqual(d.turns.get('tr3').writes, [], 'and no second answer');
  assert.equal(calls.saved.codexThreadId, 'thr_postbox_1', 'the rebuild finished');
  abort.abort();
  await turn;
  assert.deepEqual(JSON.parse(d.turns.get('tr3').writes[0]).method, 'turn/interrupt');
});

test('#120: a remote Codex turn that can’t be rebuilt after a restart ends as interrupted, and is stopped on the host', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  // Postbox restarted after initialize, before the thread or the turn existed: the message never reached Codex.
  leftOnHost(d, 'tr2', { out: RECORDED.slice(0, 1), inLines: SENT_BEFORE.slice(0, 2) });
  const link = linkTo(d);
  await ready(link);
  const adapter = new CodexAdapter();
  // An attach reuses the host turn it names, so it needs no ctx.remote.turn.
  const { ctx } = context(link, { attach: { turn: 'tr2' }, remote: { turn: undefined } });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'x' }, ctx), (e) => e.code === 'interrupted' && /can’t be picked up/.test(e.message));
  assert.deepEqual(d.stops, ['tr2']);
  // A turn the host doesn’t list any more is interrupted too.
  const { ctx: gone } = context(link, { attach: { turn: 'tr-missing' } });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'x' }, gone), (e) => e.code === 'interrupted');
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

test('#120: the rebuild settles a request by in.jsonl, serverRequest/resolved, its item completing, or the turn completing', () => {
  const r = createCodexRebuild();
  for (const l of RECORDED.slice(0, 4)) r.out(JSON.parse(l));
  for (const id of [0, 1, 2, 3]) r.out(JSON.parse(approval(id, `cmd_${id}`, 'true')));
  r.out({ id: 'elicit-1', method: 'mcpServer/elicitation/request', params: { serverName: 'github' } });
  r.in({ id: 0, result: { decision: 'accept' } });
  r.out({ method: 'serverRequest/resolved', params: { threadId: 'thr_postbox_1', requestId: 1 } });
  r.out({ method: 'item/completed', params: { item: { id: 'cmd_2', type: 'commandExecution', status: 'declined' } } });
  for (const l of SENT_BEFORE) r.in(JSON.parse(l));
  r.in({ id: 9, method: 'turn/interrupt', params: {} });
  assert.equal(r.threadId, 'thr_postbox_1');
  assert.equal(r.turnId, 'turn_postbox_1');
  assert.equal(r.nextRequestId(), 10);
  assert.deepEqual(
    r.open().map((m) => m.id),
    [3, 'elicit-1'],
  );
  assert.equal(r.answered('1'), false, 'a string ID isn’t the integer one');
  r.out(JSON.parse(RECORDED.at(-1)));
  assert.equal(r.completed, true);
  assert.deepEqual(r.open(), []);
});
