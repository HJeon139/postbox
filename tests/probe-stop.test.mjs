// Stopping a CLI probe or model listing (server/remote/host/probe-stop.mjs): SIGTERM, then SIGKILL after the grace
// unless it closed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { PROBE_GRACE_MS, stopProbe } from '../server/remote/host/probe-stop.mjs';

/** A child that records the signals it’s sent, and closes only when the test says. */
function child(over = {}) {
  const c = Object.assign(new EventEmitter(), { kills: /** @type {string[]} */ ([]) }, over);
  c.kill = (signal) => {
    c.kills.push(signal);
    return true;
  };
  return c;
}

test('a probe that doesn’t close after SIGTERM gets SIGKILL once the grace is up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = child();
  stopProbe(c);
  assert.deepEqual(c.kills, ['SIGTERM']);
  t.mock.timers.tick(PROBE_GRACE_MS - 1);
  assert.deepEqual(c.kills, ['SIGTERM']);
  t.mock.timers.tick(1);
  assert.deepEqual(c.kills, ['SIGTERM', 'SIGKILL']);
});

test('a probe that closes after SIGTERM isn’t sent SIGKILL', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = child();
  stopProbe(c);
  c.emit('close', null, 'SIGTERM');
  t.mock.timers.tick(PROBE_GRACE_MS);
  assert.deepEqual(c.kills, ['SIGTERM']);
});

test('a probe that already ended is sent nothing', () => {
  const c = child({ exitCode: 0 });
  stopProbe(c);
  assert.deepEqual(c.kills, []);
});
