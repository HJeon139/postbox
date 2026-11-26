// An agent’s ask that its answer never reached (#634). An agent @-mentions another with an ask; the woken turn’s reply
// usually reaches the asker, by @-mentioning it or by going back to it (#1518, server/reply-back.mjs). It doesn’t when
// the turn also took something else (the person’s message, a scheduled wake), when its reply @-mentions only others,
// or when it fails. Then the ask is marked with whom it waits on (`noReplyFrom` on the asker’s reply), and the
// transcript says “no reply from @b” under it: a quiet line, not a card or a need, as the asker can act on it in words.
// A later reply of b’s that reaches the asker clears the mark. b’s session keeps the asks it owes (`owes`, OWED.kept of
// them), so clearing reads no room. Functions take the Runtime first, as waiting code does.

import { OWED } from '../shared/limits.mjs';

/**
 * The agents a turn reached: by @-mention, by going back, by a topic it opened or a review of their block, and those
 * whose ask it reacted to, a “noted” in a click. @param {any} turn @param {string[]} wentBack @param {any[]} asks  the asks the turn took
 * @param {any} rt @param {string} handle  the turn’s agent
 */
function reached(rt, turn, wentBack, asks, handle) {
  // Every route to an agent records it (`reached`: agentWake, a review of its block); a mention held on a card, and one
  // the failed reply a Retry answers already woke, count too.
  const to = new Set([...(turn.reached ?? []), ...(turn.mentioned ?? []), ...(turn.woken ?? []), ...wentBack]);
  for (const e of asks) {
    const it = rt.store.pending.item(e.threadId, e.itemId);
    if ((it?.reactions ?? []).some((/** @type {any} */ r) => r.handle === handle && r.at >= turn.startedAt)) to.add(e.from);
  }
  return to;
}

/**
 * A turn ended or failed: the asks of agents it took and didn’t answer are marked, and those it answered now, earlier
 * ones included, are cleared. Only a direct @-mention is an ask: a reply that came back (`bounce`) may end its exchange
 * in silence (#1543). The person’s message is no mention entry: they see every reply in the room. Read pending: it decides the writes.
 * @param {any} rt @param {any} turn @param {any} se @param {any[]} took  the entries the turn took
 * @param {string[]} [wentBack]  the agents its reply went back to
 */
export function noteOwed(rt, turn, se, took, wentBack = []) {
  const asks = took.filter((e) => e.source === 'mention' && !e.bounce && e.from && e.itemId);
  const to = reached(rt, turn, wentBack, asks, se.handle);
  const was = rt.store.pending.session(se.id)?.owes ?? [];
  const cleared = was.filter((/** @type {any} */ o) => to.has(o.from));
  for (const o of cleared) mark(rt, o, se.handle, false);
  const owed = asks.filter((e) => !to.has(e.from)).map((e) => ({ threadId: e.threadId, itemId: e.itemId, from: e.from }));
  for (const o of owed) mark(rt, o, se.handle, true);
  const kept = was.filter((/** @type {any} */ o) => !to.has(o.from) && !owed.some((x) => x.itemId === o.itemId));
  const next = [...kept, ...owed].slice(-OWED.kept);
  if (next.length || was.length) rt.sessions.update(se.id, { owes: next.length ? next : undefined });
}

/** Adds or takes `handle` off an ask’s “no reply” mark. @param {any} rt @param {{ threadId: string, itemId: string }} o @param {string} handle @param {boolean} on */
function mark(rt, o, handle, on) {
  const it = rt.store.pending.item(o.threadId, o.itemId);
  if (!it) return;
  const was = Array.isArray(it.noReplyFrom) ? it.noReplyFrom : [];
  const next = on ? [...new Set([...was, handle])] : was.filter((/** @type {string} */ h) => h !== handle);
  if (next.length === was.length && next.every((h, i) => h === was[i])) return;
  rt.threads.patchItem(o.threadId, o.itemId, { noReplyFrom: next.length ? next : null });
}
