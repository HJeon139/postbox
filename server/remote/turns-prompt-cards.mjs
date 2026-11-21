// Finding a host prompt’s card in its session’s conversation (#120), moved from turns-prompts.mjs unchanged.

import { sessionOfTurn } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/** The card for a host prompt, in its session’s conversation. @param {RemoteTurns} rts @param {string} turn @param {string} id */
export function cardOf(rts, turn, id) {
  const se = sessionOfTurn(rts, turn);
  if (!se) return null;
  for (const threadId of rts.rt.threads.conversationThreads(se.threadId)) {
    const it = rts.rt.store.pending
      .items(threadId)
      .find((/** @type {any} */ i) => i.kind === 'permission' && i.remote?.turn === turn && i.remote?.prompt === id);
    if (it) return { threadId, it };
  }
  return null;
}

/** @param {RemoteTurns} rts @param {string} turn */
export const openCards = (rts, turn) => permissionCards(rts, turn).filter((c) => c.it.status === 'open');

/** Every card for a host turn’s prompts, in its session’s conversation. @param {RemoteTurns} rts @param {string} turn */
export function permissionCards(rts, turn) {
  const se = sessionOfTurn(rts, turn);
  if (!se) return [];
  return rts.rt.threads.conversationThreads(se.threadId).flatMap((/** @type {string} */ threadId) =>
    rts.rt.store.pending
      .items(threadId)
      .filter((/** @type {any} */ i) => i.kind === 'permission' && i.remote?.turn === turn)
      .map((/** @type {any} */ it) => ({ threadId, it })),
  );
}
