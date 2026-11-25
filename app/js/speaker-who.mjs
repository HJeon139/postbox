// A message’s speaker line: the agent’s ring, its handle and the time, or “You” for the person’s own. Moved out of
// app/js/thread.mjs, which draws the transcript and calls it for each message that names its speaker.

import { mockMarker } from './agent-facts.mjs';
import { client } from './client.mjs';
import { dayOf, h, timeOf } from './dom.mjs';
import { replyLine } from './reply-rings.mjs';
import { namesSpeaker } from './speaker-line.mjs';

const S = () => client.state;

// What woke the turn (#135): “woken by @critic”, “after @researcher replied in a side thread”, or its scheduled wake.
function wokeText({ by, reply, in: at, scheduled }) {
  if (scheduled) return 'woken by a scheduled wake';
  if (!reply) return `woken by ${by}`;
  return `after ${by} replied${{ side: ' in a side thread', topic: ' in a thread' }[S().threads[at]?.kind] ?? ''}`;
}

/** @param {any} it @param {{ you?: boolean, threadId?: string }} [opts] */
export const who = (it, { you = false, threadId = '' } = {}) => {
  const se = S().sessions[it.sessionId];
  const ts = h('span.ts', { title: `${dayOf(it.at)} ${timeOf(it.at)}` }, timeOf(it.at));
  // A turn typed into Claude Code in a terminal, mirrored here, says so.
  const via = it.via === 'terminal' ? h('span.via', 'from terminal') : null;
  // Another person’s message carries their name (#558); your own, and one from before profiles, reads “You”.
  const mine = !it.by || it.by.id === client.who?.me?.id;
  if (you) return h('div.who', ts, h('b', mine ? 'You' : it.by.name), mine ? null : h('span.via', `@${it.by.handle}`), via);
  const { ring, word } = se ? replyLine(it, se, threadId) : { ring: h('pb-ring', { name: it.handle, state: 'idle', ctx: '0', size: 'xs' }), word: null };
  const woke = it.woke ? h('span.woke', wokeText(it.woke)) : null;
  // A reply that @-mentions you is in your queue (#558).
  const forYou = it.forPeople?.some((/** @type {any} */ p) => p.id === client.who?.me?.id) ? h('span.woke', 'mentions you') : null;
  return h('div.who', ring, h('b', it.handle), mockMarker(se), word, it.deletedAgent ? h('span.deleted', '(deleted)') : null, via, woke, forYou, ts);
};

/**
 * Puts a drawn item’s speaker line where it now belongs, once the item before it starts or stops drawing anything
 * (#1654), without drawing the item again: an app keeps its running frame, and what the person did in it. An agent’s
 * reply or a block gets or loses its line in place. Returns false for a node of any other shape, which the caller draws
 * again. @param {HTMLElement | undefined} node @param {any} it @param {any} prev @param {string} threadId
 */
export function moveSpeakerLine(node, it, prev, threadId) {
  if (!node) return true;
  const app = it.kind === 'block' && it.valid && it.block.type === 'app';
  if (!app && !(['agent', 'block'].includes(it.kind) && node.matches('.col.turn'))) return false;
  // An app’s line sits in a column of its own above the frame; a reply’s or a block’s is the node’s first child.
  const line = app ? node.querySelector(':scope > .col > .who')?.parentElement : node.querySelector(':scope > .who');
  const want = namesSpeaker(it, prev, threadId);
  if (want === Boolean(line)) return true;
  if (line) line.remove();
  else node.prepend(app ? h('div.col', who(it, { threadId })) : who(it, { threadId }));
  return true;
}
