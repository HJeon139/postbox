// What a turn’s items carry of what it was asked: the request, for Retry (#151), what woke it, for the sender line
// (#135), and the lint mark. A turn continued on a host (#120) carries what the turn it continues was asked
// (server/remote/turns-origin.mjs), so it reads as that turn did.

import { httpError } from './helpers.mjs';
import { keptMessage, readRef } from './remote/turns-origin.mjs';

/**
 * What a turn was asked, kept on its failed reply so Retry sends it again as it was, with its own kind (#151): a wake
 * answers the agent that asked again, and an agent’s or Postbox’s turn never comes back as the person’s. A continued
 * turn’s request too large to keep inline is a ref to it in Postbox’s store, with its kind, and one that couldn’t be
 * kept is lost (server/remote/turns-origin.mjs): askedAgain reads the one back and refuses the other. Null when
 * there’s nothing to send again: a turn attached again with no record of it, whose message only names the host turn.
 * @param {any} turn
 */
export const askedOf = ({ kind, asked: { message, messageRef, lost, replyTo, summarizeTo } }) => {
  const to = { replyTo: replyTo ?? null, summarizeTo: summarizeTo ?? null };
  if (messageRef) return { messageRef, kind, ...to };
  if (lost === true) return { lost: true, ...to };
  return !message || typeof message.attach === 'string' ? null : { message, ...to };
};

/** Retry’s refusal of a request that was kept and can’t be read back. */
const lostError = () =>
  httpError(409, 'Postbox couldn’t recover the request this reply answered, so Retry can’t send it again exactly. Send it again yourself to carry on.');

/**
 * What Retry sends again for a failed reply, handed to send: what it was asked (askedOf), a request kept in Postbox’s
 * store read back first, and for a reply from before #151, which kept nothing, the person’s last message, the best
 * guess. A request that was kept but can’t be read back exactly is refused, and nothing is sent in its place.
 * Returns what send does, or for one read back, a promise of it.
 * @param {any} rt @param {string} threadId @param {any} it  the failed reply
 * @param {(asked: { message: any, replyTo: string|null, summarizeTo: string|null }) => void} sendNow
 */
export function askedAgain(rt, threadId, it, sendNow) {
  // Checked before send marks the reply retried: a session archived (or gone) while a kept request was read would
  // otherwise use up the Retry with no turn started, since deliver refuses it only after.
  const send = (/** @type {any} */ asked) => {
    const sessions = rt.s?.sessions ?? {};
    const se = Object.hasOwn(sessions, it.sessionId) ? sessions[it.sessionId] : null;
    if (!se) throw httpError(409, 'The agent this reply was from isn’t in the conversation any more, so Retry can’t send it again.');
    if (se.archived) throw httpError(409, `@${se.handle}’s session is archived. Restore it first.`);
    return sendNow(asked);
  };
  const a = it.asked;
  if (!a) {
    const prior = [...rt.store.items(threadId)].reverse().find((/** @type {any} */ x) => x.kind === 'user' && x.at <= it.at);
    return send({ message: { kind: 'user', text: prior?.text ?? '', attachments: prior?.attachments ?? [] }, replyTo: null, summarizeTo: null });
  }
  if (a.lost === true) throw lostError();
  if (a.messageRef === undefined) return send(a);
  const ref = readRef(a.messageRef);
  if (!ref) throw lostError();
  return keptMessage(rt.blobs, ref, a.kind).then((message) => {
    if (!message) throw lostError();
    // A second Retry that came while this one read.
    if (rt.store.item(threadId, it.id)?.status !== 'failed') throw httpError(409, 'Only a failed reply can be retried.');
    return send({ message, replyTo: a.replyTo ?? null, summarizeTo: a.summarizeTo ?? null });
  });
}

/**
 * What woke a turn, on each item it shows, for its sender line (#135): another agent, with a message, or with its
 * answer to one (endTurn sends that with saidIn, where it answered); or a wake it scheduled. A continued turn shows
 * what woke the turn it continues.
 * @param {any} turn
 */
export const wokeOf = (turn) => {
  if (turn?.origin) return turn.origin.woke ? { woke: turn.origin.woke } : {};
  const m = turn?.asked?.message;
  if (m?.kind === 'wake') return { woke: { scheduled: true } };
  return m?.kind === 'agent' ? { woke: { by: String(m.from ?? '').replace(/^@/, ''), ...(m.saidIn ? { reply: true, in: m.saidIn } : {}) } } : {};
};

/** What each reply of a turn carries: what woke it, and that a reply to a lint message isn’t linted again, by the turn or by the browser’s diagram check. @param {any} turn */
export const replyMarks = (turn) => ({ ...(turn.kind === 'lint' ? { lintReply: true } : {}), ...wokeOf(turn) });
