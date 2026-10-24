// The Threads page: a project's threads, newest first.

import { client, hrefOf, sessionsOf, topicsOf } from './client.mjs';
import { ago, fill, h, plural } from './dom.mjs';
import { ringFor } from './ring.mjs';
import { doing, sideActive } from './side-line.mjs';

const S = () => client.state;

// ── Threads ─────────────────────────────────────────────────────────────────────────────
// A project’s threads, newest activity first, each saying which kind it is (#124). A topic thread is a fork of an
// agent’s session at the message it started from, so these are also the branches its agents are holding. A side
// thread is where agents talk to each other: an agent woke another, and the person can join it.

export function mountThreads(projectId) {
  const el = h('main.threads-view', { id: 'main', tabindex: '-1' });
  const paint = () => {
    const project = S().projects[projectId];
    const rows = [...topicsOf(projectId).map(topicRow), ...sidesOf(projectId).map(sideRow)].sort((a, b) => b.last - a.last);
    fill(
      el,
      h(
        'div.ov-head',
        h(
          'div.grow',
          h('h1.title', { style: { fontSize: '20px' } }, 'Threads'),
          h(
            'p.small.dim',
            `Threads in ${project?.name ?? 'this project'}. A topic thread is a branch of an agent’s session, so a side topic stays out of the conversation’s memory. A side thread is where agents talk to each other.`,
          ),
        ),
      ),
      rows.length
        ? h('ul.thread-list', rows.map(threadCard))
        : h(
            'p.empty-note',
            'No threads yet. To start one, choose Reply in thread under any message in a conversation. When an agent wakes another, their side thread shows here too.',
          ),
    );
  };
  paint();
  const off = client.on((ch) => {
    if (['thread', 'session', 'load', 'remove', 'item.patch'].includes(ch.type)) paint();
  });
  return { el, destroy: off };
}

/** The project’s side threads whose conversation is still here. */
const sidesOf = (projectId) => Object.values(S().threads).filter((t) => t.projectId === projectId && t.kind === 'side' && S().threads[t.parentId]);

function topicRow(t) {
  const root = (S().items[t.parentId] ?? []).find((x) => x.id === t.rootItemId);
  // Who is in it: the conversation’s agents that answer there from their one session (#228), with the thread’s unread.
  const handles = new Set([t.woke, ...(S().items[t.id] ?? []).filter((x) => x.kind === 'agent').map((x) => x.handle)]);
  const ses = sessionsOf(t.parentId).filter((x) => !x.archived && handles.has(x.handle));
  const who = ses.map((x) => `@${x.handle}`).join(', ') || 'no agent';
  return {
    t,
    kind: 'Topic thread',
    ses,
    unread: t.unread ?? 0,
    last: root?.lastReplyAt ?? t.createdAt,
    facts: [plural(root?.replies ?? 0, 'reply', 'replies'), who],
  };
}

/** A side thread: the pair, the agent at work there or that needs you, how many messages, and when the last came. */
function sideRow(t) {
  const link = (S().items[t.parentId] ?? []).find((x) => x.kind === 'sidelink' && x.sideThreadId === t.id);
  const at = sideActive(t.id);
  const state = at ? `@${at.handle} ${doing(at)}` : 'idle';
  // Its pair’s rings: their sessions in the conversation answer there (#110). Their unread is the conversation’s.
  const pair = (t.pair ?? '').split('|');
  const ses = at ? [at] : sessionsOf(t.parentId).filter((x) => !x.archived && pair.includes(x.handle));
  return { t, kind: 'Side thread', ses, unread: 0, last: link?.lastAt ?? link?.at ?? t.createdAt, facts: [plural(link?.count ?? 0, 'message'), state] };
}

function threadCard({ t, kind, ses, unread, last, facts }) {
  const rings = ses.slice(0, 3).map((se) => {
    const r = ringFor(se, 'xs');
    r.dataset.session = se.id;
    return r;
  });
  const meta = [kind, `in ${S().threads[t.parentId]?.title ?? ''}`, ...facts, ago(last)].join(' · ');
  return h(
    'li',
    { dataset: { kind: t.kind } },
    h(
      'a.thread-card',
      { href: hrefOf(t.id) },
      h('span.stack', rings),
      h('span.grow', h('b', t.title), h('span.small.dim', { style: { display: 'block' } }, meta)),
      unread ? h('span.badge', { 'aria-label': `${unread} new` }, String(unread)) : null,
    ),
  );
}
