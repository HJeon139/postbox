// The cleanup fixtures’ until() looks once more at its deadline before it gives up: a process stalled past the deadline
// while the awaited thing happened still sees it, so a busy gate doesn’t fail a test that would pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from './remote-cleanup-setup.mjs';

test('until returns once the condition holds after a look stalled past its deadline', async () => {
  let ready = false;
  const check = () => {
    if (ready) return true;
    for (const end = Date.now() + 60; Date.now() < end; ); // the stall: the deadline passes during this look
    ready = true;
    return false;
  };
  await until(check, 'the condition', 20);
});

test('until still times out when the condition never holds', async () => {
  let looks = 0;
  const check = () => {
    looks++;
    return false;
  };
  await assert.rejects(until(check, 'the condition', 20), /Timed out waiting for the condition\./);
  assert.ok(looks > 1, `looked ${looks} times`);
});
