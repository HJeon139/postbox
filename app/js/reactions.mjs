// Reactions (#251, #320): in a message’s, block’s or app’s actions, beside “Reply in thread”, all five as buttons,
// always shown. Clicking one adds yours, or takes it back. Yours is highlighted (pressed); one made only by others
// shows its count from 1, while yours alone has no count. Who reacted shows in a hover
// card (hover-content.mjs), on hover and on keyboard focus, and the button’s name says it too. The agents answering
// where it is hear yours at their next turn, and an agent’s is heard by the agent whose message it is. A reaction
// repaints only its own buttons: the item, an app’s frame among them, isn’t drawn again.
// Each button draws its reaction’s icon (app/media/reactions) and its count itself (workbench.css, data-icon and
// data-count), so a row is six elements on every item: in a long room the rows were most of the page. Its name says
// the reaction, who made it and how many, so nothing a screen reader hears comes from the icon.

import { REACTIONS } from '/shared/reactions.mjs';
import { api, client, itemIn } from './client.mjs';
import { fill, h } from './dom.mjs';
import { toast } from './ui.mjs';

const DRAWN = new Map([
  ['👍', 'approve'],
  ['👎', 'disapprove'],
  ['🚩', 'flag'],
  ['❓', 'unclear'],
  ['✅', 'done'],
]);
/** The act that reacts: server/reactions.mjs, REACT. */
const REACT = '@react';

const react = (threadId, itemId, emoji) =>
  api(`/api/threads/${threadId}/items/${itemId}/act`, { action: REACT, values: { emoji } }).catch((e) =>
    toast({ title: 'Couldn’t react', text: e.message, level: 'blocking' }),
  );

/** “you”, “critic”, “you and critic”, “you, critic and dev”. */
export const who = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Who made one reaction on an item: “you” first, then the agents, by handle. */
export function reactors(it, emoji) {
  const rs = (it?.reactions ?? []).filter((r) => r.emoji === emoji);
  return [...(rs.some((r) => !r.by) ? ['you'] : []), ...rs.filter((r) => r.by).map((r) => r.handle)];
}

/** The five buttons, as an item’s reactions stand now. */
function buttons(it, threadId) {
  return REACTIONS.map(([emoji, label]) => {
    const names = reactors(it, emoji);
    const yours = names[0] === 'you';
    // The count shows from 1 when others reacted; yours alone has none.
    const counted = names.length > 1 || (names.length === 1 && !yours);
    return h('button.react-btn', {
      type: 'button',
      class: names.length ? 'made' : '',
      'aria-pressed': String(yours),
      'aria-label': `${label}${names.length ? `, from ${who(names)}, ${names.length} reaction${names.length === 1 ? '' : 's'}` : ''}: ${yours ? 'take yours back' : 'react'}`,
      dataset: { emoji, icon: DRAWN.get(emoji), ...(counted ? { count: String(names.length) } : {}) },
      onclick: () => react(threadId, it.id, emoji),
    });
  });
}

/**
 * Puts an item’s reactions first in its actions bar, which it returns: the thread button sits on the right, the side
 * a thread opens on (#378).
 * @param {HTMLElement} bar  the item’s actions @param {HTMLElement} _node  the item @param {any} it @param {{ threadId: string }} ctx
 */
export function reactTo(bar, _node, it, ctx) {
  bar.prepend(
    h('span.react-row', { role: 'group', 'aria-label': 'Reactions', dataset: { reactions: it.id, thread: ctx.threadId } }, buttons(it, ctx.threadId)),
  );
  return bar;
}

// A reaction’s patch (it carries `reaction`) repaints that item’s buttons wherever they’re shown, and nothing else of it.
client.on((ch) => {
  if (ch.type !== 'item.patch' || !ch.data.reaction) return;
  const it = itemIn(ch.data.threadId, ch.data.id);
  if (!it) return;
  for (const row of document.querySelectorAll(`.react-row[data-reactions="${CSS.escape(it.id)}"]`)) {
    // Focus stays on the button you used (designs/engineering-practices.md, “Accessibility (axe)”).
    const had = row.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.emoji : null;
    fill(row, ...buttons(it, /** @type {HTMLElement} */ (row).dataset.thread ?? ch.data.threadId));
    if (had) /** @type {HTMLElement | null} */ (row.querySelector(`[data-emoji="${had}"]`))?.focus();
  }
});
