// What a hover card shows (initHoverCards in hovercards.mjs): a citation’s source, or a glossary term’s definition.

import { client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { mdNode } from './ui.mjs';

/** The card for a citation marker or a glossary term, or null when there’s nothing to show. */
export function hoverContent(trigger) {
  const itemEl = trigger.closest('[data-key]');
  const threadId = trigger.closest('[data-thread]')?.dataset.thread;
  if (trigger.classList.contains('cite')) {
    const it = (client.state.items[threadId] ?? []).find((x) => x.id === itemEl?.dataset.key);
    const n = +trigger.dataset.cite;
    const s = it?.sources?.[n - 1];
    if (!s) return null;
    const arxiv = s.url?.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1];
    return {
      label: `Source ${n}`,
      head: [
        h('span.label', `Source ${n}${arxiv ? ` · arXiv ${arxiv}` : ''}`),
        h('b', s.title),
        h('span.small.dim', [s.authors, s.year].filter(Boolean).join(' · ')),
      ],
      body: [
        s.note ? h('p', h('span.dim', 'Why it’s cited: '), s.note) : null,
        h(
          'div.hc-links',
          s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url.replace(/^https?:\/\//, ''), ' ', icon('link', 'i-sm')) : null,
          h(
            'a',
            {
              href: `#src-${it.id}-${n}`,
              onclick: (e) => {
                e.preventDefault();
                document.getElementById(`src-${it.id}-${n}`)?.scrollIntoView({ block: 'center' });
              },
            },
            'Show in sources',
          ),
        ),
      ],
    };
  }
  const t = client.state.threads[threadId];
  const g = { ...(client.state.glossary[t?.parentId] ?? {}), ...(client.state.glossary[threadId] ?? {}) }[trigger.dataset.term];
  if (!g)
    return {
      label: 'Not defined yet',
      head: [h('span.label', 'Glossary'), h('b', trigger.textContent)],
      body: [h('p.dim', 'Not defined yet. The agent has been asked to define it.')],
    };
  return {
    label: `Glossary: ${g.term}`,
    head: [h('span.label', 'Glossary'), h('b', g.term)],
    body: [mdNode(g.definition), h('span.small.dim', `Defined by @${g.by}${g.source ? ` · ${g.source}` : ''}`)],
  };
}
