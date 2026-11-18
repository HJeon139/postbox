// In this chat, at the top of the Work pane (#1446): the assets and changed files the conversation is about now, named
// in its last messages or touched in its last turns (shared/room-refs.mjs, relevantRefs), newest first. Each opens in
// the pane’s viewer. Names come with the ranking, so only the rows shown are drawn.

import { relevantRefs, saidKey } from '/shared/room-refs.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { latestItems } from './item-ranges.mjs';
import { readingHold } from './reading-hold.mjs';
import { openWork } from './ui.mjs';
import { nameFirst } from './work-assets.mjs';
import { row, sec, short } from './work-pane-parts.mjs';

/** How many it shows before “All …”. */
const FIRST = 5;

/** The conversation’s newest items, from the range the page holds or what it kept of the end. @param {string} convId */
const latest = (convId) => latestItems(client.state, client.ranges.get(convId), convId);

/** What In this chat ranks now. @param {string} convId */
export const relevantNow = (convId) => relevantRefs(client.state, convId, latest(convId));

/** What In this chat reads of the messages, to tell whether a message event can change it. @param {string} convId */
export const chatKey = (convId) => saidKey(latest(convId));

/** The ids In this chat shows, so Files and Assets don’t list them again. @param {any[]} list @param {boolean} all */
export const shownIds = (list, all) => new Set((all ? list : list.slice(0, FIRST)).map((r) => r.at));

/**
 * The In this chat section, or null when the latest messages and turns name nothing the viewer opens.
 * @param {string} convId @param {any[]} list  relevantNow’s @param {{ all: boolean, showAll: () => void }} opts
 */
export function relevantSection(convId, list, { all, showAll }) {
  if (!list.length) return null;
  const make = (/** @type {any} */ r) =>
    row(`wc-now-${r.at}`, () => openWork(convId, { at: r.at }), nameFirst(r.name), h('span.small.dim', r.kind === 'asset' ? 'Asset' : 'File'));
  return sec(
    'wc-now',
    'In this chat',
    String(list.length),
    h('p.small.dim', 'Named in the latest messages, or changed in the latest turns.'),
    all ? h('ul.wc-list', list.map(make)) : short(list, make, showAll, FIRST),
  );
}

/**
 * In this chat’s list, held still while the person reads (reading-hold.mjs). A message event counts only when it
 * changes what In this chat reads (chatKey): a step or a reaction draws nothing.
 * @param {string} convId @param {HTMLElement} pane @param {() => void} repaint
 */
export function chatList(convId, pane, repaint) {
  const hold = readingHold(pane, repaint);
  let list = relevantNow(convId);
  let key = chatKey(convId);
  return {
    /** The list to draw: the newest, or the one shown while the person reads. */
    current() {
      if (!hold.reading()) list = relevantNow(convId);
      return list;
    },
    /** Whether a message event changed what In this chat reads. */
    said() {
      const k = chatKey(convId);
      if (k === key) return false;
      key = k;
      return true;
    },
    destroy: hold.destroy,
  };
}
