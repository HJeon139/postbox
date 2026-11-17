// The live-progress measurement’s sections (tools/measure-progress.mjs): each backend’s recorded turns, a long turn,
// and crowds at 1x, 10x and 100x, each on the virtual clock (drive.mjs), with the log counted as written
// (log-bytes.mjs) and the wire as tabs get it (wire.mjs). Each returns rows of numbers; the runner prints them.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopTimers } from '../../server/runtime-close.mjs';
import { Store } from '../../server/store.mjs';
import { setup } from '../../tests/side-threads-fixture.mjs';
import { makeRooms, play, scriptTurns, settled, ticking } from './drive.mjs';
import { longTurn, MAPPERS, recordings, turnsOfAll } from './fixtures.mjs';
import { countingIo, shares, tally } from './log-bytes.mjs';
import { openTabs } from './wire.mjs';

/**
 * Runs `work` on a fresh store whose log writes are counted: `prepare` sets the room up and says which conversations
 * the `tabs` tabs on its stream have open; then every turn settles, the store closes and the log is counted. Returns
 * work’s numbers, the log’s shares and the tabs’ counts.
 * @param {{ tabs?: number, prepare?: (f: any) => { open: string[], [k: string]: any } }} o
 * @param {(f: any, prepared: any) => Promise<any>} work
 */
export async function measured({ tabs = 0, prepare = (f) => ({ open: [f.t.id] }) }, work) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-measure-'));
  try {
    const { io, written } = countingIo();
    const store = await new Store(dir, { io }).load();
    const f = setup(store);
    // The project’s folder isn’t a repository, so every git call the ledger makes answers as one there would, without
    // a process: real ones were about 30% of a crowd’s profile, and none of it Postbox’s own work.
    f.rt.ledger.git = notARepository;
    const prepared = prepare(f);
    const wire = tabs ? openTabs(store, tabs, prepared.open) : null;
    // The whole event loop’s work and the process’s CPU over the turns and what they start after them: the store’s
    // writes, the wire and the timers, not only the mappers. The virtual clock’s own stepping is in it too, the same
    // on every branch, so it’s compared between branches, never read as Postbox’s alone.
    const loop = performance.eventLoopUtilization();
    const cpu = process.cpuUsage();
    const out = await work(f, { ...prepared, wire });
    await settled(f.rt);
    // The turns’ ledger records, written after they end. Postbox’s close() waits for them with a grace timer
    // (settleLedger), which the virtual clock would run out at once, so this waits for the ledger itself.
    await ticking(f.rt.work.idle());
    const busy = performance.eventLoopUtilization(loop);
    const used = process.cpuUsage(cpu);
    stopTimers(f.rt);
    wire?.stop();
    await ticking(store.close());
    return { ...out, loopMs: busy.active, cpuMs: (used.user + used.system) / 1000, log: shares(tally(written())), tabs: wire?.tabs ?? [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What git answers in a folder that isn’t a repository (server/ledger-git.mjs runGit’s result). */
const notARepository = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });

/** Turns in one room, by the fixture’s agent @beta. @param {any} f @param {import('./drive.mjs').Recording} rec */
async function oneTurn(f, rec) {
  const slots = scriptTurns(f.adapter, [rec]);
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  return play(slots);
}

/** Sums rows of numbers, key by key. @param {Record<string, number>[]} rows */
const sum = (rows) => rows.reduce((a, r) => Object.fromEntries(Object.keys(r).map((k) => [k, (a[k] ?? 0) + r[k]])), /** @type {Record<string, number>} */ ({}));

/** A run’s numbers: the log’s bytes and shares, a page’s wire, and the event loop’s time a delta. @param {any} m */
function numbers(m) {
  const tab = m.tabs[0] ?? { bytes: 0, frames: 0 };
  return {
    logBytes: m.log.total,
    progressBytes: m.log.progress,
    progressEvents: m.log.progressEvents,
    mixedBytes: m.log.mixed,
    framing: m.log.framing,
    pageBytes: tab.bytes,
    pageFrames: tab.frames,
    pushes: m.pushes,
    pushMs: m.pushMs,
    loopMs: m.loopMs,
    cpuMs: m.cpuMs,
    errors: m.errors,
  };
}

/** Each backend’s recorded turns, one at a time, and apart from them the recordings that aren’t turns. */
export async function backends() {
  const rows = [];
  for (const backend of Object.keys(MAPPERS)) {
    const all = recordings(backend);
    for (const [label, recs] of [
      ['turns', all.filter((r) => r.turn)],
      ['not turns', all.filter((r) => !r.turn)],
    ]) {
      /** @type {Record<string, number>[]} */
      const each = [];
      for (const rec of /** @type {any[]} */ (recs)) each.push(numbers(await measured({ tabs: 1 }, (f) => oneTurn(f, rec))));
      rows.push({ row: `${backend}, ${recs.length} ${label}`, ...sum(each) });
    }
  }
  return rows;
}

/** One turn of 300 and of 1,000 steps. */
export async function long() {
  const rows = [];
  for (const n of [300, 1000]) rows.push({ row: `one turn of ${n} steps`, ...numbers(await measured({ tabs: 1 }, (f) => oneTurn(f, longTurn(n)))) });
  return rows;
}

/** The crowds: 4 agents in a room (1x), 40 in a room (10x), and 100 across 25 rooms (100x), with 1, 3 and 10 tabs. */
export async function crowded() {
  const pool = turnsOfAll();
  const rows = [];
  for (const [label, rooms, per] of /** @type {const} */ ([
    ['1x: 4 agents in a room', 1, 4],
    ['10x: 40 agents in a room', 1, 40],
    ['100x: 100 agents across 25 rooms', 25, 4],
  ]))
    for (const tabs of [1, 3, 10]) {
      const prepare = (/** @type {any} */ f) => {
        const rooms_ = makeRooms(f.rt, rooms, per);
        return { open: [rooms_[0].threadId], rooms: rooms_ };
      };
      const m = await measured({ tabs, prepare }, async (f, { rooms: made }) => {
        const slots = scriptTurns(
          f.adapter,
          Array.from({ length: rooms * per }, (_, i) => pool[i % pool.length]),
        );
        for (const room of made) f.rt.sendMessage(room.threadId, { text: room.wake });
        return play(slots);
      });
      rows.push({ row: `${label}, ${tabs} tabs`, ...numbers(m) });
    }
  return rows;
}
