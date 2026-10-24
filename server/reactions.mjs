// Reactions (#251): the person and the agents react to a message, block or app with an emoji, as in Slack. The
// person’s are heard by the agents answering where it is; an agent’s, by the agent whose message it is, and
// either way at the next turn (server/thread-summary.mjs, reactionLines), never by waking anyone. A reaction lives on
// its item, with who made it: none for the person, and the agent’s session and handle for an agent. Its event carries
// what it was, { emoji, on, at, by? }, so the record of each one is the store’s own: telemetry reads 🚩 as a flag,
// whoever made it, and the rest as feedback (designs/telemetry-persona.md, R9).

import { REACTIONS } from '../shared/reactions.mjs';
import { httpError } from './helpers.mjs';

export { REACTIONS };

/** The act that reacts (POST …/items/<id>/act). An agent’s action ids can’t start with @, so none of theirs is this one. */
export const REACT = '@react';
const OFFERED = new Set(REACTIONS.map(([e]) => e));
/** What can be reacted to: what the person and the agents said and showed. */
const REACTABLE = new Set(['user', 'agent', 'block', 'shared']);

/** Whether a reaction is this reactor’s: the person’s has no `by`, an agent’s names its session. */
const whose = (r, by) => (r.by ?? null) === (by?.id ?? null);

/**
 * Adds a reaction to an item, or takes it back if this reactor’s is there: clicking one again removes it. Each
 * reactor has their own: the person taking back their 👍 leaves an agent’s.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {unknown} emoji
 * @param {{ id: string, handle: string } | null} [by]  the agent’s session, or null for the person
 * @returns {{ ok: true, on: boolean, reactions: { emoji: string, at: number, by?: string, handle?: string }[] }}
 */
export function toggleReaction(rt, threadId, itemId, emoji, by = null) {
  if (typeof emoji !== 'string' || !OFFERED.has(emoji)) throw httpError(422, `React with one of ${[...OFFERED].join(' ')}.`);
  const it = rt.store.item(threadId, itemId);
  if (!it) throw httpError(404, 'That message doesn’t exist any more.');
  if (!REACTABLE.has(it.kind) || (it.kind === 'block' && !it.valid)) throw httpError(409, 'You can react to a message, a block or an app.');
  if (it.status === 'streaming') throw httpError(409, 'That reply is still being written. React once it’s done.');
  if (it.deletedAgent) throw httpError(409, 'That agent was deleted, so it can’t hear a reaction.');
  const was = it.reactions ?? [];
  const on = !was.some((r) => r.emoji === emoji && whose(r, by));
  const at = Date.now();
  const mine = by ? { by: by.id, handle: by.handle } : {};
  const reactions = on ? [...was, { emoji, at, ...mine }] : was.filter((r) => !(r.emoji === emoji && whose(r, by)));
  rt.store.emit('item.patch', { threadId, id: itemId, patch: { reactions }, reaction: { emoji, on, at, ...(by ? { by: by.id } : {}) } });
  return { ok: true, on, reactions };
}

/**
 * The react tool: an agent reacts to any message, block or app in its conversation and its topic and side threads, its own
 * included, by the item’s id (read_conversation gives each one’s) or a block’s id. Calling it again takes it back.
 * @param {any} rt @param {any} se  the agent @param {{ id?: unknown, emoji?: unknown }} args
 */
export function reactTool(rt, se, { id, emoji } = {}) {
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, message: 'Name the item: react { id, emoji }, with an id from read_conversation, or a block’s id.' };
  const threads = rt.conversationThreads(se.threadId);
  const found = threads.flatMap((th) =>
    rt.store
      .items(th)
      .filter((i) => i.id === key || (i.kind === 'block' && i.valid && i.block?.id === key))
      .map((i) => [th, i]),
  );
  if (found.length > 1) return { ok: false, message: `More than one block is called “${key}”. React to one by its item id, from read_conversation.` };
  if (!found.length) return { ok: false, message: `There’s no item “${key.slice(0, 80)}” in this conversation. read_conversation gives each item’s id.` };
  const [[threadId, it]] = found;
  try {
    const r = toggleReaction(rt, threadId, it.id, emoji, { id: se.id, handle: se.handle });
    const what =
      it.sessionId === se.id
        ? 'your own message'
        : it.kind === 'user'
          ? 'the person’s message'
          : `@${it.handle}’s ${it.kind === 'block' ? 'block' : 'message'}`;
    return { ok: true, message: r.on ? `You reacted ${emoji} to ${what}.` : `You took back your ${emoji} on ${what}.` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
