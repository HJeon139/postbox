// Reactions (#251): under a message, block or app, its reactions as buttons, one for each emoji, naming the agents
// who made it (principle 5: in words, not only on hover); clicking one takes yours back, or adds yours. A React button
// in the message’s actions has the reactions to choose from, each checked when yours is on. The agents answering where
// it is hear yours at their next turn, and an agent’s is heard by the agent whose message it is. A reaction repaints
// only its own row: the item, an app’s frame among them, isn’t drawn again.

import { REACTIONS } from '/shared/reactions.mjs';
import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { openMenu, toast } from './ui.mjs';

const said = new Map(REACTIONS);
/** The act that reacts: server/reactions.mjs, REACT. */
const REACT = '@react';

const react = (threadId, itemId, emoji) =>
  api(`/api/threads/${threadId}/items/${itemId}/act`, { action: REACT, values: { emoji } }).catch((e) =>
    toast({ title: 'Couldn’t react', text: e.message, level: 'blocking' }),
  );

/** “you”, “@critic”, “you and @critic”, “you, @critic and @dev”. */
const who = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** The row of an item’s reactions, one button for each emoji, or nothing when it has none. */
function row(it, threadId) {
  const all = it.reactions ?? [];
  if (!all.length) return null;
  const groups = REACTIONS.map(([emoji]) => [emoji, all.filter((r) => r.emoji === emoji)]).filter(([, rs]) => rs.length);
  return h(
    'div.reactions',
    { role: 'group', 'aria-label': 'Reactions', dataset: { thread: threadId } },
    groups.map(([emoji, rs]) => {
      const yours = rs.some((r) => !r.by);
      const agents = rs.filter((r) => r.by).map((r) => `@${r.handle}`);
      const names = [...(yours ? ['you'] : []), ...agents];
      return h(
        'button.react-chip',
        {
          type: 'button',
          class: yours ? 'yours' : 'theirs',
          'aria-label': `${emoji} ${said.get(emoji) ?? ''}, from ${who(names)}: ${yours ? 'take yours back' : 'add yours'}`,
          title: yours ? 'Take yours back' : 'Add yours',
          onclick: () => react(threadId, it.id, emoji),
        },
        emoji,
        // Who else reacted, in words; yours alone needs none.
        agents.length ? h('span.react-who', agents.join(', ')) : null,
      );
    }),
  );
}

/**
 * Adds an item’s reactions under it, and React to its actions bar, which it returns.
 * @param {HTMLElement} bar  the item’s actions @param {HTMLElement} node  the item @param {any} it @param {{ threadId: string }} ctx
 */
export function reactTo(bar, node, it, ctx) {
  const mine = row(it, ctx.threadId);
  if (mine) node.append(mine);
  const button = h(
    'button.btn.sm.ghost.reveal',
    {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-label': 'React to this message',
      onclick: () => {
        // Checked when yours is on: an agent’s reaction is theirs.
        const on = new Set((client.state.items[ctx.threadId]?.find((x) => x.id === it.id)?.reactions ?? []).filter((r) => !r.by).map((r) => r.emoji));
        const menu = openMenu(
          button,
          REACTIONS.map(([emoji, label]) => ({ label: `${emoji} ${label}`, run: () => react(ctx.threadId, it.id, emoji) })),
          { label: 'Reactions' },
        );
        // Each is a choice you turn on or off, and says which way it is.
        menu?.querySelectorAll('[role=menuitem]').forEach((b, i) => {
          b.setAttribute('role', 'menuitemcheckbox');
          b.setAttribute('aria-checked', String(on.has(REACTIONS[i][0])));
        });
      },
    },
    'React',
  );
  bar.append(button);
  return bar;
}

// A reaction’s patch (it carries `reaction`) repaints that item’s row wherever it’s shown, and nothing else of it.
client.on((ch) => {
  if (ch.type !== 'item.patch' || !ch.data.reaction) return;
  const it = client.state.items[ch.data.threadId]?.find((x) => x.id === ch.data.id);
  if (!it) return;
  for (const node of document.querySelectorAll(`.item[data-key="${CSS.escape(it.id)}"]`)) {
    const next = row(it, ch.data.threadId);
    const was = node.querySelector(':scope > .reactions');
    if (was && next) was.replaceWith(next);
    else if (was) was.remove();
    else if (next) node.querySelector(':scope > .msg-actions')?.before(next);
  }
});
