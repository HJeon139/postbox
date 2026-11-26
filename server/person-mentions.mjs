// A mention of a person is a “needs you” for them (#1742): a final reply that names a person by user name, or says
// @you to the person it answers, is marked with whom it asks (`asks` on the item), and the agent’s need follows from
// that mark as it does from a card (server/card-needs.mjs). The person reading it, or having the room open as it
// lands, marks it read (`asksSeen`), and the need falls to whatever else waits. Nothing here tells an agent to mention
// anyone: it decides only what a mention of a person does. Functions take the Runtime first, as waiting code does.

import { parseMentions } from '../shared/text.mjs';
import { releaseNeed } from './card-needs.mjs';
import { copiedLine } from './copied-line.mjs';

/** What a reply calls the person it answers, when it doesn’t name them. */
const YOU = 'you';

/**
 * The people a reply asks, by id: null when it asks no person. An empty list is the person the reply answers, whoever
 * that is: Sessions’ needFor names them, the room’s last person. A user name that is also an agent’s handle is the
 * agent’s. @you in a reply to another agent is that agent’s, so it asks no person.
 * @param {any} rt @param {any} se @param {any} turn @param {any} item @returns {string[] | null}
 */
function peopleAsked(rt, se, turn, item) {
  const handles = new Set(rt.personas.handles().map((/** @type {string} */ h) => h.toLowerCase()));
  const byName = new Map();
  for (const p of Object.values(rt.s.people)) {
    const name = String(/** @type {any} */ (p).username ?? '').toLowerCase();
    if (name && name !== YOU && !handles.has(name)) byName.set(name, /** @type {any} */ (p).id);
  }
  const named = parseMentions(item.text, [...byName.keys(), YOU], copiedLine(rt, se));
  const ids = named.filter((n) => n !== YOU).map((n) => byName.get(n));
  const answersPerson = rt.delivery.takenBy(se.id, turn.id).some((/** @type {any} */ e) => e.from === 'you');
  if (!ids.length && !(named.includes(YOU) && answersPerson)) return null;
  return ids;
}

/**
 * Marks a final reply with the people it asks, read already when one of them has the room open as it lands. Only an
 * agent’s reply from a turn Postbox runs, as a mention of an agent is taken (server/mention-entries.mjs).
 * @param {any} rt @param {{ threadId: string, item: any }} final
 */
export function markAsks(rt, { threadId, item }) {
  if (item.kind !== 'agent' || item.via === 'terminal' || !item.turnId || !item.sessionId || item.status === 'stopped') return;
  const turn = rt.running.turnFor(item.sessionId, item.turnId);
  const se = rt.s.sessions[item.sessionId];
  if (!turn || turn.summarizeTo || !se) return;
  const asks = peopleAsked(rt, se, turn, item);
  if (!asks) return;
  const reader = rt.threads.viewer(threadId);
  const seen = reader !== undefined && (!asks.length || !reader || asks.includes(reader));
  rt.threads.patchItem(threadId, item.id, { asks, ...(seen ? { asksSeen: true } : {}) });
}

/**
 * A person has a thread open: what its agents asked of them there is read, and each agent’s need falls to whatever
 * else waits. A mention for another person stays theirs. `personId` is absent for a view no person’s request made.
 * @param {any} rt @param {{ threadId: string, personId?: string }} viewed
 */
export function readAsks(rt, { threadId, personId }) {
  for (const se of Object.values(rt.s.sessions)) {
    const need = /** @type {any} */ (se).needs;
    if (need?.kind !== 'mention' || (need.threadId ?? /** @type {any} */ (se).threadId) !== threadId) continue;
    const theirs = /** @type {any} */ (se).needsFor;
    if (personId && theirs?.length && !theirs.includes(personId)) continue;
    rt.threads.patchItem(threadId, need.itemId, { asksSeen: true });
    releaseNeed(rt, se, need.itemId);
  }
}
