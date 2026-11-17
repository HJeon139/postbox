// In this chat, at the top of the Work pane (#1446): the assets and changed files the conversation is about now, named
// in its last messages or touched in its last turns (shared/room-refs.mjs, relevantRefs), newest first. Each opens in
// the pane’s viewer.

import { relevantRefs } from '/shared/room-refs.mjs';
import { client, itemsOf } from './client.mjs';
import { h } from './dom.mjs';
import { openWork } from './ui.mjs';
import { nameFirst } from './work-assets.mjs';
import { row, sec, short } from './work-pane-parts.mjs';
import { viewed } from './work-viewer.mjs';

/** How many it shows before “All …”. */
const FIRST = 5;

/**
 * The In this chat section, or null when the latest messages and turns name nothing the viewer opens.
 * @param {string} convId @param {{ all: boolean, showAll: () => void }} opts  all: every one, not the first few
 */
export function relevantSection(convId, { all, showAll }) {
  const list = relevantRefs(client.state, convId, itemsOf(convId))
    .map((r) => ({ r, v: viewed(convId, r.at) }))
    .filter((x) => x.v);
  if (!list.length) return null;
  const make = (/** @type {any} */ { r, v }) =>
    row(`wc-now-${r.at}`, () => openWork(convId, { at: r.at }), nameFirst(v.name), h('span.small.dim', r.kind === 'asset' ? 'Asset' : 'File'));
  return sec(
    'wc-now',
    'In this chat',
    String(list.length),
    h('p.small.dim', 'Named in the latest messages, or changed in the latest turns.'),
    all ? h('ul.wc-list', list.map(make)) : short(list, make, showAll, FIRST),
  );
}
