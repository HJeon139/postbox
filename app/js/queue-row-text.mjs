// What a row of an agent’s queue says (#1456): what is waiting, by the entry’s source (server/delivery.mjs, SOURCES)
// and what it points at, in the person’s words. An entry keeps no copy of its message, so a message’s words are its
// item’s, and an answer is told from the card it answers: the queue fetches either when the page hasn’t loaded it.

/** A block’s name, as the person saw it: its title, else the fallback every block has, else its id. @param {any} block */
const blockName = (block) => `“${block?.title ?? block?.fallback ?? block?.id}”`;

/**
 * A declined wake card’s answer, for the agent whose queue it waits in: the agent the card asked for, or another whose
 * wake was held on it (server/wake-cards.mjs, settleHeld). @param {any} card @param {string} sessionId
 */
function declinedWake(card, sessionId) {
  const declined = card.join ? `You didn’t add @${card.to} to this conversation` : `You didn’t allow @${card.from} to wake @${card.to}`;
  const held = card.fromSessionId === sessionId ? null : card.held?.find((/** @type {any} */ w) => w.fromSessionId === sessionId);
  return held ? `${declined}, so @${held.from}’s message to @${held.to}, held on that card, didn’t go` : declined;
}

/**
 * The person’s answer, told from the card it answers, as the line it posted in their voice says it
 * (server/permission-cards.mjs, tool-ask.mjs, view-app/consent.mjs and wake-cards.mjs).
 * @param {any} card @param {string} sessionId  the agent whose queue it waits in
 */
function answerTo(card, sessionId) {
  switch (card.kind) {
    case 'denial':
      if (card.status === 'allowed-once') return `You allowed @${card.handle} once to ${card.summary}`;
      if (card.status === 'allowed-always') return `You always allowed ${card.rules?.alwaysWords ?? 'it'}: @${card.handle} to ${card.summary}`;
      return `You left @${card.handle}’s step refused: ${card.summary}`;
    case 'toolask':
      return card.status === 'on' ? `You turned on “${card.label}” for @${card.handle}` : `You kept “${card.label}” off for @${card.handle}`;
    case 'viewask':
      if (card.status === 'declined') return `You chose not to download the browser for @${card.handle}’s app`;
      if (card.status === 'failed') return `You allowed the browser download for @${card.handle}’s app, and it failed`;
      return `You allowed the browser download for @${card.handle}’s app`;
    case 'hop':
      return declinedWake(card, sessionId);
    default:
      return `Your answer to ${blockName(card.block)}`;
  }
}

/**
 * What a queued entry’s row says, or null while it’s told from an item the page doesn’t have.
 * - its own text (a check, a scheduled wake, a notice, a summary request, a message a stopped turn held): that text;
 * - the person’s message, an agent’s mention, or an app’s event (the line it posted in your voice): the item’s text;
 * - a slash command: the command, which the entry carries;
 * - an answer: told from the card it answers;
 * - a review: who reviewed which block.
 * @param {{ source: string, sessionId: string, from?: string, text?: string, message?: any }} e
 * @param {any} item  the item the entry points at, when the page has it
 * @returns {string | null}
 */
export function queuedText(e, item) {
  if (typeof e.text === 'string') return e.text;
  if (e.source === 'command') return e.message?.text ?? item?.text ?? null;
  if (!item) return null;
  if (e.source === 'answer') return answerTo(item, e.sessionId);
  if (e.source === 'review') return `@${e.from}’s review of ${blockName(item.block)}`;
  return item.text ?? null;
}

/** What a row says while its item is on its way, or couldn’t be fetched. @param {{ source: string, from?: string }} e */
export function placeholderText(e) {
  if (e.source === 'answer') return 'Your answer.';
  if (e.source === 'review') return `A review from @${e.from}.`;
  if (e.source === 'event') return 'An event from your app.';
  return e.from === 'you' ? 'Your message.' : `A message from @${e.from}.`;
}
