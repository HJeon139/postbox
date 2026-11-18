// A restart mid-turn, for the live-progress measurement (tools/measure-progress.mjs). Two processes. The build starts
// Postbox for real (server/index.mjs’s start(), not listening), runs rooms of agents to half of each turn, then shuts
// down through Postbox’s own close(), or crashes, killing itself once the store has flushed what it was given. It
// counts every byte the store writes to its log from the moment it can (countingIo), and leaves beside the folder a
// whole copy of the log with no snapshot. The load, in a fresh process, opens the folder and that copy and reports the
// bytes written, the snapshot, the bytes and events replayed with the snapshot and without it, the load times, the
// heap, and the restart sweep over the turns cut off.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterRegistry } from '../../server/adapters/adapter.mjs';
import { start } from '../../server/index.mjs';
import { settleInterrupted, stopStreaming } from '../../server/restart-sweep.mjs';
import { Runtime } from '../../server/runtime.mjs';
import { stopTimers } from '../../server/runtime-close.mjs';
import { Store } from '../../server/store.mjs';
import { ScriptedAdapter } from '../../tests/side-threads-fixture.mjs';
import { crashFolders, crashPoints, POINTS } from './crash-points.mjs';
import { makeRooms, play, scriptTurns, ticking } from './drive.mjs';
import { notARepository, turnsOfAll } from './fixtures.mjs';
import { countingHandle, countingIo } from './log-bytes.mjs';

/** The log’s segments in a folder, in order. @param {string} dir */
const segments = (dir) =>
  readdirSync(dir)
    .filter((n) => n.startsWith('events-'))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));

/**
 * Runs `agents` agents, in rooms of 4, to half of each turn, on a Postbox started in `dir`; then `graceful` shuts down
 * through its own close(), and `crash` kills the process once the store has flushed. `dir`-whole gets the whole log.
 * @param {string} dir @param {string} agents @param {string} mode
 */
