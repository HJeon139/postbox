// The lines Postbox adds to a conversation about it, not said by anyone (kind 'system'): a session attached from a
// terminal, a wake, a compaction with what was kept, a scheduled wake with Cancel, a dataset loaded, an agent that
// joined or left. Moved out of app/js/thread.mjs.

import { renderMarkdown } from '/shared/markdown.mjs';
import { api } from './client.mjs';
import { h, icon, plural, timeOf, trusted } from './dom.mjs';
import { toast } from './ui.mjs';

export function systemLine(it, _ctx) {
  switch (it.variant) {
    case 'attached':
      return h(
        'div.col.sys-line',
        icon('link', 'i-sm'),
        h('b', `@${it.handle}`),
        ' is a Claude Code session from ',
        h('span.mono', it.folder ?? 'a terminal'),
        '. What you type there shows up here too.',
      );
    case 'wake':
      if (it.scheduled) return h('div.col.sys-line', icon('clock', 'i-sm'), h('b', `@${it.to}`), ' woke itself, as scheduled');
      return h(
        'div.col.sys-line',
        icon('agent', 'i-sm'),
        it.from === 'you'
          ? ['You woke ', h('b', `@${it.to}`)]
          : [
              h('b', `@${it.from}`),
              ' woke ',
              h('b', `@${it.to}`),
              // It had no session here, so it joined the conversation to answer (#110).
              it.joined ? ' · joined the conversation' : '',
              it.n ? ` · agent wake ${it.n} of ${it.limit ?? 3}` : '',
            ],
      );
    case 'compaction': {
      const sum = h(
        'div.block',
        { hidden: true, style: { marginTop: '8px' } },
        h('div.block-head', h('span.title.grow', `What @${it.handle} kept`), h('span.kind', 'Compaction')),
        h('div.block-body', h('div.md', { html: trusted(renderMarkdown(it.summary || 'No summary was kept.')) })),
      );
      const btn = h(
        'button.btn.sm.ghost',
        {
          type: 'button',
          'aria-expanded': 'false',
          onclick: () => {
            sum.hidden = !sum.hidden;
            btn.textContent = sum.hidden ? 'Show summary' : 'Hide summary';
            btn.setAttribute('aria-expanded', String(!sum.hidden));
          },
        },
        'Show summary',
      );
      return h(
        'div.col',
        h(
          'div.sys',
          h(
            'span.pill',
            icon('archive', 'i-sm'),
            'Context compacted · ',
            h('b', `@${it.handle}`),
            ` #${it.n} · kept ${Math.round(it.kept / 1000)}k of ${Math.round(it.total / 1000)}k tokens`,
            btn,
          ),
        ),
        sum,
      );
    }
    case 'schedule':
      return h(
        'div.col.sys-line',
        icon('clock', 'i-sm'),
        h('b', `@${it.handle}`),
        it.status === 'pending'
          ? ` will wake itself at ${timeOf(it.at)}`
          : it.status === 'canceled'
            ? ' won’t wake itself (canceled)'
            : ` woke itself at ${timeOf(it.at)}`,
        it.note ? ` · “${it.note}”` : '',
        it.status === 'pending'
          ? [
              ' · ',
              h(
                'button.btn.sm.ghost',
                {
                  type: 'button',
                  onclick: () => api(`/api/schedules/${it.scheduleId}/cancel`, {}).catch((e) => toast({ title: 'Couldn’t cancel', text: e.message })),
                },
                'Cancel',
              ),
            ]
          : null,
      );
    case 'dataset':
      // An agent loaded a dataset into the corpus (#47): searched only when a search names it.
      return h(
        'div.col.sys-line',
        icon('books', 'i-sm'),
        h('b', `@${it.handle}`),
        ' loaded the dataset ',
        h('span.mono', it.dataset),
        ` · ${plural(it.records, 'record')}, searched only when named`,
      );
    case 'joined':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', `@${it.to}`), ' joined');
    case 'left':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', `@${it.to}`), ' left (its session was deleted)');
    default:
      return h('div.col.sys-line', it.text ?? '');
  }
}
