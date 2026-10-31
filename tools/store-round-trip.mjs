// Measures the store’s write round trips on a copy of a room (#508’s design, “Observability and calibration”, the
// row “Write round trip”, measured in the Store step before anything else moves). It copies the data folder it’s given
// to a temporary folder (the given one is only read), imports it into Redis if it’s an old log, and times:
//   - a streamed chunk: emit('item.text'), then until Redis acknowledged it, one chunk per tick;
//   - a commit at dispatch: commit() of a session patch and an item patch, until it’s applied.
//
//   POSTBOX_REDIS_HOME=… node tools/store-round-trip.mjs <data folder> [chunks] [commits]

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';

/** @param {number[]} xs @param {number} p */
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
/** @param {string} what @param {number[]} ms */
const line = (what, ms) => `${what}: p50 ${pct(ms, 50).toFixed(3)} ms, p95 ${pct(ms, 95).toFixed(3)} ms, max ${Math.max(...ms).toFixed(3)} ms (n ${ms.length})`;

/** The busiest conversation and an agent item in it to stream into. @param {Store} s */
function target(s) {
  const [t, list] = Object.entries(s.state.items).sort((a, b) => b[1].length - a[1].length)[0];
  const se = Object.values(s.state.sessions)[0];
  return { t, it: list.findLast((i) => i.kind === 'agent') ?? list.at(-1), se };
}

async function main(src, chunks = 1000, commits = 300) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-round-trip-'));
  try {
    await cp(src, dir, { recursive: true, filter: (p) => !/[/\\](blobs|models|media|research|telemetry)$/.test(p) });
    let t0 = performance.now();
    const s = await new Store(dir).load();
    console.log(`load (with import if the copy is an old log): ${(performance.now() - t0).toFixed(0)} ms; seq ${s.state.seq}`);
    const { t, it, se } = target(s);
    console.log(`conversation ${t}: ${s.state.items[t].length} items`);
    const chunk = [];
    for (let i = 0; i < chunks; i++) {
      t0 = performance.now();
      s.emit('item.text', { threadId: t, id: it.id, text: ' word' });
      await s.flush();
      chunk.push(performance.now() - t0);
    }
    console.log(line('streamed chunk, emit to Redis ack', chunk));
    const commit = [];
    for (let i = 0; i < commits; i++) {
      t0 = performance.now();
      await s.commit([
        { type: 'session.patch', data: { id: se.id, patch: { currentStep: `step ${i}` } } },
        { type: 'item.patch', data: { threadId: t, id: it.id, patch: { status: 'streaming' } } },
      ]);
      commit.push(performance.now() - t0);
    }
    console.log(line('commit at dispatch (2 events), call to applied', commit));
    await s.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (!process.argv[2]) {
  console.error('Usage: node tools/store-round-trip.mjs <data folder> [chunks] [commits]');
  process.exit(2);
}
await main(process.argv[2], Number(process.argv[3]) || 1000, Number(process.argv[4]) || 300);
