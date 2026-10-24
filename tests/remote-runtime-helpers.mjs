// What the tests of remote hosts in the runtime and the API share (#120; tests/remote-runtime*.test.mjs): a fake host
// manager with the interface server/remote’s has, a backend that can run on a host, a runtime over them, and a clock
// the tests move by hand. No process, socket or ssh runs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await sleep(2);
  assert.ok(fn(), `Timed out waiting for ${label}`);
};
export const tick = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

/** A host manager with the interface the runtime uses, recording what it was asked. */
export class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {any[]} */
    this.calls = [];
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** @type {Map<string, any>} */
    this.links = new Map();
    this.onForget = (_id) => {};
    /** @type {Error | null} */
    this.installError = null;
    /** What removeFromHost rejects with, in place of the daemon’s `removed`. @type {Error | null} */
    this.removeError = null;
    this.onRemove = (_id) => {};
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  async forget(id) {
    this.calls.push(['forget', id]);
    this.onForget(id);
  }
  /** As the manager’s: resolves once the daemon said `removed`, or rejects with removeError. */
  async removeFromHost(id) {
    this.calls.push(['removeFromHost', id]);
    this.onRemove(id);
    if (this.removeError) throw this.removeError;
  }
  /** A link that’s connected, and answers a stop as the daemon does: with the turn’s `ended`, unless answerStops is off. */
  link(id) {
    const link =
      this.links.get(id) ??
      Object.assign(new EventEmitter(), {
        connected: true,
        answerStops: true,
        stops: /** @type {string[]} */ ([]),
        send(msg) {
          if (!this.connected) return false;
          if (msg.type === 'stop') {
            this.stops.push(msg.turn);
            if (this.answerStops) setImmediate(() => this.emit('message', { type: 'ended', turn: msg.turn, exit: { code: null, signal: 'SIGINT' }, size: 0 }));
          }
          return true;
        },
        retry: (o) => this.calls.push(['retry', id, o]),
      });
    this.links.set(id, link);
    return link;
  }
  async refresh(id) {
    this.calls.push(['refresh', id]);
    return false;
  }
  /** As install.mjs’s installHost answers, token and all; installError, when set, is thrown instead. */
  async install(id) {
    this.calls.push(['install', id]);
    if (this.installError) throw this.installError;
    return { token: 'T'.repeat(43), installed: true, version: '0.18.0' };
  }
  describeInstall(id) {
    return { destination: 'host.example.com', steps: [], text: `Install Postbox’s host program on host.example.com? (${id})` };
  }
  wake() {
    this.calls.push(['wake']);
  }
  need() {}
  release() {}
  async ensureWelcome() {
    return { home: '/home/user', turns: [] };
  }
  async signInCheck() {
    return null;
  }
  async close() {
    this.calls.push(['close']);
  }
}

export const REMOTE = { stdin: 'file', env: [], server: 'mcp-config', work: 'events', signInError: null };

/** A backend that can run on a host, whose turns run until they’re stopped; and the mock, which can’t. */
export class Held {
  name = 'claude-code';
  capabilities = { remote: REMOTE };
  constructor() {
    /** @type {string[]} */
    this.log = [];
    this.hang = new Set();
    /** Each handle’s last ctx.remote.bring. */
    this.bring = new Map();
  }
  async folderFor(persona, project) {
    return persona.folder || project?.folder || `/work/space/${persona.handle}`;
  }
  async deliver(session, _message, ctx) {
    this.log.push(`start:${session.handle}`);
    this.bring.set(session.handle, ctx.remote?.bring);
    await new Promise((r) => ctx.signal.addEventListener('abort', r, { once: true }));
    this.log.push(`stopped:${session.handle}`);
    // A turn whose process never ends, for the wait’s bound.
    if (this.hang.has(session.handle)) await new Promise(() => {});
  }
}
export const mock = { name: 'mock', deliver: async () => {} };

export function fakeSpawn() {
  const children = [];
  const spawn = (cmd, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), cmd, args, opts });
    child.kill = () => true;
    child.exit = (code) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

export function setup({ store = new Store(null), hosts = new FakeHosts() } = {}) {
  const adapter = new Held();
  const { spawn, children } = fakeSpawn();
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter).register(mock),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: '/nowhere', build: { version: '0.10.0' } },
    spawnShell: spawn,
    hosts,
  });
  if (!store.state.projects.p1) store.emit('project', { id: 'p1', name: 'P', folder: '/work/project' });
  return { store, rt, adapter, hosts, children };
}

/** Asserts a runtime call throws the HTTP error with that status, and returns its message. */
export function refused(fn, status = 422) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.status, status, e.message);
    return e.message;
  }
  assert.fail('expected a refusal');
}

/** A clock and an interval the test moves by hand. */
export function fakeClock(t0 = 1_000_000) {
  const c = {
    at: t0,
    /** @type {(() => void) | null} */
    fn: null,
    ms: 0,
    cleared: false,
    now: () => c.at,
    setInterval: (fn, ms) => {
      c.fn = fn;
      c.ms = ms;
      return { unref() {} };
    },
    clearInterval: () => {
      c.cleared = true;
    },
    /** The interval fires `ms` of wall-clock time after the last one. */
    pass(ms) {
      c.at += ms;
      c.fn?.();
    },
  };
  return c;
}
