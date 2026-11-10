// schedule_wake (#458) is capped at 20 pending wakes per agent session (#362): the refusal says how many are pending and
// that cancel_wake frees one. Only that session’s wakes count, and only those not yet fired.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelWake, scheduleWakeTool } from '../server/schedule-tools.mjs';
import { fireScheduledWake } from '../server/scheduled-wakes.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const CAP = 20;
const ask = (f, se) => scheduleWakeTool(f.rt, se.id, { in_minutes: 30, note: 'Check the run.' });
const mine = (f, se) => Object.values(f.store.state.schedules).filter((x) => x.sessionId === se.id);
/** Cancels what a test left armed, so no timer outlives it. */
const clear = (f) => {
  for (const sc of Object.values(f.store.state.schedules)) f.rt.cancelSchedule(sc.id);
};
/** The id a schedule_wake answer names. */
const idOf = (r) => /Its id is (\S+), for cancel_wake/.exec(r.message)?.[1];

test('#362: the 20th pending wake is scheduled and the 21st refused, saying how many are pending and that cancel_wake frees one', (t) => {
  const f = setup();
  t.after(() => clear(f));
  for (let i = 1; i < CAP; i++) assert.equal(ask(f, f.alpha).ok, true);
  const twentieth = ask(f, f.alpha);
  assert.equal(twentieth.ok, true, twentieth.message);
  const items = f.store.items(f.t.id).length;
  const refused = ask(f, f.alpha);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /20 pending wakes/);
  assert.match(refused.message, /cancel_wake/);
  assert.equal(mine(f, f.alpha).length, CAP, 'no 21st wake was made');
  assert.equal(f.store.items(f.t.id).length, items, 'and no schedule line was posted');
});

test('#362: a cancelled wake frees a slot', (t) => {
  const f = setup();
  t.after(() => clear(f));
  const ids = Array.from({ length: CAP }, () => idOf(ask(f, f.alpha)));
  assert.equal(ask(f, f.alpha).ok, false);
  assert.equal(cancelWake(f.rt, f.alpha.id, { id: ids[3] }).ok, true);
  assert.equal(ask(f, f.alpha).ok, true, 'one more fits');
  assert.equal(ask(f, f.alpha).ok, false, 'and only one');
});

test('#362: a wake that fired frees its slot, while its turn runs and once it’s done', async (t) => {
  const f = setup();
  t.after(() => clear(f));
  const ids = Array.from({ length: CAP }, () => idOf(ask(f, f.alpha)));
  assert.equal(ask(f, f.alpha).ok, false);
  clearTimeout(f.rt.timers.get(ids[0]));
  fireScheduledWake(f.rt, ids[0]);
  assert.equal(f.store.state.schedules[ids[0]]?.running, true, 'it fired and is running');
  assert.equal(ask(f, f.alpha).ok, true, 'a running wake isn’t pending');
  await settle(f.rt);
  assert.equal(f.store.state.schedules[ids[0]], undefined, 'it finished');
  assert.equal(ask(f, f.alpha).ok, false, 'the slot it freed is taken');
});

test('#362: another session’s wakes don’t count against an agent’s', (t) => {
  const f = setup();
  t.after(() => clear(f));
  for (let i = 0; i < CAP; i++) assert.equal(ask(f, f.beta).ok, true);
  assert.equal(ask(f, f.beta).ok, false);
  for (let i = 0; i < CAP; i++) assert.equal(ask(f, f.alpha).ok, true, `alpha’s wake ${i + 1}`);
  assert.equal(ask(f, f.alpha).ok, false);
});

test('#362: wakes the person scheduled count too, and the refusal says how many are pending', (t) => {
  const f = setup();
  t.after(() => clear(f));
  for (let i = 0; i < CAP + 3; i++) f.rt.schedule(f.alpha.id, { inMs: 60_000, note: `the person’s ${i}` });
  const r = ask(f, f.alpha);
  assert.equal(r.ok, false);
  assert.match(r.message, /^You have 23 pending wakes,/);
});

test('#362: schedule_wake’s description names the cap', () => {
  const said = TOOL_DEFS.find((x) => x.name === 'schedule_wake')?.description ?? '';
  assert.match(said, /up to 20 pending/);
});
