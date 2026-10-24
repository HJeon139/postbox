// The Kiro CLI adapter on a remote host (#120, L4b): a turn with ctx.remote set goes through the host’s daemon
// (server/remote/process.mjs’s remoteSpawn), here tests/fake-daemon.mjs over a minimal stand-in for the host link. No
// stream has been recorded from a remote Kiro turn yet, so the fake replays the local recordings in
// tests/fixtures/kiro-cli/ (kiro-cli 2.33.1, engine v3), which are what the daemon’s out.jsonl would hold: the runner
// appends the CLI’s stdout as it is.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRemoteMessage, KIRO_CAPABILITIES, KiroCliAdapter, kiroRemoteEnv, REMOTE_ARGV_NOTE } from '../server/adapters/kiro-cli.mjs';
import { createMessageReader, encode, message, PROTOCOL_VERSION, REMOTE_LIMITS } from '../shared/remote-protocol.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';

const VERSION = '0.10.0';
const HOME = '/home/user';
const FOLDER = '/home/user/postbox-work/kiro';
const SHIM = `${HOME}/.postbox-remote/${VERSION}/server/remote/host/shim.mjs`;

/** A recorded Kiro stream’s lines, as text. @param {string} name */
const fixtureLines = (name) =>
  readFileSync(new URL(`fixtures/kiro-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n');

const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/** The host link, as far as the remote process needs it (server/remote/link.mjs), over the fake daemon’s streams. */
function connectTo(d) {
  const conn = new EventEmitter();
  conn.setMaxListeners(0);
  let ready = false;
  /** @type {any} */
  let welcome = null;
  const reader = createMessageReader('daemon-to-postbox', {
    onMessage(m) {
      if (m.type === 'welcome') {
        ready = true;
        welcome = m;
        conn.emit('connected', m);
      } else conn.emit('message', m);
    },
    onError: (e) => assert.fail(`The fake daemon sent a bad line: ${e.message}`),
  });
  d.stdout.on('data', (b) => setImmediate(() => reader.push(b)));
  d.stdin.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN })));
  Object.defineProperty(conn, 'welcome', { get: () => welcome });
  return Object.assign(conn, {
    send(msg) {
      if (!ready) return false;
      d.stdin.write(encode(msg));
      return true;
    },
  });
}

/** The fake’s nth start, once it arrives. */
const startOf = async (d, n = 0) => {
  await until(() => d.received.filter((m) => m.type === 'start').length > n, `start ${n + 1}`);
  return d.received.filter((m) => m.type === 'start')[n];
};

/** Plays a recorded stream as turn `start.turn`’s out.jsonl, then ends it. */
const play = (d, start, name, code = 0) => {
  for (const l of fixtureLines(name)) d.append(start.turn, l);
  d.end(start.turn, { code, signal: null });
};

/** Turn IDs as the runtime allocates them: unique, persisted before deliver (and before nextTurn returns). */
let turnIds = 0;
const nextId = () => `kiro-turn-${++turnIds}`;

/** The adapter, with a local spawn, kill and ps that record each call: a remote turn never spawns here. */
function fakeAdapter(root, calls) {
  return new KiroCliAdapter({
    workRoot: join(root, 'work'),
    isolatedHome: join(root, 'home'),
    env: { SECRET: 'laptop', KIRO_HOME: '/Users/me/.kiro' },
    spawnImpl: /** @type {any} */ (
      () => {
        calls.spawn += 1;
        throw new Error('A remote turn never spawns here.');
      }
    ),
    kill: (pid, sig) => {
      calls.kill.push([pid, sig]);
    },
    listProcesses: async () => {
      calls.list += 1;
      return [];
    },
  });
}

async function setup({ persona = {}, state = {}, remote = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pb-kiro-remote-'));
  const d = createFakeDaemon({ lines: [], autoEnd: false, home: HOME });
  const link = connectTo(d);
  await until(() => link.welcome, 'the welcome');
  const turn = nextId();
  /** turns: every turn ID the runtime gave; startsAtNext: how many starts the daemon had when nextTurn was called */
  const calls = { text: '', activity: [], saved: {}, kill: [], list: 0, spawn: 0, turns: [turn], startsAtNext: [] };
  const abort = new AbortController();
  const adapter = fakeAdapter(root, calls);
  const ctx = {
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: {
      handle: 'kiro',
      model: 'claude-opus-5-5',
      permissionMode: 'ask',
      usesHostSetup: false,
      tools: [],
      description: '',
      instructions: '',
      ...persona,
    },
    project: { folder: '/Users/me/project' },
    addDirs: ['/Users/me/extra'],
    handles: ['kiro'],
    state: { ...state },
    saveState: (p) => Object.assign(calls.saved, p),
    pathOf: () => null,
    text: (t) => {
      calls.text += t;
    },
    activity: (a) => calls.activity.push(a),
    status: () => {},
    reported: () => {},
    remote: {
      link,
      welcome: link.welcome,
      settings: {},
      folder: FOLDER,
      version: VERSION,
      turn,
      async nextTurn() {
        calls.startsAtNext.push(d.received.filter((m) => m.type === 'start').length);
        const t = nextId();
        calls.turns.push(t);
        return t;
      },
      ...remote,
    },
  };
  return { root, d, adapter, ctx, calls, abort };
}

test('#120: a remote Isolated turn starts on the host with its agent file in Postbox’s own Kiro home there, and the shim as its server', async () => {
  const { root, d, adapter, ctx, calls } = await setup();
  const turn = adapter.deliver({}, { kind: 'user', text: 'Remember heron.' }, ctx);
  const start = await startOf(d);
  play(d, start, 'first');
  await turn;
  const kiroHome = `${HOME}/.postbox-remote/kiro-home/kiro`;
  assert.equal(start.harness, 'kiro-cli');
  assert.equal(start.folder, FOLDER);
  assert.equal(start.stdin, 'none');
  assert.deepEqual(start.env, { KIRO_HOME: kiroHome }, 'only KIRO_HOME crosses, never the laptop’s variables');
  assert.equal(start.argv[0], 'chat', 'no program: the daemon runs the kiro-cli it found');
  assert.deepEqual(start.argv.slice(-2), ['--', 'Remember heron.'], 'the message goes last, after --');
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

test('#120: a remote message over 128 KiB is refused before the turn starts, naming the limit', async () => {
  assert.doesNotThrow(() => checkRemoteMessage('x'.repeat(REMOTE_LIMITS.argBytes)));
  assert.throws(() => checkRemoteMessage('x'.repeat(REMOTE_LIMITS.argBytes + 1)), /128 KiB/);
  // Bytes, not characters: é is two.
  assert.throws(() => checkRemoteMessage('é'.repeat(64 * 1024)), /128 KiB/);
  const { d, adapter, ctx, calls } = await setup();
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'x'.repeat(130 * 1024) }, ctx), /Linux limits one argument to 128 KiB/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.received.filter((m) => m.type === 'start').length, 0);
  assert.equal(calls.activity.length, 0);
});

test('#120: a remote Kiro turn warns, as a step, that other users on the host can read its message; once, even when it starts over', async () => {
  const { d, adapter, ctx, calls } = await setup({ state: { kiroSessionId: 'sess_gone' } });
  const turn = adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  const first = await startOf(d, 0);
  play(d, first, 'missing-session', 1);
  const second = await startOf(d, 1);
  play(d, second, 'first');
  await turn;
  const notes = calls.activity.filter((a) => a.id === REMOTE_ARGV_NOTE.id);
  assert.ok(notes.length >= 1);
  assert.equal(new Set(notes.map((n) => n.id)).size, 1, 'one step: the runtime replaces a step with the same id');
  assert.equal(notes[0].state, 'done');
  assert.match(notes[0].label, /Other users on the host can read this message/);
  assert.match(notes[0].detail, /hidepid/);
  // The missing-session fallback is unchanged: a fresh turn on the host, without --resume-id, saying so.
  assert.ok(first.argv.includes('--resume-id'));
  assert.ok(!second.argv.includes('--resume-id'));
  assert.equal(first.turn, ctx.remote.turn);
  assert.deepEqual(calls.turns, [first.turn, second.turn], 'the fresh start is a second host turn, from nextTurn');
  assert.deepEqual(calls.startsAtNext, [1], 'nextTurn came before its start');
  assert.match(second.argv.at(-1), /fresh start/);
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

test('Kiro says how it runs on a remote host: no stdin, only KIRO_HOME, its agent file, an open tool call as work', () => {
  assert.deepEqual(KIRO_CAPABILITIES.remote, {
    stdin: 'none',
    env: ['KIRO_HOME'],
    server: 'agent-file',
    work: 'open-tool-call',
    signInError: null,
  });
  const a = new KiroCliAdapter({ workRoot: '/nowhere', isolatedHome: '/nowhere/kiro', models: ['gpt-5.6-terra'] });
  assert.equal(a.capabilities.remote, KIRO_CAPABILITIES.remote, 'the models don’t replace it');
  assert.deepEqual(JSON.parse(JSON.stringify(a.capabilities)).remote, KIRO_CAPABILITIES.remote);
});
