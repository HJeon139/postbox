// Answering a read from the snapshot when Postbox is gone or slow (#582; designs/508/582/settle.md and deadline.md):
// the claim on a call, the offline answer, the snapshot read and the 100 s deadline timer. broker-tools.mjs takes the
// call, broker-postbox.mjs sends it again and settles it at a hello, and broker.mjs answers for a lost link.

import { REMOTE_READ_TIMEOUT_MS } from '../../../shared/limits.mjs';
import { REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';
import { readConversation, readMessage } from './broker-reading.mjs';
import { written } from './broker-records.mjs';
import { snapshotOf } from './broker-snapshot.mjs';
import { toShims } from './broker-state.mjs';

/**
 * @typedef {import('./broker-state.mjs').Broker} Broker
 * @typedef {import('./broker-state.mjs').Tool} Tool
 */

/** Whether a call is a read that can only be answered from the snapshot, because no Postbox is attached. @param {Broker} b @param {any} t */
export const detached = (b, t) => t.route === 'read' && !b.attached();

export const OFFLINE_NOTE = '\n\n(Read offline as of this turn’s start; earlier or changed items may be missing.)';

/**
 * Takes a call for an answer being written: a second answer is refused while it is held, and the returned function lets
 * it go. Used by an offline settle and by a live reply, so the rule that decides "taken" is in one place.
 * @param {any} t @returns {() => void}
 */
export function claim(t) {
  /** @type {(v?: any) => void} */
  let finish = () => {};
  t.replying = new Promise((resolve) => (finish = resolve));
  return () => {
    t.replying = undefined;
    finish();
  };
}

/** Whether a call is taken: answered, or being answered by settleOffline or a live reply (settle.md, “The claim”). @param {any} t */
export const settled = (t) => t.replied || !!t.replying;

/** The answer cut to replyChars, the offline notice kept at its end (settle.md, “The settle path”). @param {string} s */
export const offlineText = (s) => (s.length <= REMOTE_LIMITS.replyChars ? s : s.slice(0, REMOTE_LIMITS.replyChars - OFFLINE_NOTE.length) + OFFLINE_NOTE);

/**
 * Answers an open read from the snapshot, once: the first caller claims it, the rest return. The shim is told before
 * any journal write; the reply record follows a call record when there is one. Never throws: a failure becomes a log
 * line or a result.
 * @param {Broker} b @param {any} t
 */
export async function settleOffline(b, t) {
  // Only a read has a snapshot answer; an ask or queue call waits for Postbox (settle.md, “Which path answers a read”).
  if (t.route !== 'read' || settled(t)) return;
  const release = claim(t);
  // Marks the claim as the offline one: the hello must not send this call on, whereas a live reply's write in flight
  // (also `replying`) can still fail and leave the call to be sent again. Never cleared, and it needs no reset: a
  // claimed read is answered, or its call record failed and queueTool dropped it from b.tools.
  t.offline = true;
  try {
    if (t.timer) {
      b.timers.clearTimeout(t.timer);
      t.timer = undefined;
    }
    let r;
    try {
      r = await readLocal(b, t.turn, t.name, t.args, true);
    } catch (e) {
      r = { ok: false, text: `Postbox couldn’t read the snapshot: ${/** @type {any} */ (e)?.message || e}` };
    }
    const text = offlineText(r.text);
    t.result = { ok: r.ok, text };
    t.replied = true;
    t.args = null;
    // The shim hears the answer before any journal write, so a slow or failing disk cannot hold it up.
    toShims(b, t.turn, 'result', { id: t.id, ok: r.ok, text });
    // A reply record follows a call record, when there is one: a read that was never sent to Postbox wrote none.
    if (t.saved && !(await t.saved)) {
      const why = await written(b, t.turn, 'tools', { op: 'reply', id: t.id, ok: r.ok, text });
      if (why) b.log(`Turn ${t.turn}’s ${t.name} (${t.id}) offline record failed: ${why}`);
    }
  } finally {
    release();
  }
}

/**
 * Reads from the turn’s snapshot locally.
 * @param {Broker} b @param {string} turn @param {string} name @param {Record<string, any>} args @param {boolean} [offline]
 */
export async function readLocal(b, turn, name, args, offline = false) {
  const snap = await snapshotOf(b, turn);
  if (!snap) return { ok: false, text: `Postbox hasn’t sent this host the conversation yet, so ${name} can’t read it. Try again in a moment.` };
  const r = name === 'read_message' ? readMessage(snap, args) : readConversation(snap, args);
  return { ok: r.ok, text: r.ok && offline ? `${r.text}${OFFLINE_NOTE}` : r.text };
}

/**
 * Arms the 100s deadline timer for an admitted read invocation.
 * Clamps remaining time against b.now() - t.arrived.
 * @param {Broker} b @param {Tool} t
 */
export function armReadTimer(b, t) {
  if (b.closed || settled(t) || t.route !== 'read' || !b.attached() || t.timer) return;

  const now = b.now();
  const arrived = t.arrived ?? now;
  const elapsed = Math.max(0, now - arrived);
  const remaining = Math.min(REMOTE_READ_TIMEOUT_MS, Math.max(0, REMOTE_READ_TIMEOUT_MS - elapsed));

  if (remaining === 0) {
    settleOffline(b, t).catch(b.log);
    return;
  }

  t.timer = b.timers.setTimeout(() => {
    t.timer = undefined;
    settleOffline(b, t).catch(b.log);
  }, remaining);
}
