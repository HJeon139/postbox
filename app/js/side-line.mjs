// The side-thread line in a conversation: who asked whom, the agent at work there, and how many messages it holds.

import { sessionsAt } from './client.mjs';
import { h, icon, plural } from './dom.mjs';
import { ringFor, stateWord } from './ring.mjs';

export function sideLine(it, ctx) {
  // The agent at work in it, with the ring and state word the sidebar rows use (#121), so the conversation shows
  // what’s running there without opening it.
  const at = sideActive(it.sideThreadId);
  return h(
    'div.col.sys',
    { dataset: { sideSig: sideSig(at) } },
    h(
      'a.pill',
      { href: `#/t/${ctx.threadId}/side/${it.sideThreadId}`, style: { textDecoration: 'none', borderColor: 'var(--accent)' } },
      at ? ringFor(at, 'xs') : icon('thread', 'i-sm'),
      h('b', `@${it.from}`),
      ' asked ',
      h('b', `@${it.to}`),
      at ? [' · ', h('b', `@${at.handle}`), `${at.forkOf?.busy ? ' (a fork)' : ''} ${doing(at)}`] : null,
      ` · ${plural(it.count ?? 0, 'message')} · Open`,
    ),
  );
}

/** The session most worth showing in a side thread: one that needs you, else one at work there; null when none is. */
export function sideActive(sideId) {
  const rank = { needs: 4, failed: 3, tool: 2, gen: 2, think: 2, stopping: 1 };
  const here = sessionsAt(sideId).filter((se) => !se.archived && (!se.sideTurn || se.sideTurn.threadId === sideId) && rank[se.state]);
  return here.sort((a, b) => rank[b.state] - rank[a.state])[0] ?? null;
}
export const sideSig = (se) => (se ? `${se.id}:${se.state}` : '');
/** “is calling tools”, “needs you”: what an agent is doing, after its name. */
const doing = (se) => (se.state === 'needs' ? 'needs you' : se.state === 'failed' ? 'failed' : `is ${stateWord(se.state).toLowerCase()}`);
