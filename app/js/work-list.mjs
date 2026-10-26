// The list under a turn’s last reply (#195): what the turn changed, showed, committed, wrote outside Postbox and ran,
// then what it read, from the work ledger. Its heading is the turn’s line, which opens Work in the pane at the turn;
// each row opens Work full screen at its item, and Escape comes back here. After five rows, “N more” expands in place.

import { signed, turnLine } from '/shared/work.mjs';
import { retiredApp, turnRows } from '/shared/work-list.mjs';
import { client } from './client.mjs';
import { fill, h, icon } from './dom.mjs';
import { keepFocus, openWork, paneHref } from './ui.mjs';

const SHOWN = 5;
const STATE = { failed: 'failed', denied: 'refused', stopped: 'stopped', unknown: 'didn’t report how it ended', running: 'running', background: 'running' };
const GLYPH = { failed: 'failed', denied: 'failed', stopped: 'failed', unknown: 'unknown', running: 'running', background: 'running' };
const expanded = new Set(); // turns whose whole list you opened, kept across repaints (the last 100)

/** A link into Work that replaces the address, as the pane’s own links do. */
function workAt(conv, to, attrs, ...kids) {
  return h(
    'a',
    {
      href: paneHref(conv, { work: true, ...to }),
      ...attrs,
      onclick: (e) => {
        e.preventDefault();
        openWork(conv, to);
      },
    },
    ...kids,
  );
}

/** A path, cut in its folder when it’s too long for the row, so its file name always shows. */
function pathEl(rel) {
  const i = rel.lastIndexOf('/');
  return h('span.wl-path', i >= 0 ? h('span.wl-dir', rel.slice(0, i + 1)) : null, h('span.wl-name', rel.slice(i + 1)));
}

/** What one row shows. */
function rowBody(r) {
  const n = (added, deleted) => {
    const [a, d] = signed(added, deleted).split(' ');
    return h('span.work-n', h('span.add', a), ' ', h('span.del', d));
  };
  switch (r.kind) {
    case 'file':
      return [
        icon('file', 'i-sm'),
        pathEl(r.label),
        r.binary ? h('span.small.dim', 'binary') : n(r.added, r.deleted),
        r.tag ? h('span.work-tag', r.tag) : null,
      ];
    case 'publish': {
      const app = r.what === 'app' ? client.state.apps?.[r.blockId] : null;
      const retired = retiredApp(app);
      return [
        icon(r.what === 'app' ? 'spark' : 'list', 'i-sm'),
        h('span.wl-label', r.label),
        h('span.small.dim', ` · ${r.detail}${retired ? ' · retired' : ''}`),
      ];
    }
    case 'commit':
      return [
        h('span.mono.dim.small', r.detail),
        h('span.wl-label', r.label),
        r.left ? h('span.small.dim', 'no longer on a branch') : null,
        r.overlap ? h('span.small.dim', 'or a command beside it') : null,
      ];
    case 'push':
      return [icon('upload', 'i-sm'), h('span.wl-label', r.label)];
    case 'external':
      return [icon('link', 'i-sm'), h('span.wl-label', r.label), r.url ? h('span.small.dim.wl-url', r.url.replace(/^https?:\/\/(www\.)?/, '')) : null];
    case 'command':
      return [
        h(`span.g.g-${GLYPH[r.state] ?? 'done'}`, { 'aria-hidden': 'true' }),
        h('code.wl-label', r.label),
        STATE[r.state]
          ? h(
              'span.small.wl-state',
              { class: GLYPH[r.state] === 'failed' ? 'bad' : '' },
              r.state === 'failed' && r.exit != null ? `exit ${r.exit}` : STATE[r.state],
            )
          : null,
      ];
    case 'review':
      return [icon('check', 'i-sm'), h('code.wl-label', r.label), h('span.small.dim', ` · approved by the reviewer${r.detail ? `: ${r.detail}` : ''}`)];
    default:
      return [icon('search', 'i-sm'), h('span.wl-label', r.label)];
  }
}

/**
 * The turn’s list: its line, then its rows, or the line alone for a turn recorded before the list (no entries). It
 * repaints itself when the ledger changes one of the turn’s entries (a background command ends, a file is put back)
 * or an app changes (retired), for as long as it’s on the page.
 * @param {any} it  the item the list goes under @param {string} conv  the conversation whose Work it opens
 * @param {(string|null)[]} folders  folders a command’s leading `cd` may name and leave out
 */
export function workList(it, conv, folders) {
  // The turn whose list it is: an item another turn moved on keeps the list of the turn it ended.
  const turnId = it.workTurn ?? it.turnId;
  const list = h('div.work-list-turn');
  const paint = () => {
    const entries = client.state.work?.[conv] ?? [];
    const rows = turnRows(entries, turnId, { folders });
    // Worked out with the rows, so it follows the ledger after the turn too; the item’s copy is for an old turn.
    const line = turnLine(entries, turnId) ?? it.work;
    const shown = expanded.has(turnId) || rows.length <= SHOWN ? rows : rows.slice(0, SHOWN);
    const more = () => {
      expanded.add(turnId);
      if (expanded.size > 100) expanded.delete(expanded.values().next().value);
      paint();
      /** @type {HTMLElement|null} */ (list.querySelectorAll('.wl-row')[SHOWN])?.focus();
    };
    const row = (r) =>
      h('li', workAt(conv, { full: true, at: r.at }, { id: `wl-${turnId}-${r.at}`, class: `wl-row wl-${r.kind}`, dataset: { at: r.at } }, ...rowBody(r)));
    const moreRow = h(
      'li',
      h(
        'button.wl-more',
        { type: 'button', 'aria-label': `Show ${rows.length - shown.length} more of what this turn did`, onclick: more },
        `${rows.length - shown.length} more`,
      ),
    );
    fill(
      list,
      workAt(conv, { turn: turnId }, { class: 'work-chip', 'aria-label': `This turn’s work: ${line}` }, icon('file', 'i-sm'), line),
      rows.length ? h('ul.wl-rows', { 'aria-label': 'What this turn did' }, shown.map(row), shown.length < rows.length ? moreRow : null) : null,
    );
  };
  paint();
  // Once it was on the page and isn’t any more, it stops listening, at the next event of any kind.
  let shownOnce = false;
  let frame = 0;
  const off = client.on((ch) => {
    shownOnce ||= list.isConnected;
    if (shownOnce && !list.isConnected) return off();
    const mine = (ch.type === 'work.add' || ch.type === 'work.patch') && ch.data.convId === conv;
    if (!mine && ch.type !== 'app') return;
    if (mine && (ch.data.entry ?? client.state.work?.[conv]?.find((e) => e.id === ch.data.id))?.turnId !== turnId) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => list.isConnected && keepFocus(list, paint));
  });
  return list;
}
