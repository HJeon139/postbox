// Reactions (#251): the person reacts to a message, block or app with an emoji, as in Slack, and the room’s agents
// hear it as feedback in their next catch-up. A reaction lives on the item it’s on, so the store’s own event for it
// is the record: telemetry reads 🚩 as a flag and the rest as feedback (designs/telemetry-persona.md). Functions take
// the Runtime first, as server/side-threads.mjs’s do.

import { REACTIONS } from '../shared/reactions.mjs';
import { clipText, httpError } from './helpers.mjs';

export { REACTIONS };

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
  const had = (it.reactions ?? []).some((r) => r.emoji === emoji);
  const reactions = had ? it.reactions.filter((r) => r.emoji !== emoji) : [...(it.reactions ?? []), { emoji, at: Date.now() }];
  rt.patchItem(threadId, itemId, { reactions });
  return { ok: true, reactions };
}

/** Who an item is from, as an agent’s catch-up names them. */
const whose = (it) =>
  it.kind === 'user'
    ? 'your own message'
    : it.handle
      ? `@${it.handle}’s ${it.kind === 'block' ? (it.block?.type === 'app' ? 'app' : 'block') : 'message'}`
      : 'a message';

/** The first words of what was reacted to, to say which one. */
const firstWords = (it) => {
  const s = it.kind === 'block' ? String(it.block?.title ?? it.block?.fallback ?? '') : String(it.text ?? '');
  return clipText(s.replace(/\s+/g, ' ').trim(), 80);
};

/**
 * The reactions the person made in a thread since a time, as lines for an agent’s catch-up: each is told once, at the
 * agent’s next turn after it. One on the agent’s own message says so.
 * @param {any} rt @param {any} se  the agent @param {string} threadId @param {number} since
 */
export function reactionLines(rt, se, threadId, since) {
  const out = [];
  for (const it of rt.store.items(threadId))
    for (const r of it.reactions ?? []) {
      if (r.at <= since) continue;
      const at = new Date(r.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const mine = !!it.sessionId && it.sessionId === se.id;
      const words = firstWords(it);
      // “You” is the person in a catch-up, as in “You: …”; the agent’s own message is named, and marked as its own.
      out.push(`You reacted ${r.emoji} to ${whose(it)}${mine ? ' (yours: take it as feedback)' : ''} at ${at}${words ? `: “${words}”` : ''}`);
    }
  return out;
}
