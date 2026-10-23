// The Claude Code adapter on a remote host (#120, L4a): the same adapter, with ctx.remote set, starting its turns through
// the host’s daemon. Run against tests/fake-daemon.mjs, which replays recorded Claude Code streams
// (tests/fixtures/claude-code/, claude 2.1.296 on this computer: no stream recorded on a host exists yet), through a
// minimal stand-in for the host link (server/remote/link.mjs): hello, `connected` at the welcome, send() false before.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { shimArgs } from '../server/adapters/adapter.mjs';
import { CLAUDE_CODE_CAPABILITIES, ClaudeCodeAdapter, claudeArgs, remoteClaudeProblem } from '../server/adapters/claude-code.mjs';
import { createMessageReader, encode, MESSAGE_FILE, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { createFakeDaemon, FAKE_TOKEN, fixtureLines } from './fake-daemon.mjs';

const VERSION = '0.10.0';
const HOME = '/home/user';
const FOLDER = '/home/user/postbox-work/coder';
const SHIM = `${HOME}/.postbox-remote/${VERSION}/server/remote/host/shim.mjs`;
const HOUR = 60 * 60 * 1000;
const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/** The host link, as far as the remote process needs it, over the fake daemon’s streams (as tests/remote-process.test.mjs). */
function connectTo(d) {
  const conn = new EventEmitter();
  conn.setMaxListeners(0);
  let ready = false;
  const reader = createMessageReader('daemon-to-postbox', {
    onMessage(m) {
      if (m.type === 'welcome') {
        ready = true;
        conn.emit('connected');
      } else conn.emit('message', m);
    },
    onError: (e) => assert.fail(`The fake daemon sent a bad line: ${e.message}`),
  });
  d.stdout.on('data', (b) => setImmediate(() => reader.push(b)));
  d.stdin.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN })));
  return Object.assign(conn, {
    send(msg) {
      if (!ready) return false;
      d.stdin.write(encode(msg));
      return true;
    },
  });
}

/** A welcome with this host’s claude. @param {{ version?: string|null, path?: string|null }} [claude] */
const welcomeWith = ({ version = '2.1.296', path = `${HOME}/.local/bin/claude` } = {}) => ({
  version: PROTOCOL_VERSION,
  home: HOME,
  node: { path: '/usr/bin/node', version: 'v22.12.0' },
  harnesses: [{ name: 'claude-code', path, version: path ? version : null, looked: path ? [] : [`${HOME}/.local/bin`, '/usr/local/bin'] }],
  problems: [],
  turns: [],
});

/** A local kill, ps and spawn that fail the test if they’re ever called. */
function forbidden() {
  const calls = [];
  return {
    calls,
    kill: (pid, sig) => {
      calls.push(['kill', pid, sig]);
      throw new Error(`The local kill was called with ${pid}, ${sig}.`);
    },
    listProcesses: async () => {
      calls.push(['list']);
      throw new Error('The local ps was read for a remote turn.');
    },
    spawnImpl: (bin) => {
      calls.push(['spawn', bin]);
      throw new Error('A remote turn was spawned on this computer.');
    },
  };
}

/** Turn IDs as the runtime allocates them: unique, persisted before deliver (and before nextTurn returns). */
let turnIds = 0;
const nextId = () => `cc-turn-${++turnIds}`;

/** A turn context for a remote turn, recording what the adapter did. calls.turns: every turn ID the runtime gave. */
function remoteCtx(d, { settings = {}, welcome = welcomeWith(), state = {}, remote = {}, addDirs = [] } = {}) {
  const turn = nextId();
  const calls = { text: '', saved: {}, turns: [turn], jobs: [], control: [], startsAtNext: [] };
  const abort = new AbortController();
  const ctx = {
    calls,
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    // A laptop folder that must never be made for a remote turn.
    persona: {
      handle: 'coder',
      model: 'claude-opus-5-5',
      permissionMode: 'ask',
      folder: `/tmp/pb-remote-never-${process.pid}`,
      description: '',
      instructions: '',
    },
    project: { folder: '/Users/someone/project' },
    addDirs,
    handles: ['coder'],
    state,
    saveState: (p) => Object.assign(calls.saved, p),
    pathOf: () => null,
    text: (t) => {
      calls.text += t;
    },
    activity: () => {},
    status: () => {},
    job: (j) => calls.jobs.push(j),
    control: (c) => calls.control.push(c),
    remote: {
      link: connectTo(d),
      welcome,
      settings,
      folder: FOLDER,
      version: VERSION,
      turn,
      async nextTurn() {
        calls.startsAtNext.push(starts(d).length);
        const t = nextId();
        calls.turns.push(t);
        return t;
      },
      ...remote,
    },
  };
  return ctx;
}

