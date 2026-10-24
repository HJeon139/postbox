// Reactions (#251): under a message, block or app, the person’s reactions as buttons that take one back, and a React
// button in the message’s actions with the reactions to choose from. The agents hear them at their next turn.

import { REACTIONS } from '/shared/reactions.mjs';
import { api } from './client.mjs';
import { h } from './dom.mjs';
import { openMenu, toast } from './ui.mjs';

const said = new Map(REACTIONS);

/**
 * Adds an item’s reactions under it, and React to its actions bar, which it returns.
 * @param {HTMLElement} bar  the item’s actions @param {HTMLElement} node  the item @param {any} it @param {{ threadId: string }} ctx
 */
export function reactTo(bar, node, it, ctx) {
  const react = (emoji) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action: 'react', values: { emoji } }).catch((e) =>
      toast({ title: 'Couldn’t react', text: e.message, level: 'blocking' }),
    );
  const mine = it.reactions ?? [];
  if (mine.length)
    node.append(
      h(
        'div.reactions',
        { role: 'group', 'aria-label': 'Your reactions' },
        mine.map((r) =>
          h(
            'button.react-chip',
            {
              type: 'button',
              'aria-pressed': 'true',
              'aria-label': `${r.emoji} ${said.get(r.emoji) ?? ''}: take it back`,
              title: 'Take it back',
              onclick: () => react(r.emoji),
            },
            r.emoji,
          ),
        ),
      ),
    );
  const button = h(
    'button.btn.sm.ghost.reveal',
    {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-label': 'React to this message',
      onclick: () =>
        openMenu(
          button,
          REACTIONS.map(([emoji, label]) => ({ label: `${emoji} ${label}`, run: () => react(emoji) })),
          { label: 'Reactions' },
        ),
    },
    'React',
  );
  bar.append(button);
  return bar;
}
