// Reactions (#251): the person reacts to a message, block or app with an emoji, as in Slack, and the agents answering
// where it is hear it as feedback at their next turn (server/thread-summary.mjs, reactionLines). A reaction lives on its
// item, and its event carries what it was, { emoji, on, at }, so the record of each one is the store’s own: telemetry
// reads 🚩 as a flag and the rest as feedback (designs/telemetry-persona.md, R9).

import { REACTIONS } from '../shared/reactions.mjs';
import { httpError } from './helpers.mjs';

export { REACTIONS };

/** The act that reacts (POST …/items/<id>/act). An agent’s action ids can’t start with @, so none of theirs is this one. */
export const REACT = '@react';
const OFFERED = new Set(REACTIONS.map(([e]) => e));
/** What a person can react to: what they and the agents said and showed. */
const REACTABLE = new Set(['user', 'agent', 'block', 'shared']);

/**
 * Adds a reaction to an item, or takes it back if it’s there: clicking one again removes it.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {unknown} emoji
 * @returns {{ ok: true, reactions: { emoji: string, at: number }[] }}
 */
export function toggleReaction(rt, threadId, itemId, emoji) {
  if (typeof emoji !== 'string' || !OFFERED.has(emoji)) throw httpError(422, `React with one of ${[...OFFERED].join(' ')}.`);
  const it = rt.store.item(threadId, itemId);
  if (!it) throw httpError(404, 'That message doesn’t exist any more.');
  if (!REACTABLE.has(it.kind) || (it.kind === 'block' && !it.valid)) throw httpError(409, 'You can react to a message, a block or an app.');
  if (it.status === 'streaming') throw httpError(409, 'That reply is still being written. React once it’s done.');
  if (it.deletedAgent) throw httpError(409, 'That agent was deleted, so it can’t hear a reaction.');
  const on = !(it.reactions ?? []).some((r) => r.emoji === emoji);
  const at = Date.now();
  const reactions = on ? [...(it.reactions ?? []), { emoji, at }] : it.reactions.filter((r) => r.emoji !== emoji);
  rt.store.emit('item.patch', { threadId, id: itemId, patch: { reactions }, reaction: { emoji, on, at } });
  return { ok: true, reactions };
}