const starts = (d) => d.received.filter((m) => m.type === 'start');
const argOf = (argv, flag) => argv[argv.indexOf(flag) + 1];
const serverOf = (argv) => JSON.parse(argOf(argv, '--mcp-config')).mcpServers.postbox;

test('#120: a remote turn runs on the host: the stdio shim for Postbox’s server, the host folder, the message as a file, no laptop paths', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const f = forbidden();
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...f });
  const ctx = remoteCtx(d, { addDirs: ['/Users/someone/notes'] });
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  assert.equal(ctx.calls.text, 'Tea or coffee? Pick one above.');
  const [start] = starts(d);
  assert.equal(start.harness, 'claude-code');
  assert.equal(start.folder, FOLDER);
  assert.equal(start.stdin, 'file');
  assert.deepEqual(start.env, {}, 'no variable crosses unless the adapter sets one');
  assert.deepEqual(ctx.calls.turns, [start.turn], 'the turn runs as the runtime’s ctx.remote.turn');
  const msg = start.files.find((x) => x.name === MESSAGE_FILE);
  assert.match(msg.text, /Tea or coffee\?/);
  // C1: the shim, started by the host’s node with the turn’s ID, waits past the host’s permissionWaitMax (24 h by default).
  assert.deepEqual(serverOf(start.argv), { type: 'stdio', command: '/usr/bin/node', args: [SHIM, start.turn], alwaysLoad: true, timeout: 25 * HOUR });
  assert.ok(!start.argv.some((a) => a.includes('127.0.0.1:4280')), 'the laptop’s MCP URL never crosses');
  assert.ok(!start.argv.includes('--add-dir'), 'laptop folders aren’t added on the host');
  assert.match(
    argOf(start.argv, '--append-system-prompt'),
    /runs on a remote host, in \/home\/user\/postbox-work\/coder\. The folders added to this conversation \(\/Users\/someone\/notes\) are on Postbox’s computer/,
  );
  assert.ok(start.argv.includes('--permission-prompt-tool') && !start.argv.includes('--permission-prompts'));
  assert.ok(start.argv.includes('--session-id'));
  assert.equal(start.argv[0], '-p', 'argv has no program: the daemon runs the claude it found');
  assert.equal(ctx.calls.saved.claudeSessionId, fixtureLines('block').map((l) => JSON.parse(l))[0].session_id);
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(ctx.persona.folder), false, 'no folder is made on this computer');
});

