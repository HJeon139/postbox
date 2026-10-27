// A Runtime with one scripted agent, for the block tests (blocks.test.mjs, block-outcomes.test.mjs).

import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An adapter whose turns the test scripts, one step per turn. */
class ScriptedAdapter {
  name = 'mock';
  calls = [];
  next = [];
  async folderFor() {
    return null;
  }
  fork() {}
  async deliver(session, message, ctx) {
    this.calls.push({ sessionId: session.id, message });
    ctx.checkpoint?.({ turn: this.calls.length });
    await (this.next.shift() ?? (async (c) => c.text('ok')))(ctx, message);
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
  const a = rt.createPersona({ handle: 'critic' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  return { store, rt, adapter, t };
}
export const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
/** Runs one turn of the agent, which does `step`, and returns what the step returned. */
export async function turn(rt, adapter, t, step, text = 'go') {
  let out;
  adapter.next.push(async (c) => {
    out = await step(c.tools);
    c.text('Done.');
  });
  rt.sendMessage(t.id, { text });
  await settle(rt);
  return out;
}

export const choice = {
  id: 'review-outcome-gap',
  type: 'choice',
  version: 1,
  title: 'Where should I report this?',
  fallback: 'Where should I report this?',
  options: [
    { id: 'issue', label: 'A new issue' },
    { id: 'comment', label: 'A comment on #94' },
  ],
};
export const review = {
  id: 'issue-agents-rail',
  type: 'review',
  version: 1,
  title: 'issue.md',
  fallback: 'The draft issue',
  format: 'markdown',
  content: '# Draft',
};
