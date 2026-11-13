// The writer at the scale a seeded room reaches (designs/architecture/store.md, “The store”): open-scale’s #1271 spec
// emits 101,000 items at once, and the writer took its queue one Array.shift() at a time. Once V8 can’t trim the
// array’s start in place, each shift moves every job behind it, so the pass grew with the square of the queue and held
// the event loop for seconds; a close() during the snapshot ahead of those lines outlasted its bound and failed with
// “The store can’t close” on CI. A healthy store this size closes within the bound, and the 1M-item rooms the scale
// targets need a pass that grows with the queue, not its square.
import assert from 'node:assert/strict';
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
