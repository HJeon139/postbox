// Reconnecting to a host (server/remote/ssh-reconnect.mjs, through ssh.mjs): the backoff, retrying only while the
// host is needed, never retrying what only the person can fix, and the laptop’s wake.

import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKOFF, backoffDelay, createReconnector } from '../server/remote/ssh.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { connection, fakeClock, flush } from './remote-ssh-fixtures.mjs';

// ── Reconnecting ────────────────────────────────────────────────────────────────────

test('backoff doubles from 1 s to a 60 s cap, and jitter only shortens a wait', () => {
  const none = [0, 1, 2, 3, 4, 5, 6, 7, 20, 1000].map((n) => backoffDelay(n, { random: () => 0 }));
  assert.deepEqual(none, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
  const most = [0, 3, 10].map((n) => backoffDelay(n, { random: () => 1 }));
  assert.deepEqual(most, [500, 4000, 30_000]);
  assert.deepEqual(BACKOFF, { base: 1000, factor: 2, max: 60_000, jitter: 0.5 });
});

/** A reconnector over fake ssh children that a test scripts one by one. */
function reconnectRig({ needed = () => true } = {}) {
  const clock = fakeClock();
  const daemon = createFakeDaemon();
  /** @type {((child: any) => void)[]} what each next ssh does: undefined connects to the daemon */
  const plan = [];
  const spawned = [];
  const spawn = (program, args, options) => {
    const step = plan.shift();
    const ssh = step ? fakeSsh({ script: step }) : fakeSsh({ daemon });
    const child = ssh.spawn(program, args, options);
    spawned.push(child);
    return child;
  };
  const r = createReconnector({
    open: () => connection({ spawn }),
    needed,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    delay: (n) => backoffDelay(n, { random: () => 0 }),
  });
  const states = [];
  r.on('state', (s) => states.push(s));
  const failures = [];
  r.on('failure', (f) => failures.push(f.kind));
  return { r, clock, daemon, plan, spawned, states, failures };
}
const unreachable = (child) => child.fail(255, 'ssh: connect to host host.example.com port 22: Connection refused\r\n');
const signIn = (child) => child.fail(255, 'user@host.example.com: Permission denied (publickey).\r\n');

test('reconnect backs off while needed, resets after it connects, and reconnects after a drop', async () => {
  const { r, clock, daemon, plan, spawned, states } = reconnectRig();
  plan.push(unreachable, unreachable, unreachable);
  r.need();
  await flush();
  await flush();
  assert.equal(r.state, 'waiting');
  assert.deepEqual(clock.fire(), [1000]);
  await flush();
  await flush();
  assert.deepEqual(clock.fire(), [2000]);
  await flush();
  await flush();
  assert.deepEqual(clock.pending(), [4000]);
  assert.equal(r.failure.kind, 'unreachable');
  clock.fire();
  await flush();
  await flush();
  assert.equal(r.state, 'open');
  assert.equal(r.failure, null);
  assert.equal(spawned.length, 4);
  assert.ok(r.connection);
  // A drop starts again from the first step.
  daemon.drop();
  await flush();
  await flush();
  assert.equal(r.state, 'waiting');
  assert.deepEqual(clock.pending(), [1000]);
  assert.deepEqual(states.slice(0, 3), ['connecting', 'waiting', 'connecting']);
  r.dispose();
});

test('reconnect stops when nothing needs the host', async () => {
  let needed = true;
  const { r, clock, plan, spawned } = reconnectRig({ needed: () => needed });
  plan.push(unreachable);
  r.need();
  await flush();
  await flush();
  assert.equal(r.state, 'waiting');
  needed = false;
  clock.fire();
  await flush();
  assert.equal(r.state, 'idle');
  assert.equal(spawned.length, 1);
  assert.deepEqual(clock.pending(), []);
});

test('a sign-in, host-key, install or version failure isn’t retried, not even on wake; retry, when the person asks, is', async () => {
  const { r, clock, plan, spawned, failures } = reconnectRig();
  plan.push(signIn);
  r.need();
  await flush();
  await flush();
  assert.equal(r.state, 'stopped');
  assert.deepEqual(clock.pending(), []);
  assert.deepEqual(failures, ['sign-in']);
  r.wake();
  r.need();
  await flush();
  assert.equal(spawned.length, 1);
  r.retry();
  await flush();
  await flush();
  assert.equal(r.state, 'open');
  assert.equal(spawned.length, 2);
  r.dispose();
});

test('the laptop’s wake reconnects at once and starts the backoff over', async () => {
  const { r, clock, plan, spawned } = reconnectRig();
  plan.push(unreachable, unreachable, unreachable);
  r.need();
  await flush();
  await flush();
  clock.fire();
  await flush();
  await flush();
  assert.deepEqual(clock.pending(), [2000]);
  r.wake();
  await flush();
  await flush();
  assert.equal(spawned.length, 3);
  assert.deepEqual(clock.pending(), [1000]);
  r.wake();
  await flush();
  await flush();
  assert.equal(r.state, 'open');
  r.dispose();
  await flush();
  assert.equal(r.state, 'idle');
  assert.deepEqual(spawned.at(-1).kills, ['SIGTERM']);
});
