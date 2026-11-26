// The Work pane’s lists (#132): a section, a row that opens something, a short list with “All …”, and the sections
// for what went out of Postbox and what the turns took. Moved from work.mjs, whose mountWorkPane uses them.

import { formatCost, formatTokens } from '/shared/work.mjs';
import { h, icon, plural } from './dom.mjs';
import { dur } from './work-sections.mjs';

/** How many items a list in the pane shows before “All …”. */
export const SHORT = 3;

export const sec = (id, title, count, ...kids) =>
  h('section.wc-sec', { 'aria-labelledby': `${id}-h` }, h('h2.wc-h', { id: `${id}-h` }, title, count ? h('span.badge', count) : null), ...kids);
export const row = (id, run, ...kids) => h('li', h('button.wc-row', { type: 'button', id, onclick: run }, ...kids));
/** The first few of a list, then a row that opens the whole of it. */
export const short = (list, make, all, n = SHORT) =>
  h(
    'ul.wc-list',
    list.slice(0, n).map(make),
    list.length > n ? h('li', h('button.wc-row.wc-more', { type: 'button', onclick: all }, `All ${list.length}`, icon('right', 'i-sm'))) : null,
  );

/** What went out of Postbox: an issue, a pull request. @param {any} s @param {(to: any) => void} go */
export function external(s, go) {
  if (!s.external.length) return null;
  const list = [...s.external].reverse();
  return sec(
    'wc-external',
    'Outside Postbox',
    String(list.length),
    h(
      'ul.wc-list.wc-plain',
      list
        .slice(0, SHORT)
        .map((x) =>
          h(
            'li',
            h('span', x.what),
            x.state === 'failed' || x.state === 'denied' ? [' ', h('span.status-tag.ws-failed', x.state === 'denied' ? 'Refused' : 'Failed')] : null,
            x.urls?.[0]
              ? [
                  ' · ',
                  h(
                    'a',
                    { href: x.urls[0], target: '_blank', rel: 'noopener noreferrer' },
                    x.urls[0].replace(/^https?:\/\/(www\.)?/, ''),
                    ' ',
                    icon('link', 'i-sm'),
                  ),
                ]
              : null,
          ),
        ),
      list.length > SHORT
        ? h('li', h('button.wc-row.wc-more', { type: 'button', onclick: () => go({ at: 'work-external' }) }, `All ${list.length}`, icon('right', 'i-sm')))
        : null,
    ),
  );
}

/** What the conversation’s turns took. @param {any} s @param {(to: any) => void} go */
export function spend(s, go) {
  if (!s.turns.length) return null;
  const e = s.effort;
  const agents = s.byAgent.filter((a) => a.turns);
  return sec(
    'wc-spend',
    'Spend',
    '',
    h(
      'p.small',
      [e.priced ? formatCost(e.costUsd) : null, plural(e.turns, 'turn'), e.ms ? dur(e.ms) : null, e.tokens ? `${formatTokens(e.tokens)} tokens` : null]
        .filter(Boolean)
        .join(' · '),
    ),
    e.priced ? null : h('p.small.dim', 'Spend shows for Claude Code turns.'),
    agents.length > 1
      ? h(
          'p.small.dim',
          agents.map((a, i) => [i ? ' · ' : '', `${a.handle} `, a.priced ? formatCost(a.costUsd) : plural(a.turns, 'turn')]),
        )
      : null,
    s.idle.turns
      ? h(
          'p.small.dim',
          `${plural(s.idle.turns, 'turn')} left nothing lasting${[dur(s.idle.ms), s.idle.priced ? formatCost(s.idle.costUsd) : null]
            .filter(Boolean)
            .map((x, i) => `${i ? ', ' : ': '}${x}`)
            .join('')}.`,
        )
      : null,
    h(
      'ul.wc-list',
      row('wc-effort', () => go({ at: 'work-effort' }), h('span.wc-name', 'Effort by agent'), icon('right', 'i-sm')),
    ),
  );
}
