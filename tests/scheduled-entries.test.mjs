// A scheduled wake coming due is a scheduled entry (#1425; designs/rooms-at-scale.md, “What an entry is”), carrying the
// wake its turn keeps, so #466’s lifecycle runs as before. For a busy agent it waits in the inbox, where the queue
// shows it; canceling its schedule stops it there.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fireScheduledWake } from '../server/scheduled-wakes.mjs';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** @alpha busy in a turn held open, with a wake of its own come due. */
async function busyAndDue() {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha work on it' });
  await sleep(5);
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check the run.' });
  clearTimeout(f.rt.timers.get(sc.id));
  fireScheduledWake(f.rt, sc);
  return { ...f, busy, sc };
}
const wakesTo = (f) => f.adapter.calls.filter((c) => c.sessionId === f.alpha.id && c.message.kind === 'wake');

test('#1425 a wake due for a busy agent waits as a scheduled entry, and its turn is given it once', async () => {
  const f = await busyAndDue();
  assert.deepEqual(
    arrange.waitingEntries(f.rt, f.alpha.id).map((e) => [e.source, e.message?.scheduledWakeId]),
    [['scheduled', f.sc.id]],
  );
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(
    wakesTo(f).map((c) => c.message.note),
    ['Check the run.'],
  );
  assert.equal(f.store.state.schedules[f.sc.id], undefined, 'its turn settled the schedule');
});

test('#1425 canceling a schedule whose wake waits for a busy agent stops it there', async () => {
  const f = await busyAndDue();
  f.rt.cancelSchedule(f.sc.id);
  assert.deepEqual(arrange.waitingEntries(f.rt, f.alpha.id), []);
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(wakesTo(f), []);
});
