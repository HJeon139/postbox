// The composer’s rows for messages not sent yet, from the outbox (#427): they aren’t any agent’s queue, so they’re
// drawn apart from it.

import { h, icon } from './dom.mjs';

/** How many offline messages show as rows before the rest are counted (#427, V1). */
const OFFLINE_ROWS = 2;
/** What each unsent message’s row says, by what the outbox waits on. */
const WAITING = { connection: 'Waiting for the connection', soon: 'Not sent yet. Trying again', slow: 'Not sent yet' };

/**
 * Offline messages aren’t assigned to an agent yet, so they remain in the composer without duplicating on repaint:
 * at most two rows, then one line counting the rest, so the composer stays bounded. Past the quick tries with the
 * connection open, a last line says what the page saw and that it goes on trying, with Send now.
 * @param {Element} container @param {any[]} messages
 * @param {{ wait?: 'connection' | 'soon' | 'slow', sendNow?: () => void }} [how]
 */
export function paintOfflineQueue(container, messages, { wait = 'connection', sendNow = () => {} } = {}) {
  const more = messages.length - OFFLINE_ROWS;
  const label = WAITING[wait];
  const slow = wait === 'slow' && messages.length > 0;
  const moreText = wait === 'connection' ? `and ${more} more waiting for the connection` : `and ${more} more not sent yet`;
  container.replaceChildren(
    ...messages
      .slice(0, OFFLINE_ROWS)
      .map((message) =>
        h(
          'div.queued',
          { dataset: { key: `offline-${message.threadId}-${message.text}-${message.attachments?.length ?? 0}` } },
          icon('clock', 'dim'),
          h('span.q-text', h('span.small.dim', label), h('br'), message.text),
        ),
      ),
    ...(more > 0 ? [h('div.queued.small.dim', { dataset: { key: 'offline-more' } }, moreText)] : []),
    ...(slow ? [slowLine(sendNow)] : []),
  );
}

/** The line past the quick tries. The page saw only that no answer came, so it says that, not why. */
function slowLine(sendNow) {
  return h(
    'div.queued.outbox-slow',
    { dataset: { key: 'offline-slow' }, role: 'status' },
    h('span.q-text.small', 'Postbox didn’t confirm it was sent. Trying again every 30 s.'),
    h('button.btn.sm', { type: 'button', onclick: sendNow }, 'Send now'),
  );
}
