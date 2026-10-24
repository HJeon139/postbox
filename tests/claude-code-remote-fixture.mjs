// Fixtures for tests/claude-code-remote.test.mjs, moved out of it: the Claude Code adapter on a remote host (#120), run
// against tests/fake-daemon.mjs through a minimal stand-in for the host link (server/remote/link.mjs).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMessageReader, encode, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { FAKE_TOKEN } from './fake-daemon.mjs';

const VERSION = '0.10.0';
export const HOME = '/home/user';
export const FOLDER = '/home/user/postbox-work/coder';
export const SHIM = `${HOME}/.postbox-remote/${VERSION}/server/remote/host/shim.mjs`;
export const HOUR = 60 * 60 * 1000;
export const until = async (fn, label) => {
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
export const welcomeWith = ({ version = '2.1.296', path = `${HOME}/.local/bin/claude` } = {}) => ({
  version: PROTOCOL_VERSION,
  home: HOME,
  node: { path: '/usr/bin/node', version: 'v22.12.0' },
  harnesses: [{ name: 'claude-code', path, version: path ? version : null, looked: path ? [] : [`${HOME}/.local/bin`, '/usr/local/bin'] }],
  problems: [],
  turns: [],
});

/** A local kill, ps and spawn that fail the test if they’re ever called. */
export function forbidden() {
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
export function remoteCtx(d, { settings = {}, welcome = welcomeWith(), state = {}, remote = {}, addDirs = [] } = {}) {
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

export const starts = (d) => d.received.filter((m) => m.type === 'start');
export const argOf = (argv, flag) => argv[argv.indexOf(flag) + 1];
export const serverOf = (argv) => JSON.parse(argOf(argv, '--mcp-config')).mcpServers.postbox;
