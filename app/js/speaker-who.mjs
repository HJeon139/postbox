// A message’s speaker line: the agent’s ring, its handle and the time, or “You” for the person’s own. Moved out of
// app/js/thread.mjs, which draws the transcript and calls it for each message that names its speaker.

import { mockMarker } from './agent-facts.mjs';
import { client } from './client.mjs';
import { dayOf, h, timeOf } from './dom.mjs';
import { replyLine } from './reply-rings.mjs';

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
  if (you) return h('div.who', ts, h('b', 'You'), via);
  const { ring, word } = se ? replyLine(it, se, threadId) : { ring: h('pb-ring', { name: it.handle, state: 'idle', ctx: '0', size: 'xs' }), word: null };
  const woke = it.woke ? h('span.woke', wokeText(it.woke)) : null;
  return h('div.who', ring, h('b', it.handle), mockMarker(se), word, it.deletedAgent ? h('span.deleted', '(deleted)') : null, via, woke, ts);
};
