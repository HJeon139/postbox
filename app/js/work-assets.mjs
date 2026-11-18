// The room’s assets in the Work pane (#1446): what the agents published to this conversation, newest first, each
// opening in the pane’s viewer (work-viewer.mjs). Its rows read the state the page already has: an asset’s metadata
// is public, and its bytes load only when it opens.

import { roomAssets } from '/shared/room-refs.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { openWork } from './ui.mjs';
import { row, sec, short } from './work-pane-parts.mjs';

/** A name’s last part first, then its folder, as the pane’s file rows show a path. @param {string} name */
export const nameFirst = (name) =>
  h('span.mono.wc-name', name.replace(/^.*\//, ''), name.includes('/') ? h('span.dim', ` ${name.replace(/\/[^/]*$/, '')}`) : null);

/**
 * The Assets section, or null when the room has none.
 * @param {string} convId @param {{ all: boolean, showAll: () => void, skip?: Set<string> }} opts  all: every asset, not
 *   the first few; skip: those In this chat shows, not listed again
 */
export function assetsSection(convId, { all, showAll, skip = new Set() }) {
  const every = roomAssets(client.state, convId);
  if (!every.length) return null;
  const list = every.filter((a) => !skip.has(a.id));
  const make = (/** @type {any} */ a) => {
    const v = a.versions[a.head - 1];
    return row(`wc-asset-${a.id}`, () => openWork(convId, { at: a.id }), nameFirst(a.name), h('span.small.dim', `v${v.v} · ${v.author}`));
  };
  return sec(
    'wc-assets',
    'Assets',
    String(every.length),
    h(
      'p.small.dim',
      'What the agents published to this conversation. Every agent here can read them.',
      list.length < every.length ? ` ${every.length - list.length} in In this chat.` : null,
    ),
    all ? h('ul.wc-list', list.map(make)) : short(list, make, showAll),
  );
}
