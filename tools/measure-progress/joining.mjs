// A page joining mid-turn, for the live-progress measurement (tools/measure-progress.mjs): /api/state as a new page
// loads it, and tabs reconnecting to the store’s stream (wire.mjs), on the sections’ measured store (sections.mjs).
// Moved from sections.mjs.

import { pageState } from '../../server/page-state.mjs';
import { makeRooms, play, scriptTurns } from './drive.mjs';
import { turnsOfAll } from './fixtures.mjs';
import { measured } from './sections.mjs';
import { tabOn } from './wire.mjs';

/** Where a reconnecting tab dropped: before the turns started, or a short drop, at 45% of each turn, with half run. */
const DROPS = /** @type {const} */ ([
  ['missed the turns', 0],
  ['a short drop', 0.45],
]);

/**
 * A page joining mid-turn, with 1, 10 and 100 turns running, half through each: /api/state as a new page loads it, and
 * 1 and 10 tabs reconnecting at once after a long drop or a short one. For one reconnecting tab: what its connect
 * sends, the running turns’ live snapshot within it apart, and what it’s sent after, to the turns’ end.
 */
export async function joining() {
  const pool = turnsOfAll();
  const rows = [];
  for (const [running, rooms, per] of /** @type {const} */ ([
    [1, 1, 1],
    [10, 5, 2],
    [100, 25, 4],
  ]))
    for (const [drop, at] of DROPS)
      for (const reconnecting of [1, 10]) {
        const prepare = (/** @type {any} */ f) => {
          const made = makeRooms(f.rt, rooms, per);
          return { open: [made[0].threadId], rooms: made };
        };
        const m = await measured({ tabs: 1, prepare }, (f, o) => joinMidTurn(f, o, { pool, running, reconnecting, at }));
        const tab = m.rejoined;
        rows.push({
          row: `${running} turns running, ${reconnecting} tabs reconnecting, ${drop}`,
          stateBytes: m.stateBytes,
          stateMs: m.stateMs,
          reconnectMs: m.reconnectMs,
          connectBytes: tab.connectBytes,
          connectFrames: tab.connectFrames,
          snapshotBytes: tab.snapshotBytes,
          snapshotFrames: tab.snapshotFrames,
          toEndBytes: tab.bytes,
          toEndFrames: tab.frames,
        });
      }
  return rows;
}

/**
 * Runs `running` turns to half, noting the seq at `at` of each, then times /api/state and `reconnecting` tabs
 * connecting at once from that seq; then lets the turns end, the first tab still counting.
 * @param {any} f @param {any} o @param {{ pool: any[], running: number, reconnecting: number, at: number }} p
 */
async function joinMidTurn(f, { rooms, open, wire }, { pool, running, reconnecting, at }) {
  const slots = scriptTurns(
    f.adapter,
    Array.from({ length: running }, (_, i) => pool[i % pool.length]),
  );
  let since = f.store.state.seq;
  for (const room of rooms) f.rt.sendMessage(room.threadId, { text: room.wake });
  if (at) {
    await play(slots, { upTo: at, release: false });
    since = f.store.state.seq;
  }
  await play(slots, { from: at, upTo: 0.5, release: false });
  let t = performance.now();
  const page = { store: f.store, rt: f.rt, adapters: f.rt.adapters, origin: '', demo: false, real: null, config: f.rt.config, headers: wire.ls.headers };
  const state = JSON.stringify(pageState(page));
  const stateMs = performance.now() - t;
  t = performance.now();
  const tabs = Array.from({ length: reconnecting }, () => tabOn(wire.ls, f.store, open, since));
  const reconnectMs = performance.now() - t;
  await play(slots, { from: 0.5 });
  return { stateBytes: Buffer.byteLength(state), stateMs, reconnectMs, rejoined: tabs[0] };
}
