// A page joining mid-turn, for the live-progress measurement (tools/measure-progress.mjs): /api/state as a new page
// loads it, and tabs reconnecting to the store’s stream (wire.mjs), on the sections’ measured store (sections.mjs).
// Moved from sections.mjs.

import { pageState } from '../../server/page-state.mjs';
import { makeRooms, play, scriptTurns } from './drive.mjs';
import { turnsOfAll } from './fixtures.mjs';
import { measured } from './sections.mjs';
import { tabOn } from './wire.mjs';

/**
 * A page joining mid-turn, with 1, 10 and 100 turns running, half through each: /api/state as a new page loads it, and
 * 1 and 10 tabs reconnecting at once, each having missed everything since the turns started (the stream’s backlog).
 */
export async function joining() {
  const pool = turnsOfAll();
  const rows = [];
  for (const [running, rooms, per] of /** @type {const} */ ([
    [1, 1, 1],
    [10, 5, 2],
    [100, 25, 4],
  ]))
    for (const reconnecting of [1, 10]) {
      const prepare = (/** @type {any} */ f) => {
        const made = makeRooms(f.rt, rooms, per);
        return { open: [made[0].threadId], rooms: made };
      };
      const m = await measured({ tabs: 1, prepare }, (f, o) => joinMidTurn(f, o, pool, running, reconnecting));
      const { stateBytes, stateMs, backlogBytes, backlogFrames, reconnectMs } = m;
      rows.push({ row: `${running} turns running, ${reconnecting} tabs reconnecting`, stateBytes, stateMs, backlogBytes, backlogFrames, reconnectMs });
    }
  return rows;
}

/**
 * Runs `running` turns to half, then times /api/state and `reconnecting` tabs connecting at once from before the turns
 * started; then lets the turns end. @param {any} f @param {any} o @param {any[]} pool @param {number} running
 * @param {number} reconnecting
 */
async function joinMidTurn(f, { rooms, open, wire }, pool, running, reconnecting) {
  const slots = scriptTurns(
    f.adapter,
    Array.from({ length: running }, (_, i) => pool[i % pool.length]),
  );
  const since = f.store.state.seq;
  for (const room of rooms) f.rt.sendMessage(room.threadId, { text: room.wake });
  await play(slots, { upTo: 0.5, release: false });
  let at = performance.now();
  const page = { store: f.store, rt: f.rt, adapters: f.rt.adapters, origin: '', demo: false, real: null, config: f.rt.config, headers: wire.ls.headers };
  const state = JSON.stringify(pageState(page));
  const stateMs = performance.now() - at;
  at = performance.now();
  const tabs = Array.from({ length: reconnecting }, () => tabOn(wire.ls, f.store, open, since));
  const reconnectMs = performance.now() - at;
  for (const s of slots) s.release();
  return { stateBytes: Buffer.byteLength(state), stateMs, backlogBytes: tabs[0].bytes, backlogFrames: tabs[0].frames, reconnectMs };
}
