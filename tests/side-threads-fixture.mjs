// What the side-thread tests share: a runtime with three personas and a conversation, an adapter the test scripts per
// call, and a side thread as Postbox made them before #372, which tests build to read one.

import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { newId, Store } from '../server/store.mjs';

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
export const sessionsOfPersona = (store, personaId) => Object.values(store.state.sessions).filter((x) => x.personaId === personaId);

/**
 * A side thread as a wake from @alpha to @beta opened one before #372: its line in the conversation, then the wake and
 * @beta’s answer in it, as many as texts has, taking turns. Side threads are history now, read but not written in.
 */
export function oldSide({ rt, t, alpha, beta }, texts = ['Which editions?', 'The 1908 one differs.']) {
  const side = rt.putThread({
    id: newId('th'),
    projectId: t.projectId,
    title: '@alpha ↔ @beta',
    kind: 'side',
    parentId: t.id,
    pair: 'alpha|beta',
    woke: 'beta',
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
    archived: false,
  });
  rt.addItem(t.id, { kind: 'sidelink', sideThreadId: side.id, from: 'alpha', to: 'beta', count: 0 });
  texts.forEach((text, i) => {
    const se = i % 2 ? beta : alpha;
    rt.addItem(side.id, {
      kind: 'agent',
      sessionId: se.id,
      personaId: se.personaId,
      handle: se.handle,
      text,
      status: 'done',
      ...(i % 2 ? {} : { hop: i / 2 + 1 }),
    });
  });
  return rt.s.threads[side.id];
}
