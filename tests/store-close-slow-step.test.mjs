// close() and one slow disk step (#1314). A step the disk is still working on is progress, up to a limit of its own:
// CI’s runners took 3.6 s over one write of the event log with close()’s check on time, and close() refused at 3 s
// though nothing was wrong but the disk’s speed. A step that never finishes is still given up on, at that longer limit,
// and with no step at all the short bound holds as before.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { stepOn, stepped } from '../server/store-commit.mjs';
import { stepBound } from '../server/store-recover.mjs';
import { logDisk, tmp } from './store-retry-fixture.mjs';

/** A store with one event appended and not yet synced, so close()’s final sync is its next disk step. */
async function storeBeforeItsLastSync(/** @type {{ retryBoundMs: number, stepBoundMs?: number }} */ bounds) {
  const faults = /** @type {any} */ ({});
  const dir = await tmp();
  const s = await new Store(dir, { io: logDisk(faults), retryBoundMs: bounds.retryBoundMs }).load();
  // The limit for a step is the store’s own unless it is set on it: the constructor takes the one bound.
  if (bounds.stepBoundMs) Object.assign(s, { stepBoundMs: bounds.stepBoundMs });
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  s.emit('thread', { id: 't2', members: [] });
  return { s, dir, faults };
}

test('#1314: one disk step that takes longer than the bound, and finishes, lets close() succeed', async () => {
  const { s, dir, faults } = await storeBeforeItsLastSync({ retryBoundMs: 200, stepBoundMs: 3000 });
  // The fixture’s disk waits for this before it runs the real sync.
  faults.sync = () => new Promise((r) => setTimeout(r, 600));
  const t0 = Date.now();
  await s.close();
  assert.ok(Date.now() - t0 >= 550, 'close() waited for the slow sync, three times the bound');
  assert.equal(s.lock, null, 'released');
  const again = await new Store(dir).load();
  assert.deepEqual(Object.keys(again.state.threads).sort(), ['t1', 't2'], 'both events are on disk');
  await again.close();
});

test('#1314: a disk step that never finishes is given up on at the step’s own limit, and the error names it', async () => {
  const { s, faults } = await storeBeforeItsLastSync({ retryBoundMs: 150, stepBoundMs: 600 });
  faults.sync = () => new Promise(() => {});
  const t0 = Date.now();
  const said = await s.close().then(
    () => assert.fail('close() should have given up'),
    (/** @type {any} */ e) => String(e.message),
  );
  const took = Date.now() - t0;
  assert.ok(took >= 550 && took < 1600, `gave up after ${took} ms, against a 600 ms limit for a step and a 150 ms bound`);
  assert.match(said, /^The store can’t close: a disk step hasn’t finished in 600 ms \(the final sync had run 0\.\d s; this check ran 0\.\d s late\)\./);
});

test('#1314: a caller that shortens the bound and names no limit for a step gets the bound for both, as before', async () => {
  const { s, faults } = await storeBeforeItsLastSync({ retryBoundMs: 200 });
  faults.sync = () => new Promise(() => {});
  const t0 = Date.now();
  await assert.rejects(s.close(), /can’t close/);
  assert.ok(Date.now() - t0 < 900, 'gave up within the one bound it was given');
});

test('#1314: the store’s own limits are 3 s with no step and 30 s for a step in flight', async () => {
  const s = new Store(null);
  assert.equal(s.retryBoundMs, 3000);
  assert.equal(stepBound(s), 30_000);
  assert.equal(stepBound(new Store(null, { retryBoundMs: 200 })), 200, 'a shortened bound is the step’s too');
});

// A step that finishes early isn’t a reason to wait out its limit: once no step is in flight, the short bound on no
// progress holds again (the integrator’s review of #1421). A Retry or a reconciliation can be pending with no disk step.
test('#1314: a step that finishes with the writer still pending is given up on by the short bound, not the step’s limit', async () => {
  const { s } = await storeBeforeItsLastSync({ retryBoundMs: 200, stepBoundMs: 2000 });
  await s.flush();
  s.running = new Promise(() => {}); // a pass that never settles, as a Retry’s barrier that never resolves
  stepOn(s, 'the event log’s write');
  setTimeout(() => stepped(s), 100);
  const t0 = Date.now();
  const said = await s.close().then(
    () => assert.fail('close() should have given up'),
    (/** @type {any} */ e) => String(e.message),
  );
  const took = Date.now() - t0;
  assert.ok(took >= 250 && took < 1000, `gave up after ${took} ms: 200 ms after a step that ended at 100 ms, against a 2,000 ms limit for a step`);
  assert.match(said, /no progress for 200 ms \(the event log’s write had finished 0\.[12] s before, with no step since/);
});
