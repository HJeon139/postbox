// The inbox’s listeners on the bus (designs/architecture/services.md, “Delivery and Turns, built as the inbox”, and
// “The end of a turn”), which the composition root adds once, after its other listeners, in this order. A final reply’s
// mentions become entries, and its sender’s newer post is noted on what waits; an agent with waiting entries starts a
// turn through deliver until Turns starts it; the end of a turn settles what it took and wakes whom its replies
// mentioned, as its last step. Functions take the Runtime first, as waiting code does until Turns is a service.

import { mentionEntries, wakeMentioned } from './mention-entries.mjs';
import { takePending } from './message-queue.mjs';
import { markAsks, readAsks } from './person-mentions.mjs';
import { markReacted, planBack, replyBack } from './reply-back.mjs';
import { entriesFirst } from './turns.mjs';

/** Adds the inbox’s listeners to the runtime’s bus. @param {any} rt */
export function listenInbox(rt) {
  const { bus, delivery } = rt;
  const settle = (/** @type {any} */ turn) => ({ sessionId: turn.sessionId, turnId: turn.id });
  bus.on('item.final', ({ threadId, item }) => {
    if (item.kind === 'agent' && item.handle) delivery.postedSince({ threadId, from: item.handle, itemId: item.id, turnId: item.turnId });
  });
  bus.on('item.final', (final) => mentionEntries(rt, final));
  // A reply that names a person asks them, and their reading it is its answer (#1742): having the thread open, or
  // writing in it.
  bus.on('item.final', (final) => markAsks(rt, final));
  bus.on('thread.viewed', (viewed) => readAsks(rt, viewed));
  bus.on('item.final', ({ threadId, item }) => {
    if (item.kind === 'user') readAsks(rt, { threadId, personId: item.personId });
  });
  bus.on('entry.waiting', ({ sessionId }) => rt.turnService.start(sessionId));
  // R: what the turn took was delivered, the agents its replies mentioned are woken, and its own next entries start.
  // An entry that came before everything queued for the agent starts first, so what waited goes in arrival order (#733).
  // A turn only agents’ mentions started, that named no one, goes back to them (#1518): read what it took before it settles.
  bus.on('turn.ended', ({ turn, se }) => {
    const took = delivery.takenBy(se.id, turn.id);
    // Decided, and marked on the reply, before the agent’s next turn can start and be told where its reply goes (#1591).
    const back = planBack(rt, turn, se, took);
    // Marked before the agents its replies mentioned are woken, so their turns are told it only reacted (#1974).
    markReacted(rt, turn, se, took);
    const first = entriesFirst(rt, se, turn);
    if (!first) takePending(rt, se, turn, true);
    delivery.turnEnded(settle(turn));
    wakeMentioned(rt, turn);
    replyBack(rt, turn, se, back);
    if (first) takePending(rt, se, turn, true);
  });
  // L4: the person’s messages that waited for it wait for them now (#1146), unless it resends on its own, and a wake
  // that waited still goes: it was promised an answer (#228). What it took settles by why it failed, before anything
  // wakes the agent: lost to the network (harness-failure.mjs), it goes once more as a resend, ahead of what came
  // after it, and fails if it was one (#466).
  bus.on('turn.failed', ({ turn, se, lost, resends }) => {
    if (!resends) delivery.failedWith(se.id);
    delivery.turnFailed({ ...settle(turn), lost });
    takePending(rt, se, turn, 'wakes');
    wakeMentioned(rt, turn);
  });
  // A turn the person stopped was given what it took; a shutdown’s stop raises nothing, so the restart reopens it once.
  bus.on('turn.stopping', ({ turn }) => delivery.turnEnded(settle(turn)));
  // The stopped turn is gone: entries that arrived during its exit start the next turn, if nothing else did.
  bus.on('turn.exited', ({ turn }) => delivery.wake(turn.sessionId));
}
