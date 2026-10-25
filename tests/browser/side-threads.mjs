// What the side-thread specs share (#121, #110, #225): @indexer and @researcher on a fake Claude Code backend that
// holds each turn open until a test lets it go or Stop aborts it, so no real agent runs, and a room of their own for
// each test, with the helpers to wake one, find its side thread and wait for its turns.

import { expect } from '@playwright/test';

/**
 * Registers the fake backend on a spec’s Postbox and moves @indexer and @researcher to it. turns lists every turn it
 * was sent; scripts says what a session’s next turn does, by session id, and otherwise the turn holds until release().
 * @param {{ rt: any, store: any, root: string }} app
 */
export function heldBackend(app) {
  const { rt, store } = app;
  /** @type {{ sessionId: string, thread: string, text: string, context: string[] }[]} */
  const turns = [];
  /** @type {Map<string, (ctx: any) => any>} */
  const scripts = new Map();
  const releases = new Map();
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    fork() {},
    async deliver(session, message, ctx) {
      turns.push({ sessionId: session.id, thread: ctx.thread.id, text: message.text ?? '', context: message.context ?? [] });
      const script = scripts.get(session.id);
      scripts.delete(session.id);
      if (script) return script(ctx);
      ctx.status({ state: 'tool', currentStep: 'Reading the shelf' });
      await new Promise((r) => {
        releases.set(session.id, r);
        ctx.signal.addEventListener('abort', r);
      });
      if (!ctx.signal.aborted) ctx.text('Done.');
    },
  });
  const personaNamed = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
  for (const handle of ['indexer', 'researcher'])
    store.emit('persona', { ...personaNamed(handle), backend: 'claude-code', model: 'claude-opus-5-5', version: (personaNamed(handle).version ?? 1) + 1 });
  return { turns, scripts, release: (id) => releases.get(id)?.() };
}

/**
 * A room of its own with @indexer and @researcher. wake() has one agent wake another as if the person had just
 * written (the wake limit, #108, isn’t what these check); sideOf() is the room’s side thread; idle() waits until
 * neither agent has a turn running or exiting; stop() stops both, for a test’s end.
 * @param {{ rt: any, store: any }} app  @param {string} title
 */
export function sideRoom(app, title) {
  const { rt, store } = app;
  const personaNamed = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
  const room = rt.createThread({
    projectId: Object.keys(store.state.projects)[0],
    title,
    personaIds: [personaNamed('indexer').id, personaNamed('researcher').id],
  });
  const sessionIn = (handle) => rt.sessionsIn(room.id).find((x) => x.handle === handle);
  const [indexer, researcher] = [sessionIn('indexer'), sessionIn('researcher')];
  const ids = () => rt.sessionsIn(room.id).map((x) => x.id);
  return {
    room,
    indexer,
    researcher,
    sessionIn,
    sideOf: () => Object.values(store.state.threads).find((t) => t.kind === 'side' && t.parentId === room.id),
    busy: (id) => ['think', 'gen', 'tool', 'needs'].includes(store.state.sessions[id]?.state),
    wake(from, handle, text) {
      rt.putThread({ ...store.state.threads[room.id], hops: 0 });
      return rt.agentWake(from, handle, text);
    },
    idle: () => expect.poll(() => ids().some((id) => rt.turns.has(id) || rt.exiting.has(id)), { message: 'the room’s agents to finish' }).toBe(false),
    stop() {
      for (const id of ids()) if (rt.turns.has(id)) rt.stop(id);
    },
  };
}
