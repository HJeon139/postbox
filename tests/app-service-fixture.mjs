// The Apps rig its interface tests share (tests/app-service.test.mjs, tests/app-service-review.test.mjs): Apps over an
// in-memory store, the real Bus, Threads and Running, and fakes of Sessions, Personas, Assets, Checks, Delivery and the
// `send` port that record what they were given. It never builds Runtime.

import { Apps } from '../server/app-service.mjs';
import { Bus } from '../server/bus.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';
import { Threads } from '../server/threads.mjs';

/** Apps over a store with one agent in a conversation; `blobs` is what the asset store holds, by hash. */
export function rig({ tools = [], blobs = { f1: Buffer.from('data') } } = {}) {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: '/work' });
  store.emit('thread', { id: 'th_c', projectId: 'p1', title: 'C', kind: 'thread', parentId: null, members: ['se_1', 'se_2'], queue: [], createdAt: 1 });
  store.emit('session', { id: 'se_1', personaId: 'pe_a', threadId: 'th_c', handle: 'alpha', backend: 'mock', lastTurnId: 'tu_0' });
  store.emit('session', { id: 'se_2', personaId: 'pe_b', threadId: 'th_c', handle: 'beta', backend: 'mock' });
  const bus = new Bus();
  /** @type {[string, any][]} */
  const signals = [];
  for (const s of ['app.retired', 'block.withdrawn']) bus.on(s, (data) => signals.push([s, data]));
  const threads = new Threads({ store, bus });
  const running = new Running();
  const sessions = {
    get: (/** @type {string} */ id) => {
      const se = store.state.sessions[id];
      if (!se) throw Object.assign(new Error('That session doesn’t exist.'), { status: 404 });
      return se;
    },
  };
  const personas = { forSession: () => ({ handle: 'alpha', tools }) };
  /** @type {any[]} */
  const searched = [];
  const assets = {
    blobs: blobs && { get: async (/** @type {string} */ sha) => blobs[sha] },
    search: async (room, args) => {
      searched.push([room, args]);
      return [{ name: 'a.md' }];
    },
    listText: async () => [],
  };
  /** @type {any[]} */
  const linted = [];
  const checks = { lint: (sessionId, turnId, problems) => linted.push({ sessionId, turnId, problems }) };
  /** @type {any[]} */
  const sent = [];
  const send = (sessionId, message, opts) => sent.push({ sessionId, message, opts });
  const entries = /** @type {any[]} */ ([]);
  const delivery = { send: (/** @type {any} */ e) => entries.push(e), waiting: () => [], takenBy: () => [], deliveredNow: () => {} };
  const apps = new Apps({ store, bus, threads, sessions, personas, assets, running, checks, delivery, send, narrator: null, config: { imageOrigins: [] } });
  return { store, threads, running, apps, sent, entries, linted, signals, searched };
}
