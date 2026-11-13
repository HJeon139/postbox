// The cleanup fixtures’ until() looks once more at its deadline before it gives up: a process stalled past the deadline
// while the awaited thing happened still sees it, so a busy gate doesn’t fail a test that would pass. The clock
// (Date) is node:test’s mock, moved only by the looks themselves, so the tests hold however fast the machine runs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from './remote-cleanup-setup.mjs';

test('until returns once the condition holds after a look stalled past its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let ready = false;
  const check = () => {
    if (ready) return true;
    t.mock.timers.tick(30); // the stall: the 20 ms deadline passes during this look
    ready = true;
    return false;
  };
  await until(check, 'the condition', 20);
  assert.equal(ready, true);
});

test('until still times out when the condition never holds, after one look past its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let looks = 0;
  const check = () => {
    looks++;
    t.mock.timers.tick(30); // each look runs past the 20 ms deadline
    return false;
  };
  await assert.rejects(until(check, 'the condition', 20), /Timed out waiting for the condition\./);
  assert.equal(looks, 2, 'one look before the deadline and one after it');
});
