// What close() says when it gives up (#1314): the disk step it was waiting on and how long that step had run, and how
// late close()’s own check ran. One failure then tells a slow disk (the step ran long, the check on time) from this
// process starved of CPU (the check ran seconds late), which CI’s runs couldn’t.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { logDisk, tmp } from './store-retry-fixture.mjs';

/** A store whose log's sync answers until `hang()`, then never does. */
async function storeWithSync() {
  const faults = /** @type {any} */ ({});
  const s = await new Store(await tmp(), { io: logDisk(faults), retryBoundMs: 300 }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  s.emit('thread', { id: 't2', members: [] }); // appended without a sync: close()'s final sync is still to come
  return { s, hang: () => (faults.sync = () => new Promise(() => {})) };
}

/** close()’s error message. @param {Store} s */
const refusal = (s) =>
  s.close().then(
    () => assert.fail('close() should have given up'),
    (/** @type {any} */ e) => String(e.message),
  );

test('#1314: a sync the disk never answers is named, with how long it ran, and a check that ran on time', async () => {
  const { s, hang } = await storeWithSync();
  hang();
  const said = await refusal(s);
  assert.match(
    said,
    /^The store can’t close: a write or Retry has made no progress for 300 ms \(the final sync had run 0\.\d s; this check ran 0\.\d s late\)\./,
  );
  const late = Number(/this check ran (\d+\.\d) s late/.exec(said)?.[1]);
  assert.ok(late < 0.2, `the check ran on time: ${said}`);
});

test('#1314: a process starved of CPU shows as a check that ran late, not as the disk', async () => {
  const { s, hang } = await storeWithSync();
  hang();
  const said = refusal(s);
  // The event loop blocked for 1.5 s, as a runner busy with other workers can block it: close()’s timer runs late.
  const until = Date.now() + 1500;
  while (Date.now() < until);
  const message = await said;
  const late = Number(/this check ran (\d+\.\d) s late/.exec(message)?.[1]);
  assert.ok(late >= 1, `the check ran over a second late: ${message}`);
});
