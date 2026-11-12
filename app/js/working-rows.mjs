// An agent’s working row beside its running reply (thread.mjs, paintWorking): whether its reply here is live, so the row
// needn’t say its thoughts, and whether, crowded, the reply says all the row would. Moved from activity-live.mjs.

import { CROWD, isLive, liveAgents } from './activity-live.mjs';
import { itemsOf } from './client.mjs';

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
