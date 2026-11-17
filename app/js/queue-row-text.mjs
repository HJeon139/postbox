// What a row of an agent’s queue says (#1456): what is waiting, by the entry’s source (server/delivery.mjs, SOURCES)
// and what it points at. An entry keeps no copy of its message, so a message’s words are its item’s, which the queue
// fetches when the page hasn’t loaded it.

/** A card’s name, as the person saw it: its title, else its block’s id. @param {any} item @param {string | undefined} blockId */
const cardName = (item, blockId) => `“${item?.block?.title ?? item?.block?.id ?? blockId ?? 'a card'}”`;

/**
 * What a queued entry’s row says, or null while its words are its item’s and the page doesn’t have the item.
 * - its own text (a check, a scheduled wake, a notice, a summary request, a message a stopped turn held): that text;
 * - the person’s message, an agent’s mention, or an app’s event (the line it posted in your voice): the item’s text;
 * - a slash command: the command, which the entry carries;
 * - an answer: to a card, the card by its title; to a permission, ask, consent or wake card, the notice it carries;
 * - a review: who reviewed which block.
 * @param {{ source: string, from?: string, text?: string, message?: any }} e
 * @param {any} item  the item the entry points at, when the page has it
 * @returns {string | null}
 */
export function queuedText(e, item) {
  if (typeof e.text === 'string') return e.text;
  const message = e.message;
  if (e.source === 'command') return message?.text ?? item?.text ?? null;
  if (e.source === 'answer' && message?.kind === 'notice') return String(message.text ?? '').replace(/^\[Postbox\]\s*/, '');
  if (e.source === 'answer') return `Your answer to ${cardName(item, message?.event?.blockId)}`;
  if (e.source === 'review') return `@${e.from}’s review of ${cardName(item, message?.event?.blockId)}`;
  return item?.text ?? null;
}

/** What a row says while its item is on its way, or couldn’t be fetched. @param {{ source: string, from?: string }} e */
export function placeholderText(e) {
  if (e.source === 'event') return 'An event from your app.';
  return e.from === 'you' ? 'Your message.' : `A message from @${e.from}.`;
}
