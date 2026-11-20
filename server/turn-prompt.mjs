// Records what a turn sent its agent (shared/turn-prompts.mjs): each adapter calls ctx.prompt as the prompt leaves for
// its backend, with the system prompt Postbox appends (the guide) and the prompt’s exact text. A guide is recorded
// once per distinct text, and each prompt names it by its SHA-256, so the log doesn’t carry the guide every turn.

import { createHash } from 'node:crypto';

/** @type {WeakMap<any, Set<string>>} the guides each runtime has recorded since it started */
const recorded = new WeakMap();

/**
 * A turn’s prompt, as it leaves: `guide` when the adapter has it (an adapter that sets it once per turn passes it
 * alone, then each prompt with only its text), and `text`, the prompt itself.
 * @param {any} rt @param {any} turn @param {{ guide?: string | null, text?: string }} p @param {() => number} [now]
 */
export function recordTurnPrompt(rt, turn, { guide, text }, now = Date.now) {
  if (typeof guide === 'string') {
    const sha = createHash('sha256').update(guide).digest('hex');
    const mine = recorded.get(rt) ?? new Set();
    recorded.set(rt, mine);
    if (!mine.has(sha)) rt.store.emit('turn.guide', { sha, text: guide, at: now() });
    mine.add(sha);
    turn.guideSha = sha;
  }
  if (typeof text !== 'string') return;
  rt.store.emit('turn.prompt', { sessionId: turn.sessionId, turnId: turn.id, threadId: turn.threadId, guideSha: turn.guideSha ?? null, text, at: now() });
}
