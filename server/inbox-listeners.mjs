// The inbox’s listeners on the bus (designs/architecture/services.md, “Delivery and Turns, built as the inbox”, and
// “The end of a turn”), which the composition root adds once, after its other listeners, in this order. A final reply’s
// mentions become entries, and its sender’s newer post is noted on what waits; an agent with waiting entries starts a
// turn through deliver until Turns starts it; the end of a turn settles what it took and wakes whom its replies
// mentioned, as its last step. Functions take the Runtime first, as waiting code does until Turns is a service.

import { mentionEntries, wakeMentioned } from './mention-entries.mjs';
import { startFromEntries } from './turns.mjs';

/** Adds the inbox’s listeners to the runtime’s bus. @param {any} rt */
export function listenInbox(rt) {
  const { bus, delivery } = rt;
  const settle = (/** @type {any} */ turn) => ({ sessionId: turn.sessionId, turnId: turn.id });
  bus.on('item.final', ({ threadId, item }) => {
    if (item.kind === 'agent' && item.handle) delivery.postedSince({ threadId, from: item.handle, itemId: item.id, turnId: item.turnId });
  });
  bus.on('item.final', (final) => mentionEntries(rt, final));
  bus.on('entry.waiting', ({ sessionId }) => startFromEntries(rt, sessionId));
  bus.on('turn.ended', ({ turn }) => delivery.turnEnded(settle(turn)));
  bus.on('turn.ended', ({ turn }) => wakeMentioned(rt, turn));
  // Lost after the harness accepted it is never claimed yet: one classifier of a harness’s failures comes with Turns
  // (#466), so a failed turn’s entries count as given to it.
  bus.on('turn.failed', ({ turn }) => delivery.turnFailed({ ...settle(turn), lost: false }));
  bus.on('turn.failed', ({ turn }) => wakeMentioned(rt, turn));
  // A turn the person stopped was given what it took; a shutdown’s stop raises nothing, so the restart reopens it once.
  bus.on('turn.stopping', ({ turn }) => delivery.turnEnded(settle(turn)));
}
