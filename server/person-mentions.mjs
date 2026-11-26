// A mention of a person is a “needs you” for them (#1742): the last reply of an agent’s turn that names a person by
// user name, or says @you to the person it answers, is marked with whom it asks (`asks` on the item), and the agent’s
// need follows from that mark as it does from a card (server/card-needs.mjs). The person reading it there, having the
// room open as it lands, or writing there, marks it read (`asksSeen`), and the need falls to whatever else waits. An
// ask that names people is read only by one of them; one that names no one, by whoever reads.
//
// The session keeps its newest unread asks (`asked`, ASKS.kept of them), so a view reads them without reading a room’s
// items: a page says what it has open every ten seconds, and a room can hold a million items. An ask older than those
// is read when it comes up as the session’s need, which each reading decides again, so none is left with nothing to
// clear it.
//
// Nothing here tells an agent to mention anyone: it decides only what a mention of a person does. Functions take the
// Runtime first, as waiting code does.

import { ASKS } from '../shared/limits.mjs';
import { parseMentions } from '../shared/text.mjs';
import { releaseNeed } from './card-needs.mjs';
import { copiedLine } from './copied-line.mjs';

/** What a reply calls the person it answers, when it doesn’t name them. */
const YOU = 'you';

/**
 * The people a reply asks, by id: null when it asks no person. Those it names by user name, and for @you the people
 * whose messages the turn took, by the sender each message carries. An empty list is @you to a person Postbox can’t
 * name (a message with no sender): whoever reads. A user name that is also an agent’s handle is the agent’s, and so is
 * @you in a reply to another agent, which asks no person.
 * @param {any} rt @param {any} se @param {any} turn @param {any} item @returns {string[] | null}
 */
function peopleAsked(rt, se, turn, item) {
  const handles = new Set(rt.personas.handles().map((/** @type {string} */ h) => h.toLowerCase()));
  const byName = new Map();
  for (const p of Object.values(rt.s.people)) {
    const name = String(/** @type {any} */ (p).username ?? '').toLowerCase();
    if (name && !handles.has(name)) byName.set(name, /** @type {any} */ (p).id);
  }
  const named = parseMentions(item.text, [...byName.keys(), YOU], copiedLine(rt, se));
  const ids = named.filter((n) => n !== YOU).map((n) => byName.get(n));
  const fromPerson = rt.delivery.takenBy(se.id, turn.id).filter((/** @type {any} */ e) => e.from === 'you' && e.itemId);
  const you = named.includes(YOU) && fromPerson.length > 0;
  if (!ids.length && !you) return null;
  const senders = you ? fromPerson.map((/** @type {any} */ e) => rt.store.pending.item(e.threadId, e.itemId)?.personId) : [];
  return [...new Set([...ids, ...senders.filter(Boolean)])];
}

/** Whether an ask is `personId`’s to read: one that names people, only theirs; one that names no one, anyone’s. */
const reads = (/** @type {string[]} */ asks, /** @type {string | null | undefined} */ personId) =>
  !asks.length || (Boolean(personId) && asks.includes(/** @type {string} */ (personId)));

/** Writes a session’s unread asks, without the ones named, and with one more if given. */
function keep(rt, /** @type {string} */ sessionId, /** @type {string[]} */ without, /** @type {any} */ more = null) {
  const was = rt.store.pending.session(sessionId)?.asked ?? [];
  const next = [...was.filter((/** @type {any} */ a) => !without.includes(a.itemId)), ...(more ? [more] : [])].slice(-ASKS.kept);
  if (next.length || was.length) rt.sessions.update(sessionId, { asked: next.length ? next : undefined });
}

/**
 * Marks a turn’s reply with the people it asks, as it becomes final. Only the turn’s last reply asks: “I will tell
 * @you when done.” followed by more work is narration, so a later reply of the same turn takes the mark off the one
 * before. Read already when one of the people it asks has the room open as it lands. Only an agent’s reply from a turn
 * Postbox runs counts, as a mention of an agent is taken (server/mention-entries.mjs): not a stopped reply, one
 * mirrored from a terminal, or a summary’s turn. @param {any} rt @param {{ threadId: string, item: any }} final
 */
