// The broker’s snapshot (#120): what Postbox sent of the conversation (`snapshot`, then `snapshot-items`), kept in
// snapshot.json in the turn folder, or in memory until `start` makes the folder, for the reading tools
// (broker-reading.mjs). broker.mjs’s header says how its threads and items are ordered.

import { REMOTE_LIMITS, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { exists, writeAtomic } from './broker-records.mjs';

/**
 * @typedef {import('./broker-state.mjs').Broker} Broker
 * @typedef {import('./broker-reading.mjs').Snapshot} Snapshot
 */

/** Snapshots for turns not started yet, kept at most; and snapshots read from disk, kept in memory at most. */
const PENDING_SNAPSHOTS = 64;
const CACHED_SNAPSHOTS = 16;

/** @param {Broker} b @param {string} turn @returns {Promise<Snapshot | null>} */
export async function snapshotOf(b, turn) {
  const had = b.cachedSnapshots.get(turn) ?? b.pendingSnapshots.get(turn);
  if (had) return had;
  let snap;
  try {
    snap = JSON.parse(await b.io.readFile(b.p.turn(turn, TURN_FILES.snapshot), 'utf8'));
  } catch {
    return null;
  }
  if (!snap || typeof snap.home !== 'string' || !Array.isArray(snap.threads)) return null;
  cache(b, turn, snap);
  return snap;
}
/** @param {Broker} b @param {string} turn @param {Snapshot} snap */
function cache(b, turn, snap) {
  b.cachedSnapshots.delete(turn);
  b.cachedSnapshots.set(turn, snap);
  while (b.cachedSnapshots.size > CACHED_SNAPSHOTS) b.cachedSnapshots.delete(/** @type {string} */ (b.cachedSnapshots.keys().next().value));
}
/** Keeps a turn’s snapshot: in its folder once there is one, else in memory until `start`. @param {Broker} b @param {string} turn @param {Snapshot} snap */
export async function saveSnapshot(b, turn, snap) {
  if (await exists(b.p.turn(turn))) {
    await writeAtomic(b, b.p.turn(turn, TURN_FILES.snapshot), JSON.stringify(snap));
    b.pendingSnapshots.delete(turn);
    cache(b, turn, snap);
    return;
  }
  b.pendingSnapshots.delete(turn);
  b.pendingSnapshots.set(turn, snap);
  while (b.pendingSnapshots.size > PENDING_SNAPSHOTS) b.pendingSnapshots.delete(/** @type {string} */ (b.pendingSnapshots.keys().next().value));
}

/** @param {Broker} b @param {any} m @param {{ fail: (code: string, text: string) => void }} reply */
export async function snapshotItems(b, m, reply) {
  const snap = await snapshotOf(b, m.turn);
  if (!snap) return reply.fail('no-turn', `There’s no snapshot for turn ${m.turn} on this host. Send snapshot first.`);
  let th = snap.threads.find((t) => t.id === m.thread);
  if (!th) {
    if (snap.threads.length >= REMOTE_LIMITS.snapshotThreads)
      return reply.fail('bad-message', `Turn ${m.turn}’s snapshot already has ${REMOTE_LIMITS.snapshotThreads} threads, so ${m.thread} wasn’t added.`);
    th = { id: m.thread, items: [] };
    snap.threads.push(th);
  }
  const at = new Map(th.items.map((it, i) => [it.id, i]));
  for (const it of m.items) {
    const i = at.get(it.id);
    if (i === undefined) {
      at.set(it.id, th.items.length);
      th.items.push(it);
    } else th.items[i] = it;
  }
  // The oldest go first: read_conversation reads from the newest.
  if (th.items.length > REMOTE_LIMITS.snapshotItems) th.items.splice(0, th.items.length - REMOTE_LIMITS.snapshotItems);
  await saveSnapshot(b, m.turn, snap);
}
