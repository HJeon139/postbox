// The inbox’s listeners on the bus (designs/architecture/services.md, “Delivery and Turns, built as the inbox”, and
// “The end of a turn”), which the composition root adds once, after its other listeners, in this order. A final reply’s
// mentions become entries, and its sender’s newer post is noted on what waits; an agent with waiting entries starts a
// turn through deliver until Turns starts it; the end of a turn settles what it took and wakes whom its replies
// mentioned, as its last step. Functions take the Runtime first, as waiting code does until Turns is a service.

import { mentionEntries, wakeMentioned } from './mention-entries.mjs';
import { entriesFirst } from './turns.mjs';

/** Adds the inbox’s listeners to the runtime’s bus. @param {any} rt */
export function listenInbox(rt) {
  const { bus, delivery } = rt;
  const settle = (/** @type {any} */ turn) => ({ sessionId: turn.sessionId, turnId: turn.id });
  bus.on('item.final', ({ threadId, item }) => {
    if (item.kind === 'agent' && item.handle) delivery.postedSince({ threadId, from: item.handle, itemId: item.id, turnId: item.turnId });
  });
  bus.on('item.final', (final) => mentionEntries(rt, final));
  bus.on('entry.waiting', ({ sessionId }) => rt.turnService.start(sessionId));
  // R: what the turn took was delivered, the agents its replies mentioned are woken, and its own next entries start.
  // An entry that came before everything queued for the agent starts first, so what waited goes in arrival order (#733).
  bus.on('turn.ended', ({ turn, se }) => {
    const first = entriesFirst(rt, se, turn);
    if (!first) rt.takePending(se, turn, true);
    delivery.turnEnded(settle(turn));
    wakeMentioned(rt, turn);
    if (first) rt.takePending(se, turn, true);
  });
  // L4: the person’s messages that waited for it wait for them now (#1146), and a wake that waited still goes: it was
  // promised an answer (#228). Lost after the harness accepted it is never claimed yet: one classifier of a harness’s
  // failures comes with Turns (#466), so a failed turn’s entries count as given to it.
  bus.on('turn.failed', ({ turn, se }) => {
    delivery.failedWith(se.id);
    rt.takePending(se, turn, 'wakes');
    delivery.turnFailed({ ...settle(turn), lost: false });
    wakeMentioned(rt, turn);
  });
  // A turn the person stopped was given what it took; a shutdown’s stop raises nothing, so the restart reopens it once.
  bus.on('turn.stopping', ({ turn }) => delivery.turnEnded(settle(turn)));
  // The stopped turn is gone: entries that arrived during its exit start the next turn, if nothing else did.
  bus.on('turn.exited', ({ turn }) => delivery.wake(turn.sessionId));
}
