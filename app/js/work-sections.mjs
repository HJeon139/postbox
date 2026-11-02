// Sections of the Work view (#132) that need nothing of its state but what they’re given: version control, writes
// outside Postbox and effort, with the helpers the view and its pane share. Moved from app/js/work.mjs.

import { formatDuration } from '/shared/text.mjs';
import { formatCost, formatTokens, signed } from '/shared/work.mjs';
import { ledgerIndex } from '/shared/work-index.mjs';
import { retiredApp } from '/shared/work-list.mjs';
import { client } from './client.mjs';
import { h, icon, plural, timeOf } from './dom.mjs';
import { navigate, openWork, paneHref, route, setPaneFull } from './ui.mjs';

export const dur = (ms) => (ms ? formatDuration(ms) : '');
/** A host’s name now (it may have been renamed since), else as the ledger kept it (#120). */
export const hostName = (x) => client.state.hosts?.[x.host?.id]?.name ?? x.host?.name ?? 'a host';
export const who = (e) => `@${e.handle}${e.host ? ` on ${hostName(e)}` : ''}${e.who ? ` · ${e.who}` : ''}`;
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
      el: h('li', icon('right', 'i-sm'), 'Made branch ', h('b.mono', b.name), h('span.small.dim', ` · ${who(b)} · ${timeOf(b.at)}`)),
    })),
    ...s.commits.map((c) => {
      const pushed = git?.commits?.[c.id]?.pushed;
      return {
        at: c.at,
        el: h(
          'li',
          { id: c.id, tabindex: '-1' },
          h('span.mono.dim', c.sha.slice(0, 7)),
          ' ',
          h('b', c.message || '(no message)'),
          c.branch ? h('span.small.dim', ` on ${c.branch}`) : null,
          c.left ? h('span.small.dim', ' · no longer on a branch') : null,
          c.overlap ? h('span.small.dim', ' · or a command beside it') : null,
          // Git here can’t say what a host’s commit holds or whether it was pushed (#120); its push, if the stream
          // reported one, is listed.
          c.host
            ? null
            : [
                ' · ',
                c.files.length ? [plural(c.files.length, 'file'), ' ', signedEl(c.added, c.deleted)] : 'files unknown',
                ' ',
                h('span.status-tag', { class: pushed ? 'ws-pushed' : 'ws-committed' }, git ? (pushed ? 'Pushed' : 'Not pushed') : '…'),
              ],
          h('span.small.dim', ` · ${who(c)} · ${timeOf(c.at)}`),
        ),
      };
    }),
    ...s.pushes.map((p) => ({
      at: p.at,
      el: h(
        'li',
        { id: p.id, tabindex: '-1' },
        icon('upload', 'i-sm'),
        ' Pushed ',
        h('b.mono', p.branch || 'a branch'),
        p.remote ? [' to ', h('span.mono', p.remote)] : null,
        p.refs.length ? h('span.small.dim', ` (${p.refs.join(', ')})`) : null,
        h('span.small.dim', ` · ${who(p)} · ${timeOf(p.at)}`),
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
              { id: x.id, tabindex: '-1' },
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

export function effortSection(s, entries, threadId, win) {
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
    idleList(s, entries, threadId, win),
  );
}

/** The turns that left nothing lasting, each with what it took and tried. */
function idleList(s, entries, threadId, win) {
  const anyPrice = s.effort.priced;
  const { byTurn } = ledgerIndex(entries);
  const ids = { idOf: (t) => t.id, elId: (t) => `widle-${t.id}` };
  const { items: idle, above, below } = win('idle', s.idle.list, { ...ids, newest: 'end', before: 'earlier turn', after: 'later turn' });
  if (!idle.length) return null;
  return [
    h('h3.label', 'Left nothing lasting'),
    above,
    h(
      'ul.work-list',
      idle.map((t) => {
        // The turn’s own entries, from the ledger’s index rather than a scan of it for each turn (#618).
        const mine = byTurn.get(t.id) ?? [];
        const cmds = mine.filter((c) => c.kind === 'command');
        const failed = cmds.filter((c) => c.state === 'failed').length;
        const files = mine.filter((e) => e.kind === 'change').length;
        return h(
          'li',
          { id: `widle-${t.id}`, tabindex: '-1' },
          workLink(threadId, { full: true, turn: t.id }, `@${t.handle} at ${timeOf(t.startedAt)}`),
          h(
            'span.small.dim',
            ` · ${[dur(t.ms), anyPrice ? formatCost(t.costUsd ?? 0) : null, cmds.length ? `${plural(cmds.length, 'command')}${failed ? `, ${failed} failed` : ''}` : null, files ? `${plural(files, 'file')} put back` : null].filter(Boolean).join(' · ')}`,
          ),
        );
      }),
    ),
    below,
  ];
}

/** Leaves full-screen Work for the conversation, at an item there, with focus on it. */
function showItem(conv, p) {
  if (route().full) setPaneFull(null);
  if (p.threadId !== conv) navigate(paneHref(conv, { side: p.threadId, work: route().work }), { replace: true });
  requestAnimationFrame(() => {
    const el = /** @type {HTMLElement|null} */ (document.querySelector(`.transcript [data-key="${CSS.escape(p.itemId)}"]`));
    el?.setAttribute('tabindex', '-1');
    el?.scrollIntoView({ block: 'center' });
    el?.focus({ preventScroll: true });
  });
}

/** What the agents showed in the conversation (#195): apps at their version, and blocks, each leading back to it. */
export function publishSection(s, conv, apps = {}) {
  return section(
    'work-shown',
    'Shown in the conversation',
    s.publishes.length,
    s.publishes.length
      ? h(
          'ul.work-list',
          s.publishes.map((p) => {
            const app = p.what === 'app' ? apps[p.blockId] : null;
            return h(
              'li',
              { id: p.id, tabindex: '-1' },
              icon(p.what === 'app' ? 'spark' : 'list', 'i-sm'),
              ' ',
              h('b', p.title),
              h('span.small.dim', ` · ${p.what === 'app' ? `app v${p.version ?? 1}` : `${p.type} block`}`),
              retiredApp(app) ? [' ', h('span.status-tag', 'Retired')] : null,
              h('span.small.dim', ` · ${who(p)} · ${timeOf(p.at)} · `),
              h('button.btn.sm', { type: 'button', onclick: () => showItem(conv, p) }, 'Show in the conversation'),
            );
          }),
        )
      : h('p.empty-note', 'No apps or blocks shown yet.'),
  );
}

const READ_WORDS = { Read: 'Read', Grep: 'Searched files for', Glob: 'Listed files matching', WebFetch: 'Fetched', WebSearch: 'Searched the web for' };
/** Each file the agents read and each page they fetched or searched for (#195), by agent, with when. */
export function readsSection(s, win) {
  const ids = { idOf: (r) => r.id, elId: (r) => r.id };
  const { items, above, below } = win('reads', s.reads, { ...ids, newest: 'end', before: 'earlier read', after: 'later read' });
  // The list’s Reads row opens Work at this section, so it takes focus, and keeps it across repaints.
  const el = section(
    'work-reads',
    'Reads',
    s.reads.length,
    above,
    s.reads.length
      ? h(
          'ul.work-list',
          items.map((r) =>
            h(
              'li',
              { id: r.id, tabindex: '-1' },
              `${READ_WORDS[r.tool] ?? r.tool} `,
              h(r.tool === 'WebSearch' || r.tool === 'Grep' || r.tool === 'Glob' ? 'b' : 'b.mono', r.what),
              r.where ? h('span.small.dim', ` in ${r.where}`) : null,
              h('span.small.dim', ` · ${who(r)} · ${timeOf(r.at)}`),
            ),
          ),
        )
      : h('p.empty-note', 'Nothing read yet. Each file an agent reads and each page it fetches or searches for shows here.'),
    below,
  );
  el.tabIndex = -1;
  return el;
}
