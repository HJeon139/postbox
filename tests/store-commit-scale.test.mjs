// The writer at the scale a seeded room reaches (designs/architecture/store.md, “The store”): open-scale’s #1271 spec
// emits 101,000 items at once, and the writer took its queue one Array.shift() at a time. Once V8 can’t trim the
// array’s start in place, each shift moves every job behind it, so the pass grew with the square of the queue and held
// the event loop for seconds; a close() during the snapshot ahead of those lines outlasted its bound and failed with
// “The store can’t close” on CI. A healthy store this size closes within the bound, and the 1M-item rooms the scale
// targets need a pass that grows with the queue, not its square. The store’s other long lists, the held emits and the
// backlog kept for since(), are held to the same: each costs the same per event at 100,000 as at 10,000.
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

test('releasing 100,000 emits held behind a commit costs each about what releasing 10,000 does', async () => {
  // release() took each job off the held log with Array.shift(), which moved every job behind it: 25,000 held emits
  // took 0.3 s to release, 100,000 took 3.5 s, and a long outage’s streamed chunks pile up there.
  /** The mean cost of releasing `count` emits held behind one commit. @param {number} count */
  const releaseCost = async (count) => {
    const dir = await tempDir('pb-held-');
    const fs = await import('node:fs/promises');
    let open = () => {};
    const gate = new Promise((r) => {
      open = () => r(undefined);
    });
    let hold = false;
    const io = {
      ...fs,
      async open(path, flags) {
        const fh = await fs.open(path, flags);
        const sync = fh.sync.bind(fh);
        fh.sync = async () => {
          if (hold) await gate;
          return sync();
        };
        return fh;
      },
    };
    const store = await new Store(dir, { io, snapshotEvery: 1e9 }).load();
    hold = true;
    const committed = store.commit([{ type: 'thread', data: { id: 'th_c', members: [] } }]);
    for (let i = 0; i < count; i++) store.emit('thread', { id: `th_${i}`, members: [] });
    assert.equal(store.held, count, 'every emit is held behind the commit');
    const started = performance.now();
    hold = false;
    open();
    await committed;
    await store.flush();
    const cost = (performance.now() - started) / count;
    assert.equal(store.writtenThrough, count + 1, 'every held emit reached the log');
    await store.close();
    return cost;
  };
  const small = await releaseCost(10_000);
  const large = await releaseCost(LINES);
  assert.ok(large < small * 5, `a release among 100,000 cost ${(large / small).toFixed(1)} times one among 10,000`);
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
