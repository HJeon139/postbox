// End on a subagent’s row (#229). Postbox can’t stop one subagent without stopping its agent’s whole turn, so it tells
// the agent, urgently: the person ended that subagent, so stop it with your own tools and don’t use its result. The
// note reaches the agent on the result of the next Postbox tool it calls in this turn (withUrgent). If the turn ends
// first, the subagent ended with it, so the note isn’t given at the next turn (notUrgent). The row reads “ending” until
// the subagent or the turn ends.

import { httpError } from './helpers.mjs';
import { newerFromSender } from './newer-waiting.mjs';

const URGENT = '[Postbox] URGENT:';

/**
 * @param {any} rt @param {string} sessionId  the agent whose subagent it is @param {string} subId  the subagent’s id
 * @returns {{ ending: true }}
 */
export function endSubagent(rt, sessionId, subId) {
  const se = rt.session(sessionId);
  const sub = (se.subagents ?? []).find((x) => x.id === subId);
  if (!sub || !rt.turns.has(sessionId)) throw httpError(409, 'That subagent has already ended.');
  if ((se.endingSubagents ?? []).includes(subId)) return { ending: true };
  const what = sub.asked && sub.asked !== sub.name ? `${sub.name}, asked “${sub.asked}”` : sub.name;
  // From the pending session: a notice still held behind a commit stays in the context (#796's class in sessions).
  rt.updateSession(sessionId, (now) => ({
    endingSubagents: [...(now.endingSubagents ?? []), subId],
    context: [
      ...(now.context ?? []),
      `${URGENT} the person ended your subagent ${what} (id ${subId}). If it’s still running, stop it now with your own tools, and don’t use its result.`,
    ].slice(-20),
  }));
  return { ending: true };
}

/** A turn’s context without urgent notes from the turn before: the subagent they were about ended with it. */
export const notUrgent = (/** @type {string[]} */ context) => context.filter((x) => !x.startsWith(URGENT));

/**
 * A Postbox tool’s result text, with any urgent note for its agent first. A note given this way isn’t given again at
 * the agent’s next turn. `turn` is the turn that made the call, taken before its tool ran.
 * @param {any} rt @param {string} sessionId @param {string} text @param {any} turn
 */
export function withUrgent(rt, sessionId, text, turn) {
  // Pending: an urgent note, or another notice, still held behind a commit is given, or kept for the next turn (#796's class).
  const se = rt.store.pending.session(sessionId);
  const urgent = (se?.context ?? []).filter((/** @type {string} */ x) => x.startsWith(URGENT));
  if (urgent.length) rt.updateSession(sessionId, (now) => ({ context: now.context.filter((/** @type {string} */ x) => !x.startsWith(URGENT)) }));
  // A newer message from the sender the agent is answering, waiting in this thread (#694), comes after any urgent note.
  const notes = [...urgent, ...newerFromSender(rt, sessionId, turn)];
  return notes.length ? `${notes.join('\n')}\n\n${text}` : text;
}
