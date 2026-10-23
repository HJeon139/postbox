// The Threads page: a project's threads, newest first.

import { client, hrefOf, sessionsOf, topicsOf } from './client.mjs';
import { ago, fill, h, plural } from './dom.mjs';
import { ringFor } from './ring.mjs';

const S = () => client.state;

// ── Threads ─────────────────────────────────────────────────────────────────────────────
// A project’s topic threads, newest reply first. Each one is a fork of an agent’s session at the message it
// started from, so this is also the list of branches its agents are holding.

export function mountThreads(projectId) {
  const el = h('main.threads-view', { id: 'main', tabindex: '-1' });
  const paint = () => {
    const project = S().projects[projectId];
    const topics = topicsOf(projectId)
      .map((t) => {
        const parent = S().threads[t.parentId];
        const root = (S().items[t.parentId] ?? []).find((x) => x.id === t.rootItemId);
        const ses = sessionsOf(t.id).filter((x) => !x.archived);
        return { t, parent, root, ses, unread: ses.reduce((a, x) => a + (x.unread ?? 0), 0), last: root?.lastReplyAt ?? t.createdAt };
      })
      .sort((a, b) => b.last - a.last);
    fill(
      el,
      h(
        'div.ov-head',
        h(
          'div.grow',
          h('h1.title', { style: { fontSize: '20px' } }, 'Threads'),
          h(
            'p.small.dim',
            `Topic threads in ${project?.name ?? 'this project'}. Each one is a branch of an agent’s session, so a side topic stays out of the conversation’s memory.`,
          ),
        ),
      ),
      topics.length
        ? h(
            'ul.thread-list',
            topics.map(({ t, parent, root, ses, unread, last }) =>
              h(
                'li',
                h(
                  'a.thread-card',
                  { href: hrefOf(t.id) },
                  h(
                    'span.stack',
                    ses.slice(0, 3).map((se) => {
                      const r = ringFor(se, 'xs');
                      r.dataset.session = se.id;
                      return r;
                    }),
                  ),
                  h(
                    'span.grow',
                    h('b', t.title),
                    h(
                      'span.small.dim',
                      { style: { display: 'block' } },
                      `in ${parent?.title ?? ''} · ${plural(root?.replies ?? 0, 'reply', 'replies')} · ${ses.map((x) => `@${x.handle}`).join(', ') || 'no agent'} · ${ago(last)}`,
                    ),
                  ),
                  unread ? h('span.badge', { 'aria-label': `${unread} new` }, String(unread)) : null,
                ),
              ),
            ),
          )
        : h('p.empty-note', 'No topic threads yet. To start one, choose Reply in thread under any message in a conversation.'),
    );
  };
  paint();
  const off = client.on((ch) => {
    if (['thread', 'session', 'load', 'remove', 'item.patch'].includes(ch.type)) paint();
  });
  return { el, destroy: off };
}