test('#120: every remote resume passes the shim again (C6), and a resume after an interrupted turn goes on with it (D2)', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  const state = { claudeSessionId: '11111111-1111-4111-8111-111111111111' };
  await adapter.deliver({}, { kind: 'user', text: 'Again' }, remoteCtx(d, { state: { ...state }, settings: { permissionWaitMax: HOUR } }));
  await adapter.deliver({}, { kind: 'user', text: 'Go on' }, remoteCtx(d, { state: { ...state }, remote: { resumeInterrupted: true } }));
  const [a, b] = starts(d);
  assert.notEqual(a.turn, b.turn, 'each turn has its own ID');
  for (const s of [a, b]) {
    assert.equal(argOf(s.argv, '--resume'), state.claudeSessionId, 'the session lives on the host');
    assert.equal(serverOf(s.argv).args[1], s.turn);
  }
  assert.equal(serverOf(a.argv).timeout, 2 * HOUR, 'the host’s permissionWaitMax plus an hour');
  assert.deepEqual(a.env, {});
  assert.deepEqual(b.env, { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1' });
  assert.ok(CLAUDE_CODE_CAPABILITIES.remote.env.includes('CLAUDE_CODE_RESUME_INTERRUPTED_TURN'));
  // A fresh start has nothing to go on with.
  await adapter.deliver({}, { kind: 'user', text: 'New' }, remoteCtx(d, { remote: { resumeInterrupted: true } }));
  assert.deepEqual(starts(d)[2].env, {});
});

test('#120: with the host’s denyPrompts on, --permission-prompts none replaces the prompt tool; bypass and laptop turns are unchanged', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d, { settings: { denyPrompts: true }, welcome: welcomeWith({ version: '2.1.259' }) }));
  const [s] = starts(d);
  assert.deepEqual(s.argv.slice(s.argv.indexOf('--permission-prompts'), s.argv.indexOf('--permission-prompts') + 2), ['--permission-prompts', 'none']);
  assert.ok(!s.argv.includes('--permission-prompt-tool'));
  const base = { sessionId: 's', mcpUrl: 'http://x/mcp', guide: 'G', resume: false };
  const bypass = claudeArgs({ ...base, persona: { permissionMode: 'bypass' }, denyPrompts: true });
  assert.ok(!bypass.includes('--permission-prompts') && !bypass.includes('--permission-prompt-tool'));
  const local = claudeArgs({ ...base, persona: { permissionMode: 'ask' } });
  assert.deepEqual(serverOf(local), { type: 'http', url: 'http://x/mcp', alwaysLoad: true, timeout: 25 * HOUR });
});

test('#120: a host whose claude is missing or too old refuses the turn before it starts, saying what it found and where (C3)', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  const refuse = (opts, re) => assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d, opts)), re);
  await refuse(
    { welcome: welcomeWith({ path: null }) },
    /Claude Code isn’t installed on the host\. It looked in \/home\/user\/\.local\/bin, \/usr\/local\/bin\./,
  );
  await refuse(
    { welcome: welcomeWith({ version: '2.1.186' }) },
    /Claude Code 2\.1\.186 at \/home\/user\/\.local\/bin\/claude on the host is older than 2\.1\.187/,
  );
  await refuse(
    { welcome: welcomeWith({ version: '2.1.258' }), settings: { denyPrompts: true } },
    /2\.1\.258 at \/home\/user\/\.local\/bin\/claude .*older than 2\.1\.259, which turning off permission prompts/,
  );
  await refuse(
    { welcome: welcomeWith({ version: 'nightly' }) },
    /couldn’t tell the version of Claude Code at \/home\/user\/\.local\/bin\/claude on the host \(it said “nightly”\)/,
  );
  assert.deepEqual(starts(d), [], 'nothing started on the host');
  assert.equal(remoteClaudeProblem(welcomeWith({ version: '2.1.187' })), null);
  assert.equal(remoteClaudeProblem(welcomeWith({ version: '2.1.308.1314' }), { denyPrompts: true }), null);
  assert.equal(remoteClaudeProblem(welcomeWith({ version: '2.1.259' }), { denyPrompts: false }), null);
});

test('#120: Stop on a remote turn goes through the daemon, never the local kill or ps; a job to keep is reported stopped, and a job’s own Stop isn’t offered', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block').slice(0, 2), autoEnd: false });
  const f = forbidden();
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...f });
  const ctx = remoteCtx(d);
  const done = adapter.deliver({}, { kind: 'user', text: 'Long job' }, ctx);
  await until(() => d.received.some((m) => m.type === 'read'), 'the read');
  ctx.abort.abort(Object.assign(new Error('Stopped by you.'), { name: 'AbortError', keepJobs: [{ id: 'job1', command: 'sleep 100' }] }));
  await done;
  assert.deepEqual(d.stops, [starts(d)[0].turn]);
  assert.deepEqual(ctx.calls.jobs, [{ id: 'job1', state: 'stopped' }], 'not kept: the host’s jobs stop with the turn');
  assert.deepEqual(ctx.calls.control, [], 'no stopJob for a remote turn');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(f.calls, []);
});

