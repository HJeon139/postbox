// The player the bounce-loop tests share (tests/bounce-loop.test.mjs): each agent plays its own recorded replies, in
// order, as the room wakes it, and the room’s chain limit, set low, bounds each test as it bounds a room.

import { readFileSync } from 'node:fs';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const RUNS = JSON.parse(readFileSync(new URL('fixtures/uat/bounce-loops-2026-11-21.json', import.meta.url), 'utf8')).runs;
const DIR = tempDir('pb-bounce-loop-');
/** The room’s chain limit for these tests: past it a wake waits on a card, which ends the run. */
export const LIMIT = 40;

/** One agent’s recorded replies from a turn on: its words, and whether it reacted to the message that woke it. */
export const playsFrom = (run, handle, from) =>
  RUNS[run].turns.filter((t) => t.handle === handle && t.turn >= from).map((t) => ({ text: t.text, react: t.reactedToWaker }));

/** An adapter that plays each agent’s replies in order, repeating its last once they run out, as the runs did. */
class Recorded {
  name = 'mock';
  calls = [];
  constructor(plays) {
    this.plays = plays;
  }
  async folderFor() {
    return null;
  }
  fork() {}
  async deliver(session, message, ctx) {
    const se = this.rt.s.sessions[session.id];
    const mine = this.plays[se.handle];
    const play = mine.length > 1 ? mine.shift() : mine[0];
    this.calls.push({ handle: se.handle, text: message.text ?? '' });
    const waker = this.rt.store
      .items(se.threadId)
      .filter((i) => i.kind === 'agent' && i.handle !== se.handle && i.text?.trim())
      .at(-1);
    if (waker && play.react) ctx.tools.react({ id: waker.id, emoji: '✅' });
    // The person’s reaction is theirs: it ends no agent’s exchange.
    if (waker && play.personReacts) this.rt.threads.toggleReaction(se.threadId, waker.id, '👍', null);
    if (play.text) ctx.text(play.text);
    if (play.fail) throw new Error('Claude Code exited with code 1.');
    // Still at work, so what comes back meanwhile waits, and the next turn takes it together.
    if (play.busyMs) await new Promise((r) => setTimeout(r, play.busyMs));
  }
}

export function room(plays) {
  const store = new Store(null);
  const adapter = new Recorded(plays);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  adapter.rt = rt;
  store.emit('project', { id: 'p1', name: 'P', folder: DIR });
  const ids = Object.keys(plays).map((handle) => rt.createPersona({ handle }).id);
  const t = rt.createThread({ projectId: 'p1', title: 'UAT', personaIds: ids });
  rt.threads.patch(t.id, { chainLimit: LIMIT });
  return { store, rt, adapter, t };
}

export const settle = async (rt) => {
  for (let i = 0; i < 2000 && rt.turns.size; i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 10));
};
export const heldOnCard = (store, t) => store.items(t.id).some((i) => i.kind === 'hop' && i.status === 'open');
