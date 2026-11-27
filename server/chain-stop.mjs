// The wake chain’s loop guard (#1623; designs/intent.md, principle 6): agents that keep waking each other without the
// person stop at HOP_LIMIT wakes in a row. The wake past it doesn’t go, the room shows one line, and its agent is told.
// Nothing waits on the person: their next message, or the room going quiet (endChain), starts the count again. The
// wake-limit cards from before close at startup (wake-cards.mjs, closeOrphanCards). Functions take the Runtime first.

import { HOP_LIMIT } from '../shared/limits.mjs';

/** The wakes count, as a person reads it: 1,000. */
const cap = HOP_LIMIT.toLocaleString('en-US');

/** What an agent whose wake the guard refused is told, as the call’s result or a note at its next turn. */
export const CHAIN_STOPPED = `agents in this conversation woke each other ${cap} times in a row without the person, so Postbox stopped the chain. Finish your turn; the person’s next message starts it again.`;

/**
 * The count a stopped chain is left at: past any cap POSTBOX_CHAIN_LIMIT allows, so a chain stays stopped, and is told
 * apart from one merely counted past the cap, as a cap lowered across a restart leaves it. Every reset sets it to 0.
 */
const STOPPED = Number.MAX_SAFE_INTEGER;

/**
 * Whether the conversation’s chain is at the cap: the next wake would be past it. A stopped chain is too.
 * @param {any} parent  the conversation, read pending
 */
export const atCap = (parent) => (parent.hops ?? 0) >= HOP_LIMIT;

/**
 * Refuses a wake at the cap. The first refusal in a chain posts the room’s one line, and marks the chain stopped, so
 * the refusals after it post nothing; every reset of the count sets it back to 0.
 * @param {any} rt @param {any} parent  the conversation, read pending
 */
export function stopChain(rt, parent) {
  if (parent.hops !== STOPPED) {
    rt.threads.patch(parent.id, { hops: STOPPED });
    rt.threads.addItem(parent.id, { kind: 'system', variant: 'chain-stopped', wakes: HOP_LIMIT });
  }
  return { ok: false, message: CHAIN_STOPPED };
}
