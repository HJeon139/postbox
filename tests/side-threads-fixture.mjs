// What the side-thread tests share: a runtime with three personas and a conversation, and an adapter the test
// scripts per call.

import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An adapter whose replies the test scripts per call; a step can hold its turn open until the test lets it go. */
export class ScriptedAdapter {
  name = 'mock';
  constructor() {
    this.calls = [];
    this.next = [];
    this.forks = [];
  }
  fork(source, target) {
    this.forks.push([source.id, target.id]);
  }
  async deliver(session, message, ctx) {
    this.calls.push({ handle: session.handle, sessionId: session.id, message, thread: ctx.thread.id, state: ctx.state });
    ctx.saveState({ backendSession: `cli-${session.id}` });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx, message, session);
  }
}

export function setup() {
  const store = new Store(null);
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha' });
  const b = rt.createPersona({ handle: 'beta' });
  const c = rt.createPersona({ handle: 'gamma' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id, b.id] });
  const [alpha, beta] = rt.sessionsIn(t.id);
  return { store, rt, adapter, t, a, b, c, alpha, beta };
}
export const settle = async (rt) => {
  for (let i = 0; i < 200 && (rt.turns.size || rt.exiting.size); i++) await sleep(5);
  await sleep(5);
};
/** A step that holds its turn open until release() is called. */
export function held() {
  let release = () => {};
  const done = new Promise((r) => {
    release = r;
  });
  return {
    release: () => release(),
    step: async (c) => {
      c.text('working on it');
      await done;
    },
  };
}
export const sideOf = (store, t) => Object.values(store.state.threads).find((x) => x.kind === 'side' && x.parentId === t.id);
export const sessionsOfPersona = (store, personaId) => Object.values(store.state.sessions).filter((x) => x.personaId === personaId);
