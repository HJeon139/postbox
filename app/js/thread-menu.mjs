// The composer’s menu for # (app/js/thread.mjs, mountComposer): the conversation’s threads, to link one in the
// message. The arrow keys move through it from the composer, and Enter or a click picks.

import { h, icon } from './dom.mjs';

/** Threads to link, as the menu for #. The link is what Copy link gives, so an agent reads it the same way. */
export function threadMenu(list, mention, pick) {
  return h(
    'div.menu.mention-menu',
    { role: 'listbox', id: 'mention-list', 'aria-label': 'Threads' },
    h('div.label', 'Link a thread'),
    list.map(({ thread: x }, i) =>
      h(
        'div.mi',
        {
          role: 'option',
          id: `mention-${i}`,
          'aria-selected': String(i === mention.index),
          class: i === mention.index ? 'active' : '',
          onmousedown: (e) => {
            e.preventDefault();
            pick({ thread: x });
          },
        },
        icon('thread', 'i-sm'),
        h('span.grow', x.title, h('span.d', x.kind === 'side' ? 'Side thread' : 'Topic thread')),
        i === mention.index ? h('span.k', 'Enter') : null,
      ),
    ),
  );
}