test('#120: a session the host no longer has starts over once, read from the result since its stderr stays on the host', async () => {
  // resume-missing.jsonl: claude 2.1.308, `-p --resume <unknown id> --output-format stream-json`, recorded on this
  // computer; it exited 1, with the same words on stderr.
  const d = createFakeDaemon({ lines: [], autoEnd: false });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  const ctx = remoteCtx(d, { state: { claudeSessionId: '00000000-0000-4000-8000-0000000000aa' } });
  const done = adapter.deliver({}, { kind: 'user', text: 'Hello again' }, ctx);
  await until(() => starts(d).length === 1 && d.turns.has(starts(d)[0].turn), 'the first start');
  const first = starts(d)[0].turn;
  for (const l of fixtureLines('resume-missing')) d.append(first, l);
  d.end(first, { code: 1, signal: null });
  await until(() => starts(d).length === 2 && d.turns.has(starts(d)[1].turn), 'the fresh start');
  const second = starts(d)[1];
  assert.ok(second.argv.includes('--session-id') && !second.argv.includes('--resume'));
  assert.match(second.files.find((x) => x.name === MESSAGE_FILE).text, /couldn’t be loaded, so this is a fresh start/);
  for (const l of fixtureLines('block')) d.append(second.turn, l);
  d.end(second.turn);
  await done;
  assert.equal(ctx.calls.text, 'Tea or coffee? Pick one above.');
  assert.equal(first, ctx.remote.turn, 'the first run is the runtime’s turn');
  assert.deepEqual(ctx.calls.turns, [first, second.turn], 'the fresh start is a second host turn, from nextTurn');
  assert.deepEqual(ctx.calls.startsAtNext, [1], 'nextTurn came before its start');
});

test('#120: a fork point the host can’t find runs again as a second host turn from ctx.remote.nextTurn', async () => {
  const d = createFakeDaemon({ lines: [], autoEnd: false });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  const fork = { claudeSessionId: '00000000-0000-4000-8000-0000000000bb', uuid: '00000000-0000-4000-8000-0000000000cc' };
  const ctx = remoteCtx(d, { state: { fork } });
  const done = adapter.deliver({}, { kind: 'user', text: 'Branch' }, ctx);
  await until(() => starts(d).length === 1 && d.turns.has(starts(d)[0].turn), 'the first start');
  const first = starts(d)[0];
  assert.equal(first.turn, ctx.remote.turn);
  assert.equal(argOf(first.argv, '--resume-session-at'), fork.uuid);
  // As claude says it when the message to branch at isn’t in the session.
  d.append(
    first.turn,
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`No message found with message.uuid of: ${fork.uuid}`] }),
  );
  d.end(first.turn, { code: 1, signal: null });
  await until(() => starts(d).length === 2 && d.turns.has(starts(d)[1].turn), 'the start from the latest point');
  const second = starts(d)[1];
  assert.deepEqual(ctx.calls.turns, [first.turn, second.turn]);
  assert.equal(serverOf(second.argv).args[1], second.turn, 'the shim names the second turn');
  for (const l of fixtureLines('block')) d.append(second.turn, l);
  d.end(second.turn);
  await done;
});

test('#120: a remote turn needs the runtime’s ctx.remote.turn and version, and says so before anything starts', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d, { remote: { turn: undefined } })), /ctx\.remote\.turn/);
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d, { remote: { version: undefined } })), /ctx\.remote\.version/);
  assert.deepEqual(starts(d), [], 'nothing started on the host');
});

test('#120: the shim’s path is under the Postbox version the runtime passes in ctx.remote.version, never the protocol’s', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d, { remote: { version: '0.99.1' } }));
  const [start] = starts(d);
  assert.deepEqual(serverOf(start.argv).args, [`${HOME}/.postbox-remote/0.99.1/server/remote/host/shim.mjs`, start.turn]);
});

test('#120: a turn the person started in a side or topic thread (ctx.remote.bring) starts the shim with --bring', async () => {
  // So the shim lists bring_to_conversation where the laptop’s server/mcp.mjs would, and nowhere else.
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d, { remote: { bring: true } }));
  const [start] = starts(d);
  assert.deepEqual(serverOf(start.argv).args, [SHIM, start.turn, '--bring']);
  // Kiro CLI and Codex build theirs with the same helper.
  assert.deepEqual(shimArgs(/** @type {any} */ ({ bring: false }), SHIM, 't1'), [SHIM, 't1']);
});
