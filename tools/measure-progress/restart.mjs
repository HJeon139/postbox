// A restart mid-turn, for the live-progress measurement (tools/measure-progress.mjs). Two processes: the build runs
// rooms of agents to half of each turn, then shuts down gracefully, as server/index.mjs’s close() does, or crashes,
// killing itself once the store has flushed what it was given; the load, in a fresh process, opens that folder and
// reports the log, the events it replays with and without the snapshot, the time and heap of the load, and the
// restart sweep over the turns cut off.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '../../server/adapters/adapter.mjs';
import { settleInterrupted, stopStreaming } from '../../server/restart-sweep.mjs';
import { Runtime } from '../../server/runtime.mjs';
import { stopTimers } from '../../server/runtime-close.mjs';
import { Store } from '../../server/store.mjs';
import { ScriptedAdapter, setup } from '../../tests/side-threads-fixture.mjs';
import { makeRooms, play, scriptTurns, ticking } from './drive.mjs';
import { turnsOfAll } from './fixtures.mjs';

/**
 * Runs `agents` agents, in rooms of 4, to half of each turn, in the folder `dir`; then `graceful` shuts down as
 * Postbox does, and `crash` kills the process once the store has flushed.
 * @param {string} dir @param {string} agents @param {string} mode
 */
export async function restartBuild(dir, agents, mode) {
  const store = await new Store(dir).load();
  const f = setup(store);
  const pool = turnsOfAll();
  const n = Number(agents);
  const rooms = makeRooms(f.rt, n / 4, 4);
  const slots = scriptTurns(
    f.adapter,
    Array.from({ length: n }, (_, i) => pool[i % pool.length]),
  );
  for (const room of rooms) f.rt.sendMessage(room.threadId, { text: room.wake });
  await play(slots, { upTo: 0.5, release: false });
  if (mode === 'crash') {
    await ticking(store.flush());
    process.kill(process.pid, 'SIGKILL');
  }
  const at = performance.now();
  await ticking(f.rt.work.stopAll());
  await ticking(f.rt.stopTurns());
  stopTimers(f.rt);
  // The ledger itself, not settleLedger’s grace timer, which the virtual clock would run out at once.
  await ticking(f.rt.work.idle());
  await ticking(store.close());
  return [{ row: `build ${agents} agents, ${mode}`, shutdownMs: performance.now() - at }];
}

/** The events in a folder’s log segments, and how many come after its snapshot’s seq. @param {string} dir */
function logOf(dir) {
  // The snapshot is lines (server/store-snapshot-lines.mjs); its seq is the line ["v", "seq", n].
  const snapLines = existsSync(join(dir, 'snapshot.json')) ? readFileSync(join(dir, 'snapshot.json'), 'utf8').split('\n') : [];
  const seqLine = snapLines.find((l) => l.startsWith('["v","seq",'));
  const seqs = readdirSync(dir)
    .filter((n) => n.startsWith('events-'))
    .flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean))
    .flatMap((line) => [JSON.parse(line)].flat().map((ev) => ev.seq));
  const bytes = readdirSync(dir)
    .filter((n) => n.startsWith('events-'))
    .reduce((a, n) => a + statSync(join(dir, n)).size, 0);
  const snapSeq = seqLine ? JSON.parse(seqLine)[2] : 0;
  return { bytes, events: seqs.length, afterSnapshot: seqs.filter((s) => s > snapSeq).length, whole: seqs.includes(1), snapSeq };
}

/** Loads a folder, timed, with the heap it took. @param {string} dir */
async function timedLoad(dir) {
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  const at = performance.now();
  const store = await new Store(dir).load();
  const loadMs = performance.now() - at;
  globalThis.gc?.();
  return { store, loadMs, heapMB: (process.memoryUsage().heapUsed - heap) / 1e6 };
}

/**
 * Opens what restartBuild left, and reports the restart: the log, the events replayed, the load, and the sweep over
 * the replies cut off. @param {string} dir @param {string} agents @param {string} mode
 */
export async function restartLoad(dir, agents, mode) {
  const log = logOf(dir);
  // A load not counted first, in a copy, so the counted ones don’t pay for the process’s warm-up.
  const warm = mkdtempSync(join(tmpdir(), 'pb-measure-warm-'));
  try {
    cpSync(dir, warm, { recursive: true });
    await (await new Store(warm).load()).close();
  } finally {
    rmSync(warm, { recursive: true, force: true });
  }
  let wholeMs = null;
  if (log.whole) {
    // The same log replayed from its first event, with no snapshot, in a copy.
    const copy = mkdtempSync(join(tmpdir(), 'pb-measure-whole-'));
    try {
      cpSync(dir, copy, { recursive: true });
      rmSync(join(copy, 'snapshot.json'), { force: true });
      const { store: s, loadMs } = await timedLoad(copy);
      wholeMs = loadMs;
      await s.close();
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  const { store, loadMs, heapMB } = await timedLoad(dir);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(new ScriptedAdapter()),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  const at = performance.now();
  settleInterrupted(rt);
  stopStreaming(rt);
  const sweepMs = performance.now() - at;
  stopTimers(rt);
  await store.close();
  return [
    {
      row: `restart after ${agents} agents, ${mode}`,
      logBytes: log.bytes,
      events: log.events,
      replayedWithSnapshot: log.afterSnapshot,
      replayedWithout: log.whole ? log.events : -1,
      loadMs,
      wholeLoadMs: wholeMs ?? -1,
      heapMB,
      sweepMs,
    },
  ];
}
