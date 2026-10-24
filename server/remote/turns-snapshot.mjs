// The conversation snapshot a remote turn’s host keeps (#120, server/remote/turns.mjs): it goes before the adapter’s
// `start`, so the reading tools on the host never find it missing, again in full at each welcome, and as
// snapshot-items while the turn runs.

import { encodedBytes, REMOTE_LIMITS } from '../../shared/remote-protocol.mjs';
import { linkOf } from './turns-need.mjs';
import { SNAPSHOT_FLUSH_MS, send } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */
/** @typedef {import('./turns-shared.mjs').Live} Live */

/**
 * The conversation as the session’s reading tools see it: its threads in conversationThreads’ order, each with the
 * items read_conversation pages through (every one counts, so one with no line is kept with an empty one), each with
 * its line and the full text read_message reads, in the runtime’s own words.
 * @param {RemoteTurns} rts @param {any} se
 */
export function snapshotOf(rts, se) {
  const rt = rts.rt;
  const threads = rt
    .conversationThreads(se.threadId)
    .slice(0, REMOTE_LIMITS.snapshotThreads)
    .map((/** @type {string} */ id) => ({ id, items: readable(rts, id).map((/** @type {any} */ i) => itemOf(rts, i, se)) }));
  return { home: se.threadId, threads: fit(threads) };
}

/** read_conversation’s items for a thread. @param {RemoteTurns} rts @param {string} threadId */
function readable(rts, threadId) {
  return rts.rt.store
    .items(threadId)
    .filter((/** @type {any} */ i) => i.kind !== 'system' || i.variant === 'wake')
    .slice(-REMOTE_LIMITS.snapshotItems);
}

/** @param {RemoteTurns} rts @param {any} i @param {any} se */
function itemOf(rts, i, se) {
  const line = String(rts.rt.readLine(i, se) ?? '').slice(0, REMOTE_LIMITS.snapshotLineChars);
  const text = String(rts.rt.readLine(i, se, Number.POSITIVE_INFINITY) ?? '').slice(0, REMOTE_LIMITS.snapshotTextChars);
  return { id: i.id, line, text, ...(i.kind === 'block' && i.valid && typeof i.block?.id === 'string' ? { blockId: i.block.id } : {}) };
}

/** @param {RemoteTurns} rts @param {Live} live @param {string} turn */
export function sendSnapshot(rts, live, turn) {
  const se = rts.rt.s.sessions[live.sessionId];
  const link = live.link ?? linkOf(rts, live.hostId);
  if (!se || !link) return false;
  const sent = send(link, 'snapshot', { turn, ...snapshotOf(rts, se) });
  // Not sent: it goes in full at the next welcome.
  if (!sent) markDirty(rts, live.sessionId, null, null);
  return sent;
}

/** @param {RemoteTurns} rts @param {any} ev */
export function onStoreEvent(rts, ev) {
  if (!rts.live.size) return;
  const d = ev.data ?? {};
  if (ev.type === 'item.add' || ev.type === 'item.patch' || ev.type === 'item.text') {
    const id = ev.type === 'item.add' ? d.item?.id : d.id;
    for (const live of rts.live.values()) if (inConversation(rts, live, d.threadId)) markDirty(rts, live.sessionId, d.threadId, id);
  } else if (ev.type === 'item.move' || ev.type === 'thread') {
    // A moved item changes the order, and a new thread the list: snapshot-items can say neither, so it goes in full.
    const threadId = ev.type === 'thread' ? d.id : d.threadId;
    for (const live of rts.live.values()) if (inConversation(rts, live, threadId)) markDirty(rts, live.sessionId, null, null);
  }
}

/** @param {RemoteTurns} rts @param {Live} live @param {string} threadId */
function inConversation(rts, live, threadId) {
  const se = rts.rt.s.sessions[live.sessionId];
  if (!se || !threadId) return false;
  const root = (/** @type {string} */ id) => rts.rt.lineage(id).at(-1);
  return root(threadId) === root(se.threadId);
}

/** @param {RemoteTurns} rts @param {string} sessionId @param {string | null} threadId @param {string | null} itemId  null: all of it */
function markDirty(rts, sessionId, threadId, itemId) {
  const d = rts.dirty.get(sessionId) ?? { full: false, items: new Map() };
  rts.dirty.set(sessionId, d);
  if (!threadId || !itemId) d.full = true;
  else {
    const set = d.items.get(threadId) ?? new Set();
    set.add(itemId);
    d.items.set(threadId, set);
  }
  if (!rts.flushTimer && !rts.closed) {
    rts.flushTimer = rts.setTimer(() => flushSnapshots(rts), SNAPSHOT_FLUSH_MS);
    rts.flushTimer?.unref?.();
  }
}

/** Sends what changed in each live turn’s conversation: snapshot-items per thread, or the whole snapshot. @param {RemoteTurns} rts */
export function flushSnapshots(rts) {
  rts.flushTimer = null;
  const dirty = [...rts.dirty];
  rts.dirty.clear();
  for (const [sessionId, d] of dirty) {
    const live = rts.live.get(sessionId);
    const se = rts.rt.s.sessions[sessionId];
    if (!live?.current || !se) continue;
    if (d.full) {
      sendSnapshot(rts, live, live.current);
      continue;
    }
    const threads = rts.rt.conversationThreads(se.threadId);
    for (const [threadId, ids] of d.items) {
      if (!threads.includes(threadId)) continue;
      const items = readable(rts, threadId)
        .filter((/** @type {any} */ i) => ids.has(i.id))
        .map((/** @type {any} */ i) => itemOf(rts, i, se));
      if (items.length && !send(live.link, 'snapshot-items', { turn: live.current, thread: threadId, items })) markDirty(rts, sessionId, null, null);
    }
  }
}

/**
 * A snapshot within one message’s limit: the oldest items’ full text goes first (their lines stay, so paging still
 * counts them), then their lines.
 * @param {{ id: string, items: { id: string, line: string, text: string, blockId?: string }[] }[]} threads
 */
function fit(threads) {
  const limit = REMOTE_LIMITS.lineBytes - 64 * 1024;
  if (encodedBytes({ threads }) <= limit) return threads;
  for (const field of /** @type {const} */ (['text', 'line'])) {
    const all = threads.flatMap((t) => t.items);
    let size = encodedBytes({ threads });
    for (const it of all) {
      if (size <= limit) return threads;
      size -= Buffer.byteLength(JSON.stringify(it[field]), 'utf8') - 2;
      it[field] = '';
    }
  }
  return threads;
}
