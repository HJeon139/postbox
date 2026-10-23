// Sections of the Work view (#132) that need nothing of its state but what they’re given: version control, writes
// outside Postbox and effort, with the helpers the view and its pane share. Moved from app/js/work.mjs.

import { formatDuration } from '/shared/text.mjs';
import { formatCost, formatTokens, signed } from '/shared/work.mjs';
import { h, icon, plural, timeOf } from './dom.mjs';
import { openWork, paneHref, route } from './ui.mjs';

export const dur = (ms) => (ms ? formatDuration(ms) : '');
export const who = (e) => `@${e.handle}${e.who ? ` · ${e.who}` : ''}`;
export const priced = (n, has) => (has ? formatCost(n) : '—');
/** +a −d, with the signs as text and each count in its color. */
export function signedEl(added, deleted) {
  const [a, d] = signed(added, deleted).split(' ');
  return h('span.work-n', h('span.add', a), ' ', h('span.del', d));
}

/**
 * A link to Work as the pane or full-screen Work shows it, which replaces the address like the rest of the pane.
 * @param {string} threadId
 * @param {{ turn?: string|null, full?: boolean, at?: string|null }} to
 */
export function workLink(threadId, to, ...children) {
  const r = route();
  const href = paneHref(threadId, { side: r.threadId === threadId ? r.sideId : null, work: true, ...to });
  return h(
    'a',
    {
      href,
      onclick: (e) => {
        e.preventDefault();
        openWork(threadId, to);
      },
    },
    ...children,
  );
}

export const section = (id, title, n, ...body) =>
  h('section.work-sec', { id, 'aria-labelledby': `${id}-h` }, h('h2', { id: `${id}-h` }, title, n ? h('span.badge', String(n)) : null), ...body);

export function vcsSection(s, git) {
  const rows = [
    ...s.branches.map((b) => ({
      at: b.at,
      el: h('li', icon('right', 'i-sm'), 'Made branch ', h('b.mono', b.name), h('span.small.dim', ` · @${b.handle} · ${timeOf(b.at)}`)),
    })),
    ...s.commits.map((c) => {
      const pushed = git?.commits?.[c.id]?.pushed;
      return {
        at: c.at,
        el: h(
          'li',
          h('span.mono.dim', c.sha.slice(0, 7)),
          ' ',
          h('b', c.message || '(no message)'),
          c.branch ? h('span.small.dim', ` on ${c.branch}`) : null,
          ' · ',
          c.files.length ? [plural(c.files.length, 'file'), ' ', signedEl(c.added, c.deleted)] : 'files unknown',
          ' ',
          h('span.status-tag', { class: pushed ? 'ws-pushed' : 'ws-committed' }, git ? (pushed ? 'Pushed' : 'Not pushed') : '…'),
          h('span.small.dim', ` · @${c.handle} · ${timeOf(c.at)}`),
        ),
      };
    }),
    ...s.pushes.map((p) => ({
      at: p.at,
      el: h(
        'li',
        icon('upload', 'i-sm'),
        ' Pushed ',
        h('b.mono', p.branch || 'a branch'),
        p.remote ? [' to ', h('span.mono', p.remote)] : null,
        p.refs.length ? h('span.small.dim', ` (${p.refs.join(', ')})`) : null,
        h('span.small.dim', ` · @${p.handle} · ${timeOf(p.at)}`),
      ),
    })),
  ].sort((a, b) => a.at - b.at);
  return section(
    'work-vcs',
    'Version control',
    rows.length,
    rows.length
      ? h(
          'ul.work-list',
          rows.map((r) => r.el),
        )
      : h('p.empty-note', 'No branches, commits or pushes yet.'),
  );
}

export function externalSection(s) {
  return section(
    'work-external',
    'Outside Postbox',
    s.external.length,
    s.external.length
      ? h(
          'ul.work-list',
          s.external.map((x) =>
            h(
              'li',
              h('b', x.what),
              x.via === 'mcp' ? h('span.small.dim', ` (${x.server})`) : null,
              x.state === 'failed' || x.state === 'denied' ? [' ', h('span.status-tag.ws-failed', x.state === 'denied' ? 'Refused' : 'Failed')] : null,
              x.urls?.length
                ? [
                    ' · ',
                    x.urls.map((u, i) => [
                      i ? ', ' : '',
                      h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u.replace(/^https?:\/\/(www\.)?/, ''), ' ', icon('link', 'i-sm')),
                    ]),
                  ]
                : null,
              h('span.small.dim', ` · ${who(x)} · ${timeOf(x.at)}`),
            ),
          ),
        )
      : h('p.empty-note', 'Nothing published outside Postbox yet: issues, pull requests and comments an agent writes with gh or a connector show here.'),
  );
}

export function effortSection(s, entries, threadId) {
  const anyPrice = s.effort.priced;
  const row = (a, total = false) =>
    h(
      'tr',
      { class: total ? 'work-total' : '' },
      h(total ? 'th' : 'td', { scope: total ? 'row' : null }, total ? 'All' : `@${a.handle}`),
      h('td.num', a.turns.toLocaleString('en-US')),
      h('td.num', dur(a.ms) || '—'),
      h('td.num', a.toolCalls.toLocaleString('en-US')),
      h('td.num', a.tokens ? formatTokens(a.tokens) : '—'),
      h('td.num', priced(a.costUsd, anyPrice)),
      h('td.num', `+${(a.written ?? 0).toLocaleString('en-US')}`),
      h('td.num', signedEl(a.added, a.deleted)),
    );
  const idle = s.idle.list;
  return section(
    'work-effort',
    'Effort',
    0,
    s.turns.length
      ? h(
          'div.tbl-wrap.work-tbl',
          { tabindex: '0', role: 'region', 'aria-label': 'Effort by agent' },
          h(
            'table.tbl',
            h(
              'thead',
              h(
                'tr',
                ['Agent', 'Turns', 'Time', 'Tool calls', 'Tokens', 'Spend', 'Written', 'Kept'].map((x, i) =>
                  h('th', { scope: 'col', class: i ? 'num' : '' }, x),
                ),
              ),
            ),
            h(
              'tbody',
              s.byAgent.map((a) => row(a)),
            ),
            s.byAgent.length > 1
              ? h(
                  'tfoot',
                  row({ handle: '', ...s.effort, tokens: s.effort.tokens, written: s.effort.written, added: s.total.added, deleted: s.total.deleted }, true),
                )
              : null,
          ),
        )
      : h('p.empty-note', 'No turns yet.'),
    anyPrice || !s.turns.length ? null : h('p.small.dim', 'Spend shows for Claude Code and Agent SDK turns.'),
    idle.length
      ? [
          h('h3.label', 'Left nothing lasting'),
          h(
            'ul.work-list',
            idle.map((t) => {
              const cmds = s.commands.filter((c) => c.turnId === t.id);
              const failed = cmds.filter((c) => c.state === 'failed').length;
              const files = entries.filter((e) => e.kind === 'change' && e.turnId === t.id).length;
              return h(
                'li',
                workLink(threadId, { full: true, turn: t.id }, `@${t.handle} at ${timeOf(t.startedAt)}`),
                h(
                  'span.small.dim',
                  ` · ${[dur(t.ms), anyPrice ? formatCost(t.costUsd ?? 0) : null, cmds.length ? `${plural(cmds.length, 'command')}${failed ? `, ${failed} failed` : ''}` : null, files ? `${plural(files, 'file')} put back` : null].filter(Boolean).join(' · ')}`,
                ),
              );
            }),
          ),
        ]
      : null,
  );
}
