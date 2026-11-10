// The composer’s rows for messages not sent yet, from the outbox (#427): they aren’t any agent’s queue, so they’re
// drawn apart from it.

import { h, icon } from './dom.mjs';

/** How many offline messages show as rows before the rest are counted (#427, V1). */
const OFFLINE_ROWS = 2;

/**
 * Offline messages aren’t assigned to an agent yet, so they remain in the composer without duplicating on repaint:
 * at most two rows, then one line counting the rest, so the composer stays bounded.
 */
export function paintOfflineQueue(container, messages) {
  const more = messages.length - OFFLINE_ROWS;
  container.replaceChildren(
    ...messages
      .slice(0, OFFLINE_ROWS)
      .map((message) =>
        h(
          'div.queued',
          { dataset: { key: `offline-${message.threadId}-${message.text}-${message.attachments?.length ?? 0}` } },
          icon('clock', 'dim'),
          h('span.q-text', h('span.small.dim', 'Waiting for the connection'), h('br'), message.text),
        ),
      ),
    ...(more > 0 ? [h('div.queued.small.dim', { dataset: { key: 'offline-more' } }, `and ${more} more waiting for the connection`)] : []),
  );
}
