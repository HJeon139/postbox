// The broker fixtures’ until() looks once more at its deadline before it gives up: a process stalled past the deadline
// while the awaited thing happened still sees it, so a busy gate doesn’t fail a test that would pass. The clock
// (Date) is node:test’s mock, moved only by the looks themselves, so the tests hold however fast the machine runs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from './remote-broker-fixtures.mjs';

test('until returns a value that turns up while the waiter is stalled past its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let ready = false;
  const check = async () => {
    if (ready) return 'seen';
    t.mock.timers.tick(30); // the stall: the 20 ms deadline passes while this look is still running
    ready = true;
    return false;
  };
  assert.equal(await until(check, 'the value', 20), 'seen');
});

test('until still times out when the value never turns up, after one look past its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let looks = 0;
  const check = () => {
    looks++;
    t.mock.timers.tick(30); // each look runs past the 20 ms deadline
    return false;
  };
  await assert.rejects(until(check, 'the value', 20), /Timed out waiting for the value\./);
  assert.equal(looks, 2, 'one look before the deadline and one after it');
});