export async function restartBuild(dir, agents, mode) {
  const app = await start({ port: 4999, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  const { store, rt } = app;
  // From here, every byte the log gets is counted; what start() wrote is on disk already, and leads the whole copy.
  // Flushed first, so the segment’s handle is settled before it’s wrapped, and what’s on disk is all start() wrote.
  await ticking(store.flush());
  const counting = countingIo();
  const before = Buffer.concat(segments(dir).map((n) => readFileSync(join(dir, n))));
  store.io = counting.io;
  if (store.fh) store.fh = countingHandle(store.fh, counting.chunks);
  // close() waits this long for the ledger; the virtual clock would run a real grace out at once.
  rt.config.ledgerGraceMs = 10 * 60_000;
  rt.ledger.git = notARepository;
  store.emit('project', { id: 'p1', name: 'P', folder: dir });
  const adapter = new ScriptedAdapter();
  /** @type {any} */ (adapter).rt = rt;
  rt.adapters.register(adapter);
  const n = Number(agents);
  const pool = turnsOfAll();
  const rooms = makeRooms(rt, n / 4, 4);
  const slots = scriptTurns(
    adapter,
    Array.from({ length: n }, (_, i) => pool[i % pool.length]),
  );
  for (const room of rooms) rt.sendMessage(room.threadId, { text: room.wake });
  await play(slots, { upTo: 0.5, release: false });
  const whole = () => {
    mkdirSync(`${dir}-whole`, { recursive: true });
    writeFileSync(join(`${dir}-whole`, 'events-1.jsonl'), Buffer.concat([before, counting.written()]));
  };
  if (mode === 'crash') {
    await ticking(store.flush());
    whole();
    process.kill(process.pid, 'SIGKILL');
  }
  const at = performance.now();
  await ticking(app.close());
  const shutdownMs = performance.now() - at;
  whole();
  return [{ row: `build ${agents} agents, ${mode}`, shutdownMs, bytesWritten: before.length + counting.written().length }];
}

/** The snapshot’s seq, read from its lines (server/store-snapshot-lines.mjs), or 0 with none. @param {string} dir */
function snapshotSeq(dir) {
  if (!existsSync(join(dir, 'snapshot.json'))) return 0;
  const line = readFileSync(join(dir, 'snapshot.json'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('["v","seq",'));
  return line ? JSON.parse(line)[2] : 0;
}

/** What a load of the folder replays: the events after its snapshot, and their bytes. @param {string} dir */
function replayed(dir) {
  const after = snapshotSeq(dir);
  let events = 0;
  let bytes = 0;
  for (const n of segments(dir))
    for (const line of readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean)) {
      const seqs = [JSON.parse(line)].flat().map((ev) => ev.seq);
      if (seqs.some((s) => s > after)) {
        events += seqs.filter((s) => s > after).length;
        bytes += Buffer.byteLength(line) + 1;
      }
    }
  return { events, bytes, snapshotBytes: existsSync(join(dir, 'snapshot.json')) ? statSync(join(dir, 'snapshot.json')).size : 0 };
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
 * Opens what restartBuild left, and reports the restart: the snapshot, what’s replayed with it and without it, the
 * load, and the sweep over the replies cut off. @param {string} dir @param {string} agents @param {string} mode
 */
export async function restartLoad(dir, agents, mode) {
  const withSnap = replayed(dir);
  const without = replayed(`${dir}-whole`);
  // A load not counted first, of the whole copy, so the counted ones don’t pay for the process’s warm-up.
  await (await new Store(`${dir}-whole`).load()).close();
  const { store: w, loadMs: wholeLoadMs } = await timedLoad(`${dir}-whole`);
  await w.close();
  const points = mode === 'crash' ? await pointLoads(dir, without.events) : [];
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
  const row = `restart after ${agents} agents, ${mode}`;
  // A crash past one snapshot interval is judged at its points: the mean and the worst load, and each point’s replay
  // against main’s at the same point (tools/measure-progress/crash-points.mjs). One crash alone decides it by luck.
  if (points.length > 1)
    return [
      {
        row,
        wholeBytes: without.bytes,
        wholeEvents: without.events,
        loadMs: points.reduce((a, p) => a + p.loadMs, 0) / points.length,
        worstLoadMs: Math.max(...points.map((p) => p.loadMs)),
        wholeLoadMs,
        heapMB,
        sweepMs,
      },
      ...points.map((p, k) => ({ row: `${row}, at point ${k + 1} of ${POINTS}`, replayedBytes: p.bytes, replayedEvents: p.events })),
    ];
  return [
    {
      row,
      snapshotBytes: withSnap.snapshotBytes,
      replayedBytes: withSnap.bytes,
      replayedEvents: withSnap.events,
      wholeBytes: without.bytes,
      wholeEvents: without.events,
      loadMs,
      wholeLoadMs,
      heapMB,
      sweepMs,
    },
  ];
}

/**
 * A crash’s load at each of its points, when its log runs past one snapshot interval: what each replays, and its load
 * time. @param {string} dir  the crash’s folder, beside which its whole log is @param {number} events  the whole log’s
 */
async function pointLoads(dir, events) {
  const points = crashPoints(events);
  if (points.length < 2) return [];
  const { folders } = await crashFolders(`${dir}-whole`, `${dir}-crash`, points);
  const out = [];
  for (const f of folders) {
    const { events: e, bytes } = replayed(f);
    const { store, loadMs } = await timedLoad(f);
    await store.close();
    out.push({ events: e, bytes, loadMs });
  }
  return out;
}

/** Removes what a restart run left. @param {string} dir */
export function removeRestart(dir) {
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}-whole`, { recursive: true, force: true });
  rmSync(`${dir}-crash-replay`, { recursive: true, force: true });
  for (let k = 0; k < POINTS; k++) rmSync(`${dir}-crash-p${k}`, { recursive: true, force: true });
}
