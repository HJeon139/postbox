// The side-thread line in a conversation: who asked whom, the agent at work there, and how many messages it holds.

import { api, liveSessions } from './client.mjs';
import { h, icon, plural } from './dom.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { toast } from './ui.mjs';

export function sideLine(it, ctx) {
  // The agent at work in it, with the ring and state word the sidebar rows use (#121), so the conversation shows
  // what’s running there without opening it.
  const at = sideActive(it.sideThreadId);
  // What it waits on there, such as a failed turn’s card (#151): Open goes to it, and a failed turn has Retry here.
  const card = at?.needs?.itemId ?? null;
  const failed = at?.state === 'failed' && at.needs?.kind === 'failed' ? card : null;
  return h(
    'div.col.sys',
    { dataset: { sideSig: sideSig(at) } },
    h(
      'a.pill',
      {
        href: `#/t/${ctx.threadId}/side/${it.sideThreadId}`,
        style: { textDecoration: 'none', borderColor: 'var(--accent)' },
        onclick: () => card && goToCard(card),
      },
      at ? ringFor(at, 'xs') : icon('thread', 'i-sm'),
      h('b', `@${it.from}`),
      ' asked ',
      h('b', `@${it.to}`),
      at ? [' · ', h('b', `@${at.handle}`), `${at.forkOf?.busy ? ' (a fork)' : ''} ${doing(at)}`] : null,
      ` · ${plural(it.count ?? 0, 'message')} · Open`,
    ),
    failed
      ? h(
          'button.btn.sm',
          {
            type: 'button',
            'aria-label': `Retry @${at.handle}’s turn in the side thread`,
            onclick: () =>
              api(`/api/threads/${it.sideThreadId}/items/${failed}/retry`, {}).catch((e) =>
                toast({ title: 'Retry didn’t start', text: e.message, level: 'blocking' }),
              ),
          },
          icon('retry', 'i-sm'),
          'Retry',
        )
      : null,
  );
}

/** Once the side thread’s panel has opened, scrolls to the card there and focuses what answers it. */
function goToCard(itemId, frames = 180) {
  const node = document.querySelector(`.sidepanel [data-key="${CSS.escape(itemId)}"]`);
  if (!node) {
    if (frames) requestAnimationFrame(() => goToCard(itemId, frames - 1));
    return;
  }
  node.scrollIntoView({ block: 'center' });
  (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus();
}

/**
 * The session most worth showing in a side thread: one that needs you there, else one at work there; null when none
 * is. That’s a session whose turn is there, or one waiting on a card there, as a failed turn’s is once the turn has
 * ended (#151). A session at work elsewhere shows where it works, even with a card left open here.
 */
export function sideActive(sideId) {
  const rank = { needs: 4, failed: 3, tool: 2, gen: 2, think: 2, stopping: 1 };
  const waiting = (se) => (se.state === 'needs' || se.state === 'failed') && se.needs?.threadId === sideId;
  const here = liveSessions().filter((se) => rank[se.state] && ((se.sideTurn?.threadId ?? se.threadId) === sideId || waiting(se)));
  return here.sort((a, b) => rank[b.state] - rank[a.state])[0] ?? null;
}
export const sideSig = (se) => (se ? `${se.id}:${se.state}` : '');
/** “is calling tools”, “needs you”: what an agent is doing, after its name. */
export const doing = (se) => (se.state === 'needs' ? 'needs you' : se.state === 'failed' ? 'failed' : `is ${stateWord(se.state).toLowerCase()}`);
