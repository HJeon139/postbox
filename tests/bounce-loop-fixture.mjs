// The player the bounce-loop tests share (tests/bounce-loop.test.mjs): each agent plays its own recorded replies, in
// order, as the room wakes it, and stops at LIMIT turns, which bounds each test. The chain’s own cap is 1,000 wakes,
// fixed for the server since #1623, so it can’t be set low for one room.

import { readFileSync } from 'node:fs';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { HOP_LIMIT } from '../shared/limits.mjs';
import { tempDir } from './temp-dirs.mjs';

const runsOf = (file) => JSON.parse(readFileSync(new URL(`fixtures/uat/${file}`, import.meta.url), 'utf8')).runs;
/** The runs of 21 November (#1553), and the batch 9–10 UAT’s of 23 November (#1591), whose rows also say what woke each turn. */
const RUNS = { ...runsOf('bounce-loops-2026-11-21.json'), ...runsOf('ack-loops-2026-11-23.json') };
const DIR = tempDir('pb-bounce-loop-');
/** The turns these tests run at most: past it the player says nothing, which ends the run. */
export const LIMIT = 40;
// The chain’s cap must sit past the player’s limit, or it ends a loop first and the tests read it as ended by a rule.
// A POSTBOX_CHAIN_LIMIT exported from UAT work lowers it for the whole process.
if (HOP_LIMIT <= LIMIT)
  throw new Error(`The bounce-loop tests need the chain’s cap past ${LIMIT} wakes; POSTBOX_CHAIN_LIMIT sets it to ${HOP_LIMIT}. Unset it to run them.`);

/** One agent’s recorded replies from a turn on: its words, and whether it reacted to the message that woke it. */
export const playsFrom = (run, handle, from) =>
  RUNS[run].turns.filter((t) => t.handle === handle && t.turn >= from).map((t) => ({ text: t.text, react: t.reactedToWaker }));

/**
 * One agent’s recorded replies to another alone, in order: its turns that only the other’s messages woke, so a pair
 * plays its own exchange out of a run with three agents. `first` is the turn that opens the exchange in the test.
 */
export const playsWith = (run, handle, other, first = null) =>
  RUNS[run].turns
    .filter((t) => t.handle === handle && (t.turn === first || (t.turn > (first ?? 0) && t.wokeBy.join() === other)))
    .map((t) => ({ text: t.text, react: t.reactedToWaker, step: t.otherToolCalls > 0 }));

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
    if (this.calls.length > LIMIT) return;
    const waker = this.rt.store
      .items(se.threadId)
      .filter((i) => i.kind === 'agent' && i.handle !== se.handle && i.text?.trim())
      .at(-1);
    if (waker && play.react) ctx.tools.react({ id: waker.id, emoji: '✅' });
    // The person’s reaction is theirs: it ends no agent’s exchange.
    if (waker && play.personReacts) this.rt.threads.toggleReaction(se.threadId, waker.id, '👍', null);
    // Work of its own: a tool call that shows as a step, which a reaction doesn’t (tool-labels.mjs, QUIET).
    if (play.step) ctx.activity({ id: `step-${this.calls.length}`, label: 'Ran npm test', state: 'done' });
    // One of Postbox’s read tools that shows as a step, as the harness reports it (harness-tools.mjs).
    if (play.reads) ctx.activity({ id: `read-${this.calls.length}`, label: 'list assets (postbox)', state: 'done', postbox: true });
    // One of Postbox’s tools that acts, called in Postbox’s own process, as the mock backend calls them.
    if (play.shows) ctx.tools.show_block({ block: { ...play.shows, id: `pick-${this.calls.length}` } });
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
  return { store, rt, adapter, t };
}

export const settle = async (rt) => {
  for (let i = 0; i < 2000 && rt.turns.size; i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 10));
};
/** Whether the run went past LIMIT turns, where the player stopped it: a loop the room didn’t end. */
export const hitLimit = (adapter) => adapter.calls.length > LIMIT;
