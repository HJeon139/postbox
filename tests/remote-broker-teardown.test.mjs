// The broker fixtures’ teardown (tests/remote-broker-fixtures.mjs, makeHome’s done): a spec can end while the broker
// still has an append in flight, which it writes without waiting on. Removing the home under it failed CI with
// ENOTEMPTY in tests/remote-broker-prompts.test.mjs; done waits for the append first.

import assert from 'node:assert/strict';
import { existsSync, promises as fsp } from 'node:fs';
import { test } from 'node:test';
import { connectShim, makeBroker, makeHome, REQUEST, sleep, until } from './remote-broker-fixtures.mjs';

test('removing a home waits for the append its broker still has in flight, and then the home is gone', async () => {
  const h = makeHome();
  h.turn('t1');
  // Each append lands 50 ms after it starts, as on a slow disk.
  const appendLate = async (...a) => {
    await sleep(50);
    return fsp.appendFile(...a);
  };
  const slow = { appendFile: appendLate, readFile: fsp.readFile, stat: fsp.stat };
  const k = makeBroker(h, { io: slow });
  const s = connectShim(k.b, 't1');
  await s.next('welcome');
  s.send('permission', { id: 'p1', request: REQUEST });
  await until(() => h.appending().length, 'the prompt’s append under way');
  await h.done();
  // Long enough for an append the removal didn’t wait for to land in a folder that’s gone, and be logged.
  await sleep(150);
  assert.deepEqual(
    k.logs.filter((l) => l.startsWith('Couldn’t record')),
    [],
    'the append landed before the home was removed',
  );
  assert.equal(existsSync(h.home), false);
});
