// Fixtures for tests/kiro-cli-remote.test.mjs, moved out of it: the Kiro CLI adapter on a remote host (#120), run
// against tests/fake-daemon.mjs through a minimal stand-in for the host link (server/remote/link.mjs). No stream has
// been recorded from a remote Kiro turn yet, so the fake replays the local recordings in tests/fixtures/kiro-cli/.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { createMessageReader, encode, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';
export const VERSION = '0.10.0';
export const HOME = '/home/user';
export const FOLDER = '/home/user/postbox-work/kiro';
export const SHIM = `${HOME}/.postbox-remote/${VERSION}/server/remote/host/shim.mjs`;

/** A recorded Kiro stream’s lines, as text. @param {string} name */
export const fixtureLines = (name) =>
  readFileSync(new URL(`fixtures/kiro-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n');

export const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/** The host link, as far as the remote process needs it (server/remote/link.mjs), over the fake daemon’s streams. */
export function connectTo(d) {
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
export const startOf = async (d, n = 0) => {
  await until(() => d.received.filter((m) => m.type === 'start').length > n, `start ${n + 1}`);
  return d.received.filter((m) => m.type === 'start')[n];
};

/** Plays a recorded stream as turn `start.turn`’s out.jsonl, then ends it. */
export const play = (d, start, name, code = 0) => {
  for (const l of fixtureLines(name)) d.append(start.turn, l);
  d.end(start.turn, { code, signal: null });
};

/** Turn IDs as the runtime allocates them: unique, persisted before deliver (and before nextTurn returns). */
let turnIds = 0;
export const nextId = () => `kiro-turn-${++turnIds}`;

/** The adapter, with a local spawn, kill and ps that record each call: a remote turn never spawns here. */
export function fakeAdapter(root, calls) {
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

export async function setup({ persona = {}, state = {}, remote = {} } = {}) {
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
