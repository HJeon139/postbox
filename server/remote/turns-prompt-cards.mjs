// Finding a host prompt’s card in its session’s conversation (#120). An AskUserQuestion prompt’s card is its choice
// blocks instead, one per question, each marked with the prompt and its part (server/ask-question.mjs, #1059): part 0
// stands for the prompt, and every part keeps the call’s answer once it has one.

import { sessionOfTurn } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/** Whether an item is an AskUserQuestion’s block. @param {any} it */
export const isQuestion = (it) => it.kind === 'block' && it.question === true;

/** Whether a host prompt’s card still waits on the person: a card still open, or a question whose call has no answer yet. @param {any} it */
export const isOpen = (it) => (isQuestion(it) ? !it.remote?.answer : it.status === 'open');

/** @param {any} i @param {string} turn */
const forTurn = (i, turn) => (i.kind === 'permission' || isQuestion(i)) && i.remote?.turn === turn;

/** The card for a host prompt, in its session’s conversation. @param {RemoteTurns} rts @param {string} turn @param {string} id */
export function cardOf(rts, turn, id) {
  return permissionCards(rts, turn).find((c) => c.it.remote?.prompt === id && (c.it.remote?.part ?? 0) === 0) ?? null;
}

/** An AskUserQuestion prompt’s blocks, by part, or none for a card. @param {RemoteTurns} rts @param {string} turn @param {string} id */
export const questionParts = (rts, turn, id) => permissionCards(rts, turn).filter((c) => isQuestion(c.it) && c.it.remote?.prompt === id);

/** Each open prompt’s card, once: a question counts by its part 0. @param {RemoteTurns} rts @param {string} turn */
export const openCards = (rts, turn) => permissionCards(rts, turn).filter((c) => isOpen(c.it) && (c.it.remote?.part ?? 0) === 0);

/** Every card for a host turn’s prompts, in its session’s conversation. @param {RemoteTurns} rts @param {string} turn */
export function permissionCards(rts, turn) {
  const se = sessionOfTurn(rts, turn);
  if (!se) return [];
  return rts.rt.threads.conversationThreads(se.threadId).flatMap((/** @type {string} */ threadId) =>
    rts.rt.store.pending
      .items(threadId)
      .filter((/** @type {any} */ i) => forTurn(i, turn))
      .map((/** @type {any} */ it) => ({ threadId, it })),
  );
}
