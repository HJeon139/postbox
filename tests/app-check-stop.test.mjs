// A stopped or failed app-check turn lets go of its app’s “fixing”, as a turn that ends does (#1664). Before, only the
// end of a turn (`turn.ended`, listener M) moved a check out of “fixing”, and a stopped turn never raises it, so after
// Stop, Send now, a run clock’s stop or a UAT run’s bound the app read “@x is fixing this app” for good, and a bounded
// UAT run waited on it to its turn timeout (uat-runs/2026-11-23T06-31-18-b4-trial-kiro). The stop path is the
// runtime’s, the same for every backend: the adapter only sees its turn’s signal abort.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import { Runtime } from '../server/runtime.mjs';
import { setup, slowToExit } from './stop-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTRAST = [{ code: 'contrast', message: 'Low contrast.' }];
const THREW = [{ code: 'script-error', message: 'TypeError: r is negative (line 12, column 3)' }];

/** An app whose check found problems, and the app-check turn that took them, at work until it’s stopped. */
async function fixing(problems = CONTRAST) {
  const r = setup();
  const turn = slowToExit({ kept: null });
  r.adapter.next.push(turn);
  r.rt.toolsFor(r.se.id).show_app({ id: 'jam', title: 'Traffic jam', code: '<p>Jam</p>' });
  assert.deepEqual(r.rt.appCheck('jam', { version: 1, problems }), { status: 'fixing' });
  await sleep(5);
  assert.equal(r.adapter.calls.at(-1)?.message.kind, 'app-check', 'the app-check turn is at work');
  return { ...r, turn, status: () => r.store.state.apps.jam.check.status };
}

for (const [how, stop] of [
  ['Stop', (r) => r.rt.requestStop(r.se.id)],
  ['Send now', (r) => r.rt.sendMessage(r.t.id, { text: 'Leave the app, look at this instead.', sendNow: true })],
  ['a run clock’s stop', (r) => r.rt.stop(r.se.id, { by: 'clock' })],
]) {
  test(`#1664 ${how} on an app-check turn shows the app with its note, not “fixing”`, async () => {
    const r = await fixing();
    stop(r);
    assert.equal(r.status(), 'note', 'it leaves fixing when the turn is stopped');
    r.turn.exit();
    await sleep(10);
    assert.equal(r.status(), 'note');
  });
}

test('#1664 a stopped app-check turn for a script error shows the app as crashed, as its end would', async () => {
  const r = await fixing(THREW);
  r.rt.requestStop(r.se.id);
  assert.equal(r.status(), 'crashed');
  r.turn.exit();
});

test('#1664 a shutdown’s stop keeps the app fixing: the restart reopens what the turn took', async () => {
  const r = await fixing();
  r.rt.stop(r.se.id, { silent: true, by: 'shutdown' });
  assert.equal(r.status(), 'fixing');
  r.turn.exit();
});

test('#1664 a failed app-check turn shows the app with its note, not “fixing”', async () => {
  const r = setup();
  r.adapter.next.push(async () => {
    throw new Error('The CLI exited with code 1.');
  });
  r.rt.toolsFor(r.se.id).show_app({ id: 'jam', title: 'Traffic jam', code: '<p>Jam</p>' });
  r.rt.appCheck('jam', { version: 1, problems: CONTRAST });
  await sleep(10);
  assert.equal(r.store.state.sessions[r.se.id].state, 'failed', 'the turn failed');
  assert.equal(r.store.state.apps.jam.check.status, 'note');
});

test('#1664 an app-check turn lost to the network keeps the app fixing: what it took goes again as a resend', async () => {
  const r = setup();
  r.adapter.next.push(async () => {
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  });
  r.adapter.next.push(slowToExit({ kept: null }));
  r.rt.toolsFor(r.se.id).show_app({ id: 'jam', title: 'Traffic jam', code: '<p>Jam</p>' });
  r.rt.appCheck('jam', { version: 1, problems: CONTRAST });
  await sleep(10);
  assert.equal(r.adapter.calls.length, 2, 'the app check went again');
  assert.equal(r.store.state.apps.jam.check.status, 'fixing');
  r.rt.stop(r.se.id, { silent: true, by: 'shutdown' });
});

test('#1664 a stopped turn that wasn’t the app’s fix keeps it fixing: the app check still waits for the agent', async () => {
  const r = setup();
  const busy = slowToExit({ kept: null });
  r.adapter.next.push(busy);
  r.rt.sendMessage(r.t.id, { text: 'Make the chart.' });
  await sleep(5);
  r.rt.toolsFor(r.se.id).show_app({ id: 'jam', title: 'Traffic jam', code: '<p>Jam</p>' });
  r.rt.appCheck('jam', { version: 1, problems: CONTRAST });
  r.rt.requestStop(r.se.id);
  assert.equal(r.store.state.apps.jam.check.status, 'fixing');
  busy.exit();
});

/** A second runtime on the same store, as a restart makes one, with the restart’s sweep run. */
function restart(r) {
  const rt = new Runtime({
    store: r.store,
    adapters: new AdapterRegistry().register(r.adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  settleInterrupted(rt);
  return rt;
}

/** An agent with an app left fixing, and its app-check entry in the inbox as `entry` says, or none. */
function leftFixing(entry) {
  const r = setup();
  const tools = r.rt.toolsFor(r.se.id);
  for (const id of ['jam', 'other']) tools.show_app({ id, title: id, code: '<p>App</p>' });
  r.store.emit('app', { ...r.store.state.apps.jam, check: { status: 'fixing', attempt: 1, problems: CONTRAST } });
  if (entry) {
    const e = r.rt.delivery.send(
      {
        sessionId: r.se.id,
        threadId: r.t.id,
        source: 'check',
        text: 'Problems',
        message: { kind: 'app-check', appId: entry.appId ?? 'jam', problems: CONTRAST },
      },
      { wake: false },
    );
    r.rt.delivery.patch(e, entry.patch);
  }
  restart(r);
  return r.store.state.apps.jam.check.status;
}

test('#1664 after a restart, an app left fixing with no app-check turn to come shows its note', () => {
  // What a stop before this fix left: the app fixing, its entry delivered.
  assert.equal(leftFixing({ patch: { state: 'delivered' } }), 'note');
  assert.equal(leftFixing(null), 'note', 'with no entry at all');
  // A resend the restart cut off fails instead of going again (Delivery’s start).
  assert.equal(leftFixing({ patch: { state: 'taken', takenBy: 'turn_x', resend: true } }), 'note');
  assert.equal(leftFixing({ appId: 'other', patch: { state: 'waiting' } }), 'note', 'another app’s check doesn’t hold this one');
});

test('#1664 after a restart, an app whose app-check entry still waits stays fixing', () => {
  assert.equal(leftFixing({ patch: { state: 'waiting' } }), 'fixing');
  assert.equal(leftFixing({ patch: { state: 'taken', takenBy: 'turn_x' } }), 'fixing');
});

test('#1664 after a restart, an app whose app-check turn was cut off stays fixing: the turn goes again', async () => {
  const r = await fixing();
  const taken = r.rt.delivery.inbox(r.se.id);
  assert.ok(
    taken.some((e) => e.state === 'taken' && e.message?.kind === 'app-check'),
    'the app-check entry is taken by the turn',
  );
  restart(r);
  assert.equal(r.status(), 'fixing');
  r.turn.exit();
});
