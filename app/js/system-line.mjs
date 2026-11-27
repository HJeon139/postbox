// The lines Postbox adds to a conversation about it, not said by anyone (kind 'system'): a session attached from a
// terminal, a wake, a compaction with what was kept, a scheduled wake with Cancel, an agent that joined or
// left, a chain of wakes the loop guard stopped. Moved out of app/js/thread.mjs.

import { renderMarkdown } from '/shared/markdown.mjs';
import { h, icon, trusted } from './dom.mjs';
import { scheduledWakeLine } from './scheduled-wake-line.mjs';

export function systemLine(it, _ctx) {
  switch (it.variant) {
    case 'attached':
      return h(
        'div.col.sys-line',
        icon('link', 'i-sm'),
        h('b', it.handle),
        ' is a Claude Code session from ',
        h('span.mono', it.folder ?? 'a terminal'),
        '. What you type there shows up here too.',
      );
    case 'wake':
      if (it.scheduled) return h('div.col.sys-line', icon('clock', 'i-sm'), h('b', it.to), ' woke itself, as scheduled');
      return h(
        'div.col.sys-line',
        icon('agent', 'i-sm'),
        it.from === 'you'
          ? ['You woke ', h('b', it.to)]
          : [
              h('b', it.from),
              ' woke ',
              h('b', it.to),
              // It had no session here, so it joined the conversation to answer (#110).
              it.joined ? ' · joined the conversation' : '',
            ],
      );
    case 'compaction': {
      const sum = h(
        'div.block',
        { hidden: true, style: { marginTop: '8px' } },
        h('div.block-head', h('span.title.grow', `What ${it.handle} kept`), h('span.kind', 'Compaction')),
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
            h('b', it.handle),
            ` #${it.n}`,
            // A harness that doesn’t count what it kept, as Codex doesn’t (#425), shows no counts.
            Number.isFinite(it.kept) && Number.isFinite(it.total) ? ` · kept ${Math.round(it.kept / 1000)}k of ${Math.round(it.total / 1000)}k tokens` : null,
            btn,
          ),
        ),
        sum,
      );
    }
    case 'schedule':
      return scheduledWakeLine(it);
    case 'chain-stopped':
      // The loop guard (#1623): the one line the room shows, with nothing to answer. Its count is the cap it stopped at.
      return h(
        'div.col.sys-line',
        icon('agent', 'i-sm'),
        `Agents stopped waking each other after ${Number(it.wakes).toLocaleString('en-US')} wakes in a row. Your next message lets them start again.`,
      );
    case 'joined':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', it.to), ' joined');
    case 'left':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', it.to), ' left');
    default:
      return h('div.col.sys-line', it.text ?? '');
  }
}
