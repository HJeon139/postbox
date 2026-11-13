// The writer at the scale a seeded room reaches (designs/architecture/store.md, “The store”): open-scale’s #1271 spec
// emits 101,000 items at once, and the writer took its queue one Array.shift() at a time. Once V8 can’t trim the
// array’s start in place, each shift moves every job behind it, so the pass grew with the square of the queue and held
// the event loop for seconds; a close() during the snapshot ahead of those lines outlasted its bound and failed with
// “The store can’t close” on CI. A healthy store this size closes within the bound, and the 1M-item rooms the scale
// targets need a pass that grows with the queue, not its square.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const LINES = 100_000;

test('close() during the snapshot ahead of 100,000 queued lines writes them all and closes within its bound', async () => {
  const dir = await tempDir('pb-scale-');
  // The first emit starts the writer’s loop; the rest queue behind it, and the snapshot they make due runs first.
  let snapshotStarted = () => {};
  const started = new Promise((r) => {
    snapshotStarted = () => r(undefined);
  });
  const fs = await import('node:fs/promises');
  const io = {
    ...fs,
    async open(path, flags) {
      if (String(path).includes('snapshot.json.')) snapshotStarted();
      return fs.open(path, flags);
    },
  };
  const store = await new Store(dir, { io, retryBoundMs: 1000 }).load();
  for (let i = 0; i < LINES; i++) store.emit('thread', { id: `th_${i}`, members: [] });
  await started;
  const errors = [];
  const logged = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await store.close();
  } finally {
    console.error = logged;
  }
  assert.deepEqual(errors, [], 'close() logged nothing');
  assert.equal(store.writtenThrough, store.state.seq, 'every queued line reached the log');
  assert.equal(store.lock, null, 'the folder’s lock is released');
});

test('an emit past the 20,000 events kept for since() costs about what one before it does', () => {
  // In memory, so record() alone is measured. The backlog kept for reconnecting browsers was trimmed by a splice of
  // its start at every event past 20,000, which moved every event kept: an emit there cost about 100 times one before
  // it (some 35 µs), and 5 of the 8 s the close test above spent seeding. Measured as a ratio, so a slow machine slows
  // both alike.
  const store = new Store(null);
  /** The mean cost of emits numbered from..to-1. @param {number} from @param {number} to */
  const emit = (from, to) => {
    const started = performance.now();
    for (let i = from; i < to; i++) store.emit('thread', { id: `th_${i}`, members: [] });
    return (performance.now() - started) / (to - from);
  };
  const before = emit(0, 20_000);
  const past = emit(20_000, LINES);
  assert.ok(past < before * 10, `an emit past the backlog’s size cost ${(past / before).toFixed(1)} times one before it`);
  assert.equal(store.since(LINES - 20_000)?.length, 20_000, 'the last 20,000 events are still served');
});