export function markAsks(rt, { threadId, item }) {
  if (item.kind !== 'agent' || item.via === 'terminal' || !item.turnId || !item.sessionId) return;
  const turn = rt.running.turnFor(item.sessionId, item.turnId);
  // As written: the session, and the asks it keeps, may be behind a held commit, as the reply is.
  const se = rt.store.pending.session(item.sessionId);
  if (!turn || turn.summarizeTo || !se) return;
  const before = turn.personAsk ?? null;
  if (before) rt.threads.patchItem(before.threadId, before.itemId, { asks: null });
  const asks = item.status === 'stopped' ? null : peopleAsked(rt, se, turn, item);
  turn.personAsk = asks ? { threadId, itemId: item.id } : null;
  // Whoever of them has the room open as it lands has read it; it waits for the rest.
  const reader = rt.threads.viewer(threadId);
  const left = asks && reader !== undefined && reads(asks, reader) ? after(asks, reader) : asks;
  if (asks) rt.threads.patchItem(threadId, item.id, { asks, ...readMark(asks, left) });
  keep(rt, se.id, before ? [before.itemId] : [], left ? { itemId: item.id, threadId, for: left } : null);
}

/**
 * Whom an ask still waits for once `personId` has read it: the others it names, or no one (null) when they were the
 * last, or it named no one. @param {string[]} asks @param {string | null | undefined} personId @returns {string[] | null}
 */
function after(asks, personId) {
  const rest = asks.filter((id) => id !== personId);
  return asks.length && rest.length ? rest : null;
}

/** What an item keeps of who has read its ask: all of them (`asksSeen`), or those so far (`asksRead`). */
const readMark = (/** @type {string[]} */ asks, /** @type {string[] | null} */ left) => {
  if (!left) return { asksSeen: true };
  return left.length < asks.length ? { asksRead: asks.filter((id) => !left.includes(id)) } : {};
};

/**
 * A person has a thread open, or wrote in it: what its agents asked of them there is read, whichever of an agent’s asks
 * is its need now, and each need falls to whatever else waits. An ask for another person stays theirs.
 * @param {any} rt @param {{ threadId: string, personId?: string }} read  `personId` absent for one Postbox can’t name
 */
export function readAsks(rt, { threadId, personId }) {
  for (const { id } of /** @type {any[]} */ (Object.values(rt.store.pending.sessions()))) {
    for (let a = nextAsk(rt, id, threadId, personId); a; a = nextAsk(rt, id, threadId, personId)) {
      const item = rt.store.pending.item(threadId, a.itemId);
      const left = after(a.for, personId);
      rt.threads.patchItem(threadId, a.itemId, readMark(item?.asks ?? a.for, left));
      keep(rt, id, [a.itemId], left ? { ...a, for: left } : null);
      // The need is decided again: read by all it asked, it falls to whatever else waits; read by some, it is the
      // others’ from now on (needOf leaves out who has read it).
      releaseNeed(rt, rt.store.pending.session(id), a.itemId);
    }
  }
}

/**
 * The next of a session’s asks that is `personId`’s to read in the thread: one it keeps, and past the ones it keeps
 * (ASKS.kept), the one that is its need, which each reading decides again, so an ask too old to be kept is still read.
 * @param {any} rt @param {string} sessionId @param {string} threadId @param {string | null | undefined} personId
 */
function nextAsk(rt, sessionId, threadId, personId) {
  const se = rt.store.pending.session(sessionId);
  const kept = (se?.asked ?? []).find((/** @type {any} */ a) => a.threadId === threadId && reads(a.for, personId));
  if (kept) return kept;
  const need = se?.needs;
  if (need?.kind !== 'mention' || (need.threadId ?? se.threadId) !== threadId || !reads(need.for ?? [], personId)) return null;
  return { itemId: need.itemId, threadId, for: need.for ?? [] };
}
