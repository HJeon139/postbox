// End on a subagent’s row (#229). Postbox can’t stop one subagent without stopping its agent’s whole turn, so it tells
// the agent, urgently: the person ended that subagent, so stop it with your own tools and don’t use its result. The
// note reaches the agent on the result of the next Postbox tool it calls in this turn (withUrgent). If the turn ends
// first, the subagent ended with it, so the note isn’t given at the next turn (notUrgent). The row reads “ending” until
// the subagent or the turn ends.

import { httpError } from './helpers.mjs';

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
  rt.updateSession(sessionId, {
    endingSubagents: [...(se.endingSubagents ?? []), subId],
    context: [
      ...(se.context ?? []),
      `${URGENT} the person ended your subagent ${what} (id ${subId}). If it’s still running, stop it now with your own tools, and don’t use its result.`,
    ].slice(-20),
  });
  return { ending: true };
}

/** A turn’s context without urgent notes from the turn before: the subagent they were about ended with it. */
export const notUrgent = (/** @type {string[]} */ context) => context.filter((x) => !x.startsWith(URGENT));

/**
 * A Postbox tool’s result text, with any urgent note for its agent first. A note given this way isn’t given again at
 * the agent’s next turn.
 * @param {any} rt @param {string} sessionId @param {string} text
 */
export function withUrgent(rt, sessionId, text) {
  const se = rt.s.sessions[sessionId];
  const urgent = (se?.context ?? []).filter((/** @type {string} */ x) => x.startsWith(URGENT));
  if (!urgent.length) return text;
  rt.updateSession(sessionId, { context: se.context.filter((/** @type {string} */ x) => !x.startsWith(URGENT)) });
  return `${urgent.join('\n')}\n\n${text}`;
}
