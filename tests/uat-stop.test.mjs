import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runStop } from '../tools/uat/stop.mjs';
import { closeOrKill, untilGone } from '../tools/uat/until-gone.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#120: a run’s stop ends only once its page and its Postbox have gone, so their ports are free when the run exits', async () => {
  /** @type {string[]} */
  const said = [];
  // Each takes a while to go, as Chrome and Postbox do on a loaded runner after they’re asked to.
  const page = { close: async () => sleep(30).then(() => said.push('page closed')) };
  const postbox = { kill: async () => sleep(60).then(() => said.push('postbox exited')) };
  const stop = runStop({ page, postbox, log: () => {} });
  await stop();
  said.push('stop done');
  assert.deepEqual(said, ['page closed', 'postbox exited', 'stop done']);
  // Once, however often it’s called.
  await stop();
  assert.equal(said.filter((s) => s === 'postbox exited').length, 1);
});

/** A child process as untilGone sees one: it ends on the signals it doesn’t ignore. */
const fakeChild = (ignores = []) => {
  const c = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    signals: [],
    stderr: { destroyed: false, destroy: () => (c.stderr.destroyed = true) },
  });
  c.kill = (sig = 'SIGTERM') => {
    c.signals.push(sig);
    if (ignores.includes(sig)) return;
    setImmediate(() => {
      c.signalCode = sig;
      c.emit('exit', null, sig);
    });
  };
  return c;
};
const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('#120: untilGone resolves once a child has exited, and leaves no timer to hold the process open', async () => {
  const before = timers();
  const c = fakeChild();
  await untilGone(c, 60_000);
  assert.deepEqual(c.signals, ['SIGTERM']);
  assert.equal(c.stderr.destroyed, true, 'its stderr is let go');
  assert.equal(timers(), before, 'no timer left running');
});

test('#120: untilGone kills a child that’s still there after its wait', async () => {
  const before = timers();
  const c = fakeChild(['SIGTERM']);
  await untilGone(c, 20);
  assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(timers(), before, 'no timer left running');
});

test('a browser that closes in time isn’t killed, and no timer is left to hold the process open', async () => {
  const before = timers();
  let killed = false;
  await closeOrKill(
    () => sleep(5),
    () => (killed = true),
    60_000,
  );
  assert.equal(killed, false);
  assert.equal(timers(), before, 'no timer left running');
});

test('a browser whose close hangs is killed after its wait, and the close resolves once it has gone', async () => {
  const before = timers();
  /** @type {(v?: unknown) => void} */
  let gone = () => {};
  const said = [];
  await closeOrKill(
    () => new Promise((ok) => (gone = ok)),
    () => {
      said.push('killed');
      setImmediate(gone);
    },
    20,
  );
  said.push('closed');
  assert.deepEqual(said, ['killed', 'closed']);
  assert.equal(timers(), before, 'no timer left running');
});
