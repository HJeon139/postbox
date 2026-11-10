// What the archive pass’s specs share (#305; designs/305-archive-turns.md, “Write path”): a conversation with a topic
// thread off it, and turns of work, each with its `turn` entry, two commands and a reply with one activity step.

import { memoryBlobs } from '../server/ledger-io.mjs';
import { Store } from '../server/store.mjs';
import { archiveTurns } from '../server/work-archive.mjs';

export const C = 'th_c';
export const TOPIC = 'th_topic';

/** The fields that name the agent that made an entry or a reply, as the ledger’s `base` and replySegment set them. */
export const who = (/** @type {string} */ agent) => ({ sessionId: `se_${agent}`, handle: agent });

/**
 * One turn: its `turn` entry, two commands and a reply, at `at` and just after.
 * @param {Store} store @param {string} turnId @param {string} agent
 * @param {{ at: number, where?: string, commands?: number, reply?: boolean, work?: boolean }} o
 */
export function addTurn(store, turnId, agent, { at, where = C, commands = 2, reply = true, work = true }) {
  const by = { turnId, threadId: where, ...who(agent) };
  if (work) {
    const turn = { id: turnId, kind: 'turn', ...by, startedAt: at, status: 'done', ms: 100, toolCalls: commands };
    store.emit('work.add', { convId: C, entry: { ...turn, costUsd: 0.01, tokens: { input: 3, output: 2 } } });
    for (let i = 1; i <= commands; i++)
      store.emit('work.add', { convId: C, entry: { id: `w_${turnId}_${i}`, kind: 'command', ...by, command: `npm test ${i}`, state: 'done', at: at + i } });
  }
  if (reply) {
    const activity = { steps: [{ id: 's1', label: 'Read', detail: `${turnId} detail` }] };
    store.emit('item.add', { threadId: where, item: { id: `r_${turnId}`, kind: 'agent', ...who(agent), turnId, text: 'done', at: at + 5, activity } });
  }
}

/**
 * A store with the conversation, its topic thread and the turns, ten apart, oldest first.
 * @param {[string, string, string?][]} turns  [turnId, agent, thread]
 */
export function room(
  turns = [
    ['t1', 'alpha'],
    ['t2', 'alpha', TOPIC],
    ['t3', 'alpha'],
  ],
  store = new Store(null),
) {
  store.emit('thread', { id: C, members: [] });
  store.emit('thread', { id: TOPIC, kind: 'topic', parentId: C, members: [] });
  for (const [k, [turnId, agent, where]] of turns.entries()) addTurn(store, turnId, agent, { at: (k + 1) * 10, where });
  return store;
}

export const summaries = (/** @type {Store} */ store) => (store.state.work[C] ?? []).filter((e) => e.kind === 'turn-archive');
export const archived = (/** @type {Store} */ store) => summaries(store).map((e) => e.turnId);

/** The pass on the conversation, with nothing running unless `running` says so. @param {Store} store @param {any} [o] */
export const pass = (store, o = {}) => archiveTurns({ store, blobs: memoryBlobs(), convId: C, running: new Set(), ...o });
