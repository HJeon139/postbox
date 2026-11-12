// The broker fixtures’ until() looks once more at its deadline before it gives up: a process stalled past the deadline
// while the awaited thing happened still sees it, so a busy gate doesn’t fail a test that would pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sleep, until } from './remote-broker-fixtures.mjs';

test('until returns a value that turns up while the waiter is stalled past its deadline', async () => {
  let ready = false;
  const check = async () => {
    if (ready) return 'seen';
    await sleep(60); // the stall: the deadline passes while this look is still running
    ready = true;
    return false;
  };
  assert.equal(await until(check, 'the value', 20), 'seen');
});

test('until still times out when the value never turns up', async () => {
  let looks = 0;
  const check = () => {
    looks++;
    return false;
  };
  await assert.rejects(until(check, 'the value', 20), /Timed out waiting for the value\./);
  assert.ok(looks > 1, `looked ${looks} times`);
});
