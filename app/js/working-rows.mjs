// An agent’s working row beside its running reply (thread.mjs, paintWorking): what it says, whether its reply here is
// live, so the row needn’t say its thoughts, and whether, crowded, the reply says all the row would. liveHere and
// saysItself moved from activity-live.mjs, and fillWorkRow from thread.mjs.

import { CROWD, isLive, liveAgents } from './activity-live.mjs';
import { subagentNow } from './agents.mjs';
import { itemsOf } from './client.mjs';
import { fill, h } from './dom.mjs';
import { ringFor, stateWord } from './ring.mjs';

/**
 * Whether an agent’s reply here is live, its thoughts and words shown as they’re written, so its working row needn’t
 * say them again. @param {any} se @param {string} threadId
 */
export function liveHere(se, threadId) {
  const items = itemsOf(threadId);
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'agent' && items[i].sessionId === se.id) return isLive(items[i], threadId);
  return false;
}

/**
 * Whether an agent at work needs no working row: crowded, its running reply here is its name, its state, a line of its
 * words and its step, all a working row would say. @param {any} se @param {string} threadId
 */
export const saysItself = (se, threadId) => liveAgents(threadId) >= CROWD && liveHere(se, threadId);

/** Fills an agent’s working row: its ring, its state and step, its glimpse and its subagents at work. */
export function fillWorkRow(row, se, threadId) {
  ringFor(se, 'xs', row.querySelector('pb-ring'));
  const step = se.state === 'tool' && se.currentStep ? `: ${se.currentStep}` : '';
  fill(
    row.querySelector('.work-text'),
    h('div.work-line', h('b', se.handle), h('span.dim', ` · ${stateWord(se.state).toLowerCase()}${step}`)),
    se.glimpse && !liveHere(se, threadId) ? h('div.glimpse', se.glimpse) : null, // a live reply shows it as it’s written
    // Each subagent at work, in its own words when it has said something (#73): “reader: Now I’ll read paper 3…”.
    (se.subagents ?? []).map((x) => h('div.work-line.work-sub', h('span', `${x.name}: `), h('span.dim', subagentNow(x)))),
  );
}
