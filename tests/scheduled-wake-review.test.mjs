// #466, from the review of #522’s fix at d1811486: a Stop of a scheduled wake’s turn is the end of that wake, a Retry
// after you cancel a tool-aware recovery still sends the recovery rather than the original instruction, and one tool
// call reported through both toolUse and activity is one entry in the recovery.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fireScheduledWake, rearmWakes } from '../server/scheduled-wakes.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

const networkError = (code = 'ECONNRESET') => Object.assign(new Error(`network failed: ${code}`), { code });
const fire = async (f, sc) => {
  clearTimeout(f.rt.timers.get(sc.id));
  fireScheduledWake(f.rt, sc);
  await settle(f.rt);
};

test('#466 Retry after you cancel a tool-aware recovery sends the recovery, not the original instruction', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Deploy production.' });
  f.adapter.next.push(async (ctx) => {
    ctx.toolUse({ id: 'tool-1', name: 'Deploy production', input: {} });
    throw networkError();
  });
  await fire(f, sc);
  assert.match(f.store.state.schedules[sc.id]?.recoveryNote ?? '', /Deploy production/, 'a recovery is armed');
  f.rt.cancelSchedule(sc.id);
  const failed = f.store.items(sc.threadId).findLast((item) => item.kind === 'agent' && item.status === 'failed');
  f.adapter.next.push(async (ctx) => ctx.text('Checked first.'));
  f.rt.retry(sc.threadId, failed.id);
  await settle(f.rt);
  const sent = f.adapter.calls.at(-1).message.note;
  assert.notEqual(sent, 'Deploy production.', 'the original instruction isn’t replayed');
  assert.match(sent, /Do not repeat them until you have checked their effects/);
  assert.equal(f.store.state.schedules[sc.id], undefined, 'and the canceled wake isn’t armed again');
});

test('#466 one tool call reported through toolUse and activity is one entry in the recovery', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Deploy.' });
  f.adapter.next.push(async (ctx) => {
    ctx.toolUse({ id: 't1', name: 'Bash', input: { command: 'deploy' } });
    ctx.activity({ id: 't1', label: 'Run deployment', state: 'running' });
    throw networkError();
  });
  await fire(f, sc);
  assert.equal(f.store.state.schedules[sc.id]?.recoveryTools?.length, 1, JSON.stringify(f.store.state.schedules[sc.id]?.recoveryTools));
  f.rt.cancelSchedule(sc.id);
});

test('#466 Stop ends a running scheduled wake: no schedule, timer or turn comes back after a restart', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check the run.' });
  const h = held();
  f.adapter.next.push(h.step);
  clearTimeout(f.rt.timers.get(sc.id));
  fireScheduledWake(f.rt, sc);
  await new Promise((r) => setTimeout(r, 5));
  f.rt.stop(f.alpha.id);
  h.release();
  await settle(f.rt);
  assert.equal(f.store.state.schedules[sc.id], undefined, 'the schedule is settled');
  assert.equal(f.store.item(sc.threadId, sc.itemId).status, 'canceled');
  rearmWakes(f.rt);
  assert.equal(f.rt.timers.has(sc.id), false, 'a restart arms nothing');
  await settle(f.rt);
  assert.equal(f.adapter.calls.length, 1, 'and no second turn runs');
});
